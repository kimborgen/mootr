package db

import (
	"context"
	"strings"
	"time"

	"zombiezen.com/go/sqlite"

	"stam/internal/jsfmt"
)

// The rest's reads and writes (src/lifecycle.ts requestRest and rest, S-2237, S-4332). A rest request is kept on the
// wait it was made with, as data.rest and data.rest_until (the wait's until then), so a daemon restart keeps it; TS
// keeps it in memory, where a restart drops it. It lasts while that wait is open with the same until (a repeating
// wake_me that fired moved it on), until the agent's next turn starts (DropRestRequests).

// RestUntilKey and RestKey are the wait data members a rest request sets.
const (
	RestKey      = "rest"
	RestUntilKey = "rest_until"
)

type restRequestedEvent struct {
	Wait string `json:"wait"`
}

// RequestRest marks the agent's wait as asking for a rest at the agent's turn end, with the standing:rest-requested
// event. until is the wait's until as its creation returned it: a wait gone by then (cleared, or answered), or one whose
// until moved since (a repeating wake_me that fired), is left alone, and requested is false.
func (d *DB) RequestRest(ctx context.Context, agentID, waitID string, until *string) (requested bool, err error) {
	err = d.Write(ctx, func(conn *sqlite.Conn) error {
		ws, err := queryWaits(conn, "WHERE id = ? AND agent_id = ?", waitID, agentID)
		if err != nil || len(ws) == 0 || deref(ws[0].Until) != deref(until) || (ws[0].Until == nil) != (until == nil) {
			return err
		}
		data := waitObject(ws[0].Data)
		data.Set(RestKey, jsfmt.Value{Kind: jsfmt.Bool, Bool: true})
		if ws[0].Until != nil {
			data.Set(RestUntilKey, jsfmt.StringValue(*ws[0].Until))
		} else {
			data.Set(RestUntilKey, jsfmt.NullValue())
		}
		if err := runSQL(conn, "UPDATE waits SET data = ? WHERE id = ?", jsfmt.Compact(data), waitID); err != nil {
			return err
		}
		requested = true
		return insertEvent(conn, agentID, "standing:rest-requested", restRequestedEvent{Wait: waitID})
	})
	return requested, wrap("request rest", err)
}

// DropRestRequests is src/lifecycle.ts dropRestRequest: a turn starts, so the rest its last turn asked for is dropped;
// the new turn makes its own request, if any. It writes only when a request is there to drop.
func (d *DB) DropRestRequests(ctx context.Context, agentID string) (dropped int, err error) {
	var flagged bool
	if err := d.Read(ctx, func(conn *sqlite.Conn) error {
		ws, err := queryWaits(conn, "WHERE agent_id = ?", agentID)
		for _, w := range ws {
			flagged = flagged || restRequestOf(w)
		}
		return err
	}); err != nil || !flagged {
		return 0, wrap("drop rest requests", err)
	}
	err = d.Write(ctx, func(conn *sqlite.Conn) error {
		ws, err := queryWaits(conn, "WHERE agent_id = ?", agentID)
		if err != nil {
			return err
		}
		for _, w := range ws {
			if !restRequestOf(w) {
				continue
			}
			data := withoutKeys(waitObject(w.Data), RestKey, RestUntilKey)
			if err := runSQL(conn, "UPDATE waits SET data = ? WHERE id = ?", jsfmt.Compact(data), w.ID); err != nil {
				return err
			}
			dropped++
		}
		return nil
	})
	return dropped, wrap("drop rest requests", err)
}

// RestRequesters is the agents with a wait that asks for a rest, still open with the until it was asked with.
func (d *DB) RestRequesters(ctx context.Context) (ids []string, err error) {
	err = d.Read(ctx, func(conn *sqlite.Conn) error {
		ws, err := queryWaits(conn, "WHERE data LIKE '%\"rest\":true%' ORDER BY agent_id")
		for _, w := range ws {
			if restRequestOf(w) && (len(ids) == 0 || ids[len(ids)-1] != w.AgentID) {
				ids = append(ids, w.AgentID)
			}
		}
		return err
	})
	return ids, wrap("rest requesters", err)
}

// RestRequestOf is whether the wait asks for a rest that still holds: its until is the one the request was made with.
func RestRequestOf(w Wait) bool { return restRequestOf(w) }

