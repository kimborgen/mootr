package server

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	neturl "net/url"
	"os/exec"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"stam/internal/clock"
)

// A peer's web UI writes to another daemon straight from the browser (src/web-origins.ts, S-414, S-544): shared
// settings, agent types and the instructions for all agents to the settings home, and the human's writes for a
// machine's own agents, permission requests and ITSAs to that machine. The daemon checks the human's proof as for its
// own page. The origins a peer's UI may have come from this daemon's own settings and from tailscale, never from a
// request or a peer's answer, so an agent can't add one.

type uiRoute struct {
	method string
	path   *regexp.Regexp
}

// peerUIRoutes are the cross-origin writes a peer's UI may make on the settings home, and nothing else.
var peerUIRoutes = []uiRoute{
	{"PATCH", regexp.MustCompile(`^/api/config/settings$`)},
	{"POST", regexp.MustCompile(`^/api/config/instructions$`)},
	{"POST", regexp.MustCompile(`^/api/types/[\w-]+$`)},
	{"DELETE", regexp.MustCompile(`^/api/types/[\w-]+$`)},
	// A type's template is the home's (S-417, S-3079): a peer that knows the home's page saves it there.
	{"POST", regexp.MustCompile(`^/api/templates/type-[\w-]+$`)},
}

// peerUIHumanRoutes are the human's writes on a machine other than the one the page came from (S-544): any daemon
// answers them, not just the settings home.
var peerUIHumanRoutes = []uiRoute{
	{"POST", regexp.MustCompile(`^/api/permissions/[\w-]+/answer$`)},
	{"POST", regexp.MustCompile(`^/api/itsas/[\w-]+/(act|post)$`)},
	{"PATCH", regexp.MustCompile(`^/api/itsas/[\w-]+$`)},
	{"POST", regexp.MustCompile(`^/api/agents/[\w-]+/(pause|unpause|shutdown|archive|resume|restart|reconnect-mcp|compact|adopt|set-visibility|set-child-notices|set-parent|rename|chief-of-staff|kill|forget|prompt|permission-mode)$`)},
}

func matchUI(routes []uiRoute, method, path string) bool {
	return slices.ContainsFunc(routes, func(u uiRoute) bool { return u.method == method && u.path.MatchString(path) })
}

// tailnetNode is a node of `tailscale status --json`.
type tailnetNode struct {
	DNSName      string
	TailscaleIPs []string
}

// tailnetCache is this tailnet's other nodes, read at most once a minute, by one read at a time.
type tailnetCache struct {
	mu   sync.Mutex
	at   time.Time
	list []tailnetNode
	// done is the running read's, closed once it stored its list; nil when none runs.
	done chan struct{}
}

// tailscaleStatus is `tailscale status --json`, or nil without tailscale or when ctx ends first. A test swaps it.
var tailscaleStatus = func(ctx context.Context) []byte {
	if _, err := exec.LookPath("tailscale"); err != nil {
		return nil
	}
	out, _ := exec.CommandContext(ctx, "tailscale", "status", "--json").Output()
	return out
}

// tailnetTimeout bounds one read of the tailnet, as TS's spawnSync timeout does.
var tailnetTimeout = 3 * time.Second

// tailnetWaiting is called when a request starts waiting on a read. A test waits on it.
var tailnetWaiting = func() {}

