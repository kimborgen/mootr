package claude

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"stam/internal/db"
	"stam/internal/jsjson"
)

// TestStopWaitsMatchTS: a Stop's background tasks and session crons become the same hook waits as src/adapters/claude.ts
// syncStopWaits writes, odd payloads included.
func TestStopWaitsMatchTS(t *testing.T) {
	payloads := []string{
		`{"hook_event_name":"Stop"}`,
		`{"hook_event_name":"Stop","background_tasks":[],"session_crons":[]}`,
		`{"hook_event_name":"Stop","background_tasks":[
			{"id":"b1","type":"shell","status":"running","description":"npm test"},
			{"id":"b2","type":"subagent","description":"review"},
			{"id":"b3","type":"monitor","status":"completed","description":"done"},
			{"id":"b4","type":"other","command":"sleep 9"},
			{"id":"b5"},
			{"id":7,"type":null,"description":null,"command":"c"},
			{"type":"shell","description":"no id"},
			"b6",
			null,
			{"id":"b1","type":"shell","description":"the same id"}]}`,
		`{"hook_event_name":"Stop","background_tasks":{"id":"x"},"session_crons":"no"}`,
		`{"hook_event_name":"Stop","session_crons":[
			{"id":"c1","schedule":"*/5 * * * *","recurring":true,"prompt":"tick"},
			{"id":"c2","schedule":"30 14 25 12 *","recurring":false,"prompt":"wake"},
			{"id":"c3","schedule":"* * * * *"},
			{"id":"c4","recurring":1},
			{"id":"c5","schedule":null,"prompt":null},
			{"schedule":"0 9 * * *"},
			5]}`,
	}
	cases := make([]json.RawMessage, len(payloads))
	for i, p := range payloads {
		cases[i] = json.RawMessage(p)
	}
	home := filepath.Join(t.TempDir(), "home")
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	in, _ := json.Marshal(cases)
	cmd := exec.Command("node", "testdata/ts-hook.mjs", home, "waits")
	cmd.Stdin = bytes.NewReader(in)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("ts-hook.mjs: %v\n%s", err, stderr.String())
	}
	type wait struct {
		Kind   string  `json:"kind"`
		Target *string `json:"target"`
		Detail *string `json:"detail"`
		Until  *string `json:"until"`
		Data   *string `json:"data"`
	}
	var want [][]wait
	if err := json.Unmarshal(out, &want); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	for i, raw := range payloads {
		v, err := jsjson.Parse([]byte(raw))
		if err != nil {
			t.Fatal(err)
		}
		r := OnHook(db.Agent{Lifecycle: "active", Activity: "working"}, v.(*jsjson.Object), func() (string, bool) { return "", false })
		got := []wait{}
		for _, k := range []struct {
			kind string
			ws   []db.HookWait
		}{{"job", r.Waits.Jobs}, {"timer", r.Waits.Timers}} {
			for _, w := range k.ws {
				target, detail := w.Target, w.Detail
				got = append(got, wait{k.kind, &target, &detail, w.Until, w.Data})
			}
		}
		g, _ := json.Marshal(got)
		w, _ := json.Marshal(want[i])
		if want[i] == nil {
			w = []byte("[]")
		}
		if !bytes.Equal(g, w) {
			t.Errorf("payload %d:\n Go %s\n TS %s", i, g, w)
		}
	}
}

// TestHookWaitsOfEvents: SessionStart on startup or resume clears the hook waits (on clear it doesn't), a submitted
// prompt is passed on, and a Stop without the lists leaves the waits as they are.
func TestHookWaitsOfEvents(t *testing.T) {
	on := func(raw string) HookWaits {
		t.Helper()
		v, err := jsjson.Parse([]byte(raw))
		if err != nil {
			t.Fatal(err)
		}
		return OnHook(db.Agent{Lifecycle: "active", Activity: "idle"}, v.(*jsjson.Object), func() (string, bool) { return "", false }).Waits
	}
	for raw, want := range map[string]bool{
		`{"hook_event_name":"SessionStart","source":"startup"}`: true,
		`{"hook_event_name":"SessionStart","source":"resume"}`:  true,
		`{"hook_event_name":"SessionStart","source":"clear"}`:   false,
		`{"hook_event_name":"SessionStart"}`:                    false,
	} {
		if got := on(raw); got.Clear != want {
			t.Errorf("%s: clear %v", raw, got.Clear)
		}
	}
	if w := on(`{"hook_event_name":"UserPromptSubmit","prompt":"go"}`); w.Prompt == nil || *w.Prompt != "go" {
		t.Errorf("prompt %v", w.Prompt)
	}
	if w := on(`{"hook_event_name":"UserPromptSubmit","prompt":5}`); w.Prompt != nil {
		t.Errorf("a prompt that isn't a string: %v", *w.Prompt)
	}
	if w := on(`{"hook_event_name":"Stop"}`); w.Jobs != nil || w.Timers != nil || w.Clear {
		t.Errorf("a Stop without the lists: %+v", w)
	}
}

