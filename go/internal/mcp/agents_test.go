package mcp

import (
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"testing"
)

// tempCwd is a spawn's defaulted cwd, each process's own temporary directory.
var tempCwd = regexp.MustCompile(`"cwd":"` + regexp.QuoteMeta(os.TempDir()) + `[^"]*"`)

// sameSpawns is sameCalls with the defaulted cwd of each process made one placeholder, kept in its place.
func sameSpawns(t *testing.T, ts, g result) {
	t.Helper()
	for _, l := range [][]seen{ts.calls, g.calls} {
		for i := range l {
			l[i].Raw = tempCwd.ReplaceAllString(l[i].Raw, `"cwd":"CWD"`)
		}
	}
	sameCalls(t, ts.calls, g.calls)
}

// agentList is GET /api/agents for the stub: one agent of each shape find_agents maps, whatever the query, so the tool's
// own filter decides.
const agentList = `[` +
	`{"id":"a1","name":"worker","role":"dev","type":"developer","harness":"claude","model":"m","machine":"m1","capabilities":"{\"image\":true,\"z\":[1]}","lifecycle":"active","activity":"working","resting":null,"standing":0,"personal_workspace":null,"paused_by":null,"waits":[],"blockers":[],"open_ask_detail":null},` +
	`{"id":"a2","name":"keeper","role":"spec","type":null,"harness":"codex","model":null,"machine":"m1","capabilities":null,"lifecycle":"active","activity":"idle","standing":1,"personal_workspace":"/h/workspaces/keeper/","load":{"context_tokens":900},"waits":[{"id":"w1","kind":"human","target":null,"detail":"d","since":"s","until":null,"extra":1}],"open_ask_detail":{"mail":"m3","kind":"decision"}},` +
	`{"id":"a3","name":"held","harness":"claude","machine":"m2","lifecycle":"paused","paused_by":"[\"human\"]","blockers":[{"kind":"cost","account":"claude","reason":"window","since":"s","clear":"reset","id":9}]},` +
	`{"id":"a4","name":"sleepy","harness":"claude","machine":"m1","lifecycle":"paused","resting":{"reason":"idle","expected_wake":null,"since":"x"},"paused_by":null},` +
	`{"id":"a5","name":"old","harness":"claude","machine":"m1","lifecycle":"archived","activity":"idle"}]`

// agentRoutes answers the agent routes for the stub daemon: the list find_agents asks for (with a state; namesOf asks
// without), the registry, a spawn by the name asked for, the
// agent-control actions, and the cancel of a queued spawn.
func agentRoutes(w http.ResponseWriter, r *http.Request, body any) bool {
	b, _ := body.(map[string]any)
	path := r.URL.Path
	switch {
	case r.Method == "GET" && path == "/api/agents" && r.URL.Query().Has("state"):
		io.WriteString(w, agentList)
	case r.Method == "GET" && path == "/api/registry":
		io.WriteString(w, `{"types":{"developer":{"when":"code"}},"harnesses":["claude"],"rule":"delegate"}`)
	case r.Method == "POST" && path == "/api/agents":
		switch b["name"] {
		case "ring":
			io.WriteString(w, `{"kind":"ring","ring":{"name":"ring","id":"r1","format":"rounds","max_rounds":3},"members":[{"name":"ring-1","type":"reviewer"},{"name":"ring-2","type":null}],"moderator":{"name":"ring-mod"}}`)
		case "q":
			io.WriteString(w, `{"queued":true,"name":"q","place":2,"queue_length":3,"urgent":"red-main","machine":"m1","cap":6,"holders":["d1","d2"],"holder_info":[{"name":"d1","age_ms":7800000,"activity":"working"},{"name":"d2","age_ms":null,"activity":null},{"name":"d3","age_ms":30000}]}`)
		case "q2":
			io.WriteString(w, `{"queued":true,"name":"q2","place":1,"queue_length":1,"machine":"m1","cap":6,"holders":["d1","d2"]}`)
		case "pr":
			io.WriteString(w, `{"id":"a9","name":"pr","cwd":"/w/pr","workspace":"{\"worktree\":{\"branch\":\"stam/x\",\"continues\":true},\"baseUsed\":{\"sha\":\"0123456789abcdef\"}}"}`)
		case "bad":
			w.WriteHeader(409)
			io.WriteString(w, `{"error":"name bad is taken"}`)
		default:
			io.WriteString(w, `{"id":"a8","name":"`+b["name"].(string)+`","cwd":"/w","workspace":"not json","warning":"no worktree"}`)
		}
	case r.Method == "POST" && path == "/api/slot-queue/q/cancel":
		io.WriteString(w, `{"name":"q","machine":"m1"}`)
	case r.Method == "POST" && strings.HasPrefix(path, "/api/agents/nope/"):
		w.WriteHeader(403)
		io.WriteString(w, `{"error":"a1 can only control itself or its children"}`)
	case r.Method == "POST" && strings.HasSuffix(path, "/forget"):
		io.WriteString(w, `{"result":"forgot w"}`)
	case r.Method == "POST" && path == "/api/agents/a1/workspace-share" && b["agent"] == "nobody":
		w.WriteHeader(400)
		io.WriteString(w, `{"error":"no agent nobody on this machine: a workspace folder is local, so it can only be shared with an agent on m1"}`)
	case r.Method == "POST" && path == "/api/agents/a1/workspace-share":
		io.WriteString(w, `{"message":"Shared /h/workspaces/worker with keeper (read)."}`)
	case r.Method == "POST" && path == "/api/agents/a1/reconnect-mcp":
		io.WriteString(w, `{"agent":{"name":"worker"},"result":"reconnected"}`)
	case r.Method == "POST" && path == "/api/agents/a2/reconnect-mcp":
		io.WriteString(w, `{"agent":{"name":"keeper"},"result":"scheduled"}`)
	case r.Method == "POST" && strings.HasPrefix(path, "/api/agents/"):
		parts := strings.Split(path, "/")
		io.WriteString(w, `{"agent":{"id":"x","name":"`+parts[3]+`-name"},"result":"`+parts[4]+` done"}`)
	default:
		return false
	}
	return true
}

