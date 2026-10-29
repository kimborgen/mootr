// Package peers is the calls between daemons (src/peers.ts, S-2881): each machine's daemon owns its agents and their
// mail, and a request about an agent elsewhere goes to the daemon that owns it. Peers are listed in settings.json as
// { name, url, token, peerToken }. A call between daemons carries `x-stam-local: 1`, which stops it from fanning out
// again, and the peer's token; the receiving side trusts those headers only from a peer's token (go/internal/auth).
//
// A peer that failed is skipped by lists until a background probe reaches it again (every 30 seconds), so a stopped
// machine slows only the request that found it down. A direct call to a down peer probes it first, with the short check.
//
// A peer's token never leaves this package: it is a config.Secret, and an error that would quote it says [redacted]. A
// peer's answer that isn't a success has every token the call could expose redacted before any caller sees it (S-3994):
// the peer's, and this daemon's own, since a peer or a proxy may echo the bearer it got or a token it holds.
package peers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	neturl "net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"stam/internal/config"
	"stam/internal/jsfmt"
)

// The deadlines of src/peers.ts and its callers.
const (
	// DefaultTimeout is a peerCall's, 8 seconds.
	DefaultTimeout = 8 * time.Second
	// FanOutTimeout is a list's call to each peer.
	FanOutTimeout = 4 * time.Second
	// RelayTimeout is a relayed request about an agent on a peer, which may wait out a long spawn.
	RelayTimeout = 660 * time.Second
	// healthTimeout is a start or deploy poll's, and ensureUp's first look.
	healthTimeout = 2 * time.Second
	pollEvery     = 2 * time.Second
)

// Via is the agent a forwarded request acts as (S-239): the agent whose own token the forwarding daemon verified, and
// whether it is that daemon's chief of staff or assistant (the peer can't tell).
type Via struct {
	Agent string
	Boss  bool
	// Assistant: only the assistant kills, renames, reparents or forgets there.
	Assistant bool
	// Scope is the caller's daemon's answer to who owns a branch (S-581): tree, foreign or none. Read only from a peer.
	Scope string
	// ReviewRole is the caller's daemon's answer to what the agent may review (S-1065), sent with a verdict relay and read
	// only from a peer: reviewer, manager or other. OwnBranches are the branches it owns (its worktree's, and stam/<name>);
	// nil is unknown, which a verdict relay refuses. The home can't see a peer's agents.
	ReviewRole  string
	OwnBranches []string
}

// headers are the ones that name the agent a forwarded request acts as; none for a daemon's own calls.
func (v *Via) headers(h http.Header) {
	if v == nil {
		return
	}
	h.Set("x-stam-agent", v.Agent)
	if v.Boss {
		h.Set("x-stam-agent-boss", "1")
	}
	if v.Assistant {
		h.Set("x-stam-agent-assistant", "1")
	}
	if v.Scope != "" {
		h.Set("x-stam-branch-scope", v.Scope)
	}
	if v.ReviewRole != "" {
		h.Set("x-stam-review-role", v.ReviewRole)
		if v.OwnBranches != nil {
			var b bytes.Buffer
			enc := json.NewEncoder(&b)
			enc.SetEscapeHTML(false)
			_ = enc.Encode(v.OwnBranches)
			h.Set("x-stam-own-branches", strings.TrimSuffix(b.String(), "\n"))
		}
	}
}

// Reply is a peer's answer: its status and its JSON body (an empty one is {}).
type Reply struct {
	Status int
	Data   jsfmt.Value
}

