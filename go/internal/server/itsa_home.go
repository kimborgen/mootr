package server

import (
	"context"
	"errors"
	"net/http"
	neturl "net/url"
	"strconv"
	"strings"
	"time"

	"stam/internal/auth"
	"stam/internal/jsfmt"
	"stam/internal/peers"
)

// A Go daemon that is not the ITSA home asks the home (src/itsa-owners.ts toHome): a spawn's ITSA, its join and undo, the
// join to its parent's ITSA, and an archived or forgotten agent's unown all run where the ITSAs are.

// errHomeRefused is the home's final answer (a 403): no peer holds that agent, or the asking agent may not. Asking again
// can't change it (itsa-owners.ts isFinal).
var errHomeRefused = errors.New("the ITSA home refused")

// toHome is src/itsa-owners.ts toHome: the home's answer to a call, as the agent via when it is set. A 403 is a refusal
// (wrapping errHomeRefused, answered 403 to a spawn); any other status from 300 up, a network failure and a home that is
// not a configured peer are errors to retry. The messages name the home and its error, never its URL or a token.
func (s *Server) toHome(ctx context.Context, method, path string, body any, timeout time.Duration, via *itsaVia) (jsfmt.Value, error) {
	home := s.settings.Get().Itsa.Home
	p, ok := s.homePeer()
	if !ok || s.peers == nil {
		return jsfmt.Value{}, errors.New("ITSA home '" + home + "' is not a configured peer")
	}
	var v *peers.Via
	if via != nil {
		v = &peers.Via{Agent: via.agent, Boss: via.boss}
	}
	r, err := s.peers.Call(ctx, p, method, path, body, timeout, false, v)
	if err != nil {
		return jsfmt.Value{}, errors.New("the ITSA home " + home + " did not answer")
	}
	if r.Status >= 300 {
		why := r.Data.Text("error")
		if why == "" {
			why = strconv.Itoa(r.Status)
		}
		why = s.scrubPeerURLs(s.peers.RedactText(p, why))
		if r.Status == http.StatusForbidden {
			return jsfmt.Value{}, &homeRefusal{Errorf(http.StatusForbidden, "the ITSA home %s refused: %s", home, why)}
		}
		return jsfmt.Value{}, errors.New("the ITSA home " + home + " refused: " + why)
	}
	return r.Data, nil
}

// scrubPeerURLs is msg with every configured peer's URL and host replaced by its name: a home's error can echo its own
// address, which never goes into a spawn's answer or a log line.
func (s *Server) scrubPeerURLs(msg string) string {
	for _, p := range s.peers.Peers() {
		u, err := neturl.Parse(p.URL)
		if err != nil || u.Host == "" {
			continue
		}
		msg = strings.ReplaceAll(msg, u.Scheme+"://"+u.Host, p.Name)
		msg = strings.ReplaceAll(msg, u.Host, p.Name)
	}
	return msg
}

// homeRefusal is the home's 403, an *Error that is also errHomeRefused.
type homeRefusal struct{ err *Error }

func (h *homeRefusal) Error() string   { return h.err.Error() }
func (h *homeRefusal) Unwrap() []error { return []error{h.err, errHomeRefused} }
func isHomeRefusal(err error) bool     { return errors.Is(err, errHomeRefused) }

// background runs fn off the request: in the daemon's background work when it has one, so its shutdown waits for it.
func (s *Server) background(ctx context.Context, fn func(context.Context)) {
	if s.life != nil {
		s.life.Go(fn)
		return
	}
	go fn(context.WithoutCancel(ctx))
}

// itsaIncidentRoute is src/daemon.ts GET /api/itsas/:id/incident (S-3324), for scripts/merge-pr.mjs: whether the ITSA, or
// an ancestor, is marked an incident, read here on the ITSA home, else asked of the home. Fails closed: no mark when it
// can't be read.
func (s *Server) itsaIncidentRoute(r *http.Request, _ auth.Resolved) (any, error) {
	out := jsfmt.Value{Kind: jsfmt.Object}
	out.Set("marked", jsfmt.Value{Kind: jsfmt.Bool, Bool: s.incidentMarked(context.WithoutCancel(r.Context()), r.PathValue("id"))})
	return out, nil
}
