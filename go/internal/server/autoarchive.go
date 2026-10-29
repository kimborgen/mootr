package server

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/peers"
)

// Auto-archive of the human's resolved threads (src/auto-archive.ts over src/thread-resolved.ts, S-637; S-3734). A pass
// looks at the human's inbox as their list shows it and archives each thread someone else resolved, here and on the peers,
// whose archive state is their own. It runs every 10 minutes, soon after mail to or from the human, and on demand (POST
// /api/mail/resolved). A thread waits until nothing happened in it for the quiet period, so it never leaves the list under
// the human's eyes. A later mail to the human brings it back (db.SplitArchived); a thread the human unarchived stays until
// it has new mail for them (db.KeptOpen). Not ported: the nudge when an ITSA closes or a request settles, which the timer
// covers.

const (
	autoArchiveSinceKey  = "autoArchive.since"
	autoArchiveRepairKey = "autoArchive.fullPassDone2"
	autoArchiveFullKey   = "autoArchive.fullPassDone3"
	autoArchiveEvery     = 10 * time.Minute
)

// envMillis is Number(envVar(name) ?? fallback) as a duration: MOOTR_NAME, else STAM_NAME; 0 is a value, not a fallback.
func envMillis(name string, fallback time.Duration) time.Duration {
	v, ok := os.LookupEnv("MOOTR_" + name)
	if !ok {
		v, ok = os.LookupEnv("STAM_" + name)
	}
	if !ok {
		return fallback
	}
	n, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
	if err != nil || math.IsNaN(n) {
		return fallback
	}
	return time.Duration(n * float64(time.Millisecond))
}

// autoArchiveQuiet is QUIET_MS: tests set STAM_AUTO_ARCHIVE_QUIET_MS, so they wait on state, not on minutes.
func autoArchiveQuiet() time.Duration { return envMillis("AUTO_ARCHIVE_QUIET_MS", 3*time.Minute) }

// autoArchiveFullDelay is FULL_DELAY_MS: how long after start the one-time work waits.
func autoArchiveFullDelay() time.Duration {
	return envMillis("AUTO_ARCHIVE_FULL_DELAY_MS", time.Minute)
}

// millis is Date.parse of an ISO time, 0 for none.
func millis(s string) int64 {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return 0
	}
	return t.UnixMilli()
}

// humanRecipient is the human's row among the mail's recipients.
func humanRecipient(m jsfmt.Value) (jsfmt.Value, bool) {
	rs, _ := m.Get("recipients")
	for _, r := range rs.Items {
		if r.Text("id") == humanBox {
			return r, true
		}
	}
	return jsfmt.Value{}, false
}

// lastActivity is the last thing that happened in the thread: its newest mail, or the human reading one.
func lastActivity(t db.ThreadGroup) int64 {
	var at int64
	for _, m := range t.Mails {
		at = max(at, millis(m.Text("created_at")))
		if r, ok := humanRecipient(m); ok {
			at = max(at, millis(r.Text("read_at")))
		}
	}
	return at
}

// itsaOf is m.itsa_id ?? m.about_itsa.
func itsaOf(m jsfmt.Value) string {
	if v, ok := m.Get("itsa_id"); ok && v.Kind != jsfmt.Null {
		return db.JSStr(v)
	}
	if v, ok := m.Get("about_itsa"); ok && v.Kind != jsfmt.Null {
		return db.JSStr(v)
	}
	return ""
}

// autoArchiveCtx is what the pass knows about a thread's ITSAs, decisions and waits (src/thread-resolved.ts ResolvedContext).
type autoArchiveCtx struct {
	s     *Server
	ctx   context.Context
	open  map[string]bool
	waits []db.HumanWait
}

// itsaClosedAt is when the ITSA closed; ok false while it is open or when it isn't known here.
func (a *autoArchiveCtx) itsaClosedAt(id string) (string, bool) {
	x, found, err := a.s.db.FindItsa(a.ctx, id)
	if err != nil || !found || !a.s.isClosedStatus(x.Text("status")) {
		return "", false
	}
	if at := x.Text("closed_at"); at != "" {
		return at, true
	}
	return x.Text("updated_at"), x.Text("updated_at") != ""
}

