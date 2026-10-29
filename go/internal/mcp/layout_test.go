package mcp

import (
	"strings"
	"testing"
)

// stubLayout is the stub daemon's layout: the home world current with a split, an agent's world, and a named world.
const stubLayout = `{"version":2,"current":"_home","agentWorlds":{"_home":{"root":{"id":"s1","split":"row","children":[{"id":"p1","tabs":["agent:a1","view:a1"],"active":"view:a1"},{"id":"s2","split":"col","children":[{"id":"p2","tabs":[],"active":null},{"id":"p3","tabs":["usage"],"active":"usage","showTabs":true}],"sizes":[1,2]}],"sizes":[1,1]},"focused":"p3"},"a9":{"root":{"id":"p_0","tabs":["agent:a9"],"active":"agent:a9"},"focused":"p_0"}},"worlds":{"w:config":{"root":{"id":"q","tabs":["config"],"active":"config"},"focused":"q","tree":"col"}}}`

// The layout tools answer as src/mcp.ts's do, byte for byte: layout_get's tree, layout_arrange's ops sent with the agent as by,
// an empty layout, and a stale base's error.
func TestLayoutToolsMatchTS(t *testing.T) {
	lines := []string{
		call(1, "layout_get", `{}`),
		call(2, "layout_arrange", `{"base":2,"ops":[{"op":"focus","world":"main","pane":"p1"}]}`),
		call(3, "layout_arrange", `{"base":1,"ops":[{"op":"focus","world":"main","pane":"p1"}]}`),
		call(4, "layout_arrange", `{"ops":[]}`),
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
	for id, want := range map[string]string{"1": `pane p3 (focused)`, "2": `Layout version 3, current: home`, "3": `version 2, not the base 1`} {
		if !strings.Contains(g.byID[id], want) {
			t.Errorf("id %s: %s, want %q in it", id, g.byID[id], want)
		}
	}
}
