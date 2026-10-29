package lifecycle

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"stam/internal/db"
	"stam/internal/jsjson"
)

// The window, projection and daily-spend warnings (costnotices.go, usage.go), after test/cost-notices.test.mjs, and the
// human's mail from system:cost, as src/usage.ts and src/credits.ts mailHuman send it (S-1239).

// systemBox records stam's mail from system senders, "name|to|subject|body", and fails every send while fail is set.
type systemBox struct {
	mu   sync.Mutex
	sent []string
	fail bool
}

func (b *systemBox) send(_ context.Context, name string, to []string, subject, body string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.fail {
		return false
	}
	b.sent = append(b.sent, name+"|"+strings.Join(to, ",")+"|"+subject+"|"+body)
	return true
}

func (b *systemBox) mails() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.sent...)
}

const windowSettings = `{"chiefOfStaff":"n-cos","humanMail":{"when":"HM"},"cost":{"subscriptionWarnPercent":[80,95],"accounts":{"max":{"match":{"harness":"claude"},"paid":false}},"instructions":"Never spend extra credits."}}`

func withHumanMail(when string) string { return strings.Replace(windowSettings, "HM", when, 1) }

// newWindowLive is a cost live with the cos > cost > dev tree on the claude account, and the human's mail recorded.
func newWindowLive(t *testing.T, when string) (*live, *costBox, *systemBox) {
	l, box := newCostLive(t, withHumanMail(when))
	l.member("cos", "")
	l.member("cost", "cos")
	l.member("dev", "cost")
	human := &systemBox{}
	l.life.SetSystemMail(human.send)
	return l, box, human
}

func windowsOf(used float64, resets float64) *jsjson.Object {
	return jsjson.NewObject("five_hour", jsjson.NewObject("used_percentage", used, "resets_at", resets))
}

// TestNoticesWindow: a window past a warn percentage warns the managers of every active agent on the account, once per
// window and reset; a new reset re-arms it. The notice carries the reading, the reset time and the tree's share line.
func TestNoticesWindow(t *testing.T) {
	l, box, _ := newWindowLive(t, "necessary")
	R := float64(time.Now().Unix() + 3600)
	l.life.windowWarning(l.ctx, "claude", "five_hour", 82, 80, &R, time.Now())
	if got := strings.Join(l.notices(), " "); got != `window|["cos","cost"]|` {
		t.Fatalf("notices %s", got)
	}
	if got := l.query("SELECT account, window, resets_at FROM cost_notices"); got != "max|five_hour|"+jsjson.Number(R) {
		t.Errorf("stored %s", got)
	}
	l.until("the managers' mail", func() bool { return len(box.mails()) == 2 })
	id := l.noticeID("window")
	for _, m := range box.mails() {
		for _, want := range []string{
			"[stam] Cost notice " + id + ": claude five-hour at 82% (threshold 80%)",
			"The five-hour window is at 82%, past the 80% warning line, and resets " + utcSec(R) + ".",
			"No five-hour reading yet to estimate this tree's share of max.",
		} {
			if !strings.Contains(m, want) {
				t.Errorf("notice lacks %q:\n%s", want, m)
			}
		}
	}
	l.life.windowWarning(l.ctx, "claude", "five_hour", 83, 80, &R, time.Now())
	if len(l.notices()) != 1 {
		t.Errorf("the same window and reset notified again: %v", l.notices())
	}
	R2 := R + 18000
	l.life.windowWarning(l.ctx, "claude", "five_hour", 82, 80, &R2, time.Now())
	if len(l.notices()) != 2 {
		t.Errorf("a new reset didn't re-arm: %v", l.notices())
	}
	// No reset time: the key says none, and the notice says so.
	l.life.windowWarning(l.ctx, "claude", "five_hour", 90, 80, nil, time.Now())
	if got := l.query("SELECT key FROM cost_notices ORDER BY rowid DESC LIMIT 1"); got != "window:max:five_hour:80:none" {
		t.Errorf("key %s", got)
	}
	l.until("the no-reset mail", func() bool { return len(box.mails()) == 6 })
	if m := box.mails()[5]; !strings.Contains(m, "and resets at an unknown time.") {
		t.Errorf("no reset %s", m)
	}
	// A reading no account covers keeps its name as the account, and has no managers: the human isn't wanted.
	l.life.windowWarning(l.ctx, "codex:acct", "five_hour", 90, 80, &R, time.Now())
	if len(l.notices()) != 3 {
		t.Errorf("an account no agent is on was notified: %v", l.notices())
	}
}

