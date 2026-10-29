package server

import (
	"context"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"

	"stam/internal/auth"
	"stam/internal/jsfmt"
	"stam/internal/peers"
)

// The Needs you list (src/asks.ts, src/daemon.ts asksAll; S-3831): every open ask of every kind on this daemon and its peers,
// plus each one settled in the last day with its outcome. It is read from durable rows (permission requests, ITSA status
// events, comms events), so a restart keeps the history, and a row carries no secret: only the one line the ask card already
// shows. The open ask each agent and ITSA waits on (open_ask, open_ask_detail; S-3977) is openAskLinks, read from the same rows.

const askOneLine = 160

// askLine is src/asks.ts oneLine: text that carries no secret (an ITSA's title, a mail's subject) as one line, cut short.
func askLine(s string) string {
	space := func(r rune) bool { return (unicode.IsSpace(r) && r != 0x85) || r == 0xfeff }
	t := strings.Join(strings.FieldsFunc(s, space), " ")
	if utf16Len(t) > askOneLine {
		return sliceUnits(t, askOneLine-1) + "…"
	}
	return t
}

// permissionWhat is src/asks.ts PERMISSION_WHAT: a permission request's what is its kind, never its text. The action and
// details can hold a command with a credential in it, and the ask card (one click away) shows them.
var permissionWhat = map[string]string{
	"request":  "Permission request",
	"dialog":   "Harness dialog",
	"settings": "Settings change",
	"input":    "Suggested input",
}

// askRow is one row of the list, in src/asks.ts Ask's key order. Nil is null.
type askRow struct {
	key, kind, state   string
	outcome            any
	what               string
	agentID, agentName any
	machine            string
	threadID, itsaID   any
	since              string
	settledAt          any
}

func (a askRow) value() jsfmt.Value {
	v := jsfmt.Value{Kind: jsfmt.Object}
	v.Set("key", jsfmt.StringValue(a.key))
	v.Set("kind", jsfmt.StringValue(a.kind))
	v.Set("state", jsfmt.StringValue(a.state))
	v.Set("outcome", nullable(a.outcome))
	v.Set("what", jsfmt.StringValue(a.what))
	v.Set("agent_id", nullable(a.agentID))
	v.Set("agent_name", nullable(a.agentName))
	v.Set("machine", jsfmt.StringValue(a.machine))
	v.Set("thread_id", nullable(a.threadID))
	v.Set("itsa_id", nullable(a.itsaID))
	v.Set("since", jsfmt.StringValue(a.since))
	v.Set("settled_at", nullable(a.settledAt))
	return v
}

// nullable is a string, or null for nil.
func nullable(v any) jsfmt.Value {
	if s, ok := v.(string); ok {
		return jsfmt.StringValue(s)
	}
	return jsfmt.NullValue()
}

