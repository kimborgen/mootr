package server

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// TestStageKindsMatchesTS: a stage field narrowed to kinds steps the same on the Go daemon as in src/itsa.ts (S-3233). Closing an
// ITSA of a listed kind moves its stage to the end node and closing one of another kind leaves it, and the one-off backfill does
// the same. The process ends both kinds at done, so an ITSA of the other kind would move if the kinds were ignored. testdata/stagekinds-ref.mjs runs the steps through src/itsa.ts, and here they run through the routes and the backfill,
// and the stage of each ITSA and the backfill's count are compared.
func TestStageKindsMatchesTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to run src/itsa.ts")
	}
	home := filepath.Join(t.TempDir(), "home")
	must(t, os.Mkdir(home, 0o700))
	if out, err := exec.Command("node", "--no-warnings", "testdata/stagekinds-ref.mjs", home).CombinedOutput(); err != nil {
		t.Fatalf("stagekinds-ref.mjs: %v\n%s", err, out)
	}
	raw, err := os.ReadFile(filepath.Join(home, "expect.json"))
	must(t, err)
	var want struct {
		Stages     map[string]any `json:"stages"`
		Backfilled int            `json:"backfilled"`
	}
	must(t, json.Unmarshal(raw, &want))

	// The flow process, also for the kind other, so an ITSA of that kind has an end node the stage's kinds must keep it from.
	f := flowFixtureOf(t, `{}`, strings.Replace(flowYAML, "kind: [work]", "kind: [work, other]", 1))
	ctx := context.Background()
	stages := map[string]any{}
	// The stage field, narrowed to `work` as src/itsa.ts's updateField does: the stored kinds list.
	narrow := func() { f.sql(`UPDATE itsa_fields SET kinds = '["work"]' WHERE id = 'fstage'`) }
	a := f.createItsa(`{"title":"a","kind":"work"}`)
	b := f.createItsa(`{"title":"b","kind":"other"}`)
	c := f.createItsa(`{"title":"c","kind":"work"}`)
	e := f.createItsa(`{"title":"e","kind":"other"}`)
	for _, key := range []string{a, b, c, e} {
		f.setStage(key, `"draft"`)
	}
	narrow()
	for _, key := range []string{a, b} {
		if rec := f.post2("PATCH", "/api/itsas/"+key, `{"status":"done"}`); rec.Code != 200 {
			t.Fatalf("close %s: %d %s", key, rec.Code, rec.Body.String())
		}
	}
	stages["a"], stages["b"] = f.stageOf(a), f.stageOf(b)

	// The backfill: closed ITSAs whose stage was set before the close, one of each kind.
	f.sql("UPDATE itsas SET status = 'done' WHERE key IN (?, ?)", c, e)
	n, ok, err := f.srv.db.BackfillClosedStage(ctx, f.srv.closeNodeOfKind, []string{"work", "other"}, f.srv.isClosedStatus)
	must(t, err)
	if !ok {
		t.Fatal("the backfill did not run")
	}
	stages["c"], stages["e"] = f.stageOf(c), f.stageOf(e)

	if !reflect.DeepEqual(stages, want.Stages) || n != want.Backfilled {
		t.Errorf("the Go daemon steps the stage differently from src/itsa.ts:\n go: %v, backfilled %d\n ts: %v, backfilled %d", stages, n, want.Stages, want.Backfilled)
	}
}
