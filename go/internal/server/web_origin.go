package server

import (
	"context"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	"stam/internal/jsjson"
)

// The web UI's one canonical origin, for an MCP OAuth redirect (src/daemon.ts canonicalWebOrigin). It is never taken
// from the request (Origin, Host and x-forwarded-proto are all forgeable): STAM_WEB_ORIGIN names it for tests,
// `tailscale serve` gives the tailnet url, and 127.0.0.1 is the last resort. Discovery runs in the background, so a
// request only reads its last result.

var webOriginEnv = regexp.MustCompile(`^https?://[^/]+$`)

// StartWebOrigin discovers the canonical origin at boot and again every MOOTR_WEB_RETRY_MS (60 s) until a serve is
// found.
func (s *Server) StartWebOrigin(ctx context.Context) {
	retry := 60 * time.Second
	if n, err := strconv.ParseFloat(getenvStam("WEB_RETRY_MS"), 64); err == nil && n > 0 {
		retry = time.Duration(n * float64(time.Millisecond))
	}
	// The tailnet's nodes are read now too, so a peer's UI origins are known before the first request asks.
	go s.tailnetNodes(ctx)
	go func() {
		for !s.discoverWebOrigin(ctx) {
			select {
			case <-ctx.Done():
				return
			case <-time.After(retry):
			}
		}
	}()
}

// getenvStam is src/env.ts envVar: MOOTR_NAME first, then STAM_NAME.
func getenvStam(name string) string {
	if v := os.Getenv("MOOTR_" + name); v != "" {
		return v
	}
	return os.Getenv("STAM_" + name)
}

// discoverWebOrigin stores the canonical origin and whether a serve gives it.
func (s *Server) discoverWebOrigin(ctx context.Context) bool {
	if env := getenvStam("WEB_ORIGIN"); env != "" && webOriginEnv.MatchString(env) {
		s.setWebOrigin(strings.TrimRight(env, "/"), true)
		return true
	}
	found := ""
	// No tailscale binary: no serve to find, and nothing spawned on each retry.
	if _, err := exec.LookPath("tailscale"); err == nil {
		ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		if out, err := exec.CommandContext(ctx, "tailscale", "serve", "status", "--json").Output(); err == nil {
			found = servedOrigin(out, s.cfg.Port)
		}
	}
	s.setWebOrigin(found, found != "")
	return found != ""
}

// servedOrigin is the https origin of the first host in `tailscale serve status --json` whose handlers reach this
// daemon's port, in the JSON's own key order as TS's Object.keys reads it, so two hosts on one port always give the
// same one; "" for none.
func servedOrigin(status []byte, port int) string {
	v, err := jsjson.Parse(status)
	if err != nil {
		return ""
	}
	o, _ := v.(*jsjson.Object)
	web, _ := o.Get("Web")
	hosts, _ := web.(*jsjson.Object)
	target := "127.0.0.1:" + strconv.Itoa(port)
	for _, h := range hosts.Keys() {
		if x, _ := hosts.Get(h); strings.Contains(jsjson.Stringify(x, ""), target) {
			return "https://" + strings.TrimSuffix(h, ":443")
		}
	}
	return ""
}

func (s *Server) setWebOrigin(base string, served bool) {
	s.web.mu.Lock()
	defer s.web.mu.Unlock()
	s.web.base, s.web.served = base, served
}

// canonicalWebOrigin is the origin the last discovery left, or the 127.0.0.1 fallback.
func (s *Server) canonicalWebOrigin() string {
	s.web.mu.Lock()
	defer s.web.mu.Unlock()
	if s.web.base != "" {
		return s.web.base
	}
	return "http://127.0.0.1:" + strconv.Itoa(s.cfg.Port)
}