// orNil is a string, or nil for "".
func orNil(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// askAgentName is src/asks.ts agentName: the agent's name, or nil.
func (s *Server) askAgentName(ctx context.Context, id any) any {
	sid, _ := id.(string)
	if sid == "" {
		return nil
	}
	if a, err := s.db.GetAgent(ctx, sid); err == nil {
		return a.Name
	}
	return nil
}

// permissionAsks is src/asks.ts permissionAsks: open while pending or held, settled for a day after it was decided.
func (s *Server) permissionAsks(ctx context.Context, since string) ([]askRow, error) {
	found, err := s.db.PermissionAsks(ctx, since)
	if err != nil {
		return nil, err
	}
	out := make([]askRow, 0, len(found))
	for _, r := range found {
		kind, status := r.Text("kind"), r.Text("status")
		open := status == "pending" || status == "held"
		a := askRow{key: kind + ":" + r.Text("id"), kind: kind, state: "settled", what: permissionWhat[kind], agentID: r.Nullable("agent_id"),
			machine: s.cfg.Machine, threadID: r.Nullable("home_thread"), itsaID: r.Nullable("home_itsa"), since: r.Text("created_at")}
		a.agentName = s.askAgentName(ctx, a.agentID)
		if open {
			a.state = "open"
		} else {
			// A suggested input that was approved was typed into the box.
			a.outcome = status
			if kind == "input" && status == "approved" {
				a.outcome = "typed"
			}
			a.settledAt = r.Text("created_at")
			if at := r.Text("decided_at"); at != "" {
				a.settledAt = at
			}
		}
		out = append(out, a)
	}
	return out, nil
}

// itsaAsks is src/asks.ts itsaAsks: the ITSAs in a human status are open rows; the moves out of a human status in the last day
// are settled, `approved` for an approve, `answered` for any other action, and `withdrawn` for a move with no action.
func (s *Server) itsaAsks(ctx context.Context, since string) ([]askRow, error) {
	waiting, err := s.attention(ctx)
	if err != nil {
		return nil, err
	}
	var out []askRow
	for _, x := range waiting {
		a := askRow{key: "itsa:" + x.Text("id"), kind: "itsa", state: "open", what: askLine(x.Text("title")), agentID: orNil(x.Text("owner")),
			machine: s.cfg.Machine, threadID: orNil(x.Text("ask_thread_id")), itsaID: x.Text("id"), since: x.Text("since")}
		a.agentName = s.askAgentName(ctx, a.agentID)
		out = append(out, a)
	}
	if since == "" {
		return out, nil
	}
	human := map[string]bool{}
	for _, st := range s.itsaStatuses() {
		if st.Human {
			human[st.Name] = true
		}
	}
	moves, err := s.db.ItsaStatusMoves(ctx, since)
	if err != nil {
		return nil, err
	}
	for _, e := range moves {
		d := jsonObject(e.Text("data"))
		if from := d.Text("from"); from == "" || !human[from] {
			continue
		}
		id, _ := e["id"].(int64)
		// An action is written right after the status change it caused, from the same status. Any other next event (a later
		// status change) means this move had no action: it was withdrawn.
		next, err := s.db.NextItsaAct(ctx, e.Text("itsa_id"), id)
		if err != nil {
			return nil, err
		}
		outcome := "withdrawn"
		if next != nil && next.Text("type") == "action" && next.Text("data") != "" {
			if act := jsonObject(next.Text("data")); act.Text("from") == d.Text("from") {
				outcome = "answered"
				if act.Text("id") == "approve" {
					outcome = "approved"
				}
			}
		}
		// The move out of the human status is the ask's cycle. An ITSA has one home and its events don't move, so the ITSA and
		// the move's own event id identify it (a time can repeat within a millisecond).
		a := askRow{key: "itsa:" + e.Text("itsa_id") + "#" + strconv.FormatInt(id, 10), kind: "itsa", state: "settled", outcome: outcome,
			what: askLine(e.Text("title")), agentID: e.Nullable("owner"), machine: s.cfg.Machine, itsaID: e.Text("itsa_id"),
			since: e.Text("ts"), settledAt: e.Text("ts")}
		a.agentName = s.askAgentName(ctx, a.agentID)
		out = append(out, a)
	}
	return out, nil
}

// jsonObject is the object in a JSON text, or an empty object for anything else (src/asks.ts JSON.parse of a row's data).
func jsonObject(text string) jsfmt.Value {
	if text != "" {
		if v, err := jsfmt.Parse([]byte(text)); err == nil && v.Kind == jsfmt.Object {
			return v
		}
	}
	return jsfmt.Value{Kind: jsfmt.Object}
}

// decisionAsks is src/asks.ts decisionAsks: the decision mails that wait on the human (open), and the ones answered,
// superseded or withdrawn in the last day (settled). A decision mail about an ITSA in a human status (held, on every home) is
// the ITSA's row, so it is left out here.
func (s *Server) decisionAsks(ctx context.Context, since string, held map[string]bool) ([]askRow, error) {
	mine, err := s.db.DecisionMails(ctx)
	if err != nil {
		return nil, err
	}
	var out []askRow
	for _, m := range mine {
		if about := m.Text("about_itsa"); about != "" && held[about] {
			continue
		}
		a := askRow{key: "decision:" + m.Text("mail_id"), kind: "decision", state: "open", what: askLine(m.Text("subject")),
			agentID: orNil(m.Text("from_id")), machine: s.cfg.Machine, threadID: orNil(m.Text("thread_id")), itsaID: orNil(m.Text("about_itsa")),
			since: m.Text("created_at")}
		a.agentName = orNil(m.Text("from_name"))
		if a.agentName == nil {
			a.agentName = s.askAgentName(ctx, a.agentID)
		}
		out = append(out, a)
	}
	if since == "" {
		return out, nil
	}
	settled, err := s.db.SettledDecisions(ctx, since)
	if err != nil {
		return nil, err
	}
	for _, r := range settled {
		outcome := r.Text("outcome")
		if label := r.Text("label"); outcome == "answered" && label != "" {
			outcome = "answered: " + askLine(label)
		}
		// The mail's id is the same on every daemon that holds the decision, so a copy settles once in the merged list.
		a := askRow{key: "decision:" + r.Text("ref"), kind: "decision", state: "settled", outcome: outcome, what: askLine(r.Text("subject")),
			agentID: r.Nullable("from_id"), machine: s.cfg.Machine, threadID: r.Nullable("thread_id"), itsaID: r.Nullable("about_itsa"),
			since: r.Text("created_at"), settledAt: r.Text("created_at")}
		if at := r.Text("asked_at"); at != "" {
			a.since = at
		}
		a.agentName = r.Nullable("from_name")
		if a.agentName == nil {
			a.agentName = s.askAgentName(ctx, a.agentID)
		}
		out = append(out, a)
	}
	return out, nil
}

// orderedAsks is src/asks.ts ordered: the open asks oldest first, then the ones settled in the last day, newest first.
func orderedAsks(all []jsfmt.Value) []jsfmt.Value {
	var open, settled []jsfmt.Value
	for _, a := range all {
		if a.Text("state") == "open" {
			open = append(open, a)
		} else if a.Text("state") == "settled" {
			settled = append(settled, a)
		}
	}
	sort.SliceStable(open, func(i, j int) bool { return open[i].Text("since") < open[j].Text("since") })
	sort.SliceStable(settled, func(i, j int) bool { return settled[i].Text("settled_at") > settled[j].Text("settled_at") })
	return append(append([]jsfmt.Value{}, open...), settled...)
}

// localAsks is src/asks.ts localAsks: every ask this daemon holds, in the list's order. held is the ids of the ITSAs in a
// human status on every home.
func (s *Server) localAsks(ctx context.Context, held map[string]bool) ([]jsfmt.Value, error) {
	return s.asksSince(ctx, time.Now().Add(-24*time.Hour).UTC().Format("2006-01-02T15:04:05.000Z"), held)
}

// openAsks is src/asks.ts openAsks: the open asks this daemon holds, in the list's order, with no settled rows read.
func (s *Server) openAsks(ctx context.Context, held map[string]bool) ([]jsfmt.Value, error) {
	return s.asksSince(ctx, "", held)
}

// asksSince is the rows of localAsks and openAsks: the settled ones from since on (none when since is empty).
func (s *Server) asksSince(ctx context.Context, since string, held map[string]bool) ([]jsfmt.Value, error) {
	perms, err := s.permissionAsks(ctx, since)
	if err != nil {
		return nil, err
	}
	itsas, err := s.itsaAsks(ctx, since)
	if err != nil {
		return nil, err
	}
	decisions, err := s.decisionAsks(ctx, since, held)
	if err != nil {
		return nil, err
	}
	var all []jsfmt.Value
	for _, group := range [][]askRow{perms, itsas, decisions} {
		for _, a := range group {
			all = append(all, a.value())
		}
	}
	return orderedAsks(all), nil
}

// heldItsas is the ids of the ITSAs in a human status on this daemon (src/itsa-human.ts waitingIds).
func (s *Server) heldItsas(ctx context.Context) (map[string]bool, error) {
	held := map[string]bool{}
	waiting, err := s.waitingItsas(ctx)
	if err != nil {
		return nil, err
	}
	for _, x := range waiting {
		held[x.Text("id")] = true
	}
	return held, nil
}

// openAskLinks is src/asks.ts openAskLinks (S-3977): the open ask each agent and each ITSA on this daemon waits on, by the
// row's key, which GET /api/agents and GET /api/itsas/:ref carry as open_ask and open_ask_detail. An agent's is its oldest open
// ask of its own (a permission of any kind, or a decision mail), else the ITSA ask a wait on the human is tied to; an ITSA's is
// its own open ask. Read from the same rows as the list, one read for every agent.
func (s *Server) openAskLinks(ctx context.Context, held map[string]bool) (agents, itsas map[string]jsfmt.Value, err error) {
	open, err := s.openAsks(ctx, held)
	if err != nil {
		return nil, nil, err
	}
	agents, itsas = map[string]jsfmt.Value{}, map[string]jsfmt.Value{}
	for _, a := range open {
		if a.Text("kind") == "itsa" {
			if id := a.Text("itsa_id"); id != "" {
				itsas[id] = a
			}
		} else if id := a.Text("agent_id"); id != "" {
			if _, ok := agents[id]; !ok {
				agents[id] = a
			}
		}
	}
	waits, err := s.db.HumanWaitTargets(ctx)
	if err != nil {
		return nil, nil, err
	}
	for _, w := range waits {
		agent, target := w.Text("agent_id"), w.Text("target")
		if _, ok := agents[agent]; ok {
			continue
		}
		if a, ok := itsas[target]; ok {
			agents[agent] = a
		}
	}
	return agents, itsas, nil
}

// askKindLabel is src/asks.ts KIND_LABEL: the kind of an open ask as the Needs you list names it.
var askKindLabel = map[string]string{"request": "Permission", "dialog": "Harness dialog", "settings": "Settings change", "input": "Suggested input", "itsa": "ITSA", "decision": "Decision"}

// askDetail is src/asks.ts askDetail: the mail an open ask lives in and its kind label, never its text. Null when there is no ask.
func askDetail(a jsfmt.Value, ok bool) jsfmt.Value {
	if !ok {
		return jsfmt.NullValue()
	}
	mail, found := a.Get("thread_id")
	if !found {
		mail = jsfmt.NullValue()
	}
	d := jsfmt.Value{Kind: jsfmt.Object}
	d.Set("mail", mail)
	d.Set("kind", jsfmt.StringValue(askKindLabel[a.Text("kind")]))
	return d
}

// asksAll is src/daemon.ts asksAll: this daemon's asks and its peers', each key once, in the list's order. A key that two
// daemons hold (a decision copy) is one row, and the settled one is the newer state. A decision about an ITSA waiting on any
// home is left out: that ITSA's row covers it. A peer's own request gets this daemon's rows.
func (s *Server) asksAll(ctx context.Context, local bool, via *peers.Via) ([]jsfmt.Value, error) {
	held := map[string]bool{}
	waiting, err := s.waitingItsas(ctx)
	if err != nil {
		return nil, err
	}
	for _, x := range waiting {
		held[x.Text("id")] = true
	}
	if local {
		return s.localAsks(ctx, held)
	}
	for _, x := range s.peers.FanOut(ctx, "/api/itsas/attention", via) {
		held[x.Text("id")] = true
	}
	mine, err := s.localAsks(ctx, held)
	if err != nil {
		return nil, err
	}
	theirs := s.peers.FanOut(ctx, "/api/asks", via)
	for i := range theirs {
		theirs[i] = peerAsk(theirs[i])
	}
	var order []string
	byKey := map[string]jsfmt.Value{}
	for _, a := range append(mine, theirs...) {
		if a.Kind != jsfmt.Object {
			continue
		}
		key := a.Text("key")
		had, ok := byKey[key]
		if !ok {
			order = append(order, key)
		}
		if !ok || (had.Text("state") == "open" && a.Text("state") == "settled") {
			byKey[key] = a
		}
	}
	all := make([]jsfmt.Value, 0, len(order))
	for _, key := range order {
		a := byKey[key]
		// src/asks.ts withoutHeldDecisions: settled decisions stay (they are history).
		if a.Text("kind") == "decision" && a.Text("state") == "open" && a.Text("itsa_id") != "" && held[a.Text("itsa_id")] {
			continue
		}
		all = append(all, a)
	}
	return orderedAsks(all), nil
}

// peerAsk is a peer's row as this daemon lists it: only the Ask fields, each a string (or null where Ask allows it), and a
// permission row's what is its kind label, whatever the peer sent, so a peer can't put a request's text, or any other field,
// on the list. A row of a kind the list doesn't know is dropped (no object). TS passes the peers' rows through as they are.
func peerAsk(v jsfmt.Value) jsfmt.Value {
	kind := v.Text("kind")
	what, isPermission := permissionWhat[kind]
	if !isPermission && kind != "itsa" && kind != "decision" {
		return jsfmt.Value{}
	}
	text := func(k string) string {
		if x, ok := v.Get(k); ok && x.Kind == jsfmt.String {
			return x.Str
		}
		return ""
	}
	maybe := func(k string) any {
		if x, ok := v.Get(k); ok && x.Kind == jsfmt.String {
			return x.Str
		}
		return nil
	}
	if !isPermission {
		what = askLine(text("what"))
	}
	return askRow{key: text("key"), kind: kind, state: text("state"), outcome: maybe("outcome"), what: what, agentID: maybe("agent_id"),
		agentName: maybe("agent_name"), machine: text("machine"), threadID: maybe("thread_id"), itsaID: maybe("itsa_id"), since: text("since"),
		settledAt: maybe("settled_at")}.value()
}

// asksRoute is GET /api/asks: the Needs you list. Not an agent's to read.
func (s *Server) asksRoute(r *http.Request, c auth.Resolved) (any, error) {
	if msg := auth.NotAgentToken(c.Caller, "read the Needs you list"); msg != "" {
		return nil, Errorf(http.StatusForbidden, "%s", msg)
	}
	ctx := context.WithoutCancel(r.Context())
	out, err := s.asksAll(ctx, c.Local, s.viaOf(ctx, c))
	if err != nil {
		return nil, err
	}
	return jsfmt.ArrayValue(out), nil
}
