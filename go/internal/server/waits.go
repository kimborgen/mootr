package server

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"

	"stam/internal/adapters/claude"
	"stam/internal/api"
	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/events"
	"stam/internal/jsjson"
	"stam/internal/lifecycle"
	"stam/internal/peers"
	"stam/internal/steps"
)

// The waits routes (src/daemon.ts, src/waits.ts, S-2848 B2a): GET /api/agents/:id/waits, POST /api/agents/:id/waits
// (any wait, from the sources of waits), /waits/clear, and the agent's own wait_for (/waits/declared), wake_me
// (/waits/wake) and wait_done (/waits/done). Who may write is mayManageWaits.
//
// Not ported, a 501 before any write: `rest`.

func (s *Server) waitsRoutes() {
	s.handle("GET /api/agents/{id}/waits", agentPath(s.getWaits))
	s.handle("POST /api/agents/{id}/waits", agentPath(s.addWait))
	s.handle("POST /api/agents/{id}/waits/clear", agentPath(s.clearWaits))
	s.handle("POST /api/agents/{id}/waits/declared", agentPath(s.declareWait))
	s.handle("POST /api/agents/{id}/waits/wake", agentPath(s.wakeWait))
	s.handle("POST /api/agents/{id}/waits/done", agentPath(s.waitDone))
}

// webWaits is src/waits.ts webWaitsByAgent for the agents given: each wait with the mail thread its data names (a mail
// id resolved to its thread), or null.
func (s *Server) webWaits(ctx context.Context, byAgent map[string][]db.Wait) (map[string][]api.AgentWait, error) {
	refs := map[string]string{}
	var ids []string
	for _, ws := range byAgent {
		for _, w := range ws {
			if ref := waitThread(w); ref != "" {
				refs[w.ID] = ref
				ids = append(ids, ref)
			}
		}
	}
	threads, err := s.db.MailThreadIDs(ctx, ids)
	if err != nil {
		return nil, err
	}
	out := map[string][]api.AgentWait{}
	for id, ws := range byAgent {
		list := make([]api.AgentWait, len(ws))
		for i, w := range ws {
			list[i] = api.AgentWait{Id: w.ID, AgentId: w.AgentID, Kind: w.Kind, Target: w.Target, Detail: w.Detail, Since: w.Since,
				Until: w.Until, Source: api.AgentWaitSource(w.Source), Data: w.Data}
			if ref, ok := refs[w.ID]; ok {
				t := ref
				if th, ok := threads[ref]; ok {
					t = th
				}
				list[i].Thread = &t
			}
		}
		out[id] = list
	}
	return out, nil
}

// waitThread is a wait's data.thread as String() reads it when truthy, else "".
func waitThread(w db.Wait) string {
	if w.Data == nil {
		return ""
	}
	v, err := jsjson.Parse([]byte(*w.Data))
	o, _ := v.(*jsjson.Object)
	if err != nil || o == nil {
		return ""
	}
	th, _ := o.Get("thread")
	if !jsjson.Truthy(th) {
		return ""
	}
	return claude.JSString(th)
}

func (s *Server) agentWaits(ctx context.Context, id string) ([]api.AgentWait, error) {
	ws, err := s.db.ListWaits(ctx, id)
	if err != nil {
		return nil, err
	}
	web, err := s.webWaits(ctx, map[string][]db.Wait{id: ws})
	if err != nil {
		return nil, err
	}
	if web[id] == nil {
		return []api.AgentWait{}, nil
	}
	return web[id], nil
}

func (s *Server) getWaits(r *http.Request, _ auth.Resolved) (any, error) {
	a, err := s.mustAgent(r.Context(), r.PathValue("id"))
	if err != nil {
		return nil, err
	}
	return s.agentWaits(r.Context(), a.ID)
}

// waitWrite is a waits write after its checks: the agent in the path and the body.
func (s *Server) waitWrite(r *http.Request, c auth.Resolved) (db.Agent, *jsjson.Object, error) {
	w, err := s.readWrite(r, c)
	if err != nil {
		return db.Agent{}, nil, err
	}
	a, err := s.mustAgent(r.Context(), r.PathValue("id"))
	if err != nil {
		return db.Agent{}, nil, err
	}
	body := w.body
	if body == nil {
		body = jsjson.NewObject()
	}
	by, _ := body.Get("by")
	if err := s.mayManageWaits(r.Context(), a, by, w.human, w.local && c.Kind == auth.Shared); err != nil {
		return db.Agent{}, nil, err
	}
	return a, body, nil
}