// TestNoticesWindowFallback: with no manager, the human is told only when humanMail.when allows important.
func TestNoticesWindowFallback(t *testing.T) {
	l, _ := newCostLive(t, `{"humanMail":{"when":"important"},"cost":{"accounts":{"max":{"match":{"harness":"claude"}}}}}`)
	l.member("orphan", "")
	R := float64(time.Now().Unix() + 3600)
	l.life.windowWarning(l.ctx, "claude", "five_hour", 82, 80, &R, time.Now())
	if got := strings.Join(l.notices(), " "); got != `window|["human"]|` {
		t.Errorf("notices %s", got)
	}
	l.setSettings(`{"humanMail":{"when":"necessary"},"cost":{"accounts":{"max":{"match":{"harness":"claude"}}}}}`)
	R2 := R + 18000
	l.life.windowWarning(l.ctx, "claude", "five_hour", 82, 80, &R2, time.Now())
	if len(l.notices()) != 1 {
		t.Errorf("recorded with no one to tell: %v", l.notices())
	}
}

// seedProjection is test/cost-notices.test.mjs's projection case: a window at 98% burning 6 points per half hour.
func seedProjection(l *live, t0 time.Time) {
	l.t.Helper()
	at := func(m float64) string { return isoMs(ms(t0) + m*minute) }
	for _, r := range [][2]float64{{0, 90}, {5, 92}, {30, 98}} {
		l.exec("INSERT INTO window_readings (name, window, at, used_percentage, resets_at) VALUES ('claude', 'five_hour', ?, ?, NULL)", isoMs(ms(t0)+r[0]*minute+30_000), r[1])
	}
	for _, m := range []float64{5, 10, 20, 30} {
		l.exec("INSERT INTO usage_samples (agent_id, account, harness, model, bucket, tokens_in) VALUES ('dev', 'max', 'claude', 'claude-opus-5-5', ?, 2000)", at(m))
	}
}

// TestNoticesProjection: a window projected to reach 100% within 30 minutes warns the managers, once per window and
// reset, and the check is throttled to once per 5 minutes per window. A projection past 30 minutes warns no one.
func TestNoticesProjection(t *testing.T) {
	l, box, _ := newWindowLive(t, "necessary")
	t0 := time.Date(2026, 10, 11, 10, 0, 0, 0, time.UTC)
	seedProjection(l, t0)
	now := t0.Add(31 * time.Minute)
	s, err := l.life.windowSharesOf(l.ctx, "max", "five_hour", nil, ms(now))
	if err != nil || s.projection.reaches100At == nil {
		t.Fatalf("no projection: %+v %v", s.projection, err)
	}
	reaches := *s.projection.reaches100At
	l.life.checkProjection(l.ctx, "claude", "five_hour", now)
	if got := strings.Join(l.notices(), " "); got != `projection|["cos","cost"]|` {
		t.Fatalf("notices %s", got)
	}
	if got := l.query("SELECT key FROM cost_notices"); got != "projection:max:five_hour:none" {
		t.Errorf("key %s", got)
	}
	l.until("the managers' mail", func() bool { return len(box.mails()) == 2 })
	m := box.mails()[0]
	for _, want := range []string{
		": max five-hour projected to reach 100% around " + reaches[11:16] + " UTC",
		"At the last 30 minutes' rate, max's five-hour window reaches 100% around " + strings.Replace(reaches, "T", " ", 1)[:16] + " UTC.",
		"This tree's estimated share of the five-hour window on max:",
	} {
		if !strings.Contains(m, want) {
			t.Errorf("notice lacks %q:\n%s", want, m)
		}
	}
	// Throttled: a check a minute later computes nothing, even with the notice gone.
	l.exec("DELETE FROM cost_notices")
	l.life.checkProjection(l.ctx, "claude", "five_hour", now.Add(time.Minute))
	if len(l.notices()) != 0 {
		t.Errorf("a throttled check notified: %v", l.notices())
	}
	// Five minutes on, the check runs again.
	l.life.checkProjection(l.ctx, "claude", "five_hour", now.Add(5*time.Minute))
	l.life.mu.Lock()
	last := l.life.usage.lastProjection["max:five_hour"]
	l.life.mu.Unlock()
	if last != ms(now.Add(5*time.Minute)) {
		t.Errorf("the check after the throttle didn't run: %v", last)
	}
	// A reading that names no account, and a projection beyond 30 minutes (checked long before), raise nothing.
	l.exec("DELETE FROM cost_notices")
	l.life.checkProjection(l.ctx, "nope", "five_hour", now.Add(20*time.Minute))
	l.life.checkProjection(l.ctx, "claude", "five_hour", t0.Add(6*time.Minute))
	if len(l.notices()) != 0 {
		t.Errorf("notified: %v", l.notices())
	}
}

