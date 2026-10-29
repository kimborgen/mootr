package server

import (
	"encoding/json"
	"testing"
	"time"

	"stam/internal/clock"
)

// TestAgentShowNow: GET /api/agents/:id, which whoami reads, carries now, the daemon's clock as ISO UTC (S-3468).
func TestAgentShowNow(t *testing.T) {
	old := clock.Now
	t.Cleanup(func() { clock.Now = old })
	clock.Now = func() time.Time { return time.Date(2026, 10, 22, 2, 10, 30, 123000000, time.UTC) }
	f := newFixture(t, nil)
	rec := f.do(call{method: "GET", path: "/api/agents/achild", token: agentTok})
	if rec.Code != 200 {
		t.Fatalf("show: %d %s", rec.Code, rec.Body.String())
	}
	var got struct {
		Now string `json:"now"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if want := "2026-10-22T02:10:30.123Z"; got.Now != want {
		t.Errorf("now = %q, want %q", got.Now, want)
	}
}