// mayManageWaits is src/daemon.ts mayManageWaits: who may create or clear an agent's waits. The agent itself, one of
// its parents, the human (no `by`, as the CLI and the web UI send) or the assistant acting for the human.
func (s *Server) mayManageWaits(ctx context.Context, a db.Agent, by jsjson.Value, human, peerOwn bool) error {
	named := jsjson.Truthy(by)
	if !named && s.strictRefuses("waits with no by", !human && !peerOwn) {
		return Errorf(http.StatusForbidden, "only the human, or an agent naming itself (by), manages waits")
	}
	if !named {
		return nil
	}
	who := claude.JSString(by)
	if s.isAssistant(ctx, who) || who == a.ID {
		return nil
	}
	parents, err := s.db.ParentsOf(ctx, a)
	if err != nil {
		return err
	}
	for _, p := range parents {
		if p == who {
			return nil
		}
	}
	return Errorf(http.StatusForbidden, "%s may manage only its own waits or its children's", who)
}

// bodyStr is `v == null ? null : String(v)`.
func bodyStr(v jsjson.Value) *string {
	if v == nil {
		return nil
	}
	s := claude.JSString(v)
	return &s
}

// bodyText is `String(v ?? ”)`.
func bodyText(v jsjson.Value) string {
	if v == nil {
		return ""
	}
	return claude.JSString(v)
}

func bodyField(o *jsjson.Object, key string) jsjson.Value {
	v, _ := o.Get(key)
	return v
}

// addWait is POST /api/agents/:id/waits: any wait, as the sources of waits add them.
func (s *Server) addWait(r *http.Request, c auth.Resolved) (any, error) {
	a, body, err := s.waitWrite(r, c)
	if err != nil {
		return nil, err
	}
	kind := jsjson.Trim(bodyText(bodyField(body, "kind")))
	if kind == "" {
		return nil, Errorf(http.StatusBadRequest, "a wait needs a kind")
	}
	source := bodyField(body, "source")
	if source == nil {
		source = "stam"
	}
	if source != "stam" && source != "hook" && source != "declared" {
		return nil, Errorf(http.StatusBadRequest, "source must be 'stam', 'hook', or 'declared'")
	}
	var data *string
	if v := bodyField(body, "data"); v != nil {
		d := jsjson.Stringify(v, "")
		data = &d
	}
	return s.db.AddWait(r.Context(), db.NewWait{AgentID: a.ID, Kind: kind, Source: source.(string), Target: bodyStr(bodyField(body, "target")),
		Detail: bodyStr(bodyField(body, "detail")), Until: bodyStr(bodyField(body, "until")), Data: data})
}

type clearedCount struct {
	Cleared int `json:"cleared"`
}

// clearWaits is POST /api/agents/:id/waits/clear: one wait of the agent's by id, or its waits of a kind on a target.
func (s *Server) clearWaits(r *http.Request, c auth.Resolved) (any, error) {
	a, body, err := s.waitWrite(r, c)
	if err != nil {
		return nil, err
	}
	if id := bodyField(body, "id"); jsjson.Truthy(id) {
		n := 0
		// `w.id === body.id`: only a string id matches one of the agent's.
		if want, ok := id.(string); ok {
			cleared, err := s.db.ClearAgentWait(r.Context(), a.ID, want)
			if err != nil {
				return nil, err
			}
			if cleared {
				n = 1
			}
		}
		return clearedCount{n}, nil
	}
	kind := bodyField(body, "kind")
	if !jsjson.Truthy(kind) {
		return nil, Errorf(http.StatusBadRequest, "clear a wait by id, or by kind and target")
	}
	n, err := s.db.ClearWaits(r.Context(), a.ID, claude.JSString(kind), bodyStr(bodyField(body, "target")))
	if err != nil {
		return nil, err
	}
	return clearedCount{n}, nil
}

// minutes is a positive-number field (src/waits.ts `Number(x)`, refused unless > 0); nil when the field is null or
// missing.
func minutes(body *jsjson.Object, key string) (*float64, error) {
	v := bodyField(body, key)
	if v == nil {
		return nil, nil
	}
	n := steps.JSNumber(v)
	if !(n > 0) {
		return nil, Errorf(http.StatusBadRequest, "%s must be positive", key)
	}
	return &n, nil
}

// waitError answers a lifecycle refusal as the 400 TS answers for a thrown error.
func waitError(err error) error {
	var bad lifecycle.ErrWait
	if errors.As(err, &bad) {
		return Errorf(http.StatusBadRequest, "%s", bad.Msg)
	}
	return err
}

