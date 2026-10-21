package lifecycle

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"stam/internal/db"
	"stam/internal/jsjson"
)

// statusLine reports a Claude Code status line for the agent with the context size (all of it uncached input), and the
// transcript when one is given.
func (l *live) statusLine(id string, tokens int, transcript string) {
	l.t.Helper()
	tp := "null"
	if transcript != "" {
		tp = fmt.Sprintf("%q", transcript)
	}
	p, err := jsjson.Parse([]byte(fmt.Sprintf(`{"transcript_path":%s,"context_window":{"context_window_size":1000000,"current_usage":{"input_tokens":%d,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}`, tp, tokens)))
	if err != nil {
		l.t.Fatal(err)
	}
	if _, err := l.life.OnStatusLine(l.ctx, "claude", l.agent(id), p); err != nil {
		l.t.Fatal(err)
	}
}

func (l *live) events(id, typ string) []string {
	l.t.Helper()
	evs, err := l.db.ListEvents(l.ctx, id, 50, typ)
	if err != nil {
		l.t.Fatal(err)
	}
	out := make([]string, len(evs)) // oldest first, as ListEvents gives them
	for i, e := range evs {
		out[i] = deref(e.Data)
	}
	return out
}

func (l *live) lastNotice(id string) string {
	n := l.life.Notices(id)
	if len(n) == 0 {
		return ""
	}
	return n[len(n)-1]
}

// TestContextThresholds: a size report going up a level records context:threshold and warns, tells the agent to
// compact itself, or compacts it by force with the forced note as the relaunch's prompt; a report of 0 changes nothing,
// and going down a level records nothing. The first report after a compaction is measured, and a threshold then counts
// only past the growth floor.
func TestContextThresholds(t *testing.T) {
	l := newLive(t)
	l.setSettings(`{"context":{"warnTokens":100000,"instructTokens":200000,"enforceTokens":300000},"idleCompaction":{"growthTokens":50000},"retro":{"reminders":{"enabled":false}}}`)
	l.spawn("alpt1")
	l.idle("alpt1")

	l.statusLine("alpt1", 150000, "")
	if got := l.agent("alpt1"); got.ContextLevel != 1 || got.ContextTokens == nil || *got.ContextTokens != 150000 {
		t.Fatalf("after 150k: level %d tokens %v", got.ContextLevel, got.ContextTokens)
	}
	if want := "[stam] System message, info: your context has reached 150k tokens. At 200k tokens stam will ask you to round off your current work and compact yourself; at 300k tokens you will be compacted by force."; l.lastNotice("alpt1") != want {
		t.Errorf("warning: %q", l.lastNotice("alpt1"))
	}
	l.statusLine("alpt1", 0, "")
	l.statusLine("alpt1", 250000, "")
	if got := l.agent("alpt1"); got.ContextLevel != 2 {
		t.Fatalf("after 250k: level %d", got.ContextLevel)
	}
	if n := l.lastNotice("alpt1"); !strings.HasPrefix(n, "[stam] System message, action needed: your context has reached 250k tokens. Round off your current piece of work.\n\nThen call") || strings.Contains(n, "\n\n\n") {
		t.Errorf("instruction: %q", n)
	}
	l.statusLine("alpt1", 120000, "")
	if got := l.agent("alpt1"); got.ContextLevel != 1 {
		t.Errorf("after 120k: level %d", got.ContextLevel)
	}
	if got := l.events("alpt1", "context:threshold"); strings.Join(got, " ") != `{"level":1,"tokens":150000} {"level":2,"tokens":250000}` {
		t.Errorf("thresholds: %q", got)
	}
	if len(l.life.Notices("alpt1")) != 2 {
		t.Errorf("notices: %q", l.life.Notices("alpt1"))
	}

	l.statusLine("alpt1", 350000, "")
	l.until("the forced compaction", func() bool { return l.has("alpt1", "compact:done") })
	want := `{"type":"compact","prompt":"[stam] You were compacted by force because your context passed 300k tokens. Continue your work from the summary. Your full history is still on disk if you need details: not available","reason":"enforcement threshold","op":"`
	if e := lastEvent(t, l, "alpt1", "compact"); !strings.HasPrefix(e, want) {
		t.Errorf("forced compaction: %s", e)
	}
	if got := l.compacts(); len(got) != 1 || !strings.HasSuffix(got[0], "|/compact") {
		t.Errorf("compactor runs: %q", got)
	}

	// The first report after it is the post-compaction size: 120k puts the growth floor at 170k.
	l.statusLine("alpt1", 120000, "")
	if got := l.agent("alpt1"); got.ContextLevel != 0 || got.TokensAfterCompaction == nil || *got.TokensAfterCompaction != 120000 {
		t.Errorf("after the compaction: level %d, measured %v", got.ContextLevel, got.TokensAfterCompaction)
	}
	if e := lastEvent(t, l, "alpt1", "compaction:measured"); e != `{"tokens":120000}` {
		t.Errorf("measured: %s", e)
	}
	l.statusLine("alpt1", 160000, "")
	if got := l.agent("alpt1"); got.ContextLevel != 0 {
		t.Errorf("under the floor: level %d", got.ContextLevel)
	}
	l.statusLine("alpt1", 200000, "")
	if e := lastEvent(t, l, "alpt1", "context:threshold"); e != `{"level":2,"tokens":200000,"floor":170000}` {
		t.Errorf("a threshold past the floor: %s", e)
	}
	if evs := l.events("alpt1", "compaction:measured"); len(evs) != 1 {
		t.Errorf("measured twice: %q", evs)
	}
}