// Options is what a Client needs from the daemon.
type Options struct {
	// Settings gives the current settings, whose peers it reads at each call.
	Settings func() config.Settings
	// Machine is this daemon's machine name.
	Machine string
	// Home and Release are STAM_HOME and the release this daemon runs (empty from a checkout): ensureCurrent compares them.
	Home, Release string
	// Getenv reads STAM_PEER_PROBE_MS, STAM_PEER_CHECK_MS, STAM_PEER_START_TIMEOUT_MS, STAM_PEER_DEPLOY_TIMEOUT_MS,
	// STAM_PEER_REFUSAL_MS and STAM_PEER_REFUSAL_MAX_BYTES.
	Getenv func(string) string
	// HTTP is the client for the calls; nil is a client with no timeout of its own (each call has its deadline).
	HTTP *http.Client
	// Own gives this daemon's own tokens (shared, peer and lease), redacted from what a peer says as its own are; nil
	// gives none.
	Own func() []string
}

// Client calls the peers.
type Client struct {
	settings      func() config.Settings
	machine       string
	home, release string
	getenv        func(string) string
	http          *http.Client
	own           func() []string
	probe, check  time.Duration
	// refusalMax and refusalWait bound the refusal body Raw and Stream buffer to redact (S-3994).
	refusalMax  int
	refusalWait time.Duration

	mu       sync.Mutex
	down     map[string]time.Time
	checking map[string]*flight
	starting map[string]*run
	deploys  map[string]*run
	retries  map[string]*retry
}

// flight is a health probe other callers wait on.
type flight struct {
	done chan struct{}
	up   bool
}

// New is a Client. STAM_PEER_PROBE_MS (30000) and STAM_PEER_CHECK_MS (2000) tune the down-marking, as in TS.
func New(o Options) *Client {
	c := &Client{settings: o.Settings, machine: o.Machine, home: o.Home, release: o.Release, getenv: o.Getenv, http: o.HTTP, own: o.Own,
		down: map[string]time.Time{}, checking: map[string]*flight{}, starting: map[string]*run{}, deploys: map[string]*run{}, retries: map[string]*retry{}}
	if c.getenv == nil {
		c.getenv = func(string) string { return "" }
	}
	if c.http == nil {
		c.http = &http.Client{}
	}
	c.probe = c.millis("STAM_PEER_PROBE_MS", 30*time.Second)
	c.check = c.millis("STAM_PEER_CHECK_MS", 2*time.Second)
	// A wait or cap that isn't positive is the default.
	if c.refusalWait = c.millis("STAM_PEER_REFUSAL_MS", 4*time.Second); c.refusalWait <= 0 {
		c.refusalWait = 4 * time.Second
	}
	c.refusalMax = RefusalMax
	if n, err := strconv.Atoi(strings.TrimSpace(c.getenv("STAM_PEER_REFUSAL_MAX_BYTES"))); err == nil && n > 0 {
		c.refusalMax = n
	}
	return c
}

// millis is `Number(process.env.NAME) || fallback`: a number that is not zero, else the fallback.
func (c *Client) millis(name string, fallback time.Duration) time.Duration {
	if n, err := strconv.ParseFloat(strings.TrimSpace(c.getenv(name)), 64); err == nil && n != 0 && n == n {
		return time.Duration(n * float64(time.Millisecond))
	}
	return fallback
}

// Peers is settings.peers.
func (c *Client) Peers() []config.Peer { return c.settings().Peers }

// ByName is the peer with this name.
func (c *Client) ByName(name string) (config.Peer, bool) {
	for _, p := range c.Peers() {
		if p.Name == name {
			return p, true
		}
	}
	return config.Peer{}, false
}

// Machine is this daemon's machine name.
func (c *Client) Machine() string { return c.machine }

// scrub keeps the tokens out of an error: Go's transport does not quote a header, but a peer or a proxy might echo one.
// A connection that failed or ran out of time reads as Node's fetch says it (`fetch failed`, `The operation was aborted due
// to timeout`), which is what a relayed request's 500 shows; the address stays out of it.
func (c *Client) scrub(p config.Peer, err error) error {
	if err == nil {
		return nil
	}
	var ue *neturl.Error
	if errors.As(err, &ue) {
		if errors.Is(err, context.DeadlineExceeded) {
			return errors.New("The operation was aborted due to timeout")
		}
		return errors.New("fetch failed")
	}
	msg := c.redact(p, err.Error())
	if msg == err.Error() {
		return err
	}
	return errors.New(msg)
}