// lastEvent is when the thread was last touched by anything that can resolve it: its activity, a request in it settling,
// or one of its ITSAs closing.
func (a *autoArchiveCtx) lastEvent(t db.ThreadGroup) int64 {
	at := lastActivity(t)
	for _, m := range t.Mails {
		if p, ok := m.Get("permission"); ok && p.Kind == jsfmt.Object {
			at = max(at, millis(p.Text("decided_at")))
		}
		if id := itsaOf(m); id != "" {
			if x, found, err := a.s.db.FindItsa(a.ctx, id); err == nil && found {
				at = max(at, millis(x.Text("closed_at")))
			}
		}
	}
	return at
}

// humanWaited is src/auto-archive.ts humanWaited: whether an agent waits on the human for the thread: a wait naming it,
// or one tied to a request or mail in it. A wait that names neither holds only the threads its agent is in the middle of.
func humanWaited(t db.ThreadGroup, waits []db.HumanWait) bool {
	for _, w := range waits {
		if w.Thread != nil && *w.Thread == t.ThreadID {
			return true
		}
		if w.Target != nil && *w.Target != "" {
			for _, m := range t.Mails {
				if m.Text("id") == *w.Target || m.Text("permission_id") == *w.Target {
					return true
				}
			}
		}
		if (w.Thread != nil && *w.Thread != "") || (w.Target != nil && *w.Target != "") {
			continue
		}
		if w.Agent == nil || *w.Agent == "" || genericWaitHolds(t, *w.Agent) {
			return true
		}
	}
	return false
}

func genericWaitHolds(t db.ThreadGroup, agent string) bool {
	mails := append([]jsfmt.Value(nil), t.Mails...)
	byCreated(mails)
	lastHuman := ""
	for i := len(mails) - 1; i >= 0; i-- {
		if mails[i].Text("from_id") != humanBox {
			if mails[i].Text("from_id") == agent {
				return true
			}
			break
		}
	}
	for i := len(mails) - 1; i >= 0; i-- {
		if mails[i].Text("from_id") == humanBox {
			lastHuman = mails[i].Text("created_at")
			break
		}
	}
	for _, m := range mails {
		if _, toHuman := humanRecipient(m); m.Text("from_id") == agent && m.Text("created_at") > lastHuman && toHuman {
			return true
		}
	}
	return false
}

var reEndsQuestion = regexp.MustCompile(`\?\s*$`)

// resolvedCtx is src/thread-resolved.ts ResolvedContext: when an ITSA closed (ok false while it is open or unknown here),
// whether a mail is a decision still waiting on the human, and whether an agent waits on the human for the thread.
type resolvedCtx struct {
	itsaClosedAt func(id string) (string, bool)
	decisionOpen func(id string) bool
	humanWaited  func(t db.ThreadGroup) bool
}

// resolved is the context a pass judges threads with; noWaits as if no agent waited on the human.
func (a *autoArchiveCtx) resolved(noWaits bool) resolvedCtx {
	return resolvedCtx{
		itsaClosedAt: a.itsaClosedAt,
		decisionOpen: func(id string) bool { return a.open[id] },
		humanWaited:  func(t db.ThreadGroup) bool { return !noWaits && humanWaited(t, a.waits) },
	}
}