// TestUsageWindowWarnings: a reading past each warn percentage warns the managers, and mails the human (as the first
// system:cost) only under important; each threshold once per window and reset.
func TestUsageWindowWarnings(t *testing.T) {
	l, _, human := newWindowLive(t, "necessary")
	// An agent on another harness isn't running on this subscription.
	if _, err := l.db.CreateAgent(l.ctx, db.NewAgent{ID: "cx", Name: "n-cx", Role: "developer", Machine: "test-machine", Harness: "codex", Cwd: l.work}); err != nil {
		t.Fatal(err)
	}
	l.set("cx", db.Field{Col: "lifecycle", Val: "active"})
	R1 := float64(time.Now().Unix() + 3600)
	if err := l.life.reportSubscription(l.ctx, "claude", windowsOf(82, R1), time.Now()); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(l.notices(), " "); got != `window|["cos","cost"]|` {
		t.Fatalf("notices %s", got)
	}
	if err := l.life.reportSubscription(l.ctx, "claude", windowsOf(85, R1), time.Now()); err != nil {
		t.Fatal(err)
	}
	if len(l.notices()) != 1 {
		t.Errorf("warned twice for one threshold and reset: %v", l.notices())
	}

	l.setSettings(withHumanMail("important"))
	if err := l.life.reportSubscription(l.ctx, "claude", windowsOf(96, R1+18000), time.Now()); err != nil {
		t.Fatal(err)
	}
	if got := l.notices(); len(got) != 3 {
		t.Fatalf("both thresholds of the new reset: %v", got)
	}
	l.until("the human's mail", func() bool { return len(human.mails()) == 2 })
	// The same reading again is no news: each threshold and reset is recorded once.
	l.life.mu.Lock()
	warned := len(l.life.usage.warned)
	l.life.mu.Unlock()
	if err := l.life.reportSubscription(l.ctx, "claude", windowsOf(97, R1+18000), time.Now()); err != nil {
		t.Fatal(err)
	}
	l.life.mu.Lock()
	again := len(l.life.usage.warned)
	l.life.mu.Unlock()
	if warned != 3 || again != 3 {
		t.Errorf("warned keys %d, then %d", warned, again)
	}
	for _, m := range human.mails() {
		if !strings.HasPrefix(m, "cost|human|[stam] claude five-hour usage at 96%|Your claude subscription's five-hour window is at 96% (threshold ") ||
			!strings.Contains(m, "It resets "+utcSec(R1+18000)+".") || !strings.Contains(m, "Agents running now: n-cos, n-cost, n-dev.") {
			t.Errorf("human mail %s", m)
		}
	}
	if !strings.Contains(human.mails()[0], "(threshold 80%)") || !strings.Contains(human.mails()[1], "(threshold 95%)") {
		t.Errorf("thresholds %v", human.mails())
	}
	// A setting with no warn percentages warns at none; a key without a percentage (Codex's credits) is never warned.
	l.setSettings(strings.Replace(withHumanMail("important"), "[80,95]", "[]", 1))
	if err := l.life.reportSubscription(l.ctx, "claude", windowsOf(99, R1+36000), time.Now()); err != nil {
		t.Fatal(err)
	}
	l.setSettings(withHumanMail("important"))
	if err := l.life.reportSubscription(l.ctx, "codex", jsjson.NewObject("credits", jsjson.NewObject("balance", 3.0)), time.Now()); err != nil {
		t.Fatal(err)
	}
	if len(l.notices()) != 3 || len(human.mails()) != 2 {
		t.Errorf("warned: %v %v", l.notices(), human.mails())
	}
}

// TestMailFromSystem: with no system sender set, or a send that fails, stam's mail reports it wasn't sent.
func TestMailFromSystem(t *testing.T) {
	l, _, human := newWindowLive(t, "important")
	if !l.life.mailFromSystem(l.ctx, "cost", []string{humanID}, "[stam] s", "b") || strings.Join(human.mails(), " ") != "cost|human|[stam] s|b" {
		t.Fatalf("mails %v", human.mails())
	}
	human.mu.Lock()
	human.fail = true
	human.mu.Unlock()
	if l.life.mailFromSystem(l.ctx, "cost", []string{humanID}, "[stam] s", "b") {
		t.Error("a failed send reported sent")
	}
	l.life.SetSystemMail(nil)
	if l.life.mailFromSystem(l.ctx, "cost", []string{humanID}, "[stam] s", "b") {
		t.Error("no sender reported sent")
	}
}