// Redact is msg with the peer's tokens replaced by [redacted]: for text a peer or a proxy wrote, which might echo the
// bearer it got.
func Redact(p config.Peer, msg string) string {
	return redactAll(msg, p.Token.Reveal(), p.PeerToken.Reveal(), p.LeaseToken.Reveal())
}

// redactAll replaces every non-empty token: config accepts a token of any length, so none is too short to guard.
func redactAll(msg string, secrets ...string) string {
	for _, t := range secrets {
		if t != "" {
			msg = strings.ReplaceAll(msg, t, "[redacted]")
		}
	}
	return msg
}

// RedactText is Redact with this daemon's own tokens too, for a peer's answer read outside Call.
func (c *Client) RedactText(p config.Peer, msg string) string { return c.redact(p, msg) }

// RedactAny is msg with every peer's tokens and this daemon's own replaced by [redacted]: for text a client sent that
// names no peer, such as the service worker's failed direct attempt.
func (c *Client) RedactAny(msg string) string {
	for _, p := range c.Peers() {
		msg = Redact(p, msg)
	}
	if c.own != nil {
		msg = redactAll(msg, c.own()...)
	}
	return msg
}

// redact is Redact with this daemon's own tokens too.
func (c *Client) redact(p config.Peer, msg string) string {
	msg = Redact(p, msg)
	if c.own != nil {
		msg = redactAll(msg, c.own()...)
	}
	return msg
}

// reply is a peer's parsed answer. One that isn't a success has its text redacted, every string and key at any depth,
// before a caller logs its error, mails it or answers with it; a success is left as the peer sent it.
func (c *Client) reply(p config.Peer, status int, data jsfmt.Value) Reply {
	if status < 200 || status > 299 {
		data = c.redactValue(p, data)
	}
	return Reply{Status: status, Data: data}
}

func (c *Client) redactValue(p config.Peer, v jsfmt.Value) jsfmt.Value {
	switch v.Kind {
	case jsfmt.String:
		v.Str = c.redact(p, v.Str)
	case jsfmt.Array, jsfmt.Object:
		items := make([]jsfmt.Value, len(v.Items))
		for i, x := range v.Items {
			items[i] = c.redactValue(p, x)
		}
		v.Items = items
		if v.Keys != nil {
			keys := make([]string, len(v.Keys))
			for i, k := range v.Keys {
				keys[i] = c.redact(p, k)
			}
			v.Keys = keys
		}
	}
	return v
}

// url is the peer's base address without one trailing slash, then the path.
func url(p config.Peer, path string) string { return strings.TrimSuffix(p.URL, "/") + path }