// restRefusal answers 501 for `rest: true`: a wait or timer that puts its agent to rest (lifecycle.requestRest).
func restRefusal(body *jsjson.Object) error {
	if bodyField(body, "rest") == true {
		return Errorf(http.StatusNotImplemented, "rest is not ported to the Go daemon yet")
	}
	return nil
}

// declareWait is POST /api/agents/:id/waits/declared, wait_for (src/waits.ts declare).
func (s *Server) declareWait(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	a, body, err := s.waitWrite(r, c)
	if err != nil {
		return nil, err
	}
	if s.life == nil {
		return nil, Errorf(http.StatusNotImplemented, "waits aren't available on this daemon")
	}
	on := bodyText(bodyField(body, "on"))
	if on != "agent" && on != "human" && on != "event" {
		return nil, Errorf(http.StatusBadRequest, "on must be 'agent', 'human', or 'event'")
	}
	d := lifecycle.Declare{On: on, Note: jsjson.Trim(bodyText(bodyField(body, "note")))}
	if d.Timeout, err = minutes(body, "timeout_minutes"); err != nil {
		return nil, err
	}
	if d.Expect, err = minutes(body, "expect_minutes"); err != nil {
		return nil, err
	}
	if on == "event" {
		// An event wait clears on the first external event its filter fits (src/watch.ts ingest), and is kept by its
		// rows: a restart keeps it, and a cleared one stays cleared.
		if err := restRefusal(body); err != nil {
			return nil, err
		}
		ed := events.Declare{Filter: events.Sanitize(bodyField(body, "filter")), Note: d.Note, Timeout: d.Timeout, Expect: d.Expect}
		w, err := s.events.DeclareWait(ctx, a.ID, ed)
		var bad *events.ErrInvalid
		if errors.As(err, &bad) {
			return nil, Errorf(http.StatusBadRequest, "%s", bad.Msg)
		}
		return w, err
	}
	if on == "agent" {
		ref := ""
		if t := bodyField(body, "target"); jsjson.Truthy(t) {
			ref = claude.JSString(t)
		}
		if ref == "" {
			return nil, Errorf(http.StatusBadRequest, "wait_for on 'agent' needs target (an agent id or name)")
		}
		// The target may run on another machine; ids are unique across machines.
		t, err := s.db.GetAgent(ctx, ref)
		remote := false
		if errors.Is(err, db.ErrNotFound) {
			var ok bool
			if t, ok, err = s.peerTarget(ctx, ref); err != nil {
				return nil, err
			}
			if !ok {
				return nil, Errorf(http.StatusBadRequest, "no agent %s", ref)
			}
			remote = true
		} else if err != nil {
			return nil, err
		}
		// An archived agent never sends the reply, so the wait would never clear.
		if t.Lifecycle == "archived" {
			return nil, Errorf(http.StatusBadRequest, "no agent %s (archived)", ref)
		}
		d.Target, d.Remote = t, remote
	}
	if th := bodyField(body, "thread"); th != nil && th != "" {
		d.Thread = claude.JSString(th)
	}
	if err := restRefusal(body); err != nil {
		return nil, err
	}
	w, err := s.life.DeclareWait(ctx, a, d)
	return w, waitError(err)
}

// peerTarget is src/waits.ts peerTarget: an agent on a peer, found there now, or one this daemon has met before on a peer
// it still has that did not answer this lookup (send_mail queues to such an agent the same way, S-235). A peer that
// answered it has no such agent outweighs the memory of one there, and two remembered agents the name could mean are
// ambiguous, as a lookup on the peers would be (TS takes the first remembered row either way). Its mail reaches this
// daemon through the peer link, so the wait clears on it. The caller refuses an archived one.
func (s *Server) peerTarget(ctx context.Context, ref string) (db.Agent, bool, error) {
	hit, found, silent, err := s.peers.LocateSilent(ctx, s.db, ref)
	var amb *peers.AmbiguousError
	if errors.As(err, &amb) {
		return db.Agent{}, false, Errorf(http.StatusConflict, "%s", amb.Msg)
	}
	if err != nil {
		return db.Agent{}, false, err
	}
	if found == peers.Found {
		return db.Agent{ID: hit.Agent.ID, Name: hit.Agent.Name, Lifecycle: api.AgentLifecycle(hit.Agent.Lifecycle)}, true, nil
	}
	if found != peers.Unreachable {
		return db.Agent{}, false, nil
	}
	known, err := s.db.PeerAgentsMatching(ctx, ref)
	if err != nil {
		return db.Agent{}, false, err
	}
	var hits []peers.Hit
	// silent names only peers in the settings, so an agent remembered on a machine no longer there is no match.
	for _, k := range known {
		if slices.Contains(silent, k.Machine) {
			hits = append(hits, peers.Hit{Agent: peers.Agent{ID: k.ID, Name: k.Name, Machine: k.Machine, Lifecycle: k.Lifecycle}})
		}
	}
	pick, err := peers.Pick(ref, hits)
	if errors.As(err, &amb) {
		return db.Agent{}, false, Errorf(http.StatusConflict, "%s", amb.Msg)
	}
	if err != nil || pick == nil {
		return db.Agent{}, false, err
	}
	return db.Agent{ID: pick.Agent.ID, Name: pick.Agent.Name, Lifecycle: api.AgentLifecycle(pick.Agent.Lifecycle)}, true, nil
}

