// Package server is the daemon's HTTP front (S-2614): the dispatcher src/daemon.ts runs before its route table
// (caller, peer rules, owner checks, the /api/test/* gate), the `{error}` envelope, and the routes ported so far.
//
// Routes register on a net/http ServeMux with Go 1.22 method patterns. A request that matches none, a wrong method
// included, is the TS daemon's 404 `no route METHOD PATH`.
//
// The relay of /api/agents/:id/* to a peer and the ITSA-home proxy are relay.go; a peer's web UI is peer_ui.go. Not yet
// ported: the identity rules of routes not ported yet.
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
	"path/filepath"
	"regexp"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"time"

	"stam/internal/agentview"
	"stam/internal/auth"
	"stam/internal/catalog"
	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/decide"
	"stam/internal/diff"
	"stam/internal/events"
	"stam/internal/ghpoll"
	"stam/internal/instructions"
	"stam/internal/layout"
	"stam/internal/lifecycle"
	"stam/internal/linearpoll"
	"stam/internal/llm"
	"stam/internal/localhuman"
	"stam/internal/mcpauth"
	"stam/internal/mcpservers"
	"stam/internal/peers"
	"stam/internal/requirements"
	srch "stam/internal/search"
	"stam/internal/skills"
	"stam/internal/sse"
	"stam/internal/steps"
	"stam/internal/templates"
	"stam/internal/tiny"
	"stam/internal/tmux"
)

