package server

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"stam/internal/auth"
	"stam/internal/config"
	"stam/internal/jsjson"
)

// answerRelayTimeout is how long a relayed permission answer waits for the peer that holds the request.
const answerRelayTimeout = 30 * time.Second

// controlChars is what a logged line from a client never carries: control and line-separator characters, as one space.
var controlChars = regexp.MustCompile(`[\x00-\x1f\x7f\x{0085}\x{2028}\x{2029}]+`)

// directCredential is a Bearer or Basic credential of any length in the direct line: bearerText needs eight characters,
// and a short one (`Basic YTpi`, `Bearer abc123`) must not reach the log either.
var directCredential = regexp.MustCompile(`(?i)\b(bearer|basic)\s+[^\s"',;\\]+`)

// relayAnswer is the relay of POST /api/permissions/:id/answer for a request this daemon doesn't hold (src/daemon.ts, "A
// request from an agent on another machine is answered by the daemon that owns it"): the peer the body's `machine` names,
// or else each peer in turn until one holds it. done is false when no peer did, and the route answers it here.
//
// Under auth.humanStrict the human's answer with no machine named probes each peer as a non-human (no human header, no
// `by`), so only the holder's refusal says anything but "no permission request"; that holder is then the machine the
// human-on-machine 409 names. The human's answer is never carried to a peer under strict (relayHuman).
func (s *Server) relayAnswer(ctx context.Context, r *http.Request, c auth.Resolved, w write) (out any, done bool, err error) {
	// The service worker's failed direct attempt, why (S-426); text only, cut short, no secrets. It holds a failed
	// response's text, which may quote a bearer, so every known token and any bearer goes before it is cut or logged.
	if d, ok := get(w.body, "direct").(string); ok {
		d = directCredential.ReplaceAllString(s.peers.RedactAny(d), redacted)
		d = controlChars.ReplaceAllString(d, " ")
		if r := []rune(d); len(r) > 300 {
			d = string(r[:300])
		}
		slog.Info("permission answer relayed after the direct attempt failed: " + d)
	}
	machine := textOf(w.body, "machine")
	targets := s.peers.Peers()
	named := machine != ""
	if named {
		p, ok := s.peers.ByName(machine)
		if !ok {
			return nil, true, Errorf(http.StatusNotFound, "no peer machine %s", machine)
		}
		targets = []config.Peer{p}
	}
	by := get(w.body, "by")
	acts := !jsjson.Truthy(by) || by == humanBox
	probing := !named && w.human && acts && s.settings.Get().Auth.HumanStrict
	via := s.viaOf(ctx, c)
	for _, peer := range targets {
		carry := false
		if !probing {
			if carry, err = s.relayHuman(peer, w.human, true, "a permission answer", acts); err != nil {
				return nil, true, err
			}
		}
		rep, err := s.peers.Call(ctx, peer, http.MethodPost, r.URL.EscapedPath(), answerBody(w.body, probing), answerRelayTimeout, carry, via)
		if err != nil {
			continue
		}
		msg := rep.Data.Text("error")
		notHeld := strings.HasPrefix(msg, "no permission request ")
		if probing && !notHeld {
			if _, err := s.relayHuman(peer, true, true, "a permission answer", true); err != nil {
				return nil, true, err
			}
		}
		if rep.Status == http.StatusOK {
			return rep.Data, true, nil
		}
		if named || !notHeld {
			if msg == "" {
				msg = fmt.Sprintf("HTTP %d", rep.Status)
			}
			return nil, true, Errorf(rep.Status, "%s", msg)
		}
	}
	return nil, false, nil
}

// answerBody is the answer as a peer gets it: without `machine` or `direct` (this daemon's log line, which the peer
// never reads), and without `by` when it probes.
func answerBody(body *jsjson.Object, probing bool) []byte {
	out := jsjson.NewObject()
	if body != nil {
		for _, k := range body.Keys() {
			if k == "machine" || k == "direct" || (probing && k == "by") {
				continue
			}
			v, _ := body.Get(k)
			out.Set(k, v)
		}
	}
	return []byte(jsjson.Stringify(out, ""))
}
