package ghpoll

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"stam/internal/db"
	"stam/internal/events"
)

// Store is the poller's ground: the subjects watched, the rows of the poll state, and the writes to them.
type Store interface {
	// Watched is every subject a live subscription or an open event wait names.
	Watched(ctx context.Context) ([]string, error)
	// Row is a subject's row; ok false when it has none.
	Row(ctx context.Context, subject string) (db.WatchRow, bool, error)
	// Apply stores a poll's events and its snapshot in one transaction, and only if the subject is watched when it begins: a
	// subject unwatched before stores nothing, and a watch the events end still has the snapshot stored. stored counts the
	// events stored (a repeat of a dedupe key is dropped); written is whether the transaction wrote.
	Apply(ctx context.Context, subject string, evs []events.Input, state, etags string) (stored int, written bool, err error)
	// StateSubjects is the github subjects that have a row.
	StateSubjects(ctx context.Context) ([]string, error)
	// Drop deletes the rows of subjects nobody watches (checked in the delete's transaction) that were written before
	// olderThan, keeping every pull request's row (its review verdict is read after the watch ends). It returns the subjects it deleted.
	Drop(ctx context.Context, subjects []string, olderThan time.Time) ([]string, error)
}

// Options is a poller's parts.
type Options struct {
	Store Store
	// Token is the token to poll with: STAM_GITHUB_TOKEN, else the `gh` login's. An error skips the tick.
	Token func(ctx context.Context) (string, error)
	// Base is the API's base url (STAM_GITHUB_API), read at each call.
	Base func() string
	HTTP *http.Client
	// Interval is the tick interval; Start does nothing for 0 or less.
	Interval time.Duration
	Now      func() time.Time
	// Mirror and MirrorMain are the seams for the head mirror (S-1347, S-1363, S-1389): called, not awaited, when a poll finds
	// a PR opened, reopened or with new commits (or the first poll finds it open), and when one merged. nil does nothing.
	Mirror     func(subject string)
	MirrorMain func()
	// Keep is how long the row of a subject nobody watches stays before the cleanup drops it, so a watch that comes back
	// finds its baseline; 7 days when 0.
	Keep time.Duration
	// SubjectBackoff is how long a subject that fails for its own reasons (a permission 403) waits; 5 minutes when 0.
	SubjectBackoff time.Duration
}

// Poller polls the watched GitHub subjects.
type Poller struct {
	o Options

	running atomic.Bool

	mu           sync.Mutex
	backoffUntil time.Time
	subjectUntil map[string]time.Time
	// tokenID is a hash of the token the stored ETags were last used with, and fresh the subjects polled once with it since:
	// both live in memory only (never on disk or in a log), so a start or a token change polls every subject once without
	// ETags, and one token's ETags are never sent with another's.
	tokenID string
	fresh   map[string]bool
	logged  map[string]bool
	cancel  context.CancelFunc
	started bool
	closed  bool

	wg sync.WaitGroup

	// hookAfterPoll, hookBeforeApply and hookBeforeDrop land a test's interleaving at a named step; nil does nothing.
	hookAfterPoll   func(subject string)
	hookBeforeApply func(subject string)
	hookBeforeDrop  func()
}

// New is a poller that has not started.
func New(o Options) *Poller {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.HTTP == nil {
		o.HTTP = &http.Client{}
	}
	if o.Base == nil {
		o.Base = func() string { return "https://api.github.com" }
	}
	if o.Keep == 0 {
		o.Keep = 7 * 24 * time.Hour
	}
	if o.SubjectBackoff == 0 {
		o.SubjectBackoff = 5 * time.Minute
	}
	return &Poller{o: o, logged: map[string]bool{}, subjectUntil: map[string]time.Time{}, fresh: map[string]bool{}}
}

// logOnce logs a message once per daemon, so a missing token or a glob subject doesn't repeat every tick.
func (p *Poller) logOnce(msg string) {
	p.mu.Lock()
	seen := p.logged[msg]
	p.logged[msg] = true
	p.mu.Unlock()
	if !seen {
		slog.Error("github: " + msg)
	}
}

// ResetBackoff ends a backoff (tests).
func (p *Poller) ResetBackoff() {
	p.mu.Lock()
	p.backoffUntil = time.Time{}
	p.mu.Unlock()
}

// BackoffUntil is when the poller polls again after a low rate limit or a rate-limited reply; zero when it isn't backing off.
func (p *Poller) BackoffUntil() time.Time {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.backoffUntil
}

func (p *Poller) setBackoff(resetAtMs, retryAfterMs int64) {
	until := p.o.Now().Add(time.Minute)
	switch {
	case retryAfterMs > 0:
		until = p.o.Now().Add(time.Duration(retryAfterMs) * time.Millisecond)
	case resetAtMs > 0:
		until = time.UnixMilli(resetAtMs)
	}
	p.mu.Lock()
	p.backoffUntil = until
	p.mu.Unlock()
	p.logOnce("rate limit low or reached; backing off until " + until.UTC().Format("2006-01-02T15:04:05.000Z"))
}

