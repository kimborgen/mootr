package lifecycle

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os/exec"
	"testing"
	"time"

	"stam/internal/db"
)

// stuckCase is one decision of the stuck-start check (S-3250): the agent, its ops, then settleStart (check "settle") or
// startStalled (check "stall") at its alive pane and minutes from now. row "peer" reads the agent as another machine does.
// testdata/stuckref.mjs runs the same cases on src/lifecycle.ts.
type stuckCase struct {
	Name    string   `json:"name"`
	Ops     []string `json:"ops"`
	Check   string   `json:"check"`
	Alive   bool     `json:"alive"`
	Minutes float64  `json:"minutes"`
	Row     string   `json:"row,omitempty"`
}

var stuckCases = []stuckCase{
	{Name: "settle-ready", Ops: []string{"resume"}, Check: "settle", Alive: true},
	{Name: "settle-dead-pane", Ops: []string{"resume"}, Check: "settle"},
	{Name: "settle-with-prompt", Ops: []string{"resume", "with-prompt"}, Check: "settle", Alive: true},
	{Name: "settle-cost-held", Ops: []string{"resume", "block"}, Check: "settle", Alive: true},
	{Name: "settle-paused", Ops: []string{"resume", "pause"}, Check: "settle", Alive: true},
	{Name: "settle-pending-stop", Ops: []string{"resume", "pending-archive"}, Check: "settle", Alive: true},
	{Name: "stall-under-bound", Ops: []string{"resume"}, Check: "stall", Alive: true, Minutes: 10},
	{Name: "stall-past-bound", Ops: []string{"resume"}, Check: "stall", Alive: true, Minutes: 20},
	{Name: "stall-working", Ops: []string{"resume", "working"}, Check: "stall", Alive: true, Minutes: 20},
	{Name: "stall-cost-held", Ops: []string{"resume", "block"}, Check: "stall", Alive: true, Minutes: 20},
	{Name: "stall-paused", Ops: []string{"resume", "pause"}, Check: "stall", Alive: true, Minutes: 20},
	{Name: "stall-other-machine", Ops: []string{"resume"}, Check: "stall", Alive: true, Minutes: 20, Row: "peer"},
	{Name: "stall-dead-pane", Ops: []string{"resume"}, Check: "stall", Minutes: 20},
	{Name: "stall-pending-stop", Ops: []string{"resume", "pending-archive"}, Check: "stall", Alive: true, Minutes: 20},
}

func dbField(col string, val any) db.Field { return db.Field{Col: col, Val: val} }

// stuckOp applies one of a stuckCase's ops to the agent, as testdata/stuckref.mjs does.
func (l *live) stuckOp(id, op string) {
	l.t.Helper()
	switch op {
	case "resume":
		l.resumed(id)
	case "block":
		l.addBlocker(id, "window", "claude-max", "five_hour at 100%")
		if err := l.db.UpdateAgent(l.ctx, id, dbField("lifecycle", "active")); err != nil {
			l.t.Fatal(err)
		}
	case "pause":
		if err := l.db.UpdateAgent(l.ctx, id, dbField("lifecycle", "paused"), dbField("paused_by", jsonText([]string{"human"}))); err != nil {
			l.t.Fatal(err)
		}
	case "working":
		l.setActivity(id, "working", "")
	case "with-prompt":
		l.setActivity(id, "starting", "with prompt")
	case "pending-archive":
		if err := l.db.UpdateAgent(l.ctx, id, dbField("pending_action", `{"type":"archive","force":false}`)); err != nil {
			l.t.Fatal(err)
		}
	default:
		l.t.Fatalf("unknown op %s", op)
	}
}

// TestStuckStartMatchesTS: settleStart and startStalled decide the same on the Go daemon as on src/lifecycle.ts, for each
// case, on a live tmux server and the fake Claude Code.
func TestStuckStartMatchesTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to run src/lifecycle.ts")
	}
	in, err := json.Marshal(stuckCases)
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd := exec.Command("node", "--no-warnings", "testdata/stuckref.mjs", string(in))
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("stuckref.mjs: %v\n%s", err, stderr.String())
	}
	var want map[string]bool
	if err := json.Unmarshal(out, &want); err != nil {
		t.Fatalf("stuckref.mjs output %q: %v", out, err)
	}

	l := newLive(t)
	got := map[string]bool{}
	for i, c := range stuckCases {
		// An id with an l and a 1, which a stam agent id never has (see live).
		id := fmt.Sprintf("sml1%c", 'a'+i)
		l.spawn(id)
		for _, op := range c.Ops {
			l.stuckOp(id, op)
		}
		row := l.agent(id)
		if c.Row == "peer" {
			row.Machine = "peer"
		}
		now := time.Now().Add(time.Duration(c.Minutes * float64(time.Minute)))
		switch c.Check {
		case "settle":
			got[c.Name] = l.life.settleStart(l.ctx, row, c.Alive)
		case "stall":
			got[c.Name] = l.life.startStalled(l.ctx, row, c.Alive, now)
		default:
			t.Fatalf("%s: unknown check %s", c.Name, c.Check)
		}
	}
	for _, c := range stuckCases {
		if got[c.Name] != want[c.Name] {
			t.Errorf("%s: go %v, ts %v", c.Name, got[c.Name], want[c.Name])
		}
	}
	if len(want) != len(stuckCases) {
		t.Errorf("the reference has %d cases, the corpus %d", len(want), len(stuckCases))
	}
	// The corpus must tell the decisions apart: both answers appear.
	trues := 0
	for _, v := range want {
		if v {
			trues++
		}
	}
	if trues == 0 || trues == len(want) {
		t.Errorf("the corpus decides every case the same way (%d of %d true)", trues, len(want))
	}
}
