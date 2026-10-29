package agentview

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"stam/internal/jsjson"
)

// The parity of OpenCode's pure view parts with src/adapters/opencode-view.ts (fromOpenCode, permissionOf, applyEvent):
// testdata/viewref.mjs runs TS's over the same cases. The answers are compared as JSON values, not as bytes: TS writes a
// tool part's keys in the order its code set them (a live part gets `input` after `status`), which no client reads. A
// message made live takes its time from the daemon's clock (and so do its marks), so those are left out of the live steps.

func ocFixture(t *testing.T) map[string]any {
	t.Helper()
	b, err := os.ReadFile("../../../test/fixtures/opencode-view.json")
	if err != nil {
		t.Fatal(err)
	}
	var fx map[string]any
	if err := json.Unmarshal(b, &fx); err != nil {
		t.Fatal(err)
	}
	return fx
}

// ocMessages are stored messages of every type the view knows, and some it doesn't, with the fields each reads missing or
// odd as well as present.
func ocMessages() []any {
	obj := func(kv ...any) map[string]any {
		m := map[string]any{}
		for i := 0; i < len(kv); i += 2 {
			m[kv[i].(string)] = kv[i+1]
		}
		return m
	}
	at := func(n float64) map[string]any { return obj("created", n) }
	return []any{
		obj("id", "u1", "type", "user", "text", "hello", "time", at(5)),
		obj("id", "u2", "type", "user", "time", at(6)),
		obj("id", "s1", "type", "synthetic", "text", "[stam] mail", "time", at(7)),
		obj("id", "y1", "type", "system", "text", "reminder", "time", at(8)),
		obj("id", "k1", "type", "skill", "name", "review", "time", at(9)),
		obj("id", "k2", "type", "skill", "skill", "lint", "time", at(9)),
		obj("id", "k3", "type", "skill", "time", at(9)),
		obj("id", "h1", "type", "shell", "shellID", "sh1", "command", "ls", "status", "exited", "exit", 0, "output", obj("output", "a\nb"), "time", at(10)),
		obj("id", "h2", "type", "shell", "command", "false", "status", "exited", "exit", 1, "time", at(10)),
		obj("id", "h3", "type", "shell", "status", "running", "time", at(10)),
		obj("id", "c1", "type", "compaction", "status", "failed", "error", obj("message", "no room"), "time", at(11)),
		obj("id", "c2", "type", "compaction", "status", "failed", "time", at(11)),
		obj("id", "c3", "type", "compaction", "status", "running", "time", at(11)),
		obj("id", "c4", "type", "compaction", "status", "done", "time", at(11)),
		obj("id", "i1", "type", "idle", "outcome", "succeeded", "time", at(12)),
		obj("id", "i2", "type", "idle", "outcome", "interrupted", "time", at(12)),
		obj("id", "i3", "type", "idle", "outcome", "failed", "time", at(12)),
		obj("id", "m1", "type", "model-switched", "model", obj("providerID", "openrouter", "id", "x"), "time", at(13)),
		obj("id", "m2", "type", "model-switched", "time", at(13)),
		obj("id", "g1", "type", "agent-switched", "agent", "build", "time", at(14)),
		obj("id", "x1", "type", "unknown", "time", at(15)),
		obj("id", "a1", "type", "assistant", "time", obj("created", 20, "completed", 30), "content", []any{
			obj("type", "text", "text", "hi", "time", at(21)),
			obj("type", "reasoning", "text", "think"),
			obj("type", "tool", "id", "t1", "name", "bash", "time", at(19), "state", obj("status", "completed", "input", obj("command", "ls"), "content", []any{obj("text", "out"), obj("type", "x")})),
			obj("type", "tool", "id", "t2", "name", "bash", "state", obj("status", "error", "error", obj("message", "boom"))),
			obj("type", "tool", "id", "t3", "name", "bash", "state", obj("status", "running")),
			obj("type", "tool", "id", "t4", "name", "bash", "state", obj("status", "weird", "content", "plain")),
			obj("type", "step-start"),
		}),
		obj("id", "a2", "type", "assistant", "time", at(40), "error", obj("type", "Overloaded"), "content", []any{}),
		obj("id", "a3", "type", "assistant", "time", obj("created", 50, "completed", 60), "error", "plain error"),
	}
}

func ocPermissions() []any {
	return []any{
		map[string]any{"id": "p1", "action": "bash", "resources": []any{"ls", "pwd"}, "source": map[string]any{"messageID": "a1", "id": "t1"}},
		map[string]any{"id": "p2"},
		map[string]any{"id": "p3", "action": "edit", "resources": []any{"f"}},
	}
}

