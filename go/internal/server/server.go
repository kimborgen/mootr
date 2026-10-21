// Package server is the daemon's HTTP front (S-2614): the dispatcher src/daemon.ts runs before its route table
// (caller, peer rules, owner checks, the /api/test/* gate), the `{error}` envelope, and the routes ported so far.
//
// Routes register on a net/http ServeMux with Go 1.22 method patterns. A request that matches none, a wrong method
// included, is the TS daemon's 404 `no route METHOD PATH`.
//
// Not yet ported: the static web UI, CORS for a peer's UI (an OPTIONS request is refused, as TS refuses one that isn't
// from a peer's UI), response compression, the ITSA-home proxy (the relay of /api/agents/:id/* to a peer is relay.go), and the
// identity rules of routes not ported yet.
package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	pathpkg "path"
	"regexp"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"time"

	"stam/internal/auth"
	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/decide"
	"stam/internal/lifecycle"
	"stam/internal/peers"
	"stam/internal/requirements"
	"stam/internal/sse"
	"stam/internal/steps"
	"stam/internal/templates"
)

// Server serves the API of one daemon.
type Server struct {
	cfg      config.Config
	settings *config.SettingsFile
	db       *db.DB
	auth     *auth.Auth
	hub      *sse.Hub
	// life runs agents' harnesses; nil in a server without the lifecycle routes' work (they answer 501).
	life *lifecycle.Lifecycle
	mux  *http.ServeMux
	// hosts are the Host headers that name this daemon (src/daemon.ts ownHosts, without the served web origin).
	hosts map[string]bool
	// sends remembers the client_ids of sends (src/client-dedup.ts).
	sends *sendDedup
	// peers calls the other machines' daemons.
	peers *peers.Client
	// steps are the decision steps; decide is the model they ask.
	steps        *steps.Store
	decide       *decide.Client
	requirements *requirements.Store
	// remoteIdx is the copy of the ITSA home's enforced-tools index (steps_remote.go).
	remoteIdx remoteIndex
	// capMu makes the daily cap notice once (requirements_observers.go).
	capMu sync.Mutex
	// permMu runs one permission answer, escalation, dialog report or dialog timeout at a time (permissions.go).
	permMu sync.Mutex
	// noticeHook replaces the notice queue of the lifecycle; a test sees the notices here.
	noticeHook func(agentID, text string)
	// beforeApprove runs in the goroutine of an Approve on a requirement ask before it acts; a test edits the draft there.
	beforeApprove func()
	// afterApprove runs when that goroutine ends, acted or not; a test waits on it instead of on a later request.
	afterApprove func()
	// startApprove runs on the request, just before that goroutine starts; a test counts the handlers that start with it.
	startApprove func()
	// strictLogged is when a would-refuse line was last logged, by request pattern (once a minute each).
	strictMu     sync.Mutex
	strictLogged map[string]time.Time
	// tpl renders the texts the daemon mails (the human's ask on an ITSA); nil in a server that has none, where they
	// answer 501.
	tpl *templates.Set
	// ringHooks are a test's hooks on a ring's submit (ring.Engine Entered and Wrote).
	ringHooks struct{ entered, wrote func(agent string) }
	// procs caches the parse of processes/ (processes.go).
	procs processCache
	// stages is the node each ITSA was last recorded at (process_run.go).
	stages stageMemo
	// live is the state of the runner's live actions (process_live.go).
	runner liveRunner
	// proposals is the process proposals' test hooks (process_proposal.go).
	proposals proposalState
	// bg counts the background goroutines that use the database (StartRequirements and the runner's short actions), so shutdown
	// waits for them before it closes it (WaitBackground).
	bg sync.WaitGroup
	// bgMu and bgWaited guard bg.Add against WaitBackground: once shutdown waits, nothing starts (goBg).
	bgMu     sync.Mutex
	bgWaited bool
}

// UseTemplates gives the server the templates it renders mail texts from.
func (s *Server) UseTemplates(t *templates.Set) { s.tpl = t }