// useToken notes the token this tick polls with: a different one than the last ends the ETags' use until each subject has been
// polled once with it.
func (p *Poller) useToken(token string) {
	sum := sha256.Sum256([]byte(token))
	id := hex.EncodeToString(sum[:])
	p.mu.Lock()
	defer p.mu.Unlock()
	if id != p.tokenID {
		p.tokenID = id
		p.fresh = map[string]bool{}
	}
}

// etagsUsable is whether the subject's stored ETags were last sent with this process's token: only after a poll of it with the
// current token, so the first poll after a start or a token change sends none.
func (p *Poller) etagsUsable(subject string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.fresh[subject]
}

// subjectWaits is whether the subject is in its own backoff.
func (p *Poller) subjectWaits(subject string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.o.Now().Before(p.subjectUntil[subject])
}

// ErrBusy is a tick asked for while another still runs: ticks never overlap.
var ErrBusy = errors.New("a tick is still running")

func isGithub(s string) bool { return strings.HasPrefix(s, "github:") }

// Tick is one poll of every watched GitHub subject, then the cleanup of the state nobody watches. It returns how many events
// it ingested. Only one tick runs at a time (ErrBusy otherwise); a subject's poll, its events and its snapshot are one step
// of the tick, so the cleanup that follows never meets a poll of the subject in flight.
//
// Contexts: ctx is the poller's own (cancelled at Close), for every step: the calls to GitHub get a 20 s timeout derived
// from it, and the ingest and the snapshot write do not, so a timed-out call never cuts an event or a write.
func (p *Poller) Tick(ctx context.Context) (int, error) {
	if !p.running.CompareAndSwap(false, true) {
		return 0, ErrBusy
	}
	defer p.running.Store(false)
	if p.o.Now().Before(p.BackoffUntil()) {
		return 0, nil
	}
	watched, err := p.o.Store.Watched(ctx)
	if err != nil {
		return 0, err
	}
	var pollable []string
	have := map[string]bool{}
	for _, s := range watched {
		if !isGithub(s) {
			continue
		}
		have[s] = true
		if _, ok := ParseSubject(s); !ok {
			p.logOnce("ignoring subject " + s + ": only github:OWNER/REPO and github:OWNER/REPO#N are polled")
			continue
		}
		pollable = append(pollable, s)
	}
	ingested := 0
	var remaining, resetAt int64 = -1, -1
	if len(pollable) > 0 {
		if token, err := p.o.Token(ctx); err != nil || token == "" {
			p.logOnce("no gh login; polling skipped (log in with `gh auth login`, or set STAM_GITHUB_TOKEN)")
		} else {
			p.useToken(token)
			for _, subject := range pollable {
				if ctx.Err() != nil {
					break
				}
				if p.subjectWaits(subject) {
					continue
				}
				n, rem, reset, err := p.pollOne(ctx, subject, token)
				ingested += n
				var se *StatusError
				if errors.As(err, &se) && se.RateLimited() {
					p.setBackoff(se.ResetAt, se.RetryAfter)
					return ingested, nil
				}
				if errors.As(err, &se) {
					// Its own failure (a permission, a missing repo): this subject waits, the others go on.
					p.mu.Lock()
					p.subjectUntil[subject] = p.o.Now().Add(p.o.SubjectBackoff)
					p.mu.Unlock()
				}
				if err != nil {
					if ctx.Err() == nil {
						p.logOnce("poll " + subject + " failed: " + redactText(err.Error(), token))
					}
					continue
				}
				if rem >= 0 && (remaining < 0 || rem < remaining) {
					remaining = rem
				}
				if reset > resetAt {
					resetAt = reset
				}
			}
		}
	}
	if remaining >= 0 && remaining < 200 {
		p.setBackoff(resetAt, 0)
	}
	p.prune(have)
	if ctx.Err() == nil {
		p.cleanup(ctx, have)
	}
	return ingested, nil
}

func redactText(msg, token string) string {
	if token == "" {
		return msg
	}
	return strings.ReplaceAll(msg, token, "[redacted]")
}

// prune forgets the in-memory state of subjects nobody watches and the subject backoffs that ended.
func (p *Poller) prune(watched map[string]bool) {
	now := p.o.Now()
	p.mu.Lock()
	defer p.mu.Unlock()
	for s, until := range p.subjectUntil {
		if !watched[s] || !now.Before(until) {
			delete(p.subjectUntil, s)
		}
	}
	for s := range p.fresh {
		if !watched[s] {
			delete(p.fresh, s)
		}
	}
}

// cleanup drops the state of subjects nobody watches. The delete reads the watchers itself, so a watch added after the
// list was read keeps its row.
func (p *Poller) cleanup(ctx context.Context, watched map[string]bool) {
	rows, err := p.o.Store.StateSubjects(ctx)
	if err != nil {
		slog.Error("github: poll state not listed", "err", err)
		return
	}
	var stale []string
	for _, s := range rows {
		if !watched[s] {
			stale = append(stale, s)
		}
	}
	if len(stale) == 0 {
		return
	}
	if p.hookBeforeDrop != nil {
		p.hookBeforeDrop()
	}
	if _, err := p.o.Store.Drop(ctx, stale, p.o.Now().Add(-p.o.Keep)); err != nil {
		slog.Error("github: poll state not dropped", "err", err)
	}
}