// threadResolved is src/thread-resolved.ts threadResolved: whether someone else resolved a thread in the human's inbox,
// and which rule did (itsa or request), or why not.
func threadResolved(t db.ThreadGroup, c resolvedCtx) (bool, string) {
	mails := append([]jsfmt.Value(nil), t.Mails...)
	byCreated(mails)
	if c.humanWaited(t) {
		return false, "an agent waits on the human for it"
	}
	var itsas []string
	requests := false
	for _, m := range mails {
		if id := itsaOf(m); id != "" && !contains(itsas, id) {
			itsas = append(itsas, id)
		}
		if m.Text("permission_id") != "" {
			requests = true
		}
	}
	if len(itsas) == 0 && !requests {
		return false, "it is about no ITSA and holds no request"
	}
	closedAt := ""
	for _, id := range itsas {
		at, ok := c.itsaClosedAt(id)
		if !ok {
			return false, "ITSA " + id + " is open"
		}
		if at > closedAt {
			closedAt = at
		}
	}
	// A request whose state isn't known here (it lives on a peer that didn't answer) counts as pending.
	for _, m := range mails {
		if pid := m.Text("permission_id"); pid != "" {
			status := "pending"
			if p, ok := m.Get("permission"); ok && p.Kind == jsfmt.Object {
				if v, ok := p.Get("status"); ok && v.Kind != jsfmt.Null {
					status = db.JSStr(v)
				}
			}
			if status == "pending" {
				return false, "request " + pid + " isn't settled"
			}
		}
	}
	for _, m := range mails {
		if c.decisionOpen(m.Text("id")) {
			return false, "decision " + m.Text("id") + " is open"
		}
	}
	// The human's side of the thread: what they sent, and what was sent to them and not withdrawn.
	var theirs []jsfmt.Value
	for _, m := range mails {
		r, toHuman := humanRecipient(m)
		if m.Text("from_id") == humanBox || (toHuman && r.Text("withdrawn_at") == "") {
			theirs = append(theirs, m)
		}
	}
	for _, m := range theirs {
		if r, _ := humanRecipient(m); m.Text("from_id") != humanBox && r.Text("read_at") == "" {
			return false, "the human hasn't read " + m.Text("id")
		}
	}
	if len(itsas) == 0 {
		if len(theirs) == 0 || theirs[len(theirs)-1].Text("permission_id") != "" {
			return true, "request"
		}
		return false, "the last mail on the human's side, " + theirs[len(theirs)-1].Text("id") + ", isn't a request"
	}
	if len(theirs) == 0 {
		return true, "itsa"
	}
	last := theirs[len(theirs)-1]
	if last.Text("from_id") == humanBox {
		if last.Text("created_at") <= closedAt {
			return true, "itsa"
		}
		return false, "the human wrote " + last.Text("id") + " after the ITSA closed"
	}
	if reEndsQuestion.MatchString(last.Text("body")) {
		return false, "the last mail to the human, " + last.Text("id") + ", asks them a question"
	}
	if last.Text("kind") == "ask" || hasDecisionBlock(last.Text("body")) {
		return false, "the last mail to the human, " + last.Text("id") + ", asks them something"
	}
	return true, "itsa"
}

// autoArchiveSince is src/auto-archive.ts since: the automatic pass archives only threads touched since it was first
// switched on (kv, set once).
func (s *Server) autoArchiveSince(ctx context.Context) (int64, error) {
	v, ok, err := s.db.KV(ctx, autoArchiveSinceKey)
	if err != nil {
		return 0, err
	}
	if ok {
		n, _ := strconv.ParseFloat(v, 64)
		return int64(n), nil
	}
	now := time.Now().UnixMilli()
	if err := s.db.KVSetOnce(ctx, autoArchiveSinceKey, strconv.FormatInt(now, 10)); err != nil {
		return 0, err
	}
	return now, nil
}

// autoArchiveSources reads what a pass judges: the human's inbox, the open decisions and the waits on the human, on every
// daemon.
func (s *Server) autoArchiveSources(ctx context.Context, limit int) (active, archived []db.ThreadGroup, a *autoArchiveCtx, err error) {
	active, archived, _, err = s.mailboxThreads(ctx, humanBox, limit, nil, nil, "")
	if err != nil {
		return nil, nil, nil, err
	}
	ds, err := s.decisionMailsAll(ctx, false, nil)
	if err != nil {
		return nil, nil, nil, err
	}
	a = &autoArchiveCtx{s: s, ctx: ctx, open: map[string]bool{}}
	for _, d := range ds {
		a.open[d.Text("mail_id")] = true
	}
	if a.waits, err = s.db.OpenHumanWaits(ctx); err != nil {
		return nil, nil, nil, err
	}
	for _, w := range s.peers.FanOut(ctx, "/api/mail/human-waits", nil) {
		hw := db.HumanWait{}
		for k, dst := range map[string]**string{"thread": &hw.Thread, "target": &hw.Target, "agent": &hw.Agent} {
			if v, ok := w.Get(k); ok && v.Kind == jsfmt.String {
				str := v.Str
				*dst = &str
			}
		}
		a.waits = append(a.waits, hw)
	}
	return active, archived, a, nil
}