// ocEvents are the captured session's events, and the live ones the fixture lacks (a failed tool, a step ended on a
// message the store lacks, an answer for a permission that wasn't asked, a stream with no ordinal).
func ocEvents(t *testing.T) []any {
	fx := ocFixture(t)
	events, _ := fx["events"].([]any)
	m := func(typ string, d map[string]any) any { return map[string]any{"type": typ, "data": d} }
	extra := []any{
		m("session.text.delta", map[string]any{"assistantMessageID": "live1", "delta": "a"}),
		m("session.text.delta", map[string]any{"assistantMessageID": "live1", "ordinal": 0, "delta": "b"}),
		m("session.text.ended", map[string]any{"assistantMessageID": "live1", "ordinal": 0, "text": "final"}),
		m("session.reasoning.started", map[string]any{"assistantMessageID": "live1", "ordinal": 0}),
		m("session.tool.input.started", map[string]any{"assistantMessageID": "live1", "id": "tx", "name": "grep"}),
		m("session.tool.called", map[string]any{"assistantMessageID": "live1", "id": "tx", "input": map[string]any{"q": 1}}),
		m("session.tool.called", map[string]any{"assistantMessageID": "live1", "id": "ty"}),
		m("session.tool.failed", map[string]any{"assistantMessageID": "live1", "id": "tx", "error": map[string]any{"type": "Boom"}}),
		m("session.tool.failed", map[string]any{"assistantMessageID": "live1", "id": "ty"}),
		m("session.tool.success", map[string]any{"assistantMessageID": "live1", "id": "tz", "content": []any{map[string]any{"text": "z"}}}),
		m("permission.asked", map[string]any{"id": "pq", "action": "bash", "resources": []any{"x"}, "source": map[string]any{"messageID": "live1", "id": "tx"}}),
		m("permission.asked", map[string]any{"id": "pq", "action": "bash"}),
		m("permission.asked", map[string]any{"id": "pr", "action": "edit"}),
		m("permission.replied", map[string]any{"requestID": "pq", "reply": "always"}),
		m("permission.replied", map[string]any{"requestID": "nope", "reply": "reject"}),
		m("session.step.ended", map[string]any{"assistantMessageID": "live1"}),
		m("session.step.ended", map[string]any{"assistantMessageID": "never"}),
		m("session.step.ended", map[string]any{}),
		m("session.execution.started", map[string]any{}),
		m("session.execution.interrupted", map[string]any{}),
		m("session.execution.failed", map[string]any{}),
		m("session.compaction.started", map[string]any{}),
		m("session.usage.updated", map[string]any{}),
		m("something.else", nil),
	}
	return append(events, extra...)
}

// ocNorm drops what the daemon's clock decides (a live message's time and marks) and the empty marks TS writes and Go
// leaves out.
func ocNorm(v any, live bool) any {
	switch x := v.(type) {
	case map[string]any:
		if live {
			delete(x, "marks")
			if _, ok := x["role"]; ok {
				x["at"] = 0.0
			}
		}
		if mk, ok := x["marks"].([]any); ok && len(mk) == 0 {
			delete(x, "marks")
		}
		for k, e := range x {
			x[k] = ocNorm(e, live)
		}
	case []any:
		for i, e := range x {
			x[i] = ocNorm(e, live)
		}
	}
	return v
}

func TestOpenCodePureMatchesTS(t *testing.T) {
	msgs, perms, events := ocMessages(), ocPermissions(), ocEvents(t)
	if fx := ocFixture(t); fx != nil {
		if m, ok := fx["messages"].(map[string]any); ok {
			msgs = append(msgs, m["data"].([]any)...)
		}
	}
	// What each case is: stored messages, permissions and events as TS reads them, and as Go does.
	ts := runRef(t, []map[string]any{{"kind": "opencode", "messages": msgs, "permissions": perms, "events": events}})
	var want map[string]any
	if err := json.Unmarshal([]byte(ts[0]), &want); err != nil {
		t.Fatal(err)
	}

	// Go's side, over the same JSON.
	raw, err := json.Marshal(map[string]any{"messages": msgs, "permissions": perms, "events": events})
	if err != nil {
		t.Fatal(err)
	}
	pv, err := jsjson.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	in := pv.(*jsjson.Object)
	list := func(key string) []any { v, _ := in.Get(key); l, _ := v.([]any); return l }
	got := map[string]any{}
	var gm []any
	for _, m := range list("messages") {
		if v := FromOpenCode(m); v != nil {
			gm = append(gm, v)
		} else {
			gm = append(gm, nil)
		}
	}
	got["messages"] = gm
	var gp []any
	for _, p := range list("permissions") {
		gp = append(gp, PermissionOf(p))
	}
	got["perms"] = gp
	var steps []any
	store := &Store{}
	for _, e := range list("events") {
		eo := e.(*jsjson.Object)
		typ, _ := eo.Get("type")
		d, _ := eo.Get("data")
		r := ApplyEvent(store, typ.(string), objOf(d))
		msgsOut := store.Messages
		if msgsOut == nil {
			msgsOut = []*Message{}
		}
		permsOut := store.Permissions
		if permsOut == nil {
			permsOut = []*Permission{}
		}
		// Written now: later events change the messages in place.
		snap, err := json.Marshal(map[string]any{"r": r, "messages": msgsOut, "permissions": permsOut, "running": store.Running})
		if err != nil {
			t.Fatal(err)
		}
		steps = append(steps, json.RawMessage(snap))
	}
	got["steps"] = steps
	gb, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var have map[string]any
	if err := json.Unmarshal(gb, &have); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"messages", "perms"} {
		if !reflect.DeepEqual(ocNorm(have[k], false), ocNorm(want[k], false)) {
			a, _ := json.Marshal(ocNorm(have[k], false))
			b, _ := json.Marshal(ocNorm(want[k], false))
			t.Errorf("%s differ:\n%s", k, firstDiff(string(a), string(b)))
		}
	}
	hs, ws := have["steps"].([]any), want["steps"].([]any)
	if len(ws) < 45 || len(want["messages"].([]any)) < 25 {
		t.Fatalf("TS gave %d steps and %d messages: the case is too small to mean anything", len(ws), len(want["messages"].([]any)))
	}
	if len(hs) != len(ws) {
		t.Fatalf("%d steps, TS %d", len(hs), len(ws))
	}
	for i := range ws {
		if !reflect.DeepEqual(ocNorm(hs[i], true), ocNorm(ws[i], true)) {
			a, _ := json.Marshal(ocNorm(hs[i], true))
			b, _ := json.Marshal(ocNorm(ws[i], true))
			t.Errorf("event %d (%v): %s", i, list("events")[i].(*jsjson.Object).Keys(), firstDiff(string(a), string(b)))
			break
		}
	}
}