// TestDailySpend: today's spend past cost.dailyWarnUsd mails the human once a day with the top agents, only under
// important; below it, or with no threshold, nothing.
func TestDailySpend(t *testing.T) {
	l, _, human := newWindowLive(t, "important")
	day := time.Now().UTC().Format("2006-01-02")
	add := func(agent string, usd float64) {
		l.exec("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd) VALUES (?, ?, 'claude', NULL, 'max', ?)", agent, day, usd)
	}
	add("dev", 1.5)
	add("cost", 0.25)
	l.life.checkDailySpend(l.ctx)
	if len(human.mails()) != 0 {
		t.Fatalf("mailed with no threshold: %v", human.mails())
	}
	l.setSettings(strings.Replace(withHumanMail("important"), `"accounts"`, `"dailyWarnUsd":2,"accounts"`, 1))
	l.life.checkDailySpend(l.ctx)
	if len(human.mails()) != 0 {
		t.Fatalf("mailed below the threshold: %v", human.mails())
	}
	add("gone", 0.5)
	l.life.checkDailySpend(l.ctx)
	l.until("the human's mail", func() bool { return len(human.mails()) == 1 })
	if got := human.mails()[0]; got != "cost|human|[stam] Daily spend passed $2|Today's agent spend has reached $2.25 (API-equivalent), past your daily threshold of $2.\n\nTop agents today: n-dev $1.50, gone $0.50, n-cost $0.25" {
		t.Errorf("mail %q", got)
	}
	l.life.mu.Lock()
	done := l.life.usage.warned["daily:"+day]
	l.life.mu.Unlock()
	if !done {
		t.Error("the day's warning wasn't recorded")
	}
	l.life.checkDailySpend(l.ctx)
	if len(human.mails()) != 1 {
		t.Errorf("mailed twice in a day: %v", human.mails())
	}
}

// TestDailySpendNecessary: under necessary the day's warning is spent without a mail, as TS marks it warned first.
func TestDailySpendNecessary(t *testing.T) {
	l, _, human := newWindowLive(t, "necessary")
	l.setSettings(strings.Replace(withHumanMail("necessary"), `"accounts"`, `"dailyWarnUsd":1,"accounts"`, 1))
	l.exec("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd) VALUES ('dev', ?, 'claude', NULL, 'max', 3)", time.Now().UTC().Format("2006-01-02"))
	l.life.checkDailySpend(l.ctx)
	l.setSettings(strings.Replace(withHumanMail("important"), `"accounts"`, `"dailyWarnUsd":1,"accounts"`, 1))
	l.life.checkDailySpend(l.ctx)
	if len(human.mails()) != 0 {
		t.Errorf("mailed: %v", human.mails())
	}
}

// TestCreditWarningSystem: the credit warning goes to the human from system:cost, and stays pending while it can't be
// sent.
func TestCreditWarningSystem(t *testing.T) {
	l, stub, _ := newCreditLive(t, humanImportant)
	l.life.credits.send = nil
	human := &systemBox{fail: true}
	l.life.SetSystemMail(human.send)
	stub.setCredits(200, 10.0, 9.0)
	l.poll()
	if v, _ := jsjson.Parse([]byte(l.creditEntryJSON())); field(v, "pending") != any(true) || len(human.mails()) != 0 {
		t.Fatalf("with the send failing: %s %v", l.creditEntryJSON(), human.mails())
	}
	human.mu.Lock()
	human.fail = false
	human.mu.Unlock()
	l.poll()
	if got := human.mails(); len(got) != 1 || !strings.HasPrefix(got[0], "cost|human|[stam] OpenRouter credit low: $1.00 left|") {
		t.Errorf("mails %v", got)
	}
	if v, _ := jsjson.Parse([]byte(l.creditEntryJSON())); field(v, "pending") != any(false) {
		t.Errorf("still pending: %s", l.creditEntryJSON())
	}
}