func restRequestOf(w Wait) bool {
	if w.Data == nil || !strings.Contains(*w.Data, `"rest"`) {
		return false
	}
	data := waitObject(w.Data)
	if v, ok := data.Get(RestKey); !ok || v.Kind != jsfmt.Bool || !v.Bool {
		return false
	}
	u, ok := data.Get(RestUntilKey)
	if !ok {
		return false
	}
	if w.Until == nil {
		return u.Kind == jsfmt.Null
	}
	return u.Kind == jsfmt.String && u.Str == *w.Until
}

// waitObject is a wait's data as an object: an empty one for none or for text that isn't a JSON object.
func waitObject(raw *string) jsfmt.Value {
	if raw != nil && *raw != "" {
		if v, err := jsfmt.Parse([]byte(*raw)); err == nil && v.Kind == jsfmt.Object {
			return v
		}
	}
	return jsfmt.Value{Kind: jsfmt.Object}
}

func withoutKeys(v jsfmt.Value, keys ...string) jsfmt.Value {
	out := jsfmt.Value{Kind: jsfmt.Object}
	for i, k := range v.Keys {
		drop := false
		for _, x := range keys {
			drop = drop || k == x
		}
		if !drop {
			out.Keys, out.Items = append(out.Keys, k), append(out.Items, v.Items[i])
		}
	}
	return out
}

// RestOwnerJSON is the paused_by of a resting agent (src/lifecycle.ts REST_OWNER).
const RestOwnerJSON = `["standing-idle"]`

// Rest is the outcome of RestNow: Rested, or Refused naming the check that kept the agent up.
type Rest struct {
	Rested  bool
	Refused string
	// Reason is "wait" or "idle", and Wake the expected wake (ISO, "" for none), of a rest that happened.
	Reason, Wake string
}

type restEvent struct {
	IdleSince    *string `json:"idleSince"`
	Reason       string  `json:"reason"`
	ExpectedWake *string `json:"expectedWake"`
}

// RestNow is the write of src/lifecycle.ts rest for a requested rest, in one transaction that reads every durable
// check it makes, so the mail that answers the wait commits either before it (the rest sees the wait cleared, or the
// mail unpushed, and refuses) or after it (the mail finds the agent resting, and wakes it). The agent rests only when:
//   - it is active, idle or waiting since a time, with a workspace and a session, no pending action, not taken over;
//   - its turn ended delay ago or more (idle_since), and no push or prompt went to it since;
//   - a wait asks for the rest, still open with the until it was asked with, and no wait is the harness's own;
//   - it has no unpushed mail and no pending permission request.
//
// The agent is then paused with the rest as its one owner, with its activity unknown and the standing:rest event.
// idle_since stays: the tree-idle notice its parents may be owed is keyed by it.
func (d *DB) RestNow(ctx context.Context, id string, now time.Time, delay time.Duration) (out Rest, err error) {
	err = d.Write(ctx, func(conn *sqlite.Conn) error {
		var a Agent
		found := false
		if err := runSQLRows(conn, selectAgents+" WHERE id = ?", func(stmt *sqlite.Stmt) { a, found = scanAgent(stmt), true }, id); err != nil {
			return err
		}
		refuse := func(why string) error { out.Refused = why; return nil }
		switch {
		case !found:
			return refuse("no agent")
		case a.Lifecycle != "active":
			return refuse("not active")
		case a.Activity != "idle" && a.Activity != "waiting":
			return refuse("not idle")
		case a.IdleSince == nil || *a.IdleSince == "" || a.Workspace == nil || *a.Workspace == "" || a.SessionID == nil || *a.SessionID == "":
			return refuse("no idle time, workspace or session")
		case a.PendingAction != nil && *a.PendingAction != "" || a.ForwardedTo != nil && *a.ForwardedTo != "":
			return refuse("a pending action")
		}
		idle, perr := time.Parse(time.RFC3339Nano, *a.IdleSince)
		if perr != nil || now.Before(idle.Add(delay)) {
			return refuse("turn just ended")
		}
		ws, err := queryWaits(conn, "WHERE agent_id = ?", id)
		if err != nil {
			return err
		}
		requested := false
		for _, w := range ws {
			if w.Source != "declared" && w.Source != "stam" {
				return refuse("a harness wait")
			}
			requested = requested || restRequestOf(w)
		}
		if !requested {
			return refuse("no rest request")
		}
		if mail, err := unpushed(conn, id); err != nil || len(mail) > 0 {
			if err != nil {
				return err
			}
			return refuse("unpushed mail")
		}
		pending, err := rows(conn, "SELECT 1 FROM permission_requests WHERE agent_id = ? AND status = 'pending' LIMIT 1", id)
		if err != nil {
			return err
		}
		if len(pending) > 0 {
			return refuse("a pending permission request")
		}
		pushed, err := rows(conn, "SELECT 1 FROM events WHERE agent_id = ? AND type IN ('pushed', 'prompt:sent', 'view-prompt') AND ts >= ? LIMIT 1", id, *a.IdleSince)
		if err != nil {
			return err
		}
		if len(pushed) > 0 {
			return refuse("a pushed turn pending")
		}
		out.Rested, out.Reason = true, "idle"
		if len(ws) > 0 {
			out.Reason = "wait"
		}
		out.Wake = expectedWake(ws, now)
		detail := "resting: idle; mail or a notice wakes it"
		if out.Reason == "wait" {
			detail = "resting: waiting"
			if out.Wake != "" {
				t, _ := time.Parse(time.RFC3339Nano, out.Wake)
				detail += ", expected wake " + t.UTC().Format("15:04") + " UTC"
			}
			detail += "; mail or a notice wakes it"
		}
		if err := d.updateAgent(conn, id, []Field{{"lifecycle", "paused"}, {"paused_by", RestOwnerJSON}, {"activity", "unknown"},
			{"activity_detail", detail}, {"pending_action", nil}, {"idle_since", *a.IdleSince}}); err != nil {
			return err
		}
		var wake *string
		if out.Wake != "" {
			wake = &out.Wake
		}
		return insertEvent(conn, id, "standing:rest", restEvent{IdleSince: a.IdleSince, Reason: out.Reason, ExpectedWake: wake})
	})
	return out, wrap("rest", err)
}