// Server serves the API of one daemon.
type Server struct {
	cfg      config.Config
	settings *config.SettingsFile
	db       *db.DB
	auth     *auth.Auth
	// login is the local human login's codes and sessions (local_human.go).
	login *localhuman.Login
	hub   *sse.Hub
	// life runs agents' harnesses; nil in a server without the lifecycle routes' work (they answer 501).
	life *lifecycle.Lifecycle
	mux  *http.ServeMux
	// patterns is every pattern handle registered: the route table a test walks (every write route is one of them).
	patterns []string
	// treeLookup, when set, stands in for the agent lookup of usageTree (usagescope.go): a test's failing lookup, or
	// one that picks a row.
	treeLookup func(ctx context.Context, ref string) (db.Agent, error)
	// usageItsaCheck, when set, stands in for mayReadItsaThreads in the usage routes' ITSA scoping (usage.go): a test's
	// failing check.
	usageItsaCheck func(ctx context.Context, me, key string) (bool, error)
	// usageVisible, when set, stands in for visibleAgents in the series and scope routes (usage.go): a test's failing
	// lookup.
	usageVisible func(ctx context.Context, me string) (map[string]bool, error)
	// hosts are the loopback and bound Host headers that name this daemon; ownHost adds the canonical web origin's.
	hosts map[string]bool
	// tailnet is this tailnet's nodes, for a peer's UI origins (peer_ui.go).
	tailnet tailnetCache
	// sends remembers the client_ids of sends (src/client-dedup.ts).
	sends *sendDedup
	// peers calls the other machines' daemons.
	peers *peers.Client
	// outbox runs one delivery pass of the peer outbox at a time (outbox.go).
	outbox outboxPass
	// mcp is the MCP logins and bearers (mcp_routes.go).
	mcp *mcpauth.Auth
	// secrets is the home's secret store (secrets_routes.go).
	secrets *config.Secrets
	// mcpRegistry browses the public MCP registry, with its page cache (mcp_config_routes.go).
	mcpRegistry *mcpservers.Registry
	// openRouter is OpenRouter's model catalogue, kept for six hours (catalog_routes.go).
	openRouter *catalog.OpenRouter
	// skills imports, updates and checks Settings › Skills' skills (skills_routes.go).
	skills *skills.Importer
	// llm is stam's own model calls; tiny the tiny-model steps that ask through it (tiny_routes.go).
	llm  *llm.Layer
	tiny *tiny.Steps
	// web is the canonical web origin as the last discovery left it (web_origin.go).
	web struct {
		mu     sync.Mutex
		base   string
		served bool
	}
	// steps are the decision steps; decide is the model they ask.
	steps        *steps.Store
	decide       *decide.Client
	requirements *requirements.Store
	// events stores external events and delivers them (events.go).
	events *events.Service
	// github is the GitHub poller (github.go), set by StartEvents.
	github *ghpoll.Poller
	// linear is the Linear poller (linear.go), set by StartEvents.
	linear *linearpoll.Poller
	// remoteIdx is the copy of the ITSA home's enforced-tools index (steps_remote.go).
	remoteIdx remoteIndex
	// capMu makes the daily cap notice once (requirements_observers.go).
	capMu sync.Mutex
	// permMu runs one permission answer, escalation, dialog report or dialog timeout at a time (permissions.go).
	permMu sync.Mutex
	// inputs is the state of suggested input (inputs.go); inputExpect how long a typed one has to show as submitted.
	inputs      inputState
	inputExpect time.Duration
	// bashExpect is how long a typed bash-mode command has to show in the transcript: Claude Code records it when the
	// command finishes (S-3188), so it is far longer than inputExpect.
	bashExpect time.Duration
	// noticeHook replaces the notice queue of the lifecycle; a test sees the notices here.
	noticeHook func(agentID, text string)
	// askMailHook runs once an ask's row exists and before its mail is stored (permissions.go); a test closes the request here.
	askMailHook func(requestID string)
	// liveReviewersHook replaces the lookup of an agent's live reviewers (permissions.go); a test counts the lookups here.
	liveReviewersHook func(ctx context.Context, a db.Agent) ([]string, error)
	// mailIDHook replaces db.NewMailID for a send's own id (send.go); a test draws ids that collide here.
	mailIDHook func() string
	// forwardedIDs holds a forwarded mail's id from the check whether it is here to its store (send.go).
	forwardedIDs idLocks
	// forwardStoreHook runs in a forwarded mail's send after its files are written and before it is stored; a test
	// holds one arrival there.
	forwardStoreHook func(id string)
	// beforeApprove runs in the goroutine of an Approve on a requirement ask before it acts; a test edits the draft there.
	beforeApprove func()
	// devSlots holds the developer spawns in flight (spawn_worktree.go).
	devSlots devSlots
	// beforeShare, when set, runs in a workspace share between reading the grantee and the write: a test lands a cost
	// switch there.
	beforeShare func()
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
	// prompts renders the system prompt's parts for the Instructions view, the inventory and a launch (prompts.go); nil
	// with no templates.
	prompts *instructions.Prompts
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
	// switched is the cost switches' hand-offs to the ITSA home still owed (costswitch.go).
	switched switchedState
	// unowns is the retry of the unowns sent to the ITSA home off it (itsa_unown.go).
	unowns unownRetry
	// tests is the /api/test/* routes' state (testhooks.go).
	tests testHooks
	// autoArch is the auto-archive pass's timer state (autoarchive.go).
	autoArch autoArchiver
	// index is the embedding index search by meaning reads (search.go); StartSearchIndex runs its worker.
	index *srch.Index
	// costBad is the invalid cost config mailed to the human (config_routes.go).
	costBad costInvalid
	// sharedSync is the settings sync between the home and its peers (settings_sync.go).
	sharedSync settingsSync
	// machines samples this machine's load (machines.go).
	machines sampler
	// cos keeps the chief of staff to one (cos.go).
	cos cosState
	// assets caches the web UI's files (static.go).
	assets assetCache
	// layout is the human's layout (layout_routes.go); layoutDone ends its streams, once StartLayout has run.
	layout     *layout.Store
	layoutDone <-chan struct{}
	// diffs is the PR diff cache (diff_routes.go).
	diffs *diff.Service
	// views is stam's own view of each agent (view_routes.go); StartViews ends its streams.
	views *agentview.Service
	// ocView is OpenCode's view source, told of the shared server's events (viewEvent).
	ocView *agentview.OpenCode
	// tmux is this daemon's tmux socket, for the human's terminals (shells_routes.go, tty.go).
	tmux *tmux.Client
	// tickets and terms are the terminal sockets' tickets and viewers (tty.go).
	tickets tickets
	terms   terminals

	// senderPeerFor, set by a test, stands in for the peer token S-4127 adds: the peer that made a call (senderPeer).
	senderPeerFor func(auth.Resolved) (string, bool)
	// peerAgentByID, set by a test, stands in for db.PeerAgentByID in peerSent (a lookup that fails).
	peerAgentByID func(context.Context, string) (db.PeerAgentRef, bool, error)
}