// TestCacheCold: a mark notes the transcript's latest turn; the first later turn a status line sees is cold (most of
// its context written to the cache) or warm, against the mark's cause; a wake doesn't mark over a pending compaction
// mark, nor a cause over itself; and the cache window is recorded when it changes.
func TestCacheCold(t *testing.T) {
	l := newLive(t)
	l.spawn("alpk1")
	file := filepath.Join(l.base, "alpk1.jsonl")
	row := func(id string, in, read, write int, window string) {
		appendFile(t, file, fmt.Sprintf(`{"type":"assistant","message":{"id":%q,"usage":{"input_tokens":%d,"output_tokens":1,"cache_read_input_tokens":%d,"cache_creation_input_tokens":%d,"cache_creation":{"ephemeral_%s_input_tokens":%d}}}}`+"\n", id, in, read, write, window, write))
	}
	row("t1", 100, 0, 900, "5m")
	l.set("alpk1", db.Field{Col: "transcript_path", Val: file})

	l.life.markCold(l.ctx, "alpk1", "wake")
	if e := lastEvent(t, l, "alpk1", "cache:mark"); e != `{"cause":"wake","seen":"t1"}` {
		t.Fatalf("mark: %s", e)
	}
	l.statusLine("alpk1", 1000, file) // still the turn the mark saw
	if l.has("alpk1", "cache:cold") || l.has("alpk1", "cache:warm") {
		t.Error("the seen turn was measured")
	}
	if got := l.events("alpk1", "cache:ttl"); strings.Join(got, " ") != `{"ttl":"5m"}` {
		t.Errorf("ttl: %q", got)
	}
	row("t2", 100, 0, 900, "5m")
	l.statusLine("alpk1", 1001, file)
	if got := l.events("alpk1", "cache:cold"); strings.Join(got, " ") != `{"tokens":900,"context":1000,"cause":"wake"}` {
		t.Errorf("cold: %q", got)
	}
	l.statusLine("alpk1", 1002, file)
	if got := l.events("alpk1", "cache:cold"); len(got) != 1 {
		t.Errorf("measured again: %q", got)
	}

	l.life.markCold(l.ctx, "alpk1", "compaction")
	l.life.markCold(l.ctx, "alpk1", "wake")
	l.life.markCold(l.ctx, "alpk1", "compaction")
	if got := l.events("alpk1", "cache:mark"); strings.Join(got, " ") != `{"cause":"wake","seen":"t1"} {"cause":"compaction","seen":"t2"}` {
		t.Errorf("marks: %q", got)
	}
	row("t3", 100, 800, 100, "1h")
	l.statusLine("alpk1", 1003, file)
	if got := l.events("alpk1", "cache:warm"); strings.Join(got, " ") != `{"tokens":100,"context":1000,"cause":"compaction"}` {
		t.Errorf("warm: %q", got)
	}
	l.statusLine("alpk1", 1004, file)
	if got := l.events("alpk1", "cache:ttl"); strings.Join(got, " ") != `{"ttl":"5m"} {"ttl":"1h"}` {
		t.Errorf("ttl changes: %q", got)
	}
	// An agent that can't be read gets no mark, as TS marks only an agent it holds.
	l.life.markCold(l.ctx, "alnone1", "wake")
	if l.has("alnone1", "cache:mark") {
		t.Error("a missing agent was marked")
	}
}

