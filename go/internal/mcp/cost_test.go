package mcp

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

// costStub answers the cost routes for the stub daemon, by the request's tree, agent or event.
func costStub(w http.ResponseWriter, path string, body any) {
	b, _ := body.(map[string]any)
	switch {
	case b["tree"] == "nope" || b["agent"] == "nope" || b["event"] == "nope":
		w.WriteHeader(403)
		io.WriteString(w, `{"error":"a1 may only act inside its own tree"}`)
	case path == "/api/cost/allocate" && b["clear"] == true:
		if b["id"] == "al1" {
			io.WriteString(w, `{"cleared":1}`)
		} else {
			io.WriteString(w, `{"cleared":0}`)
		}
	case path == "/api/cost/allocate" && b["kind"] == "usd":
		io.WriteString(w, `{"allocation":{"id":"al1","tree":"t1","account":"openrouter","kind":"usd","amount":2.5,"period":"week"}}`)
	case path == "/api/cost/allocate":
		io.WriteString(w, `{"allocation":{"id":"al2","tree":"t1","account":"claude","kind":"window","window":"five_hour","percent":20},"warning":"t1's children now allocate 120% of its own."}`)
	case path == "/api/cost/ack":
		io.WriteString(w, `{"ok":true,"event":"cn-1","by":"a1","acked_at":"2026-10-02T00:00:00.000Z"}`)
	case path == "/api/cost/switch" && b["agent"] == "busy":
		io.WriteString(w, `{"status":"quiescing","from":"busy","to":"busy-t2","preset":"cheap","minutes":10}`)
	case path == "/api/cost/switch":
		io.WriteString(w, switchReply(b["agent"] == "w"))
	case path == "/api/cost/pause" && b["clear"] == true:
		io.WriteString(w, `{"action":"cleared","root":"t1","agents":["t1"],"acked":[]}`)
	case path == "/api/cost/pause":
		io.WriteString(w, `{"action":"paused","root":"t1","agents":["t1","c1"],"until":"2026-10-12T09:00:00.000Z","acked":["cn-1","cn-2"]}`)
	}
}

func switchReply(first bool) string {
	if first {
		return `{"from":"w","to":"w-t2","preset":"cheap","moved":{"children":["c1"],"threads":3,"unread":1},"interrupted":true,"handover":false}`
	}
	return `{"from":"v","to":"v-t2","preset":"cheap","moved":{"children":[],"threads":0,"unread":2},"interrupted":false,"handover":true}`
}

// The cost tools send the daemon what src/mcp.ts sends (self dropped, by the caller, an argument not passed left out) and
// say what it says, a refusal too.
func TestCostToolsMatchTS(t *testing.T) {
	lines := []string{
		call(1, "cost_allocate", `{"tree":"t1","account":"claude","kind":"window","window":"five_hour","percent":20,"self":"a1"}`),
		call(2, "cost_allocate", `{"tree":"t1","account":"openrouter","kind":"usd","amount":2.5,"period":"week","note":"é"}`),
		call(3, "cost_allocate", `{"clear":true,"id":"al1"}`),
		call(4, "cost_allocate", `{"clear":true,"tree":"t1","by":"spoof"}`),
		call(5, "cost_allocate", `{"tree":"nope","kind":"usd"}`),
		call(6, "cost_ack", `{"event":"cn-1"}`),
		call(7, "cost_ack", `{"event":"nope"}`),
		call(8, "cost_switch", `{"agent":"busy","preset":"cheap","soft_stop_minutes":5}`),
		call(9, "cost_switch", `{"agent":"w","preset":"cheap"}`),
		call(10, "cost_switch", `{"agent":"v","preset":"cheap"}`),
		call(11, "cost_switch", `{"agent":"nope","preset":"cheap"}`),
		call(12, "cost_pause", `{"tree":"t1","until":"reset","account":"claude","window":"five_hour","reason":"window"}`),
		call(13, "cost_pause", `{"tree":"t1","clear":true}`),
		call(14, "cost_pause", `{"tree":"nope"}`),
		call(15, "usage_info", `{}`),
		call(16, "usage_info", `{"days":30,"tree":"t 1/é"}`),
		call(17, "usage_info", `{"days":null,"tree":""}`),
		call(18, "usage_info", `{"tree":"nope"}`),
		call(19, "usage_info", `{"detail":true}`),
		call(20, "usage_info", `{"detail":true,"days":30}`),
		call(21, "usage_info", `{"detail":false}`),
		call(22, "usage_info", `{"detail":"yes"}`),
	}
	ts, g := both(t, map[string]string{"STAM_AGENT_ID": "a1"}, lines, len(lines), 0, "")
	for id, want := range ts.byID {
		if g.byID[id] != want {
			t.Errorf("id %s differs\n ts: %s\n go: %s", id, want, g.byID[id])
		}
	}
	if len(g.byID) != len(ts.byID) || len(ts.byID) != len(lines) {
		t.Errorf("go answered %d calls, ts %d, want %d", len(g.byID), len(ts.byID), len(lines))
	}
	sameCalls(t, ts.calls, g.calls)
	for _, want := range []string{"Allocation al2 on t1: 20% of claude five-hour.", "$2.5/week", "Cleared 1 allocation.", "Cleared 0 allocations.",
		"busy is finishing its step (up to 10 minutes)", "(1 children, 3 threads, 1 unread mails; its turn was interrupted; no HANDOVER.md)",
		"Paused 2 agents in t1's tree: 2026-10-12T09:00:00.000Z; acknowledged 2 cost notices.", "Cleared the cost pause on t1's tree (1 agent).",
		"may only act inside its own tree", `\"see_also\": \"For time and bottlenecks, call activity_info.\"`, `\"days\": \"30\"`, `\"own_tree\"`, `\"other_trees\"`, `\"omitted\"`, "not nope's"} {
		found := false
		for _, l := range g.byID {
			found = found || strings.Contains(l, want)
		}
		if !found {
			t.Errorf("no answer holds %q", want)
		}
	}
}