// New returns the server of a config over an open database and an SSE hub, with life running agents' harnesses (nil
// for none).
func New(cfg config.Config, settings *config.SettingsFile, d *db.DB, hub *sse.Hub, life *lifecycle.Lifecycle) *Server {
	s := &Server{
		cfg:      cfg,
		settings: settings,
		db:       d,
		hub:      hub,
		life:     life,
		mux:      http.NewServeMux(),
		hosts:    map[string]bool{},
	}
	if life != nil {
		life.SetMailHuman(s.mailHumanFromStam)
		life.SetTellPeer(s.tellWhere)
		life.SetOwnerStopped(s.ownerStopped)
		life.SetDialogs(s)
	}
	s.peers = peers.New(peers.Options{Settings: settings.Get, Machine: cfg.Machine, Home: cfg.Home, Release: cfg.Release, Getenv: os.Getenv})
	s.decide = decide.New(decide.Options{Settings: settings.Get, Events: d, Home: cfg.Home, Getenv: os.Getenv})
	s.steps = &steps.Store{DB: d, Ask: s.decide}
	s.requirements = &requirements.Store{DB: d, Settings: settings.Get, Person: s.storePerson, Ask: s.decide, Actors: s.steps, IsHome: s.isHome,
		Notify: s.tellViolation, CapNotice: s.capNotice, Demoted: s.tellDemotion}
	s.auth = auth.New(cfg, func(ctx context.Context, hash string) (string, bool, error) {
		a, err := d.AgentByTokenHash(ctx, hash)
		if errors.Is(err, db.ErrNotFound) {
			return "", false, nil
		}
		if err != nil {
			return "", false, err
		}
		return a.ID, true, nil
	})
	port := strconv.Itoa(cfg.Port)
	for _, h := range append([]string{"127.0.0.1", "localhost", "::1"}, cfg.Binds...) {
		s.hosts[strings.ToLower(net.JoinHostPort(h, port))] = true
	}
	s.routes()
	s.wireLive()
	return s
}

func (s *Server) routes() {
	s.handle("GET /api/health", s.health)
	s.handle("GET /api/agents", s.listAgents)
	s.handle("POST /api/agents", s.spawn)
	s.handle("GET /api/agents/{id}", agentPath(s.showAgent))
	s.handle("GET /api/agents/{id}/events", agentPath(s.agentEvents))
	s.mux.Handle("GET /api/agents/{id}/stream", s.stream(s.pushStream))
	for _, action := range []string{"shutdown", "resume", "restart", "compact"} {
		s.handle("POST /api/agents/{id}/"+action, agentPath(s.controlAgent(action)))
	}
	s.handle("POST /api/agents/{id}/kill", agentPath(s.controlAgent("kill")))
	s.handle("POST /api/agents/{id}/forget", agentPath(s.controlAgent("forget")))
	s.handle("POST /api/hook/{harness}/{id}", s.hook)
	s.handle("POST /api/statusline/{harness}/{id}", s.statusline)
	s.mux.Handle("GET /api/live", s.stream(s.live))
	s.waitsRoutes()
	s.mailRoutes()
	s.itsaRoutes()
	s.stepsRoutes()
	s.requirementsRoutes()
	s.permissionRoutes()
}

// agentPath refuses an agent route whose id isn't one TS's ([\w-]+) matches, as no route.
func agentPath(h handler) handler {
	return func(r *http.Request, c auth.Resolved) (any, error) {
		if !agentRef.MatchString(r.PathValue("id")) {
			return nil, Errorf(http.StatusNotFound, "no route %s %s", r.Method, r.URL.Path)
		}
		return h(r, c)
	}
}

// handler is a JSON route: its value is sent with 200, its error as the envelope.
type handler func(r *http.Request, c auth.Resolved) (any, error)

func (s *Server) handle(pattern string, h handler) {
	s.mux.Handle(pattern, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		out, err := h(r, callerFrom(r.Context()))
		if err != nil {
			writeError(w, err)
			return
		}
		if out == nil {
			out = struct{}{}
		}
		writeJSON(w, http.StatusOK, out)
	}))
}