// TestStartedWaits: a task notification names the job that ended (not one still running); a one-shot timer's own
// prompt is its firing, a recurring one's or another prompt is not.
func TestStartedWaits(t *testing.T) {
	for _, c := range []struct {
		prompt          string
		id              string
		ended, isNotice bool
	}{
		{"<task-notification>\n<task-id> b1 </task-id>\n<status>completed</status>\n</task-notification>", "b1", true, true},
		{"  <task-notification><task-id>b2</task-id><status>running</status>", "b2", false, true},
		{"<task-notification><task-id>b3</task-id>", "", false, false},
		{"say <task-notification><task-id>b4</task-id><status>failed</status>", "", false, false},
		{"wake", "", false, false},
	} {
		id, ended, ok := StartedJob(c.prompt)
		if id != c.id || ended != c.ended || ok != c.isNotice {
			t.Errorf("%q: %q %v %v", c.prompt, id, ended, ok)
		}
	}
	data := func(s string) *string { return &s }
	if !FiredTimer(data(`{"schedule":"1 2 3 4 *","recurring":false,"prompt":"wake"}`), "wake") {
		t.Error("the one-shot timer's prompt")
	}
	for _, d := range []*string{nil, data(`{"recurring":true,"prompt":"wake"}`), data(`{"prompt":"other"}`), data(`not json`), data(`[1]`)} {
		if FiredTimer(d, "wake") {
			t.Errorf("fired: %v", *d)
		}
	}
}

// TestNextCronFireMatchesTS: NextCronFire gives what src/adapters/claude.ts nextCronFire gives, in UTC and in a zone
// with daylight saving, around its changes.
func TestNextCronFireMatchesTS(t *testing.T) {
	specs := []struct{ spec, from string }{
		{"30 14 * * *", "2026-10-21T10:07:30.000Z"},
		{"30 9 * * *", "2026-10-21T10:07:30.000Z"},
		{"0 0 25 12 *", "2026-10-21T10:07:30.000Z"},
		{"0 0 1 * *", "2026-10-21T10:07:30.000Z"},
		{"5 4 * 3 *", "2026-10-21T10:07:30.000Z"},
		{"30 2 29 3 *", "2026-03-01T00:00:00.000Z"},
		{"30 2 * * *", "2026-03-28T12:00:00.000Z"},
		{"30 2 25 10 *", "2026-10-01T00:00:00.000Z"},
		{"75 26 * * *", "2026-10-21T10:07:30.000Z"},
		{"0 0 31 2 *", "2026-10-21T10:07:30.000Z"},
		{"*/5 * * * *", "2026-10-21T10:07:30.000Z"},
		{"5", "2026-10-21T10:07:30.000Z"},
		{"", "2026-10-21T10:07:30.000Z"},
	}
	for _, zone := range []string{"UTC", "Europe/Oslo"} {
		loc, err := time.LoadLocation(zone)
		if err != nil {
			t.Skipf("no time zone %s: %v", zone, err)
		}
		var reqs []map[string]string
		for _, s := range specs {
			reqs = append(reqs, map[string]string{"fn": "fire", "spec": s.spec, "from": s.from})
		}
		in, _ := json.Marshal(reqs)
		cmd := exec.Command("node", "../../cron/testdata/ts-cron.mjs", t.TempDir())
		cmd.Env = append(os.Environ(), "TZ="+zone)
		cmd.Stdin = bytes.NewReader(in)
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("ts-cron.mjs: %v\n%s", err, stderr.String())
		}
		var want []json.RawMessage
		if err := json.Unmarshal(out, &want); err != nil {
			t.Fatal(err)
		}
		prev := time.Local
		time.Local = loc
		for i, s := range specs {
			from, _ := time.Parse(time.RFC3339Nano, s.from)
			got, _ := json.Marshal(NextCronFire(s.spec, from))
			if string(got) != string(want[i]) {
				t.Errorf("%s %q from %s: got %s, TS %s", zone, s.spec, s.from, got, want[i])
			}
		}
		time.Local = prev
	}
}
