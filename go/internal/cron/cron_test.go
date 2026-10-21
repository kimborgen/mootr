package cron

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"testing"
	"time"
)

// specs covers every field form, the errors, day-of-month OR day-of-week, Sunday as 7, and times around a
// daylight-saving change.
var specs = []struct{ spec, from string }{
	{"*/15 * * * *", "2026-10-21T10:07:30.000Z"},
	{"0 9 * * *", "2026-10-21T10:00:00.000Z"},
	{"0 9 * * *", "2026-10-21T08:59:59.999Z"},
	{"30 2 * * *", "2026-03-28T12:00:00.000Z"},
	{"30 2 * * *", "2026-10-24T12:00:00.000Z"},
	{"0 0 1 * 1", "2026-10-21T00:00:00.000Z"},
	{"0 0 */10 * *", "2026-10-21T00:00:00.000Z"},
	{"0 12 * * 7", "2026-10-21T00:00:00.000Z"},
	{"0 12 * * 0,6", "2026-10-21T00:00:00.000Z"},
	{"5-10/2 1-3 * 2 *", "2026-10-21T00:00:00.000Z"},
	{"0 0 29 2 *", "2026-10-21T00:00:00.000Z"},
	{"0 0 31 2 *", "2026-10-21T00:00:00.000Z"},
	{"  1 2 3 4 5  ", "2026-10-21T00:00:00.000Z"},
	{",5 * * * *", "2026-10-21T00:00:30.000Z"},
	{"*/2/3 * * * *", "2026-10-21T00:00:30.000Z"},
	{"", "2026-10-21T00:00:00.000Z"},
	{"* * * *", "2026-10-21T00:00:00.000Z"},
	{"60 * * * *", "2026-10-21T00:00:00.000Z"},
	{"5-1 * * * *", "2026-10-21T00:00:00.000Z"},
	{"*/0 * * * *", "2026-10-21T00:00:00.000Z"},
	{"*/x * * * *", "2026-10-21T00:00:00.000Z"},
	{"*/1.5 * * * *", "2026-10-21T00:00:00.000Z"},
	{"a * * * *", "2026-10-21T00:00:00.000Z"},
	{"* * * 13 *", "2026-10-21T00:00:00.000Z"},
	{"* * * * 8", "2026-10-21T00:00:00.000Z"},
	{"*/1e30 * * * *", "2026-10-21T00:00:30.000Z"},
	{"*/9223372036854775808 * * * *", "2026-10-21T00:00:30.000Z"},
	{"5-50/1e30 */1e400 * * *", "2026-10-21T00:00:30.000Z"},
	{"*/0x10 * * * *", "2026-10-21T00:00:30.000Z"},
	{"*/0b11 */0O7 * * *", "2026-10-21T00:00:30.000Z"},
	{"*/0x * * * *", "2026-10-21T00:00:30.000Z"},
	{"*/0b12 * * * *", "2026-10-21T00:00:30.000Z"},
	{"*/-0x10 * * * *", "2026-10-21T00:00:30.000Z"},
	{"*/Infinity * * * *", "2026-10-21T00:00:30.000Z"},
}

// tsCron runs the requests through the TS daemon's code (testdata/ts-cron.mjs), under the time zone zone.
func tsCron(t *testing.T, zone string, reqs []map[string]string) []json.RawMessage {
	t.Helper()
	in, err := json.Marshal(reqs)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("node", "testdata/ts-cron.mjs", t.TempDir())
	cmd.Env = append(os.Environ(), "TZ="+zone)
	cmd.Stdin = bytes.NewReader(in)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("ts-cron.mjs: %v\n%s", err, stderr.String())
	}
	var res []json.RawMessage
	if err := json.Unmarshal(out, &res); err != nil {
		t.Fatalf("ts-cron.mjs output %q: %v", out, err)
	}
	return res
}

// inZone runs fn with time.Local set to zone.
func inZone(t *testing.T, zone string, fn func()) {
	t.Helper()
	loc, err := time.LoadLocation(zone)
	if err != nil {
		t.Skipf("no time zone %s: %v", zone, err)
	}
	prev := time.Local
	time.Local = loc
	defer func() { time.Local = prev }()
	fn()
}

const iso = "2006-01-02T15:04:05.000Z"

// TestNextMatchesTS: Next gives what src/waits.ts nextCron gives for every spec, its errors included, in UTC and in a
// zone with daylight saving.
func TestNextMatchesTS(t *testing.T) {
	for _, zone := range []string{"UTC", "Europe/Oslo"} {
		var reqs []map[string]string
		for _, s := range specs {
			reqs = append(reqs, map[string]string{"fn": "next", "spec": s.spec, "from": s.from})
		}
		want := tsCron(t, zone, reqs)
		inZone(t, zone, func() {
			for i, s := range specs {
				from, err := time.Parse(time.RFC3339Nano, s.from)
				if err != nil {
					t.Fatal(err)
				}
				var got []byte
				if next, err := Next(s.spec, from); err != nil {
					got, _ = json.Marshal(map[string]string{"error": err.Error()})
				} else {
					got, _ = json.Marshal(next.UTC().Format(iso))
				}
				if string(got) != string(want[i]) {
					t.Errorf("%s %q from %s: got %s, TS %s", zone, s.spec, s.from, got, want[i])
				}
			}
		})
	}
}