// TestIdleCompaction: an agent idle past the cache lifetime is compacted once its context grew past the threshold
// (minTokens with no measurement, the recent average, or its own measured size, plus growthTokens), once per idle
// period, across a daemon restart too; a churning agent or one with a pushed turn since it went idle is held.
func TestIdleCompaction(t *testing.T) {
	l := newLive(t)
	l.setSettings(`{"idleCompaction":{"idleMinutes":1,"growthTokens":50000,"minTokens":100000}}`)
	idleFor := func(id string, tokens int, ago time.Duration) string {
		since := time.Now().Add(-ago).UTC().Format("2006-01-02T15:04:05.000Z")
		l.set(id, db.Field{Col: "activity", Val: "idle"}, db.Field{Col: "idle_since", Val: since}, db.Field{Col: "context_tokens", Val: tokens})
		return since
	}
	sweeps := func(id string) []string { return l.events(id, "context:idle-compaction") }

	l.spawn("alpi1")
	idleFor("alpi1", 150000, 30*time.Second) // not idle long enough
	l.life.idleSweep(l.ctx)
	idleFor("alpi1", 90000, 2*time.Minute) // not past minTokens
	l.life.idleSweep(l.ctx)
	if got := sweeps("alpi1"); len(got) != 0 {
		t.Fatalf("compacted early: %q", got)
	}
	since := idleFor("alpi1", 150000, 2*time.Minute)
	l.life.idleSweep(l.ctx)
	if got := sweeps("alpi1"); strings.Join(got, " ") != `{"tokens":150000,"threshold":100000,"reason":"idle past the cache lifetime"}` {
		t.Fatalf("idle compaction: %q", got)
	}
	l.until("the idle compaction", func() bool { return l.has("alpi1", "compact:done") })
	// The same idle period, by the map and then by the event after a daemon restart: no second one.
	l.set("alpi1", db.Field{Col: "activity", Val: "idle"}, db.Field{Col: "idle_since", Val: since})
	l.life.idleSweep(l.ctx)
	l.life = New(l.ctx, l.opts)
	l.life.idleSweep(l.ctx)
	if got := sweeps("alpi1"); len(got) != 1 {
		t.Errorf("idle compactions in one idle period: %q", got)
	}

	// Its own measured size: 120k plus 50k.
	l.spawn("alpi2")
	l.set("alpi2", db.Field{Col: "tokens_after_compaction", Val: 120000})
	idleFor("alpi2", 160000, 2*time.Minute)
	l.life.idleSweep(l.ctx)
	if got := sweeps("alpi2"); len(got) != 0 {
		t.Errorf("under its own threshold: %q", got)
	}
	// The recent average (60k, from another agent) once there is one, for an agent with no measurement.
	if err := l.db.AddEvent(l.ctx, "alpi2", "compaction:measured", measuredEvent{Tokens: 60000}); err != nil {
		t.Fatal(err)
	}
	l.spawn("alpi3")
	idleFor("alpi3", 115000, 2*time.Minute)
	// Held: three wakes within the hour, the last under an hour ago.
	for i := 0; i < 3; i++ {
		if err := l.db.AddEvent(l.ctx, "alpi3", "standing:wake", nil); err != nil {
			t.Fatal(err)
		}
	}
	l.life.idleSweep(l.ctx)
	if got := sweeps("alpi3"); len(got) != 0 {
		t.Errorf("a churning agent: %q", got)
	}
	l.spawn("alpi4")
	idleFor("alpi4", 115000, 2*time.Minute)
	if err := l.db.AddEvent(l.ctx, "alpi4", "prompt:sent", nil); err != nil {
		t.Fatal(err)
	}
	l.life.idleSweep(l.ctx)
	if got := sweeps("alpi4"); len(got) != 0 {
		t.Errorf("a pushed turn since idle: %q", got)
	}
	l.spawn("alpi5")
	idleFor("alpi5", 115000, 2*time.Minute)
	l.life.idleSweep(l.ctx)
	if got := sweeps("alpi5"); strings.Join(got, " ") != `{"tokens":115000,"threshold":110000,"reason":"idle past the cache lifetime"}` {
		t.Errorf("against the average: %q", got)
	}
	l.until("alpi5's compaction", func() bool { return l.has("alpi5", "compact:done") })
	// An idle_since that won't parse counts as idle long enough, as TS's NaN comparison does.
	l.spawn("alpi8")
	l.set("alpi8", db.Field{Col: "activity", Val: "idle"}, db.Field{Col: "idle_since", Val: "not a date"}, db.Field{Col: "context_tokens", Val: 900000})
	l.life.idleSweep(l.ctx)
	if got := sweeps("alpi8"); len(got) != 1 {
		t.Errorf("an unparsed idle_since: %q", got)
	}
	l.until("alpi8's compaction", func() bool { return l.has("alpi8", "compact:done") })
	// A rest-owned agent is left alone, and so is everyone with idle compaction off.
	l.spawn("alpi6")
	idleFor("alpi6", 900000, 2*time.Minute)
	l.set("alpi6", db.Field{Col: "lifecycle", Val: "paused"}, db.Field{Col: "paused_by", Val: `["standing-idle"]`})
	l.spawn("alpi7")
	idleFor("alpi7", 900000, 2*time.Minute)
	l.setSettings(`{"idleCompaction":{"enabled":false}}`)
	l.life.idleSweep(l.ctx)
	l.setSettings(`{"idleCompaction":{"idleMinutes":1}}`)
	l.set("alpi7", db.Field{Col: "lifecycle", Val: "shut_down"})
	l.life.idleSweep(l.ctx)
	if a, b := sweeps("alpi6"), sweeps("alpi7"); len(a)+len(b) != 0 {
		t.Errorf("swept: rest-owned %q, disabled %q", a, b)
	}
}

