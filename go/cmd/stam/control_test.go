package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestControlSendsTheTSBody(t *testing.T) {
	s := newStub(t, map[string]func(int) (int, string){
		"POST /api/agents/worker/archive": fixed(200, `{"agent":{"name":"worker"},"result":"archived"}`),
	})
	o := runCLI(t, map[string]string{"STAM_URL": s.URL}, "", "archive", "worker", "--force", "--force-unpushed", "work", "done")
	if o.code != 0 || o.stdout != "worker: archived\n" {
		t.Fatalf("archive = %+v", o)
	}
	var body map[string]any
	json.Unmarshal([]byte(s.calls[0].body), &body)
	want := map[string]any{"force": true, "force-unpushed": true, "force_unpushed": true, "note": "work done", "reason": "work done", "instructions": "work done"}
	if len(body) != len(want) {
		t.Fatalf("body = %v", body)
	}
	for k, v := range want {
		if body[k] != v {
			t.Errorf("body[%s] = %v, want %v", k, body[k], v)
		}
	}
}

func TestControlWithoutOptionsSendsAnEmptyBody(t *testing.T) {
	s := newStub(t, map[string]func(int) (int, string){
		"POST /api/agents/a1/reconnect-mcp": fixed(200, `{"agent":{"name":"w"},"result":"reconnected"}`),
	})
	o := runCLI(t, map[string]string{"STAM_URL": s.URL}, "", "reconnect-mcp", "a1")
	if o.code != 0 || o.stdout != "w: reconnected\n" || s.calls[0].body != "{}" {
		t.Fatalf("reconnect-mcp = %+v, body %s", o, s.calls[0].body)
	}
}

func TestControlRefusalIsTheDaemonsMessage(t *testing.T) {
	s := newStub(t, map[string]func(int) (int, string){
		"POST /api/agents/other/pause": fixed(403, `{"error":"you can only control yourself or your children"}`),
	})
	o := runCLI(t, map[string]string{"STAM_URL": s.URL}, "", "pause", "other")
	if o.code != 1 || !strings.Contains(o.stderr, "you can only control yourself or your children") {
		t.Fatalf("pause = %+v", o)
	}
	if o := runCLI(t, map[string]string{"STAM_URL": s.URL}, "", "pause", "x", "--bogus"); o.code != 1 || !strings.Contains(o.stderr, "unknown option '--bogus'") {
		t.Fatalf("unknown option = %+v", o)
	}
}

func TestRenameReparentChildNotices(t *testing.T) {
	s := newStub(t, map[string]func(int) (int, string){
		"POST /api/agents/w/rename":            fixed(200, `{"agent":{"name":"w2"},"result":"renamed w to w2"}`),
		"POST /api/agents/w/set-parent":        fixed(200, `{"agent":{"name":"w"},"result":"w is top-level"}`),
		"POST /api/agents/w/set-child-notices": fixed(200, `{"result":"child notices: none"}`),
	})
	vars := map[string]string{"STAM_URL": s.URL}
	if o := runCLI(t, vars, "", "rename", "w", "w2"); o.stdout != "renamed w to w2\n" {
		t.Fatalf("rename = %+v", o)
	}
	if o := runCLI(t, vars, "", "reparent", "w"); o.stdout != "w is top-level\n" {
		t.Fatalf("reparent = %+v", o)
	}
	if o := runCLI(t, vars, "", "child-notices", "w", "none"); o.stdout != "w: child notices: none\n" {
		t.Fatalf("child-notices = %+v", o)
	}
	bodies := []string{`{"name":"w2"}`, `{"parent":[]}`, `{"child_notices":"none"}`}
	for i, b := range bodies {
		if s.calls[i].body != b {
			t.Errorf("call %d body = %s, want %s", i, s.calls[i].body, b)
		}
	}
}

func TestLsTable(t *testing.T) {
	now := time.Now().UTC()
	ts := func(d time.Duration) string { return now.Add(-d).Format("2006-01-02T15:04:05.000Z") }
	list := `[{"id":"a1","name":"worker","machine":"m1","harness":"claude","model":"claude-haiku-5-5","lifecycle":"active","activity":"working","activity_detail":"` + strings.Repeat("x", 50) + `","context_tokens":42500,"updated_at":"` + ts(5*time.Second) + `"},` +
		`{"id":"a22","name":"rest","machine":"m1","harness":"codex","model":null,"lifecycle":"paused","resting":{"reason":"idle"},"activity_detail":null,"context_tokens":null,"updated_at":"` + ts(150*time.Second) + `"},` +
		`{"id":"a3","name":"old","machine":"m1","harness":"opencode","model":"","lifecycle":"archived","activity":"idle","context_tokens":0,"updated_at":"` + ts(3*time.Hour) + `"}]`
	s := newStub(t, map[string]func(int) (int, string){"GET /api/agents": fixed(200, list)})
	o := runCLI(t, map[string]string{"STAM_URL": s.URL}, "", "ls", "--all")
	want := "ID   NAME    MACHINE  HARNESS                  STATE     DETAIL                                    CTX  AGE\n" +
		"a1   worker  m1       claude/claude-haiku-5-5  working   " + strings.Repeat("x", 40) + "  43k  5s \n" +
		"a22  rest    m1       codex                    resting                                             -    3m \n" +
		"a3   old     m1       opencode                 archived                                            0k   3h \n"
	if o.code != 0 || o.stdout != want {
		t.Fatalf("ls = %+v\nwant %q\ngot  %q", o, want, o.stdout)
	}
	if s.calls[0].path != "/api/agents?state=all" {
		t.Errorf("path = %s", s.calls[0].path)
	}
}