// fetch is peerFetch: the call with its deadline over the whole exchange, the peer's token, x-stam-local, x-stam-human
// when the human is relayed, and the headers of the agent it acts for.
func (c *Client) fetch(ctx context.Context, p config.Peer, method, path string, body any, timeout time.Duration, human bool, via *Via) (*http.Response, context.CancelFunc, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	var rd io.Reader
	if body != nil {
		b, err := encode(body)
		if err != nil {
			cancel()
			return nil, nil, err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, url(p, path), rd)
	if err != nil {
		cancel()
		return nil, nil, c.scrub(p, err)
	}
	req.Header.Set("authorization", "Bearer "+p.Bearer())
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-stam-local", "1")
	if human {
		req.Header.Set("x-stam-human", "1")
	}
	via.headers(req.Header)
	res, err := c.http.Do(req)
	if err != nil {
		cancel()
		return nil, nil, c.scrub(p, err)
	}
	return res, cancel, nil
}

func encode(body any) ([]byte, error) {
	switch b := body.(type) {
	case jsfmt.Value:
		return []byte(jsfmt.Compact(b)), nil
	case []byte:
		return b, nil
	}
	return json.Marshal(body)
}

// isDown is whether the peer is marked down.
func (c *Client) isDown(name string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	_, ok := c.down[name]
	return ok
}

func (c *Client) markDown(name string) {
	c.mu.Lock()
	c.down[name] = time.Now().Add(c.probe)
	c.mu.Unlock()
}

func (c *Client) markUp(name string) {
	c.mu.Lock()
	delete(c.down, name)
	c.mu.Unlock()
}

// Up is whether the peer is not marked down.
func (c *Client) Up(name string) bool { return !c.isDown(name) }

// checkUp is whether the peer answers /api/health, shared by callers that arrive while one is in flight. Any answer means
// the peer is back, whatever its status.
func (c *Client) checkUp(p config.Peer) bool {
	c.mu.Lock()
	f, ok := c.checking[p.Name]
	if !ok {
		f = &flight{done: make(chan struct{})}
		c.checking[p.Name] = f
		go func() {
			res, cancel, err := c.fetch(context.Background(), p, http.MethodGet, "/api/health", nil, c.check, false, nil)
			if err == nil {
				res.Body.Close()
				cancel()
				c.markUp(p.Name)
			} else {
				c.markDown(p.Name)
			}
			f.up = err == nil
			c.mu.Lock()
			delete(c.checking, p.Name)
			c.mu.Unlock()
			close(f.done)
		}()
	}
	c.mu.Unlock()
	<-f.done
	return f.up
}

// Call is peerCall. A down peer is probed first, so a slow real call after it comes back still gets its full timeout. A
// call that fails to connect marks the peer down; any answer marks it up.
func (c *Client) Call(ctx context.Context, p config.Peer, method, path string, body any, timeout time.Duration, human bool, via *Via) (Reply, error) {
	if c.isDown(p.Name) && !c.checkUp(p) {
		return Reply{}, fmt.Errorf("%s is unreachable", p.Name)
	}
	res, cancel, err := c.fetch(ctx, p, method, path, body, timeout, human, via)
	if err != nil {
		// A caller that gave up (its request went away) says nothing of the peer; only our own deadline or a failed
		// connection marks it down.
		if ctx.Err() == nil {
			c.markDown(p.Name)
		}
		return Reply{}, err
	}
	defer cancel()
	defer res.Body.Close()
	c.markUp(p.Name)
	text, err := io.ReadAll(res.Body)
	if err != nil {
		return Reply{}, c.scrub(p, err)
	}
	data := jsfmt.Value{Kind: jsfmt.Object}
	if len(text) > 0 {
		v, err := jsfmt.Parse(text)
		if err != nil {
			return Reply{}, fmt.Errorf("%s answered something that is not JSON", p.Name)
		}
		data = v
	}
	return c.reply(p, res.StatusCode, data), nil
}

// Raw is peerRaw: a GET whose reply is streamed on, such as a file's bytes (S-1525). It is the peer's response, or nil
// when the peer is down (a probe first, so a stopped machine answers at once, not after a timeout). The time limit covers
// the connection and the headers only, not the body that follows; the caller closes the body.
func (c *Client) Raw(ctx context.Context, p config.Peer, path string, headers map[string]string, human bool) *http.Response {
	if c.isDown(p.Name) && !c.checkUp(p) {
		return nil
	}
	parent := ctx
	ctx, cancel := context.WithCancel(ctx)
	timer := time.AfterFunc(c.check*2, cancel)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url(p, path), nil)
	if err != nil {
		timer.Stop()
		cancel()
		return nil
	}
	req.Header.Set("authorization", "Bearer "+p.Bearer())
	req.Header.Set("x-stam-local", "1")
	req.Header.Set("accept-encoding", "identity")
	if human {
		req.Header.Set("x-stam-human", "1")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := c.http.Do(req)
	callerGone := parent.Err() != nil
	if !timer.Stop() && err == nil {
		// The timer fired as the headers arrived: the body can no longer be read.
		res.Body.Close()
		err = context.Canceled
	}
	if err != nil {
		cancel()
		if !callerGone {
			c.markDown(p.Name)
		}
		return nil
	}
	c.markUp(p.Name)
	res.Body = &cancelOnClose{res.Body, cancel}
	c.redactRefusal(p, res)
	return res
}

// RefusalMax is the default cap on a refusal body Raw and Stream buffer to redact (STAM_PEER_REFUSAL_MAX_BYTES).
const RefusalMax = 64 << 10

// redactRefusal buffers a refusal's body (a non-2xx answer to Raw or Stream) and redacts it, as Call does a parsed one,
// so a relayed refusal that echoes a token reaches no caller with it (S-3994). A JSON body is parsed, its strings and keys
// redacted, and written again, so a token escaped in it is found too; any other body is redacted as text. Its length is
// recomputed. A body over refusalMax, one not read whole within refusalWait, or one that fails to read is a fixed
// refusal, its status kept: a cut body could still hold the start of a token. A success's bytes (a file, a diff, the
// event stream) are left as they come.
func (c *Client) redactRefusal(p config.Peer, res *http.Response) {
	if res.StatusCode >= 200 && res.StatusCode <= 299 {
		return
	}
	type read struct {
		body []byte
		err  error
	}
	done := make(chan read, 1)
	body := res.Body
	go func() {
		b, err := io.ReadAll(io.LimitReader(body, int64(c.refusalMax)+1))
		done <- read{b, err}
	}()
	timer := time.NewTimer(c.refusalWait)
	defer timer.Stop()
	var out []byte
	select {
	case r := <-done:
		if r.err == nil && len(r.body) <= c.refusalMax {
			out = c.redactBody(p, r.body)
		}
	case <-timer.C:
	}
	// Closing the body ends a read still waiting, and Raw's closer cancels the request.
	body.Close()
	if out == nil {
		out, _ = json.Marshal(map[string]string{"error": fmt.Sprintf("%s refused with %d; its answer was too long or too slow to show safely", p.Name, res.StatusCode)})
		res.Header.Set("content-type", "application/json")
	}
	res.Body = io.NopCloser(bytes.NewReader(out))
	res.ContentLength = int64(len(out))
	res.Header.Set("content-length", strconv.Itoa(len(out)))
}

// redactBody is a refusal's body redacted: a JSON one through its decoded strings and keys, any other as text.
func (c *Client) redactBody(p config.Peer, body []byte) []byte {
	if v, err := jsfmt.Parse(body); err == nil {
		return []byte(jsfmt.Compact(c.redactValue(p, v)))
	}
	return []byte(c.redact(p, string(body)))
}

type cancelOnClose struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (b *cancelOnClose) Close() error {
	err := b.ReadCloser.Close()
	b.cancel()
	return err
}

// Notify is peerNotify: a fire-and-forget note to a peer, such as the settings home's change push (S-390). It never marks
// the peer down or up, so a note sent while a peer is still starting does not hide it from lists.
func (c *Client) Notify(p config.Peer, method, path string, body any, timeout time.Duration) {
	go func() {
		res, cancel, err := c.fetch(context.Background(), p, method, path, body, timeout, false, nil)
		if err == nil {
			res.Body.Close()
			cancel()
		}
	}()
}

// Poll is peerPoll: a background poll, such as the paid-spend refresh (S-395). It never marks the peer down or up.
func (c *Client) Poll(ctx context.Context, p config.Peer, path string, timeout time.Duration) (Reply, error) {
	res, cancel, err := c.fetch(ctx, p, http.MethodGet, path, nil, timeout, false, nil)
	if err != nil {
		return Reply{}, err
	}
	defer cancel()
	defer res.Body.Close()
	text, err := io.ReadAll(res.Body)
	if err != nil {
		return Reply{}, c.scrub(p, err)
	}
	data := jsfmt.Value{Kind: jsfmt.Object}
	if len(text) > 0 {
		if data, err = jsfmt.Parse(text); err != nil {
			return Reply{}, fmt.Errorf("%s answered something that is not JSON", p.Name)
		}
	}
	return c.reply(p, res.StatusCode, data), nil
}

// Stream is peerStream: it pipes a peer's event stream (a GET that stays open) to w until either side closes. It reads
// from the peer only as fast as w takes it. The peer's daemon drops a client that lags too far, and the browser reconnects.
func (c *Client) Stream(r *http.Request, p config.Peer, path string, w http.ResponseWriter, via *Via) error {
	// Its own cancel, so a refusal body too slow to redact stops being read.
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url(p, path), nil)
	if err != nil {
		return c.scrub(p, err)
	}
	req.Header.Set("authorization", "Bearer "+p.Bearer())
	req.Header.Set("x-stam-local", "1")
	via.headers(req.Header)
	up, err := c.http.Do(req)
	if err != nil {
		return c.scrub(p, err)
	}
	up.Body = &cancelOnClose{up.Body, cancel}
	defer up.Body.Close()
	c.redactRefusal(p, up)
	ct := up.Header.Get("content-type")
	if ct == "" {
		ct = "application/json"
	}
	w.Header().Set("content-type", ct)
	w.Header().Set("cache-control", "no-cache")
	w.Header().Set("x-accel-buffering", "no")
	w.WriteHeader(up.StatusCode)
	fl, _ := w.(http.Flusher)
	buf := make([]byte, 32*1024)
	for {
		n, err := up.Body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return nil
			}
			if fl != nil {
				fl.Flush()
			}
		}
		if err != nil {
			return nil
		}
	}
}