// TestAccountForReading: a reading's account is the one for its harness alone (a Codex reading's name carries its
// account after a colon), else the first by name whose match names the harness with a model; none for a harness no
// account names.
func TestAccountForReading(t *testing.T) {
	l, _ := newCostLive(t, `{"cost":{"accounts":{"max":{"match":{"harness":"claude"}},"codex-pro":{"match":{"harness":"codex"}},`+
		`"or-b":{"match":{"harness":"opencode","model":"openrouter/b"}},"or-a":{"match":{"harness":"opencode","model":"openrouter/a"}}}}}`)
	for name, want := range map[string]string{"claude": "max", "codex:acct-1": "codex-pro", "codex": "codex-pro", "opencode": "or-a", "gemini": ""} {
		if got := l.life.accountForReading(name); got != want {
			t.Errorf("accountForReading(%s) = %q, want %q", name, got, want)
		}
	}
}

// TestUsageProjection: a subscription reading checks its window's projection, so a window burning to 100% within 30
// minutes warns the managers from the report itself.
func TestUsageProjection(t *testing.T) {
	l, _, _ := newWindowLive(t, "necessary")
	l.setSettings(strings.Replace(withHumanMail("necessary"), "[80,95]", "[]", 1))
	t0 := time.Date(2026, 10, 11, 10, 0, 0, 0, time.UTC)
	seedProjection(l, t0)
	if err := l.life.reportSubscription(l.ctx, "claude", jsjson.NewObject("five_hour", jsjson.NewObject("used_percentage", 98.0)), t0.Add(31*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(l.notices(), " "); got != `projection|["cos","cost"]|` {
		t.Errorf("notices %s", got)
	}
}

// TestUsageDailySpend: a usage report checks today's spend, so the report that passes cost.dailyWarnUsd mails the human.
func TestUsageDailySpend(t *testing.T) {
	l, _, human := newWindowLive(t, "important")
	l.setSettings(strings.Replace(withHumanMail("important"), `"accounts"`, `"dailyWarnUsd":1,"accounts"`, 1))
	a, err := l.db.GetAgent(l.ctx, "dev")
	if err != nil {
		t.Fatal(err)
	}
	cost := 1.5
	if err := l.life.reportUsage(l.ctx, a, usageReport{counts: [5]*float64{&cost}}, time.Now()); err != nil {
		t.Fatal(err)
	}
	l.until("the human's mail", func() bool { return len(human.mails()) == 1 })
	if m := human.mails()[0]; !strings.Contains(m, "|[stam] Daily spend passed $1|") || !strings.Contains(m, "Top agents today: n-dev $1.50") {
		t.Errorf("mail %s", m)
	}
}

// TestNoticesProjectionNone: a window that reaches 100% beyond 30 minutes, or is at 100% already, warns no one.
func TestNoticesProjectionNone(t *testing.T) {
	l, _, _ := newWindowLive(t, "necessary")
	t0 := time.Date(2026, 10, 11, 10, 0, 0, 0, time.UTC)
	at := func(m float64) string { return isoMs(ms(t0) + m*minute) }
	reading := func(m, used float64) {
		l.exec("INSERT INTO window_readings (name, window, at, used_percentage, resets_at) VALUES ('claude', 'five_hour', ?, ?, NULL)", isoMs(ms(t0)+m*minute+30_000), used)
	}
	for _, m := range []float64{5, 10, 20, 30} {
		l.exec("INSERT INTO usage_samples (agent_id, account, harness, model, bucket, tokens_in) VALUES ('dev', 'max', 'claude', 'claude-opus-5-5', ?, 2000)", at(m))
	}
	// 12 points an hour from 48%: 100% in over four hours.
	reading(0, 40)
	reading(5, 42)
	reading(30, 48)
	now := t0.Add(35 * time.Minute)
	if s, _ := l.life.windowSharesOf(l.ctx, "max", "five_hour", nil, ms(now)); s.projection.reaches100At == nil {
		t.Fatalf("no projection to judge: %+v", s.projection)
	}
	l.life.checkProjection(l.ctx, "claude", "five_hour", now)
	// At 100% now: the projection reads the last reading's time, which has passed.
	reading(33, 100)
	l.life.checkProjection(l.ctx, "claude", "five_hour", now.Add(10*time.Minute))
	if s, _ := l.life.windowSharesOf(l.ctx, "max", "five_hour", nil, ms(now.Add(10*time.Minute))); s.projection.reaches100At == nil {
		t.Fatalf("no projection at 100%%: %+v", s.projection)
	}
	// The table is made by the first notice: none was raised.
	if got := l.query("SELECT COUNT(*) FROM sqlite_master WHERE name = 'cost_notices'"); got != "0" && len(l.notices()) != 0 {
		t.Errorf("notified: %v", l.notices())
	}
}