// UseTemplates gives the server the templates it renders mail texts and the system prompt's parts from, and the
// lifecycle the parts of a launch's system prompt.
func (s *Server) UseTemplates(t *templates.Set) {
	s.tpl = t
	s.prompts = s.newPrompts(t)
	if s.life != nil {
		s.life.SetPrompts(launchPrompts{s})
	}
}

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
		tmux:     &tmux.Client{Socket: cfg.TmuxSocket},
		hosts:    map[string]bool{},

		inputExpect: 60 * time.Second,
		bashExpect:  15 * time.Minute,
	}
	if life != nil {
		life.SetMailHuman(s.mailHumanFromStam)
		life.SetTellPeer(s.tellWhere)
		life.SetOwnerStopped(s.ownerStopped)
		life.SetUnown(s.unownAgent)
		life.SetStartingDead(s.ringMemberDead)
		life.SetSwitchedItsas(s.handOffSwitchedItsas)
		life.SetDialogs(s)
		life.SetOpenCodeViewer(s.viewEvent)
		life.SetInputs(s)
		life.SetSystemMail(s.sendFromSystem)
		life.SetCostMail(s.sendFromSystemMail, s.withdrawQuietly)
		life.SetAgentGone(s.eventsAgentGone)
	}
	s.peers = peers.New(peers.Options{Settings: settings.Get, Machine: cfg.Machine, Home: cfg.Home, Release: cfg.Release, Getenv: os.Getenv, Own: ownTokens(cfg)})
	s.index = s.newIndex()
	if life != nil {
		life.SetPeerReadings(peerReadings{s})
		life.SetPeerSpend(peerReadings{s})
	}
	s.secrets = config.NewSecrets(cfg.Home, os.Getenv)
	s.mcpRegistry = mcpservers.NewRegistry(func() string { return getenvStam("MCP_REGISTRY_URL") })
	s.openRouter = catalog.NewOpenRouter(func() string { return getenvStam("OPENROUTER_URL") })
	// file:// skill sources are for a test daemon only (STAM_TEST_ALLOW_FILE_SKILLS in a test home).
	s.skills = skills.NewImporter(skillPaths(cfg.Home), cfg.TestHome && getenvStam("TEST_ALLOW_FILE_SKILLS") != "")
	s.mcp = mcpauth.New(mcpauth.Options{Home: cfg.Home, Machine: cfg.Machine, Settings: settings.Get, Insecure: mcpAuthInsecure(os.Getenv), HomeGet: s.mcpHomeGet, Secrets: s.secrets})
	s.decide = decide.New(decide.Options{Settings: settings.Get, Events: d, Home: cfg.Home, Getenv: os.Getenv, Held: s.decideHeld, LedgerChanged: s.ledgerChanged})
	s.llm = llm.New(llm.Options{Settings: settings.Get, Registry: s.registry, Events: d, Home: cfg.Home, Getenv: os.Getenv})
	s.tiny = tiny.New(tiny.Options{LLM: s.llm, Settings: settings.Get, Store: d, Held: s.decideHeld, LedgerChanged: s.ledgerChanged})
	settings.OnChange(s.tiny.Refresh)
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
	// The start on the clock a code's ctime is stamped with, so a code made just after it is never older.
	s.login = localhuman.New(cfg, localhuman.KernelNow())
	s.auth.LocalHuman = s.localHuman
	// The sessions end the moment the setting is seen off: a write here, or the next read of a hand edit, not only the
	// next request that carries one.
	settings.OnReload(s.noteLocalHuman)
	port := strconv.Itoa(cfg.Port)
	for _, h := range append([]string{"127.0.0.1", "localhost", "::1"}, cfg.Binds...) {
		s.hosts[strings.ToLower(net.JoinHostPort(h, port))] = true
	}
	s.layout = layout.Open(cfg.Home)
	s.events = s.newEventsService()
	s.routes()
	s.wireLive()
	return s
}