// archivedThread is one thread a pass archived, or with dry would archive.
type archivedThread struct {
	ThreadID string `json:"thread_id"`
	Subject  string `json:"subject"`
}

// archiveResolved is src/auto-archive.ts archiveResolved: one pass. `all` takes in the threads resolved before the pass was
// switched on (the one-off sweep); kept, when given, counts the resolved-looking threads an agent's wait kept.
func (s *Server) archiveResolved(ctx context.Context, dry, all bool, kept *int) ([]archivedThread, error) {
	s.autoArch.mu.Lock()
	defer s.autoArch.mu.Unlock()
	if !s.peers.Reachable() {
		return nil, errors.New("a peer does not answer, and auto-archive judges threads only with every peer in view")
	}
	now := time.Now().UnixMilli()
	var from int64
	if !all {
		var err error
		if from, err = s.autoArchiveSince(ctx); err != nil {
			return nil, err
		}
	}
	limit := 200
	if all {
		limit = 1_000_000
	}
	threads, _, a, err := s.autoArchiveSources(ctx, limit)
	if err != nil {
		return nil, err
	}
	quiet := autoArchiveQuiet().Milliseconds()
	done := []archivedThread{}
	for _, t := range threads {
		if now-lastActivity(t) < quiet || a.lastEvent(t) < from {
			continue
		}
		if ok, _ := threadResolved(t, a.resolved(false)); !ok {
			if kept != nil && humanWaited(t, a.waits) {
				if ok, _ := threadResolved(t, a.resolved(true)); ok {
					*kept++
				}
			}
			continue
		}
		// A thread the human unarchived stays until it has new mail to them; their own mail isn't news.
		var humanIDs []string
		for _, m := range t.Mails {
			if _, toHuman := humanRecipient(m); m.Text("from_id") != humanBox && toHuman {
				humanIDs = append(humanIDs, m.Text("id"))
			}
		}
		if keep, err := s.db.KeptOpen(ctx, humanBox, t.ThreadID, humanIDs); err != nil {
			return nil, err
		} else if keep {
			continue
		}
		subject := ""
		if len(t.Mails) > 0 {
			subject = t.Mails[0].Text("subject")
		}
		done = append(done, archivedThread{ThreadID: t.ThreadID, Subject: subject})
		if dry {
			continue
		}
		ids := make([]string, 0, len(t.Mails))
		for _, m := range t.Mails {
			ids = append(ids, m.Text("id"))
		}
		if err := s.db.ArchiveThread(ctx, humanBox, t.ThreadID, ids); err != nil {
			return nil, err
		}
		if err := s.db.MarkAutoArchived(ctx, humanBox, t.ThreadID); err != nil {
			return nil, err
		}
		if humanIDs == nil {
			humanIDs = []string{}
		}
		body := map[string]any{"thread_id": t.ThreadID, "ids": ids, "human_ids": humanIDs}
		for _, p := range s.peers.Peers() {
			if _, err := s.peers.Call(ctx, p, http.MethodPost, "/api/mail/archive-resolved", body, peers.DefaultTimeout, false, nil); err != nil {
				slog.Error(fmt.Sprintf("auto-archive: telling peers about %s: %s", t.ThreadID, err))
			}
		}
	}
	if len(done) > 0 && !dry {
		ids := make([]string, len(done))
		for i, d := range done {
			ids[i] = d.ThreadID
		}
		s.daemonLog(fmt.Sprintf("auto-archive: archived %d resolved thread(s) for the human: %s", len(done), strings.Join(ids, ", ")))
	}
	return done, nil
}

// daemonLog writes a line the way src/ console.log does: plain, to the daemon's stdout (daemon.log). The repair reads
// auto-archive's lines back from it.
func (s *Server) daemonLog(line string) { fmt.Fprintln(os.Stdout, line) }

var reLoggedArchive = regexp.MustCompile(`(?m)^auto-archive: archived \d+ resolved thread\(s\) for the human: (.*)$`)

// loggedAutoArchived is the threads the daemon log says auto-archive archived for the human, before they were marked.
func (s *Server) loggedAutoArchived() []string {
	text, err := os.ReadFile(filepath.Join(s.cfg.Home, "daemon.log"))
	if err != nil {
		return nil
	}
	var ids []string
	for _, m := range reLoggedArchive.FindAllStringSubmatch(string(text), -1) {
		ids = append(ids, strings.Split(m[1], ", ")...)
	}
	return ids
}