// skipDown: lists skip a down peer at once, and start the background probe once its retry time has passed.
func (c *Client) skipDown(p config.Peer) bool {
	c.mu.Lock()
	next, ok := c.down[p.Name]
	_, probing := c.checking[p.Name]
	c.mu.Unlock()
	if !ok {
		return false
	}
	if !next.After(time.Now()) && !probing {
		go c.checkUp(p)
	}
	return true
}

// Reachable is peersReachable: whether every peer answers a health probe now (S-637). Auto-archive judges a thread only
// with the whole inbox in view, so it waits while one is down.
func (c *Client) Reachable() bool {
	var wg sync.WaitGroup
	ok := true
	var mu sync.Mutex
	for _, p := range c.Peers() {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if !c.checkUp(p) {
				mu.Lock()
				ok = false
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	return ok
}

// FanOut is the same GET on every peer, the arrays concatenated. Unreachable peers are skipped. via is the verified agent
// the request acts for (S-259), so each peer checks it too.
func (c *Client) FanOut(ctx context.Context, path string, via *Via) []jsfmt.Value {
	rows, _ := c.FanOutReport(ctx, path, via)
	return rows
}

// FanOutReport is FanOut, also saying whether a peer could not be asked (down, or the request failed) (S-359).
func (c *Client) FanOutReport(ctx context.Context, path string, via *Via) ([]jsfmt.Value, bool) {
	peers := c.Peers()
	rows := make([][]jsfmt.Value, len(peers))
	bad := make([]bool, len(peers))
	var wg sync.WaitGroup
	for i, p := range peers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if c.skipDown(p) {
				bad[i] = true
				return
			}
			r, err := c.Call(ctx, p, http.MethodGet, path, nil, FanOutTimeout, false, via)
			if err != nil {
				bad[i] = true
				return
			}
			if r.Status == 200 && r.Data.Kind == jsfmt.Array {
				rows[i] = r.Data.Items
			}
		}()
	}
	wg.Wait()
	out := []jsfmt.Value{}
	unreachable := false
	for i := range peers {
		out = append(out, rows[i]...)
		unreachable = unreachable || bad[i]
	}
	return out, unreachable
}