func (s *Server) routes() {
	s.handle("GET /api/health", s.health)
	s.handle("GET /api/agents", s.listAgents)
	s.handle("POST /api/agents", s.spawn)
	s.handle("POST /api/register", s.register)
	s.handle("GET /api/agents/{id}", agentPath(s.showAgent))
	s.handle("GET /api/agents/{id}/events", agentPath(s.agentEvents))
	s.mux.Handle("GET /api/agents/{id}/stream", s.stream(s.pushStream))
	s.controlRoutes()
	s.cosRoutes()
	s.retroDigestRoutes()
	s.agentMiscRoutes()
	s.promptRoutes()
	s.handle("POST /api/hook/{harness}/{id}", s.hook)
	s.handle("POST /api/notices/{id}/ack/{row}", s.noticeAck)
	s.pluginRoutes()
	s.handle("POST /api/statusline/{harness}/{id}", s.statusline)
	s.handle("GET /api/usage", s.usageSummary)
	s.handle("GET /api/usage/issues", s.usageIssues)
	s.handle("GET /api/usage/readings", s.usageReadings)
	s.handle("GET /api/usage/scope", s.usageScope)
	s.handle("GET /api/usage/series", s.usageSeries)
	s.handle("GET /api/usage/spend", s.usageSpend)
	s.handle("POST /api/cost/ack", s.costAck)
	s.handle("POST /api/cost/pause", s.costPause)
	s.handle("POST /api/cost/switch", s.costSwitch)
	s.handle("GET /api/cost/allocations", s.costAllocations)
	s.handle("POST /api/cost/allocate", s.costAllocate)
	s.machineRoutes()
	s.slotQueueRoutes()
	s.mux.Handle("GET /api/live", s.stream(s.live))
	s.waitsRoutes()
	s.workspaceShareRoutes()
	s.mailRoutes()
	s.pushRoutes()
	s.searchRoutes()
	s.itsaRoutes()
	s.eventsRoutes()
	s.githubRoutes()
	s.stepsRoutes()
	s.requirementsRoutes()
	s.permissionRoutes()
	s.mcpRoutes()
	s.mcpConfigRoutes()
	s.catalogRoutes()
	s.permissionModesRoutes()
	s.skillsRoutes()
	s.tinyRoutes()
	s.configRoutes()
	s.secretsRoutes()
	s.testRoutes()
	s.layoutRoutes()
	s.filesRoutes()
	s.diffRoutes()
	s.viewRoutes()
	s.shellRoutes()
	s.ticketRoutes()
	s.voiceRoutes()
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
	s.patterns = append(s.patterns, pattern)
	s.mux.Handle(pattern, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		out, err := h(r, callerFrom(r.Context()))
		if err != nil {
			writeError(w, err)
			return
		}
		if out == nil {
			out = struct{}{}
		}
		if ws, ok := out.(withStatus); ok {
			writeJSON(w, ws.status, ws.body)
			return
		}
		writeJSON(w, http.StatusOK, out)
	}))
}