// autoArchiveRepair is src/auto-archive.ts repair: unarchives the human's threads that auto-archive archived and the rule
// now keeps. The human's own archives are never touched: only auto-archive's marks and its logged ids are candidates.
func (s *Server) autoArchiveRepair(ctx context.Context) error {
	marked, err := s.db.AutoArchivedThreads(ctx, humanBox)
	if err != nil {
		return err
	}
	candidates := map[string]bool{}
	var order []string
	for _, id := range append(marked, s.loggedAutoArchived()...) {
		if !candidates[id] {
			candidates[id] = true
			order = append(order, id)
		}
	}
	if len(order) == 0 {
		return nil
	}
	_, archived, a, err := s.autoArchiveSources(ctx, 1_000_000)
	if err != nil {
		return err
	}
	undone := []string{}
	still := map[string]bool{}
	for _, t := range archived {
		still[t.ThreadID] = true
		if !candidates[t.ThreadID] {
			continue
		}
		if ok, _ := threadResolved(t, a.resolved(false)); ok {
			continue
		}
		if err := s.db.UnarchiveThread(ctx, humanBox, t.ThreadID); err != nil {
			return err
		}
		if err := s.db.ForgetAutoArchived(ctx, humanBox, t.ThreadID); err != nil {
			return err
		}
		undone = append(undone, t.ThreadID)
	}
	// Threads the marks name but that no longer archive hold no mark either.
	for _, id := range order {
		if !still[id] {
			if err := s.db.ForgetAutoArchived(ctx, humanBox, id); err != nil {
				return err
			}
		}
	}
	tail := ""
	if len(undone) > 0 {
		tail = ": " + strings.Join(undone, ", ")
	}
	s.daemonLog(fmt.Sprintf("auto-archive repair: unarchived %d threads%s", len(undone), tail))
	return nil
}

func (s *Server) kvSet(ctx context.Context, key string) bool {
	_, ok, err := s.db.KV(ctx, key)
	return err == nil && ok
}

// autoArchiveFullPass is src/auto-archive.ts fullPass: the one-time work of the first start with the code, the repair and
// then one pass over every thread in the inbox, before the cutoff too. The kv flags record each is done.
func (s *Server) autoArchiveFullPass(ctx context.Context) error {
	if s.kvSet(ctx, autoArchiveFullKey) {
		return nil
	}
	if !s.kvSet(ctx, autoArchiveRepairKey) {
		if err := s.autoArchiveRepair(ctx); err != nil {
			return err
		}
		if err := s.db.KVSetOnce(ctx, autoArchiveRepairKey, db.Now()); err != nil {
			return err
		}
	}
	kept := 0
	done, err := s.archiveResolved(ctx, false, true, &kept)
	if err != nil {
		return err
	}
	if err := s.db.KVSetOnce(ctx, autoArchiveFullKey, db.Now()); err != nil {
		return err
	}
	s.daemonLog(fmt.Sprintf("auto-archive full pass: %d threads, %d kept by waits", len(done), kept))
	return nil
}

// autoArchiver is the timer state of the pass.
type autoArchiver struct {
	// mu runs one pass at a time.
	mu    sync.Mutex
	nudge chan struct{}
}

// StartAutoArchive is src/auto-archive.ts start: the pass every 10 minutes and once more the quiet period after the latest
// nudge, and the one-time work once every peer answers.
func (s *Server) StartAutoArchive(ctx context.Context) {
	if _, err := s.autoArchiveSince(ctx); err != nil {
		slog.Error("auto-archive: " + err.Error())
	}
	s.autoArch.nudge = make(chan struct{}, 1)
	run := func() {
		if _, err := s.archiveResolved(ctx, false, false, nil); err != nil && ctx.Err() == nil {
			slog.Error("auto-archive: " + err.Error())
		}
	}
	s.goBg(func() {
		full := time.NewTimer(autoArchiveFullDelay())
		defer full.Stop()
		if s.kvSet(ctx, autoArchiveFullKey) {
			full.Stop()
		}
		every := time.NewTicker(autoArchiveEvery)
		defer every.Stop()
		var soon <-chan time.Time
		for {
			select {
			case <-ctx.Done():
				return
			case <-full.C:
				if s.kvSet(ctx, autoArchiveFullKey) {
					continue
				}
				if !s.peers.Reachable() {
					s.daemonLog("auto-archive: the full pass waits for every peer to answer")
					full.Reset(autoArchiveFullDelay())
					continue
				}
				if err := s.autoArchiveFullPass(ctx); err != nil && ctx.Err() == nil {
					slog.Error("auto-archive full pass: " + err.Error())
				}
			case <-every.C:
				run()
			case <-s.autoArch.nudge:
				soon = time.After(autoArchiveQuiet() + 5*time.Second)
			case <-soon:
				soon = nil
				run()
			}
		}
	})
}

