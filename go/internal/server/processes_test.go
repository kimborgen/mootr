package server

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"stam/internal/jsfmt"
	"stam/internal/process"
)

// GET /api/processes against src/daemon.ts processRoute: the checkout's processes/ parsed against the registry's agent types and
// the ITSA statuses, the live counts over a fixed set of ITSAs, and the sources, byte for byte.
func TestProcessesRouteMatchesTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to run src/process.ts")
	}
	home := filepath.Join(t.TempDir(), "ref")
	itsasFile := "testdata/proc-itsas.json"
	if out, err := exec.Command("node", "--no-warnings", "testdata/procref.mjs", home, itsasFile).CombinedOutput(); err != nil {
		t.Fatalf("procref.mjs: %v\n%s", err, out)
	}
	raw, err := os.ReadFile(filepath.Join(home, "expect.json"))
	must(t, err)
	want, err := jsfmt.Parse(raw)
	must(t, err)

	f := newFixture(t, nil)
	data, err := os.ReadFile(itsasFile)
	must(t, err)
	var itsas []struct {
		Key, ID, Title, Status string
		Kind, Stage, Owner     *string
	}
	must(t, json.Unmarshal(data, &itsas))
	f.sql("INSERT INTO itsa_fields (id, key, label, type, width, align, card, position, created_by, created_at, updated_at) VALUES ('fstage', 'stage', 'Stage', 'text', 'm', 'left', 'show', 99, 'human', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z')")
	ownerID := map[string]string{"child": "achild", "boss": "aboss"}
	for i, x := range itsas {
		owner := any(nil)
		if x.Owner != nil {
			owner = *x.Owner
			if id, ok := ownerID[*x.Owner]; ok {
				owner = id
			}
		}
		kind := any(nil)
		if x.Kind != nil {
			kind = *x.Kind
		}
		ts := "2026-10-21T00:00:0" + string(rune('0'+i)) + ".000Z"
		f.sql("INSERT INTO itsas (id, key, title, status, kind, owner, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'human', ?, ?)", x.ID, x.Key, x.Title, x.Status, kind, owner, ts, ts)
		if x.Stage != nil {
			f.sql("INSERT INTO itsa_field_values (itsa_id, field_id, value, updated_at) VALUES (?, 'fstage', ?, ?)", x.ID, `"`+*x.Stage+`"`, ts)
		}
	}
	rec := f.post2("GET", "/api/processes", "")
	if rec.Code != 200 {
		t.Fatalf("GET /api/processes: %d %s", rec.Code, rec.Body.String())
	}
	got, err := jsfmt.Parse(rec.Body.Bytes())
	must(t, err)
	resp, _ := want.Get("response")
	if !strings.Contains(jsfmt.Compact(resp), `"count":2`) || !strings.Contains(jsfmt.Compact(resp), `"owner":null`) {
		t.Errorf("the fixture counts nothing: %.500s", jsfmt.Compact(resp))
	}
	if g, w := jsfmt.Compact(got), jsfmt.Compact(resp); g != w {
		t.Errorf("GET /api/processes differs\n go: %.3000s\n ts: %.3000s", g, w)
	}

	// The next-step text of each type, the stage rules and the close nodes, over the same processes.
	loaded, err := f.srv.processesHere()
	must(t, err)
	steps, _ := want.Get("steps")
	for i, typ := range steps.Keys {
		for j, p := range loaded.Processes {
			if g, w := process.RenderNextSteps(p, typ), steps.Items[i].Items[j].Str; g != w {
				t.Errorf("next steps of %s in %s:\n go: %q\n ts: %q", typ, p.ID, g, w)
			}
		}
	}
	fallbacks, _ := want.Get("fallbacks")
	for i, typ := range fallbacks.Keys {
		if g, w := process.FallbackNextSteps(typ), fallbacks.Items[i].Str; g != w {
			t.Errorf("fallback next steps of %s:\n go: %q\n ts: %q", typ, g, w)
		}
	}
	if len(fallbacks.Keys) == 0 {
		t.Errorf("no fallbacks dumped")
	}
	// The {{next_steps}} of a brief: the process's text for the type, else the fallback prose.
	briefs, _ := want.Get("briefs")
	nonEmpty := 0
	for i, typ := range briefs.Keys {
		g, w := process.NextSteps(loaded.Processes, typ), briefs.Items[i].Str
		if g != w {
			t.Errorf("next steps of a %s brief:\n go: %q\n ts: %q", typ, g, w)
		}
		if w != "" {
			nonEmpty++
		}
	}
	if nonEmpty == 0 {
		t.Errorf("no brief has next steps")
	}
	refusals, _ := want.Get("refusals")
	byID := map[string]*process.Def{}
	for _, p := range loaded.Processes {
		byID[p.ID] = p
	}
	for _, r := range refusals.Items {
		p := byID[r.Items[0].Str]
		why := process.StageRefusal(p, r.Items[1].Str, r.Items[2].Str)
		wantWhy := ""
		if r.Items[3].Kind == jsfmt.String {
			wantWhy = r.Items[3].Str
		}
		if why != wantWhy {
			t.Errorf("stage %s %q -> %q:\n go: %q\n ts: %q", p.ID, r.Items[1].Str, r.Items[2].Str, why, wantWhy)
		}
	}
	closeNodes, _ := want.Get("closeNodes")
	for _, c := range closeNodes.Items {
		wantNode := ""
		if c.Items[1].Kind == jsfmt.String {
			wantNode = c.Items[1].Str
		}
		if g := process.CloseNodeOf(byID[c.Items[0].Str], f.srv.isClosedStatus); g != wantNode {
			t.Errorf("close node of %s: %q, ts %q", c.Items[0].Str, g, wantNode)
		}
	}
	if strings.TrimSpace(jsfmt.Compact(steps)) == "{}" {
		t.Errorf("no agent types in the registry")
	}
}

// A process proposal on a daemon whose settings name no GitHub repo is a 501 before it writes (TS reads the checkout's origin).
func TestProcessProposalNoRepo(t *testing.T) {
	f := newFixture(t, nil)
	before := f.count("SELECT count(*) FROM itsas")
	text, err := os.ReadFile("../../../processes/dev-change.yaml")
	must(t, err)
	body, _ := json.Marshal(map[string]string{"yaml": string(text), "summary": "y"})
	rec := f.post2("POST", "/api/processes/dev-change/proposal", string(body))
	if rec.Code != 501 || f.count("SELECT count(*) FROM itsas") != before {
		t.Errorf("proposal: %d %s", rec.Code, rec.Body.String())
	}
}

func TestProcessesFixtureIsNotVacuous(t *testing.T) {
	f := newFixture(t, nil)
	loaded, err := f.srv.processesHere()
	must(t, err)
	if len(loaded.Processes) < 2 || len(loaded.Errors) != 0 {
		t.Fatalf("processes %d, errors %v", len(loaded.Processes), loaded.Errors)
	}
	for _, p := range loaded.Processes {
		if len(p.NodeIDs) < 5 || len(p.Edges) < 5 {
			t.Errorf("%s: %d nodes, %d edges", p.ID, len(p.NodeIDs), len(p.Edges))
		}
	}
}