// pollOne polls one subject: it reads the row, polls, then stores the events and the snapshot in one transaction, so a stop
// leaves both or neither and none is missed or repeated. A failed poll stores nothing, so it advances neither since nor an
// ETag. The row's ETags are sent only once the subject was polled with the current token (see useToken).
func (p *Poller) pollOne(ctx context.Context, subject, token string) (ingested int, remaining, resetAt int64, err error) {
	row, ok, err := p.o.Store.Row(ctx, subject)
	if err != nil {
		return 0, -1, -1, err
	}
	var prev *Snapshot
	prevEtags := map[string]string{}
	if ok {
		var s Snapshot
		if json.Unmarshal([]byte(row.State), &s) == nil {
			prev = &s
		}
		if !p.etagsUsable(subject) || json.Unmarshal([]byte(row.Etags), &prevEtags) != nil || prevEtags == nil {
			prevEtags = map[string]string{}
		}
	}
	res, err := p.Poll(ctx, subject, prev, prevEtags, token)
	if err != nil {
		return 0, -1, -1, redactErr(err, token)
	}
	if p.hookAfterPoll != nil {
		p.hookAfterPoll(subject)
	}
	// The events and the snapshot go in one transaction, which reads whether the subject is watched when it begins: the watch
	// may have gone while the call was out, and then nothing is stored. A stop leaves both or neither, so a restart finds neither
	// an event twice nor one lost.
	state, err := json.Marshal(res.State)
	if err != nil {
		return 0, -1, -1, err
	}
	etags, err := json.Marshal(res.Etags)
	if err != nil {
		return 0, -1, -1, err
	}
	var evs []events.Input
	for _, e := range res.Events {
		in := events.Input{Source: "github", Type: e.Type, Subjects: dedupeStrings(append(append([]string{}, e.Subjects...), e.Subject)), Actor: e.Actor, URL: e.URL, DedupeKey: e.DedupeKey}
		sum := e.Summary
		in.Summary = &sum
		if e.Payload != nil {
			in.Payload, in.HasPayload = e.Payload, true
		}
		evs = append(evs, in)
	}
	if p.hookBeforeApply != nil {
		p.hookBeforeApply(subject)
	}
	ingested, written, err := p.o.Store.Apply(ctx, subject, evs, string(state), string(etags))
	if err != nil {
		return 0, -1, -1, redactErr(err, token)
	}
	// The stored ETags now come from this token's polls.
	p.mu.Lock()
	p.fresh[subject] = true
	p.mu.Unlock()
	// A PR opened or updated on GitHub gets its head mirrored to storage, as pr_open does.
	if written {
		if p.o.Mirror != nil && MirrorsHead(prev, res) {
			p.o.Mirror(subject)
		}
		if p.o.MirrorMain != nil {
			for _, e := range res.Events {
				if e.Type == "pull_request.merged" {
					p.o.MirrorMain()
					break
				}
			}
		}
	}
	return ingested, res.Remaining, res.ResetAt, nil
}

func redactErr(err error, token string) error {
	if err == nil {
		return nil
	}
	var se *StatusError
	if errors.As(err, &se) {
		return err
	}
	return redact(err, token)
}

func dedupeStrings(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// MirrorsHead is whether a poll mirrors its PR's head to storage (S-1347, S-1363): when GitHub reports the PR opened,
// reopened or with new commits, or when the first poll finds it open. A PR opened with `gh pr create` before the watch
// began has no opened event, so only the first poll sees it. A later poll with the same head emits nothing and mirrors
// nothing.
func MirrorsHead(prev *Snapshot, r PollResult) bool {
	if prev == nil && r.State.Type == "pr" && deref(r.State.State) == "open" && deref(r.State.Head) != "" {
		return true
	}
	for _, e := range r.Events {
		switch e.Type {
		case "pull_request.opened", "pull_request.reopened", "pull_request.synchronize":
			return true
		}
	}
	return false
}

// Start runs a tick every Interval until Close. It does nothing for an interval of 0 or less, or once started.
func (p *Poller) Start(ctx context.Context) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.started || p.closed || !(p.o.Interval > 0) {
		return
	}
	p.started = true
	ctx, p.cancel = context.WithCancel(ctx)
	p.wg.Add(1)
	go func() {
		defer p.wg.Done()
		t := time.NewTicker(p.o.Interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if _, err := p.Tick(ctx); err != nil && !errors.Is(err, ErrBusy) && ctx.Err() == nil {
					slog.Error("github: tick failed", "err", err)
				}
			}
		}
	}()
}

// Close stops the ticks and waits for the one in flight, so the database can close after it. The tick's context is
// cancelled first, which ends its calls to GitHub; an event or a snapshot it was writing is cut whole by its
// transaction, and the next start polls it again.
func (p *Poller) Close() {
	p.mu.Lock()
	p.closed = true
	cancel := p.cancel
	p.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	p.wg.Wait()
}