// nudgeAutoArchive asks for a pass the quiet period from now: mail to or from the human moved.
func (s *Server) nudgeAutoArchive() {
	if s.autoArch.nudge == nil {
		return
	}
	select {
	case s.autoArch.nudge <- struct{}{}:
	default:
	}
}

// resolvedRoute is POST /api/mail/resolved: the pass on demand. `dry` (the default) lists what it would archive; `all`
// takes in the threads resolved before it was switched on. The CLI and the human may run it; an agent and a peer may not.
func (s *Server) resolvedRoute(r *http.Request, c auth.Resolved) (any, error) {
	if c.Local || c.Caller.IsAgent() {
		return nil, Errorf(http.StatusForbidden, "only the CLI or the human runs the archive pass")
	}
	body, err := jsonBody(r)
	if err != nil {
		return nil, err
	}
	dry := true
	if v, ok := body.Get("dry"); ok && v.Kind == jsfmt.Bool && !v.Bool {
		dry = false
	}
	all := false
	if v, ok := body.Get("all"); ok && v.Kind == jsfmt.Bool && v.Bool {
		all = true
	}
	threads, err := s.archiveResolved(context.WithoutCancel(r.Context()), dry, all, nil)
	if err != nil {
		return nil, err
	}
	out := jsfmt.Value{Kind: jsfmt.Object}
	out.Set("dry", jsfmt.Value{Kind: jsfmt.Bool, Bool: dry})
	out.Set("all", jsfmt.Value{Kind: jsfmt.Bool, Bool: all})
	out.Set("count", jsfmt.IntValue(int64(len(threads))))
	rows := make([]jsfmt.Value, 0, len(threads))
	for _, t := range threads {
		v := jsfmt.Value{Kind: jsfmt.Object}
		v.Set("thread_id", jsfmt.StringValue(t.ThreadID))
		v.Set("subject", jsfmt.StringValue(t.Subject))
		rows = append(rows, v)
	}
	out.Set("threads", jsfmt.ArrayValue(rows))
	return out, nil
}

// archiveResolvedRoute is POST /api/mail/archive-resolved: a peer archives a thread it found resolved for the human here
// too. A thread the human unarchived here stays, unless it has new mail for them since.
func (s *Server) archiveResolvedRoute(r *http.Request, c auth.Resolved) (any, error) {
	if !c.Local {
		return nil, Errorf(http.StatusForbidden, "only a peer archives a resolved thread this way")
	}
	body, err := jsonBody(r)
	if err != nil {
		return nil, err
	}
	list := func(k string) ([]string, bool) {
		v, ok := body.Get(k)
		if !ok || v.Kind != jsfmt.Array {
			return nil, false
		}
		out := []string{}
		for _, x := range v.Items {
			out = append(out, anyString(x))
		}
		return out, true
	}
	ids, _ := list("ids")
	tid, _ := body.Get("thread_id")
	if !tid.Truthy() || len(ids) == 0 {
		return nil, Errorf(http.StatusBadRequest, "thread_id and ids are required")
	}
	human, ok := list("human_ids")
	if !ok {
		human = ids
	}
	thread := anyString(tid)
	if keep, err := s.db.KeptOpen(r.Context(), humanBox, thread, human); err != nil {
		return nil, err
	} else if keep {
		return map[string]bool{"archived": false}, nil
	}
	if err := s.db.ArchiveThread(r.Context(), humanBox, thread, ids); err != nil {
		return nil, err
	}
	return map[string]bool{"archived": true}, nil
}