// stream is a route that writes its own response, such as an event stream; an error before it writes is the envelope.
func (s *Server) stream(h func(w http.ResponseWriter, r *http.Request, c auth.Resolved) error) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := h(w, r, callerFrom(r.Context())); err != nil {
			writeError(w, err)
		}
	})
}

// ServeHTTP is src/daemon.ts handler's checks, then the route.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	defer func() {
		if p := recover(); p != nil {
			if p == http.ErrAbortHandler {
				panic(p)
			}
			// The panic's value may hold anything, a header included: log only where it happened.
			slog.Error("handler panic", "method", r.Method, "path", r.URL.Path, "stack", string(debug.Stack()))
			writeError(w, Errorf(http.StatusInternalServerError, "internal error"))
		}
	}()
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	c, err := s.callerOf(r)
	if err != nil {
		writeError(w, err)
		return
	}
	path := r.URL.Path
	if strings.HasPrefix(path, "/api/test/") {
		// Every /api/test/* route (S-1732): only a test daemon has them, and an agent's token never reaches one.
		if !s.cfg.TestHooks {
			writeError(w, Errorf(http.StatusNotFound, "not found"))
			return
		}
		if msg := auth.NotAgentToken(c.Caller, "call the test hooks"); msg != "" {
			writeError(w, Errorf(http.StatusForbidden, "%s", msg))
			return
		}
	}
	// The identity a request claims in its `as` query is checked before anything forwards it (S-238).
	if err := s.resolveQuery(r, c); err != nil {
		writeError(w, err)
		return
	}
	// A request about an agent on another machine goes to the daemon that owns it.
	if s.relay(w, r, c) {
		return
	}
	if err := s.itsaGuards(r, c); err != nil {
		writeError(w, err)
		return
	}
	// The peer hooks of the ITSA home answer only a peer, whatever the method (src/daemon.ts, before its route table).
	if !c.Local && peerHookPath.MatchString(path) {
		writeError(w, Errorf(http.StatusForbidden, "only a peer can call this"))
		return
	}
	// Every ITSA lives on its home daemon; another machine's daemon proxies there.
	if s.itsaHome(w, r, c) {
		return
	}
	// HEAD isn't a route's method in TS, though a Go GET pattern matches it. An unclean path would get ServeMux's 301
	// to the clean one; TS matches the path as sent, so it is no route.
	if _, pattern := s.mux.Handler(r); pattern == "" || r.Method == http.MethodHead || pathpkg.Clean(path) != path {
		writeError(w, Errorf(http.StatusNotFound, "no route %s %s", r.Method, path))
		return
	}
	s.mux.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), callerKey{}, c)))
}

// peerHookPath is the ITSA routes only a peer's daemon calls.
var peerHookPath = regexp.MustCompile(`^/api/itsas/(owner-stopped|unown-agent|join-parent|join|leave|may-participate|incident-marked)$`)

// callerOf is the caller after the peer rules and the owner's checks: a 401 for no credential, a 403 for a forged
// peer header or an owner request from the wrong host or site, or a write without x-stam-human.
func (s *Server) callerOf(r *http.Request) (auth.Resolved, error) {
	verified, err := s.auth.CallerOf(r)
	if err != nil {
		return auth.Resolved{}, err
	}
	c, err := auth.Resolve(verified, r.Header)
	if errors.Is(err, auth.ErrPeerHeaders) {
		return auth.Resolved{}, Errorf(http.StatusForbidden, "%s", err.Error())
	}
	if err != nil {
		return auth.Resolved{}, err
	}
	if c.Kind == auth.None {
		return auth.Resolved{}, Errorf(http.StatusUnauthorized, "bad token")
	}
	// Without a token the browser's identity is the only credential, and a page on any site could use it (S-414).
	if c.Kind == auth.Owner {
		write := r.Method != http.MethodGet && r.Method != http.MethodHead
		if !s.hosts[strings.ToLower(r.Host)] {
			return auth.Resolved{}, Errorf(http.StatusForbidden, "a request without a token must name this daemon as its host")
		}
		if origin := strings.ToLower(r.Header.Get("Origin")); origin != "" && !s.sameOrigin(origin) {
			return auth.Resolved{}, Errorf(http.StatusForbidden, "a request from another site needs a token")
		}
		if write && r.Header.Get("X-Stam-Human") != "1" {
			return auth.Resolved{}, Errorf(http.StatusForbidden, "a write needs the x-stam-human header")
		}
	}
	return c, nil
}