func appendFile(t *testing.T, file, text string) {
	t.Helper()
	f, err := os.OpenFile(file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(text); err != nil {
		t.Fatal(err)
	}
}

// TestCompactStaleRow: a compaction handed a row read while the agent was idle (the idle sweep's) doesn't run once the
// agent has started a turn, or gone idle again since: the claim misses, the compaction waits as a pending action for
// the turn's end, and nothing is killed or compacted. The idle sweep's own request acts on the agent as it is now.
func TestCompactStaleRow(t *testing.T) {
	l := newLive(t)
	l.spawn("alps1")
	l.idle("alps1")
	stale := l.agent("alps1")
	l.set("alps1", db.Field{Col: "activity", Val: "working"})
	p := jsjson.NewObject("type", "compact", "reason", "idle past the cache lifetime")
	if r, err := l.life.compactNow(l.ctx, stale, p); err != nil || r != "waiting for n-alps1 to finish its step" {
		t.Fatalf("a working agent's stale row: %q %v", r, err)
	}
	if got := l.agent("alps1"); got.Activity != "working" || pendingText(got) != `{"type":"compact","reason":"idle past the cache lifetime"}` {
		t.Errorf("after the miss: %s, pending %s", got.Activity, pendingText(got))
	}

	// Idle again, in a later idle period: the old row still misses.
	l.set("alps1", db.Field{Col: "activity", Val: "idle"}, db.Field{Col: "idle_since", Val: "2026-01-01T00:00:00.000Z"}, db.Field{Col: "pending_action", Val: nil})
	if r, err := l.life.compactNow(l.ctx, stale, p); err != nil || r != "waiting for n-alps1 to finish its step" {
		t.Fatalf("an earlier idle period's row: %q %v", r, err)
	}
	// Errored (no idle period), then working: the row's idle_since still matches, its activity doesn't.
	l.set("alps1", db.Field{Col: "activity", Val: "errored"}, db.Field{Col: "pending_action", Val: nil})
	stale = l.agent("alps1")
	l.set("alps1", db.Field{Col: "activity", Val: "working"})
	if r, err := l.life.compactNow(l.ctx, stale, p); err != nil || r != "waiting for n-alps1 to finish its step" {
		t.Fatalf("an errored row, now working: %q %v", r, err)
	}
	if l.has("alps1", "compact") || l.compacts()[0] != "" {
		t.Errorf("a stale row compacted: %q", l.compacts())
	}

	// The idle sweep's request, handed a row from before a turn started, leaves the compaction pending.
	l.set("alps1", db.Field{Col: "activity", Val: "idle"}, db.Field{Col: "idle_since", Val: "2026-01-01T00:00:00.000Z"}, db.Field{Col: "pending_action", Val: nil},
		db.Field{Col: "context_tokens", Val: 900000})
	stale = l.agent("alps1")
	l.set("alps1", db.Field{Col: "activity", Val: "working"})
	if !l.life.idleCompactIfDue(l.ctx, stale, "idle past the cache lifetime", 0, false) {
		t.Fatal("not due")
	}
	l.until("the pending compaction", func() bool { return pendingText(l.agent("alps1")) != "" })
	if l.has("alps1", "compact") || l.compacts()[0] != "" || l.agent("alps1").Activity != "working" {
		t.Errorf("the sweep compacted a working agent: %q", l.compacts())
	}
}

// TestStatusLineWork: a report's work runs to its end when the request is cancelled (no level without its event and
// notice), and reports for one agent at once are handled one at a time, so a level is recorded once.
func TestStatusLineWork(t *testing.T) {
	l := newLive(t)
	l.setSettings(`{"context":{"warnTokens":100000,"instructTokens":200000,"enforceTokens":300000},"retro":{"reminders":{"enabled":false}}}`)
	l.spawn("alpw1")
	l.idle("alpw1")
	report := func(tokens int) jsjson.Value {
		p, err := jsjson.Parse([]byte(fmt.Sprintf(`{"context_window":{"context_window_size":1000000,"current_usage":{"input_tokens":%d}}}`, tokens)))
		if err != nil {
			t.Fatal(err)
		}
		return p
	}
	ctx, cancel := context.WithCancel(l.ctx)
	cancel()
	if _, err := l.life.OnStatusLine(ctx, "claude", l.agent("alpw1"), report(150000)); err != nil {
		t.Fatal(err)
	}
	if got := l.agent("alpw1"); got.ContextLevel != 1 || len(l.events("alpw1", "context:threshold")) != 1 || len(l.life.Notices("alpw1")) != 1 {
		t.Fatalf("a cancelled request: level %d, thresholds %q, notices %q", got.ContextLevel, l.events("alpw1", "context:threshold"), l.life.Notices("alpw1"))
	}

	// Rounds of reports at once, each from level 0 up to 2: one threshold each.
	for round := range 5 {
		if _, err := l.life.OnStatusLine(l.ctx, "claude", l.agent("alpw1"), report(50000+round)); err != nil {
			t.Fatal(err)
		}
		var wg sync.WaitGroup
		for i := range 32 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if _, err := l.life.OnStatusLine(l.ctx, "claude", l.agent("alpw1"), report(250000+100*round+i)); err != nil {
					t.Error(err)
				}
			}()
		}
		wg.Wait()
	}
	if got := l.events("alpw1", "context:threshold"); len(got) != 6 || len(l.life.Notices("alpw1")) != 6 {
		t.Errorf("reports at once: %d thresholds, %d notices", len(got), len(l.life.Notices("alpw1")))
	}
}