// withStatus is a route's answer sent with a status other than 200, such as a settings ask's 202.
type withStatus struct {
	status int
	body   any
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
func (s *Server) ServeHTTP(rw http.ResponseWriter, r *http.Request) {
	// A protocol switch is Node's 'upgrade' event, before any route: only a terminal socket is taken (tty.go).
	if isUpgrade(r) {
		s.ttyUpgrade(rw, r)
		return
	}
	// The web UI's own files are public and answered first, compressed as they are cached.
	if s.serveStatic(rw, r) {
		return
	}
	// A JSON answer, an error included, is compressed when the client takes it (src/compress.ts).
	cw := &jsonCompressor{ResponseWriter: rw, r: r}
	// Under auth.humanStrict the CLI is never the human; a refusal tells it where to answer (S-543).
	if s.settings.Get().Auth.HumanStrict && r.Header.Get("X-Stam-Human") == "1" && !s.auth.TrustedHuman(r) {
		cw.hint = "answer from stam's web UI"
	}
	// A refused request that claims the human, directly from this machine with local login on, is told a local login is
	// there, so a `stam web` token link's page offers it (src/daemon.ts, S-2121).
	if r.Header.Get("X-Stam-Human") == "1" {
		cw.localLogin = func() bool {
			return s.settings.Get().Auth.LocalHuman && runtime.GOOS == "linux" && localhuman.Direct(r) && !s.auth.TrustedHuman(r)
		}
	}
	var w http.ResponseWriter = cw
	defer func() {
		if p := recover(); p != nil {
			if p == http.ErrAbortHandler {
				panic(p)
			}
			// The panic's value may hold anything, a header included: log only where it happened.
			slog.Error("handler panic", "method", r.Method, "path", r.URL.Path, "stack", string(debug.Stack()))
			writeError(w, Errorf(http.StatusInternalServerError, "internal error"))
		}
		cw.finish()
	}()
	// A browser asks before a peer's UI writes here (S-414, S-544): only the configured peers' UI origins, only for the
	// writes a peer's UI may make; anything else gets no CORS headers.
	peerUI := s.peerUIOrigin(r)
	if r.Method == http.MethodOptions {
		s.preflight(w, r, peerUI)
		return
	}
	if peerUI != "" {
		w.Header().Set("Access-Control-Allow-Origin", peerUI)
		w.Header().Set("Vary", "origin")
		r = r.WithContext(context.WithValue(r.Context(), peerUIKey{}, true))
	}
	// The local human login and logout come before any credential check: the page has none yet (S-613).
	if r.URL.Path == "/api/human/login" || r.URL.Path == "/api/human/logout" {
		out, err := s.localHumanRoute(r)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, out)
		return
	}
	// The peer's MCP lease has its own bearer, the lease token, so it is answered before the caller logic (S-3176).
	if strings.HasPrefix(r.URL.Path, "/api/peer/mcp/") {
		s.peerLeaseRoute(w, r)
		return
	}
	c, err := s.callerOf(r)
	if err != nil {
		writeError(w, err)
		return
	}
	// A request the old rule calls the human and the human's proof doesn't back is logged once a minute per path, so
	// auth.humanStrict can be turned on knowing what it would refuse (src/daemon.ts logWouldRefuse, S-2159).
	if notAgent := c.Kind != auth.Agent && c.Kind != auth.OpenCode; notAgent && r.Header.Get("X-Stam-Human") == "1" && !c.Owned {
		s.logWouldRefuse(r, c.Kind)
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
	// TS routes every /api/agents/ path by [\w-]+ segments of the path as sent, so a percent-encoded or other character
	// is no route there. Here ServeMux would decode it and reach a handler the acting gate below didn't match (S-4237),
	// so it is no route here too, before anything reads the path.
	if esc := r.URL.EscapedPath(); strings.HasPrefix(esc, "/api/agents/") && !agentPathChars.MatchString(esc) {
		writeError(w, Errorf(http.StatusNotFound, "no route %s %s", r.Method, esc))
		return
	}
	// The identity a request claims in its body, then in its `as` query, is checked before anything forwards it (S-238),
	// once for every route (S-3795): no route resolves its own, so none can forget it.
	if err := s.resolveBody(r, c); err != nil {
		writeError(w, err)
		return
	}
	if err := s.resolveQuery(r, c); err != nil {
		writeError(w, err)
		return
	}
	// The mailbox and wait routes act as the agent in the path, so they are checked here, for every such route and
	// before a request is relayed or routed (S-242, S-4237): the relay looks only at paths with one segment after the id.
	if id, ok := matchActing(r.Method, r.URL.Path); ok {
		if err := s.mayActAs(r.Context(), c.Caller, id, false); err != nil {
			writeError(w, err)
			return
		}
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

// wouldRefuseID is the ids a would-refuse line hides: hex ids of 6 or more digits, and ITSA keys.
var wouldRefuseID = regexp.MustCompile(`/[0-9a-f]{6,}(/|$)|/S-\d+`)

func (s *Server) logWouldRefuse(r *http.Request, kind auth.Kind) {
	pattern := wouldRefuseID.ReplaceAllStringFunc(r.URL.Path, func(m string) string {
		if strings.HasSuffix(m, "/") {
			return "/:id/"
		}
		return "/:id"
	})
	key := r.Method + " " + pattern
	s.logOnce(key, func(prefix string) string {
		return prefix + ": " + key + " as human from a " + string(kind) + " caller (not trustedHuman)"
	})
}

// mediaPath is an attachment's download, which may carry the shared token as ?token= (src/daemon.ts mediaToken).
var mediaPath = regexp.MustCompile(`^/api/mail/[\w-]+/attachments/`)

// agentPathChars is the characters TS's /api/agents/ routes match in the path as sent: word characters, '-' and '/'.
var agentPathChars = regexp.MustCompile(`^[\w/-]*$`)

// peerHookPath is the ITSA routes only a peer's daemon calls.
var peerHookPath = regexp.MustCompile(`^/api/itsas/(owner-stopped|unown-agent|switch-owner|join-parent|join|leave|may-participate|incident-marked)$`)

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
	// The human's proof, whatever token comes with it; never with an agent's or the OpenCode server's token, nor on a
	// peer's daemon-to-daemon call (which a peer's forwarded agent always is). x-stam-local is never Owned, even with
	// no token: a deliberate fail-closed narrowing against TS, whose test-key and tailscale paths ignore the header,
	// since no real caller sends it without a token (peers send theirs; browsers never send the header).
	c.Owned = s.auth.TrustedHuman(r) && !verified.IsAgent() && r.Header.Get("X-Stam-Local") != "1"
	// Video, audio and PDF players can't send a header, so an attachment may carry the token in its URL instead.
	mediaToken := r.Method == http.MethodGet && mediaPath.MatchString(r.URL.Path) && s.auth.IsShared(r.URL.Query().Get("token"))
	// The OAuth callback is a browser redirect, not an API call: its single-use state is its protection (mcpauth).
	oauthCallback := r.Method == http.MethodGet && r.URL.Path == "/oauth/callback"
	if c.Kind == auth.None && r.Header.Get("Authorization") == "" && r.Header.Get("Origin") != "" && r.Method != http.MethodGet {
		s.logDirectRefused(r, "")
	}
	peerUI := fromPeerUI(r)
	if c.Kind == auth.None && peerUI {
		if matchUI(peerUIHumanRoutes, r.Method, r.URL.Path) {
			return auth.Resolved{}, Errorf(http.StatusForbidden, "only the human can do this, through %s's page (tailscale serve)", s.cfg.Machine)
		}
		return auth.Resolved{}, Errorf(http.StatusForbidden, "only the human can change shared settings, through %s's page (tailscale serve)", s.cfg.Machine)
	}
	if c.Kind == auth.None && !mediaToken && !oauthCallback {
		return auth.Resolved{}, Errorf(http.StatusUnauthorized, "bad token")
	}
	// Without a token the browser's identity is the only credential, and a page on any site could use it (S-414). A
	// request from another site is refused, except a peer's UI on its routes; a write must carry x-stam-human, which no
	// plain form or simple request can, and from a peer's UI it must be JSON.
	if c.Kind == auth.Owner {
		write := r.Method != http.MethodGet && r.Method != http.MethodHead
		refuse := func(status int, why, msg string) (auth.Resolved, error) {
			if r.Header.Get("Origin") != "" && write {
				s.logDirectRefused(r, why)
			}
			return auth.Resolved{}, Errorf(status, "%s", msg)
		}
		if !s.ownHost(r.Host) {
			return refuse(http.StatusForbidden, "host: "+orDash(r.Host)+" is not this daemon's", "a request without a token must name this daemon as its host")
		}
		if origin := strings.ToLower(r.Header.Get("Origin")); origin != "" && !s.sameOrigin(origin) && !peerUI {
			return refuse(http.StatusForbidden, "origin: "+r.Header.Get("Origin")+" is not a peer UI for this route", "a request from another site needs a token")
		}
		if write && r.Header.Get("X-Stam-Human") != "1" {
			return refuse(http.StatusForbidden, "x-stam-human header missing", "a write needs the x-stam-human header")
		}
		if peerUI && !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			return refuse(http.StatusUnsupportedMediaType, "content-type is not JSON", "a write from a peer must be JSON")
		}
	}
	return c, nil
}

// directPath is the part of a path logDirectRefused hides: the first permission or agent id.
var directPath = regexp.MustCompile(`/(permissions|agents)/[^/]+`)

// logDirectRefused is src/daemon.ts logDirectRefused: a token-less request from a browser that was refused (S-426),
// invisible otherwise, logged once a minute per method and kind of reason. why is the check that failed; empty, it is
// why the request isn't the human's. No credential is in the line: the path's query is cut.
func (s *Server) logDirectRefused(r *http.Request, why string) {
	if why == "" {
		why = "trusted"
		if !s.auth.TrustedHuman(r) {
			why = "not trustedHuman: the Go daemon proves the human by the test key or a local login only"
		}
	}
	kind, _, _ := strings.Cut(why, ":")
	path := r.URL.Path
	if loc := directPath.FindStringSubmatchIndex(path); loc != nil {
		path = path[:loc[0]] + "/" + path[loc[2]:loc[3]] + "/:id" + path[loc[1]:]
	}
	s.logOnce("direct refused "+r.Method+" "+kind, func(string) string {
		return "direct request refused: " + r.Method + " " + path + " origin=" + orDash(r.Header.Get("Origin")) + ": " + why
	})
}

func orDash(v string) string {
	if v == "" {
		return "-"
	}
	return v
}

// sameOrigin is whether a browser's Origin is this daemon's own page (src/daemon.ts sameOrigin): the canonical web
// origin, or one of its own hosts.
func (s *Server) sameOrigin(origin string) bool {
	if origin == strings.ToLower(s.canonicalWebOrigin()) {
		return true
	}
	host, ok := strings.CutPrefix(origin, "http://")
	if !ok {
		host, ok = strings.CutPrefix(origin, "https://")
	}
	return ok && s.ownHost(host)
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
	if cw, ok := w.(*jsonCompressor); ok && cw.hint != "" && e.Status == http.StatusForbidden {
		body["hint"] = cw.hint
	}
	if cw, ok := w.(*jsonCompressor); ok && cw.localLogin != nil && e.Status == http.StatusForbidden && cw.localLogin() {
		body["localLogin"] = true
	}
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

// ownTokens gives this daemon's own tokens, which the peer client redacts from a peer's refusal (S-3994): the shared
// token, the peer token, and the lease token, read when asked so a rotation counts at once.
func ownTokens(cfg config.Config) func() []string {
	return func() []string {
		lease, _ := os.ReadFile(filepath.Join(cfg.Home, "mcp-lease-token"))
		return []string{cfg.Token.Reveal(), cfg.PeerToken.Reveal(), strings.TrimSpace(string(lease))}
	}
}