// tailnetNodes is src/web-origins.ts tailnetNodes: the last list read while it is under a minute old (clock.Now).
// An older one is never used: the request waits for a read, as TS's synchronous one, bounded by tailnetTimeout and
// shared by every request that comes meanwhile. A failed or timed-out read, or ctx ending first, is no nodes.
func (s *Server) tailnetNodes(ctx context.Context) []tailnetNode {
	t := &s.tailnet
	t.mu.Lock()
	if t.fresh() {
		defer t.mu.Unlock()
		return t.list
	}
	if t.done == nil {
		done := make(chan struct{})
		t.done = done
		go func() {
			rctx, cancel := context.WithTimeout(context.Background(), tailnetTimeout)
			list := parseTailnet(tailscaleStatus(rctx))
			cancel()
			t.mu.Lock()
			t.list, t.at, t.done = list, clock.Now(), nil
			t.mu.Unlock()
			close(done)
		}()
	}
	done := t.done
	t.mu.Unlock()
	tailnetWaiting()
	select {
	case <-done:
	case <-ctx.Done():
		return nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.fresh() {
		return t.list
	}
	return nil
}

// fresh is whether the list was read under a minute ago. t.mu is held.
func (t *tailnetCache) fresh() bool {
	return !t.at.IsZero() && clock.Now().Sub(t.at) < time.Minute
}

// parseTailnet is the nodes of this tailnet only: a node shared in from another tailnet could share a short name.
func parseTailnet(status []byte) []tailnetNode {
	var st struct {
		Self struct{ DNSName string }
		Peer map[string]tailnetNode
	}
	if json.Unmarshal(status, &st) != nil {
		return nil
	}
	_, suffix, _ := strings.Cut(strings.TrimSuffix(strings.ToLower(st.Self.DNSName), "."), ".")
	var out []tailnetNode
	for _, n := range st.Peer {
		if suffix != "" && strings.HasSuffix(strings.TrimSuffix(strings.ToLower(n.DNSName), "."), "."+suffix) {
			out = append(out, n)
		}
	}
	// The map's order is random; the first match must not be.
	slices.SortFunc(out, func(a, b tailnetNode) int { return strings.Compare(a.DNSName, b.DNSName) })
	return out
}

// tailnetNames is the names a peer's machine has on the tailnet, found by the host in its stam url: its full MagicDNS
// name, its short name, and its addresses; none when tailscale doesn't know it.
func tailnetNames(host string, list []tailnetNode) []string {
	h := strings.Trim(strings.ToLower(host), "[]")
	if h == "" {
		return nil
	}
	for _, n := range list {
		fqdn := strings.TrimSuffix(strings.ToLower(n.DNSName), ".")
		short, _, _ := strings.Cut(fqdn, ".")
		ips := make([]string, len(n.TailscaleIPs))
		for i, ip := range n.TailscaleIPs {
			ips[i] = strings.ToLower(ip)
		}
		if h == fqdn || h == short || slices.Contains(ips, h) {
			return slices.DeleteFunc(append([]string{fqdn, short}, ips...), func(s string) bool { return s == "" })
		}
	}
	return nil
}

// peerUIOrigins is the origins the configured peers' UIs can have: each daemon url's own origin, that port on each of
// its tailnet names, and HTTPS on its full tailnet name (`stam web serve`).
func (s *Server) peerUIOrigins(ctx context.Context) map[string]bool {
	out := map[string]bool{}
	peers := s.peers.Peers()
	if len(peers) == 0 {
		return out
	}
	list := s.tailnetNodes(ctx)
	for _, p := range peers {
		own, ok := webOrigin(p.URL)
		if !ok {
			continue
		}
		out[own] = true
		u, _ := neturl.Parse(own)
		names := tailnetNames(u.Hostname(), list)
		for _, n := range names {
			host := n
			if port := u.Port(); port != "" {
				host = net.JoinHostPort(n, port)
			} else if strings.Contains(n, ":") {
				host = "[" + n + "]"
			}
			out[u.Scheme+"://"+host] = true
		}
		if len(names) > 0 {
			out["https://"+names[0]] = true
		}
	}
	return out
}

// peerUIOrigin is the request's Origin when it comes from a configured peer's UI for a route a peer's UI may write
// (src/daemon.ts fromPeerUi): the settings home's shared writes, or the human's writes on any daemon. A preflight is
// judged by the method it asks for. "" otherwise.
func (s *Server) peerUIOrigin(r *http.Request) string {
	origin := strings.ToLower(r.Header.Get("Origin"))
	if origin == "" || s.sameOrigin(origin) {
		return ""
	}
	method := r.Method
	if method == http.MethodOptions {
		method = r.Header.Get("Access-Control-Request-Method")
	}
	if !(s.isSettingsHome() && matchUI(peerUIRoutes, method, r.URL.Path)) && !matchUI(peerUIHumanRoutes, method, r.URL.Path) {
		return ""
	}
	if !s.peerUIOrigins(r.Context())[origin] {
		return ""
	}
	return origin
}

// preflight answers a browser's CORS preflight: 204 with the CORS headers for a peer's UI, else an empty 403.
func (s *Server) preflight(w http.ResponseWriter, r *http.Request, origin string) {
	if origin == "" {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", origin)
	h.Set("Access-Control-Allow-Methods", r.Header.Get("Access-Control-Request-Method"))
	allow := "content-type, x-stam-human"
	if s.cfg.TestHumanKey != "" {
		allow += ", x-stam-test-human"
	}
	h.Set("Access-Control-Allow-Headers", allow)
	if r.Header.Get("Access-Control-Request-Private-Network") == "true" {
		h.Set("Access-Control-Allow-Private-Network", "true")
	}
	h.Set("Access-Control-Max-Age", "600")
	h.Set("Vary", "origin")
	w.WriteHeader(http.StatusNoContent)
}

type peerUIKey struct{}

// fromPeerUI is whether the request came from a peer's UI (peerUIOrigin), for the routes that treat it as shared-only.
func fromPeerUI(r *http.Request) bool {
	v, _ := r.Context().Value(peerUIKey{}).(bool)
	return v
}

// ownHost is whether a Host header names this daemon: loopback or a bound address on its port, or the canonical web
// origin's host as the last discovery left it, so a `tailscale serve` found after boot is let in without a restart.
func (s *Server) ownHost(host string) bool {
	host = strings.ToLower(host)
	if s.hosts[host] {
		return true
	}
	u, err := neturl.Parse(s.canonicalWebOrigin())
	return err == nil && host != "" && strings.ToLower(u.Host) == host
}

// publishedWebOrigin is the canonical web origin when a serve gives it (or STAM_WEB_ORIGIN names it); "" otherwise.
func (s *Server) publishedWebOrigin() string {
	s.web.mu.Lock()
	served := s.web.served
	s.web.mu.Unlock()
	if !served {
		return ""
	}
	return s.canonicalWebOrigin()
}