// The agent tools send the daemon what src/mcp.ts sends (the caller as by and as, an argument not passed left out, a
// spawn's parent and cwd filled in) and say what it says, a refusal too.
func TestAgentToolsMatchTS(t *testing.T) {
	lines := []string{
		call(1, "find_agents", `{}`),
		call(2, "find_agents", `{"query":"old"}`),
		call(3, "find_agents", `{"query":"o l","role":"dev"}`),
		call(4, "find_agents", `{"state":"archived"}`),
		call(5, "find_agents", `{"state":"all","self":"spoof"}`),
		call(6, "registry_info", `{}`),
		call(7, "spawn_agent", `{"name":"w","self":"a1","type":"developer","visibility":{"reach":"tree"}}`),
		call(8, "spawn_agent", `{"name":"ring","parent":"none","cwd":"/x"}`),
		call(9, "spawn_agent", `{"name":"q","parent":"boss","by":"spoof","cwd":null}`),
		call(10, "spawn_agent", `{"name":"q2"}`),
		call(11, "spawn_agent", `{"name":"pr","machine":"m1"}`),
		call(12, "spawn_agent", `{"name":"bad"}`),
		call(13, "agent_control", `{"agent":"w","action":"archive","force":true,"note":"done","discard":false}`),
		call(14, "agent_control", `{"agent":"w","action":"set-child-notices","child_notices":"none"}`),
		call(15, "agent_control", `{"agent":"q","action":"cancel","note":"x"}`),
		call(16, "agent_control", `{"agent":"nope","action":"pause"}`),
		call(17, "agent_control", `{"agent":"w","action":"forget"}`),
		call(18, "agent_control", `{"agent":"w","action":"rename","name":"w2","parent":null}`),
		call(19, "compact_self", `{"instructions":"keep the plan","prompt_after":"go on"}`),
		call(20, "reconnect_mcp", `{}`),
		call(21, "workspace_share", `{"agent":"keeper","access":"read","self":"spoof"}`),
		call(22, "workspace_share", `{"agent":"nobody","access":"write"}`),
		call(23, "workspace_share", `{"access":"none"}`),
	}
	ts, g := both(t, map[string]string{"STAM_AGENT_ID": "a1", "STAM_MACHINE": "m1"}, lines, len(lines), 0, "")
	for id, want := range ts.byID {
		if g.byID[id] != want {
			t.Errorf("id %s differs\n ts: %s\n go: %s", id, want, g.byID[id])
		}
	}
	if len(g.byID) != len(ts.byID) || len(ts.byID) != len(lines) {
		t.Errorf("go answered %d calls, ts %d, want %d", len(g.byID), len(ts.byID), len(lines))
	}
	sameSpawns(t, ts, g)
	for _, want := range []string{`\"workspace\": \"keeper\"`, `\"paused_by\": [\n      \"human\",\n      \"stam\"\n    ]`, `\"state\": \"resting\"`,
		"Started ring ring (r1, rounds, up to 3 rounds). Members: ring-1 (reviewer), ring-2 (no type). Moderator: ring-mod (no type).",
		"Holders: d1 (2h10m, working), d2, d3 (30s).", "(urgent: red-main)", "Holders: d1, d2.", "On the existing PR branch stam/x at 01234567.",
		"Spawned w (a8) in /w.\\nWarning: no worktree", "name bad is taken", "w-name: archive done", "q: queued spawn cancelled on m1",
		"can only control itself", "reading 'name'", "Compaction is scheduled", "MCP servers reconnected.",
		"Shared /h/workspaces/worker with keeper (read).", "no agent nobody on this machine"} {
		found := false
		for _, l := range g.byID {
			found = found || strings.Contains(l, want)
		}
		if !found {
			t.Errorf("no answer holds %q", want)
		}
	}
}

// Without an agent id, the tools act as `self`: find_agents asks as it, and reconnect_mcp names it.
func TestAgentToolsAsSelf(t *testing.T) {
	lines := []string{
		call(1, "find_agents", `{"self":"a2","state":"active"}`),
		call(2, "reconnect_mcp", `{"self":"a2"}`),
		call(3, "spawn_agent", `{"name":"w"}`),
	}
	ts, g := both(t, map[string]string{}, lines, len(lines), 0, "")
	for id, want := range ts.byID {
		if g.byID[id] != want {
			t.Errorf("id %s differs\n ts: %s\n go: %s", id, want, g.byID[id])
		}
	}
	sameSpawns(t, ts, g)
	if !strings.Contains(g.byID["2"], "You will restart with reconnected MCP servers") || !strings.Contains(g.byID["3"], "Pass your stam id") {
		t.Errorf("answers = %v", g.byID)
	}
}
