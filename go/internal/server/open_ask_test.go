package server

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"stam/internal/jsfmt"
)

// sameJSON is the value's JSON with its object keys sorted: the wire order of a detail's keys is the schema's, not TS's.
func sameJSON(v jsfmt.Value) string {
	var x any
	if err := json.Unmarshal([]byte(jsfmt.Compact(v)), &x); err != nil {
		return "invalid: " + err.Error()
	}
	b, _ := json.Marshal(x)
	return string(b)
}

// TestOpenAskMatchesTS builds the asks home of testdata/asksref.mjs through src/ and compares the open ask each agent and ITSA
// waits on (src/asks.ts openAskLinks, as src/daemon.ts GET /api/agents and GET /api/itsas/:ref carry it: open_ask,
// open_ask_detail) with the Go server's answers on a copy of it (S-4021). The home holds a permission request, a dialog, and a
// settings change open for one agent, an open decision mail older than them, a wait on the human through a waiting ITSA, a wait
// through a settled ITSA (no ask), and ITSAs open, approved, withdrawn and answered.
func TestOpenAskMatchesTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to run src/asks.ts")
	}
	home := filepath.Join(t.TempDir(), "home")
	must(t, os.Mkdir(home, 0o700))
	if out, err := exec.Command("node", "--no-warnings", "testdata/asksref.mjs", home).CombinedOutput(); err != nil {
		t.Fatalf("asksref.mjs: %v\n%s", err, out)
	}
	raw, err := os.ReadFile(filepath.Join(home, "open-ask.json"))
	must(t, err)
	want, err := jsfmt.Parse(raw)
	must(t, err)
	wantAgents, _ := want.Get("agents")
	wantItsas, _ := want.Get("itsas")
	if len(wantAgents.Keys) < 3 || len(wantItsas.Keys) < 4 {
		t.Fatalf("the reference has %d agents and %d ITSAs", len(wantAgents.Keys), len(wantItsas.Keys))
	}

	f := newFixtureFrom(t, nil, filepath.Join(home, "stam.pre.db"))
	writeFile(t, filepath.Join(f.home, "settings.json"), `{"itsa":{"ownerNotices":"off"}}`)

	rec := f.post2("GET", "/api/agents?state=all", "")
	if rec.Code != 200 {
		t.Fatalf("GET /api/agents: %d %s", rec.Code, rec.Body)
	}
	agents, err := jsfmt.Parse(rec.Body.Bytes())
	must(t, err)
	seen := 0
	for _, row := range agents.Items {
		id := row.Text("id")
		w, ok := wantAgents.Get(id)
		if !ok {
			continue
		}
		seen++
		for _, k := range []string{"open_ask", "open_ask_detail"} {
			g, _ := row.Get(k)
			e, _ := w.Get(k)
			if sameJSON(g) != sameJSON(e) {
				t.Errorf("agent %s %s:\n go %s\n ts %s", id, k, sameJSON(g), sameJSON(e))
			}
		}
	}
	if seen != len(wantAgents.Keys) {
		t.Errorf("GET /api/agents listed %d of the reference's %d agents", seen, len(wantAgents.Keys))
	}

	for _, id := range wantItsas.Keys {
		rec := f.post2("GET", "/api/itsas/"+id, "")
		if rec.Code != 200 {
			t.Fatalf("GET /api/itsas/%s: %d %s", id, rec.Code, rec.Body)
		}
		x, err := jsfmt.Parse(rec.Body.Bytes())
		must(t, err)
		g, _ := x.Get("open_ask_detail")
		e, _ := wantItsas.Get(id)
		if sameJSON(g) != sameJSON(e) {
			t.Errorf("itsa %s open_ask_detail:\n go %s\n ts %s", id, sameJSON(g), sameJSON(e))
		}
	}
}