// expectedWake is src/lifecycle.ts expectedWake: the soonest future time a wait is expected to wake the agent, a wake_me's
// fire time, a wait_for's timeout or its expect_minutes, as ISO; "" for none.
func expectedWake(ws []Wait, now time.Time) string {
	var soonest time.Time
	out := ""
	for _, w := range ws {
		times := []string{}
		if w.Until != nil {
			times = append(times, *w.Until)
		}
		if v, ok := waitObject(w.Data).Get("expect_at"); ok && v.Kind == jsfmt.String {
			times = append(times, v.Str)
		}
		for _, s := range times {
			t, err := time.Parse(time.RFC3339Nano, s)
			if err == nil && t.After(now) && (out == "" || t.Before(soonest)) {
				soonest, out = t, t.UTC().Format("2006-01-02T15:04:05.000Z")
			}
		}
	}
	return out
}

// UndoRest takes back a rest RestNow just wrote, while its harness still runs: a wake cause that arrived as the rest
// committed. Only an agent still resting as RestNow left it goes back to active and idle, with its idle_since; its waits
// make it waiting again (updateAgent).
func (d *DB) UndoRest(ctx context.Context, id, why string) (undone bool, err error) {
	err = d.Write(ctx, func(conn *sqlite.Conn) error {
		r, err := rows(conn, "SELECT lifecycle, paused_by, idle_since FROM agents WHERE id = ?", id)
		if err != nil || len(r) == 0 || r[0].Text("lifecycle") != "paused" || r[0].Text("paused_by") != RestOwnerJSON {
			return err
		}
		var since any
		if s := r[0].Text("idle_since"); s != "" {
			since = s
		}
		if err := d.updateAgent(conn, id, []Field{{"lifecycle", "active"}, {"paused_by", nil}, {"activity", "idle"}, {"activity_detail", nil},
			{"idle_since", since}}); err != nil {
			return err
		}
		undone = true
		return insertEvent(conn, id, "standing:rest-undone", struct {
			Why string `json:"why"`
		}{why})
	})
	return undone, wrap("undo rest", err)
}