// sameOrigin is whether a browser's Origin is one of this daemon's own hosts (src/daemon.ts sameOrigin, without the
// served web origin).
func (s *Server) sameOrigin(origin string) bool {
	host, ok := strings.CutPrefix(origin, "http://")
	if !ok {
		host, ok = strings.CutPrefix(origin, "https://")
	}
	return ok && s.hosts[host]
}

type callerKey struct{}

func callerFrom(ctx context.Context) auth.Resolved {
	c, _ := ctx.Value(callerKey{}).(auth.Resolved)
	return c
}

// Error is a failing route's status and message, sent as the `{error}` envelope (api/schemas/Error.yaml) with Extra's
// fields beside it, as src/daemon.ts HttpError's extra.
type Error struct {
	Status  int
	Message string
	Extra   map[string]any
}

func (e *Error) Error() string { return e.Message }

// Errorf is an Error with a formatted message.
func Errorf(status int, format string, args ...any) *Error {
	return &Error{Status: status, Message: fmt.Sprintf(format, args...)}
}

// HumanOnMachine is the 409 refusal of a human-only write that belongs to another machine's UI
// (api/schemas/HumanOnMachineRefusal.yaml, src/daemon.ts relayHuman); origin is that machine's serve origin, or nil.
func HumanOnMachine(message, machine string, origin *string) *Error {
	return &Error{Status: http.StatusConflict, Message: message, Extra: map[string]any{
		"refusal": "human-on-machine",
		"machine": machine,
		"origin":  origin,
	}}
}

// writeError sends err as the envelope: an *Error with its status, anything else as a 500 with its message, as TS
// does. No error built in this daemon carries a token.
func writeError(w http.ResponseWriter, err error) {
	var e *Error
	if !errors.As(err, &e) {
		e = &Error{Status: http.StatusInternalServerError, Message: err.Error()}
	}
	body := map[string]any{}
	for k, v := range e.Extra {
		body[k] = v
	}
	body["error"] = e.Message
	writeJSON(w, e.Status, body)
}

// stringify writes JSON as JSON.stringify does: <, > and & as they are, and U+2028 and U+2029 as characters. Go's
// encoder escapes all of them, the last two even with HTML escaping off, so those are put back (an escaped backslash
// before `u2028` is the text, not an escape).
func stringify(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	b := bytes.TrimSuffix(buf.Bytes(), []byte("\n"))
	var out []byte
	for i := 0; i < len(b); i++ {
		if b[i] == '\\' {
			if b[i+1] == 'u' && i+6 <= len(b) && (string(b[i+2:i+6]) == "2028" || string(b[i+2:i+6]) == "2029") {
				if string(b[i+2:i+6]) == "2028" {
					out = append(out, " "...)
				} else {
					out = append(out, " "...)
				}
				i += 5
				continue
			}
			// Any other escape keeps its second byte, so `\\` is never read as the start of ` `.
			out = append(out, b[i], b[i+1])
			i++
			continue
		}
		out = append(out, b[i])
	}
	return out, nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	b, err := stringify(v)
	if err != nil {
		slog.Error("response: marshal failed", "err", err)
		status, b = http.StatusInternalServerError, []byte(`{"error":"internal error"}`)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if _, err := w.Write(b); err != nil {
		slog.Debug("response: write failed", "err", err)
	}
}