var wakeModes = []string{"in_minutes", "at", "cron", "every_minutes"}

// wakeWait is POST /api/agents/:id/waits/wake, wake_me (src/waits.ts wake).
func (s *Server) wakeWait(r *http.Request, c auth.Resolved) (any, error) {
	a, body, err := s.waitWrite(r, c)
	if err != nil {
		return nil, err
	}
	if s.life == nil {
		return nil, Errorf(http.StatusNotImplemented, "waits aren't available on this daemon")
	}
	w := lifecycle.Wake{Note: jsjson.Trim(bodyText(bodyField(body, "note")))}
	if w.Note == "" {
		return nil, Errorf(http.StatusBadRequest, "wake_me needs a note")
	}
	var modes []string
	for _, k := range wakeModes {
		if v := bodyField(body, k); v != nil && v != "" {
			modes = append(modes, k)
		}
	}
	if len(modes) != 1 {
		return nil, Errorf(http.StatusBadRequest, "wake_me needs exactly one of in_minutes, at, cron, every_minutes")
	}
	w.Mode = modes[0]
	v := bodyField(body, w.Mode)
	switch w.Mode {
	case "in_minutes", "every_minutes":
		if w.Minutes = steps.JSNumber(v); !(w.Minutes > 0) {
			return nil, Errorf(http.StatusBadRequest, "%s must be positive", w.Mode)
		}
	case "at":
		t, ok := parseAt(claude.JSString(v))
		if !ok {
			return nil, Errorf(http.StatusBadRequest, "at must be an ISO time, got \"%s\"", claude.JSString(v))
		}
		w.At = t
	case "cron":
		w.Cron = jsjson.Trim(claude.JSString(v))
	}
	if err := restRefusal(body); err != nil {
		return nil, err
	}
	out, err := s.life.WakeAt(r.Context(), a.ID, w)
	return out, waitError(err)
}

// parseAt is `new Date(String(at))` for the ISO forms an agent sends, surrounding spaces trimmed:
//   - 2026-10-21T14:30:00Z, 2026-10-21T14:30:00.123+02:00, 2026-10-21T14:30Z: with a zone, as given;
//   - 2026-10-21T14:30:00, 2026-10-21T14:30:00.5, 2026-10-21T14:30: no zone, local time, as Date reads them;
//   - 2026-10-21: a date alone, midnight UTC, as Date reads it.
//
// Anything else is refused, including forms Date also reads (a space for the T, a month name, a bare year).
func parseAt(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	for _, f := range []string{time.RFC3339Nano, "2006-01-02T15:04Z07:00"} {
		if t, err := time.Parse(f, s); err == nil {
			return t, true
		}
	}
	for _, f := range []string{"2006-01-02T15:04:05.999999999", "2006-01-02T15:04"} {
		if t, err := time.ParseInLocation(f, s, time.Local); err == nil {
			return t, true
		}
	}
	if t, err := time.Parse("2006-01-02", s); err == nil {
		return t, true
	}
	return time.Time{}, false
}

type clearedFlag struct {
	Cleared bool `json:"cleared"`
}

// waitDone is POST /api/agents/:id/waits/done, wait_done (src/waits.ts done).
func (s *Server) waitDone(r *http.Request, c auth.Resolved) (any, error) {
	a, body, err := s.waitWrite(r, c)
	if err != nil {
		return nil, err
	}
	id := ""
	if v := bodyField(body, "id"); jsjson.Truthy(v) {
		id = claude.JSString(v)
	}
	cleared := false
	if id != "" {
		if cleared, err = s.db.ClearAgentWait(r.Context(), a.ID, id, "declared", "stam"); err != nil {
			return nil, err
		}
	}
	return clearedFlag{cleared}, nil
}
