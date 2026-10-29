package lifecycle

import (
	"context"
	"errors"
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

// The tests of budgets.go, paidspend.go and peerspend.go, after test/budgets.test.mjs, test/peer-spend.test.mjs and
// test/provider-spend.test.mjs: the ledger is seeded and now is passed in; agents are rows with no harness, and stam's
// mail to the human goes to a recorder.

const orMatch = `"match":{"harness":"opencode","model":"openrouter/"},"subscription":false`

// budgetSettings is test/budgets.test.mjs writeSettings: the openrouter account with a $10 day budget and a Codex
// account, unless cost replaces the accounts or adds keys (raw JSON members of cost).
func budgetSettings(cost string) string {
	accounts := `"accounts":{"openrouter":{` + orMatch + `,"budget":{"usd":10,"per":"day"}},"other":{"match":{"harness":"codex"}}}`
	if strings.Contains(cost, `"accounts"`) {
		accounts = ""
	}
	members := []string{`"subscriptionWarnPercent":[]`}
	for _, m := range []string{accounts, cost} {
		if m != "" {
			members = append(members, m)
		}
	}
	return `{"peers":[],"chiefOfStaff":"n-cos","cost":{` + strings.Join(members, ",") + `}}`
}

var budgetT0 = time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)

const day = 24 * time.Hour

// humanBox records stam's mail to the human about budgets.
type humanBox struct {
	mu   sync.Mutex
	fail bool
	sent []string
}

func (b *humanBox) send(_ context.Context, to []string, subject, body string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.fail {
		return false
	}
	b.sent = append(b.sent, strings.Join(to, ",")+"|"+subject+"|"+body)
	return true
}

func (b *humanBox) mails() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.sent...)
}

func newBudgetLive(t *testing.T, settings string) (*live, *humanBox) {
	l, _ := newCostLive(t, settings)
	box := &humanBox{}
	l.life.budgets.send = box.send
	// A past clock's rollover is due at once; only TestBudgetRolloverTimer lets it evaluate.
	l.life.budgets.rolled = func(string) {}
	return l, box
}

// costMails is the cost notices' mail, once each has gone out.
func (l *live) costMails() []string {
	l.t.Helper()
	l.until("the mail sent", func() bool { return l.life.bgRunning.Load() == 0 })
	return l.costs.mails()
}

// costAgent makes an idle agent row on the harness and model, under parent ("" for none).
func (l *live) costAgent(id, harness, model, parent string) {
	l.t.Helper()
	var p, m *string
	if parent != "" {
		p = &parent
	}
	if model != "" {
		m = &model
	}
	if _, err := l.db.CreateAgent(l.ctx, db.NewAgent{ID: id, Name: "n-" + id, Role: "developer", Machine: "test-machine", Harness: harness, Model: m, Cwd: l.work, ParentID: p}); err != nil {
		l.t.Fatal(err)
	}
	l.set(id, db.Field{Col: "lifecycle", Val: "active"}, db.Field{Col: "activity", Val: "idle"})
}

func (l *live) orAgent(id string) { l.costAgent(id, "opencode", "openrouter/x", "") }

// spendOn seeds paid spend on the openrouter account for the UTC day of at (test/budgets.test.mjs spend).
func (l *live) spendOn(id string, usd float64, at time.Time) {
	l.t.Helper()
	l.exec(`INSERT INTO usage (agent_id, day, harness, model, account, cost_usd) VALUES (?, ?, 'opencode', 'openrouter/x', 'openrouter', ?)
		ON CONFLICT (agent_id, day, account) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd`, id, at.UTC().Format("2006-01-02"), usd)
}

// budgetOf is the agent's budget blocker, nil for none.
func (l *live) budgetOf(id string) *db.Blocker {
	l.t.Helper()
	for _, b := range l.blockerRows(id) {
		if b.Kind == "budget" {
			return &b
		}
	}
	return nil
}

func (l *live) budget(scope string, now time.Time) {
	l.t.Helper()
	<-l.life.EvaluateBudgets(scope, now, "")
}

// eventsOf is the agent's events of the type, oldest first, as their data.
func (l *live) eventsOf(id, typ string) []string {
	l.t.Helper()
	evs, err := l.db.ListEvents(l.ctx, id, 500, typ)
	if err != nil {
		l.t.Fatal(err)
	}
	out := make([]string, len(evs))
	for i, e := range evs {
		out[i] = deref(e.Data)
	}
	return out
}

func last(s []string) string {
	if len(s) == 0 {
		return ""
	}
	return s[len(s)-1]
}

// TestBudgetAccountBlocks: a spent account budget blocks the managed agents on it, and only them.
func TestBudgetAccountBlocks(t *testing.T) {
	l, _ := newBudgetLive(t, budgetSettings(""))
	l.orAgent("a")
	l.orAgent("b")
	l.costAgent("cx", "codex", "gpt-6.1-sol", "")
	l.costAgent("un", "claude", "claude-opus-5-5", "")
	l.spendOn("a", 9.99, budgetT0)
	l.budget("openrouter", budgetT0)
	if l.budgetOf("a") != nil {
		t.Fatal("under the budget nothing is set")
	}
	l.spendOn("a", 0.01, budgetT0)
	l.budget("openrouter", budgetT0)
	for _, id := range []string{"a", "b"} {
		b := l.budgetOf(id)
		if b == nil || b.Account != "openrouter" || b.Reason != "The openrouter day budget of $10 is spent" || l.agent(id).Lifecycle != "paused" {
			t.Errorf("%s: %+v %s", id, b, l.agent(id).Lifecycle)
		}
		if deref(b.Clear) != `{"per":"day","usd":10,"period":"2026-10-14"}` {
			t.Errorf("clear %s", deref(b.Clear))
		}
	}
	if l.budgetOf("cx") != nil || l.budgetOf("un") != nil {
		t.Error("another account's agent or an unmanaged one is blocked")
	}
	if got := last(l.eventsOf("a", "cost:rule")); got != `{"rule":"budget","account":"openrouter","action":"set","reason":"The openrouter day budget of $10 is spent"}` {
		t.Errorf("event %s", got)
	}
}

// TestBudgetIdempotent: evaluating again writes nothing new, and the human is mailed once.
func TestBudgetIdempotent(t *testing.T) {
	l, box := newBudgetLive(t, budgetSettings(""))
	l.orAgent("a")
	l.spendOn("a", 12, budgetT0)
	l.budget("openrouter", budgetT0)
	since := l.budgetOf("a").Since
	n := len(l.eventsOf("a", ""))
	l.budget("openrouter", budgetT0.Add(time.Second))
	if l.budgetOf("a").Since != since || len(l.eventsOf("a", "")) != n || len(l.eventsOf("a", "cost:rule")) != 1 {
		t.Errorf("a second evaluation wrote: %d events", len(l.eventsOf("a", "")))
	}
	if len(box.mails()) != 1 {
		t.Errorf("%d mails", len(box.mails()))
	}
}

// TestBudgetMailFromSystem: with no test sender the budget mail goes from system:budgets, as src/budgets.ts's send does
// since S-1239, and one that system mail couldn't send isn't recorded.
func TestBudgetMailFromSystem(t *testing.T) {
	l, _ := newBudgetLive(t, budgetSettings(""))
	l.life.budgets.send = nil
	l.life.budgets.delays = []time.Duration{}
	human := &systemBox{fail: true}
	l.life.SetSystemMail(human.send)
	l.orAgent("a")
	l.spendOn("a", 12, budgetT0)
	l.budget("openrouter", budgetT0)
	if got := l.query("SELECT count(*) FROM budget_mails"); got != "0" {
		t.Errorf("an unsent mail recorded: %s", got)
	}
	human.mu.Lock()
	human.fail = false
	human.mu.Unlock()
	l.budget("openrouter", budgetT0.Add(time.Second))
	got := human.mails()
	if len(got) != 1 || !strings.HasPrefix(got[0], "budgets|human|[stam] openrouter day budget reached: raise it or keep stopped|") {
		t.Errorf("mails %v", got)
	}
}

// TestBudgetMailMatchesTS: the human's one mail from stam is budget-reached rendered as src/budgets.ts mailHuman does, a
// raise Decision under 150 words.
func TestBudgetMailMatchesTS(t *testing.T) {
	l, box := newBudgetLive(t, budgetSettings(""))
	l.orAgent("a")
	l.spendOn("a", 10, budgetT0)
	l.budget("openrouter", budgetT0)
	l.budget("openrouter", budgetT0.Add(5*time.Second))
	mails := box.mails()
	if len(mails) != 1 {
		t.Fatalf("%d mails", len(mails))
	}
	to, rest, _ := strings.Cut(mails[0], "|")
	subject, body, _ := strings.Cut(rest, "|")
	want := "The openrouter day budget is spent: $10.00 of $10. Stam has stopped the agents on openrouter (n-a). They resume when the day rolls over, or when you raise it.\n\n" +
		"```decision\nRaise the openrouter day budget from $10?\n- Raise to $15: $5 more\n- Raise to $20: $10 more\n- Keep stopped: the agents stay stopped\n```\n\n" +
		"To raise it, set `cost.accounts.openrouter.budget.usd` in Settings, Cost. A raise clears the stop within moments. Only you can raise a budget; no agent can."
	if to != "human" || subject != "[stam] openrouter day budget reached: raise it or keep stopped" || strings.TrimSpace(body) != want {
		t.Errorf("%s|%s|%q", to, subject, body)
	}
	if n := len(strings.Fields(body)); n >= 150 {
		t.Errorf("%d words", n)
	}
	if mailed, _ := l.db.BudgetMailed(l.ctx, "openrouter:2026-10-14:10"); !mailed {
		t.Error("the mail isn't recorded under its key")
	}
}

// TestBudgetMailOptions: raiseSteps give at most three options, rounded to cents; a long list of agents is cut at six;
// the global scope names its own settings path; a cap says it holds.
func TestBudgetMailOptions(t *testing.T) {
	l, box := newBudgetLive(t, budgetSettings(`"global":{"budget":{"usd":3,"per":"cap","raiseSteps":[0.333,1,2,4]}},"accounts":{"openrouter":{`+orMatch+`}}`))
	for i := 0; i < 8; i++ {
		l.orAgent(fmt.Sprintf("a%d", i))
	}
	l.spendOn("a0", 3, budgetT0)
	l.budget("global", budgetT0)
	mails := box.mails()
	if len(mails) != 1 {
		t.Fatalf("%d mails", len(mails))
	}
	for _, s := range []string{"The global cap is spent: $3.00 of $3. Stam has stopped the agents on global (n-a0, n-a1, n-a2, n-a3, n-a4, n-a5, and 2 more). A cap holds until you raise it.",
		"- Raise to $3.33: $0.33 more\n- Raise to $4: $1 more\n- Raise to $5: $2 more\n- Keep stopped", "`cost.global.budget.usd`"} {
		if !strings.Contains(mails[0], s) {
			t.Errorf("no %q in %s", s, mails[0])
		}
	}
	if !strings.Contains(mails[0], "|[stam] global cap reached: raise it or keep stopped|") {
		t.Errorf("subject: %s", mails[0])
	}
}

// TestBudgetRaise: a raise lifts the stop and a later hit mails again.
func TestBudgetRaise(t *testing.T) {
	l, box := newBudgetLive(t, budgetSettings(""))
	l.orAgent("a")
	l.spendOn("a", 10, budgetT0)
	l.budget("openrouter", budgetT0)
	l.setSettings(budgetSettings(`"accounts":{"openrouter":{` + orMatch + `,"budget":{"usd":10.5,"per":"day"}}}`))
	l.budget("openrouter", budgetT0)
	if l.budgetOf("a") != nil || l.agent("a").Lifecycle != "active" {
		t.Fatalf("still stopped: %+v %s", l.budgetOf("a"), l.agent("a").Lifecycle)
	}
	if got := last(l.eventsOf("a", "blocker:clear")); !strings.Contains(got, `"cleared":"the budget was raised to $10.5"`) {
		t.Errorf("clear %s", got)
	}
	if got := last(l.eventsOf("a", "cost:rule")); got != `{"rule":"budget","account":"openrouter","action":"clear","reason":"The openrouter day budget of $10 is spent","cleared":"the budget was raised to $10.5"}` {
		t.Errorf("rule %s", got)
	}
	l.spendOn("a", 1, budgetT0)
	l.budget("openrouter", budgetT0)
	if l.budgetOf("a") == nil || len(box.mails()) != 2 {
		t.Errorf("the new amount: %+v, %d mails", l.budgetOf("a"), len(box.mails()))
	}
}

// TestBudgetRollover: the period rolling over lifts it; a cap does not roll over.
func TestBudgetRollover(t *testing.T) {
	l, _ := newBudgetLive(t, budgetSettings(""))
	l.orAgent("a")
	l.spendOn("a", 10, budgetT0)
	l.budget("openrouter", budgetT0)
	if l.budgetOf("a") == nil {
		t.Fatal("not stopped")
	}
	l.budget("openrouter", budgetT0.Add(day))
	if l.budgetOf("a") != nil || !strings.Contains(last(l.eventsOf("a", "blocker:clear")), "rolled over") {
		t.Errorf("rollover: %+v %s", l.budgetOf("a"), last(l.eventsOf("a", "blocker:clear")))
	}
	l.setSettings(budgetSettings(`"accounts":{"openrouter":{` + orMatch + `,"budget":{"usd":10,"per":"cap"}}}`))
	l.budget("openrouter", budgetT0.Add(day))
	if b := l.budgetOf("a"); b == nil || deref(b.Clear) != `{"per":"cap","usd":10,"period":"cap"}` {
		t.Errorf("the cap counts all time: %+v", b)
	}
	l.budget("openrouter", budgetT0.Add(40*day))
	if l.budgetOf("a") == nil {
		t.Error("the cap rolled over")
	}
}

// TestBudgetRemoved: removing the budget lifts the stop.
func TestBudgetRemoved(t *testing.T) {
	l, _ := newBudgetLive(t, budgetSettings(""))
	l.orAgent("a")
	l.spendOn("a", 10, budgetT0)
	l.budget("openrouter", budgetT0)
	l.setSettings(budgetSettings(`"accounts":{"openrouter":{` + orMatch + `}}`))
	<-l.life.EvaluateAllBudgets(budgetT0, "")
	if l.budgetOf("a") != nil || !strings.Contains(last(l.eventsOf("a", "blocker:clear")), "the budget was removed") {
		t.Errorf("%+v %s", l.budgetOf("a"), last(l.eventsOf("a", "blocker:clear")))
	}
}

// TestBudgetGlobal: the global budget sums every account and blocks every managed agent.
func TestBudgetGlobal(t *testing.T) {
	l, box := newBudgetLive(t, budgetSettings(`"global":{"budget":{"usd":4,"per":"day"}},"accounts":{"openrouter":{`+orMatch+`},"other":{"match":{"harness":"codex"}}}`))
	l.orAgent("a")
	l.costAgent("cx", "codex", "gpt-6.1-sol", "")
	l.costAgent("un", "claude", "claude-opus-5-5", "")
	l.spendOn("a", 4, budgetT0)
	<-l.life.OnSpend("openrouter", budgetT0)
	for _, id := range []string{"a", "cx"} {
		if b := l.budgetOf(id); b == nil || b.Account != "global" || b.Reason != "The global day budget of $4 is spent" {
			t.Errorf("%s: %+v", id, b)
		}
	}
	if l.budgetOf("un") != nil || len(box.mails()) != 1 {
		t.Errorf("unmanaged %+v, %d mails", l.budgetOf("un"), len(box.mails()))
	}
}

// TestBudgetLow: 90% of a budget notifies the managers of the trees on the account, once, in TS's words.
func TestBudgetLow(t *testing.T) {
	l, box := newBudgetLive(t, budgetSettings(""))
	l.costAgent("mgr", "claude", "claude-opus-5-5", "")
	l.costAgent("a", "opencode", "openrouter/x", "mgr")
	l.spendOn("a", 9, budgetT0)
	l.budget("openrouter", budgetT0)
	l.budget("openrouter", budgetT0.Add(time.Second))
	got := l.notices()
	if len(got) != 1 || got[0] != `budget-low|["mgr"]|` {
		t.Fatalf("notices %v", got)
	}
	if k := l.query("SELECT key || '|' || account FROM cost_notices"); k != "budget-low:openrouter:2026-10-14:10|openrouter" {
		t.Errorf("key %s", k)
	}
	if l.budgetOf("a") != nil || len(box.mails()) != 0 {
		t.Error("stopped or mailed at 90%")
	}
	id := l.noticeID("budget-low")
	want := "[stam] Cost notice " + id + ": openrouter at 90% of its day budget"
	mails := l.costMails()
	if len(mails) != 1 || !strings.Contains(mails[0], "|"+want+"|") ||
		!strings.Contains(mails[0], "Paid spend on openrouter is $9.00 of its $10.00 day budget. Stam stops the agents on openrouter when it is spent; only the human raises a budget, and stam asks them then.") ||
		!strings.Contains(mails[0], "A budget is paid dollars, not a subscription window, so stam has no percentage share for it.") {
		t.Errorf("mail %v", mails)
	}
}

// TestBudgetBlockerNotices: a blocker set and cleared notifies the blocked agent's manager.
func TestBudgetBlockerNotices(t *testing.T) {
	l, _ := newBudgetLive(t, budgetSettings(""))
	l.costAgent("mgr", "claude", "claude-opus-5-5", "")
	l.costAgent("a", "opencode", "openrouter/x", "mgr")
	l.spendOn("a", 10, budgetT0)
	l.budget("openrouter", budgetT0)
	l.budget("openrouter", budgetT0.Add(day))
	got := strings.Join(l.notices(), ";")
	if !strings.Contains(got, `blocker-set|["mgr"]|a`) || !strings.Contains(got, `blocker-clear|["mgr"]|a`) {
		t.Errorf("notices %s", got)
	}
}

// TestBudgetGlobalLedger: global spend sums the whole ledger, exact and estimated rows, and an account since deleted.
func TestBudgetGlobalLedger(t *testing.T) {
	l, _ := newBudgetLive(t, budgetSettings(`"global":{"budget":{"usd":4,"per":"day"}},"accounts":{"openrouter":{`+orMatch+`},"claude-p":{"match":{"harness":"claude"},"paid":true},"other":{"match":{"harness":"codex"}}}`))
	l.orAgent("a")
	l.costAgent("c", "claude", "claude-opus-5-5", "")
	l.costAgent("cx", "codex", "gpt-6.1-sol", "")
	l.spendOn("a", 2, budgetT0)
	// Claude's status-line cost counts only as its paid estimate; cost_usd is not paid spend.
	l.exec("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, paid_estimate_usd) VALUES ('c', '2026-10-14', 'claude', 'claude-opus-5-5', 'claude-p', 50, 1.5)")
	l.budget("global", budgetT0)
	if l.budgetOf("cx") != nil {
		t.Fatal("2 + 1.5 is under 4")
	}
	l.exec("UPDATE usage SET paid_estimate_usd = 2 WHERE agent_id = 'c'")
	l.budget("global", budgetT0)
	if l.budgetOf("cx") == nil {
		t.Fatal("2 + 2 reaches 4, counted once")
	}
	l.setSettings(budgetSettings(`"global":{"budget":{"usd":4,"per":"day"}},"accounts":{"other":{"match":{"harness":"codex"}}}`))
	l.budget("global", budgetT0)
	if l.budgetOf("cx") == nil {
		t.Error("deleting a spent account lowered what was spent")
	}
}

// TestBudgetGlobalBilled: global spend counts a renamed or deleted OpenRouter account by billed cost, and the decision
// calls under openrouter.
func TestBudgetGlobalBilled(t *testing.T) {
	l, _ := newBudgetLive(t, budgetSettings(`"global":{"budget":{"usd":3,"per":"day"}},"accounts":{"other":{"match":{"harness":"codex"}}}`))
	l.costAgent("a", "opencode", "openrouter/x", "")
	l.costAgent("cx", "codex", "gpt-6.1-sol", "")
	l.exec("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, paid_estimate_usd) VALUES ('a', '2026-10-14', 'opencode', 'openrouter/x', 'old-or', 2, 0)")
	l.budget("global", budgetT0)
	if l.budgetOf("cx") != nil {
		t.Fatal("2 of 3")
	}
	l.exec("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd) VALUES ('cx', '2026-10-14', 'stam', 'mail-check', 'openrouter', 1)")
	l.budget("global", budgetT0)
	if l.budgetOf("cx") == nil {
		t.Error("2 + 1 reaches 3")
	}
}

// TestBudgetSpawnHeld: a spawn onto a spent account or the global scope is held, others are not, and a new agent on a
// spent scope carries the blocker from the start (src/budgets.ts attachSpawn).
func TestBudgetSpawnHeld(t *testing.T) {
	l, _ := newBudgetLive(t, budgetSettings(""))
	l.orAgent("a")
	l.spendOn("a", 10, time.Now())
	if got := l.life.SpawnHeld(l.ctx, "openrouter", time.Now()); got != "account openrouter's day budget of $10 is spent" {
		t.Errorf("held %q", got)
	}
	if got := l.life.SpawnHeld(l.ctx, "other", time.Now()); got != "" {
		t.Errorf("other %q", got)
	}
	l.setSettings(budgetSettings(`"global":{"budget":{"usd":10,"per":"day"}},"accounts":{"openrouter":{` + orMatch + `},"other":{"match":{"harness":"codex"}}}`))
	if got := l.life.SpawnHeld(l.ctx, "other", time.Now()); got != "the global day budget of $10 is spent" {
		t.Errorf("global %q", got)
	}
	l.orAgent("forced")
	l.life.AttachBudget(l.ctx, l.agent("forced"))
	if b := l.budgetOf("forced"); b == nil || b.Account != "global" {
		t.Errorf("forced %+v", b)
	}
	// An unmanaged agent attaches nothing.
	l.costAgent("un", "claude", "claude-opus-5-5", "")
	l.life.AttachBudget(l.ctx, l.agent("un"))
	if l.budgetOf("un") != nil {
		t.Error("an unmanaged agent got a budget blocker")
	}
}

// TestAdmitSpawnMatchesTS: src/admission.ts admitSpawn refuses a spawn onto a spent budget unless the human forces it.
func TestAdmitSpawnMatchesTS(t *testing.T) {
	t.Skip("the spawn refusal (src/admission.ts admitSpawn) is not in the Go daemon yet, S-3545: a spawn onto a spent budget starts held by its blocker instead (TestBudgetSpawnHeld)")
}

// TestBudgetOutOfScope: an agent a settings change moves out of scope loses the blocker.
func TestBudgetOutOfScope(t *testing.T) {
	l, _ := newBudgetLive(t, budgetSettings(""))
	l.orAgent("a")
	l.spendOn("a", 10, budgetT0)
	l.orAgent("b")
	l.budget("openrouter", budgetT0)
	if l.budgetOf("a") == nil || l.budgetOf("b") == nil {
		t.Fatal("not both stopped")
	}
	l.setSettings(budgetSettings(`"accounts":{"openrouter":{"match":{"harness":"opencode","model":"openrouter/y"},"subscription":false,"budget":{"usd":10,"per":"day"}},"other":{"match":{"harness":"codex"}}}`))
	l.exec("UPDATE agents SET model = 'openrouter/y' WHERE id = 'b'")
	l.budget("openrouter", budgetT0)
	if l.budgetOf("a") != nil || l.budgetOf("b") == nil {
		t.Errorf("a %+v, b %+v", l.budgetOf("a"), l.budgetOf("b"))
	}
	if got := last(l.eventsOf("a", "cost:rule")); !strings.Contains(got, `"cleared":"the agent is no longer in this budget's scope"`) {
		t.Errorf("rule %s", got)
	}
}

// TestBudgetMailRetry: a mail that fails to send is retried on a timer with no later usage, and recorded once sent.
func TestBudgetMailRetry(t *testing.T) {
	l, box := newBudgetLive(t, budgetSettings(""))
	l.life.budgets.delays = []time.Duration{time.Millisecond, time.Millisecond, time.Millisecond}
	l.orAgent("a")
	now := time.Now()
	l.spendOn("a", 10, now)
	box.mu.Lock()
	box.fail = true
	box.mu.Unlock()
	l.budget("openrouter", now)
	if len(box.mails()) != 0 {
		t.Fatal("sent")
	}
	box.mu.Lock()
	box.fail = false
	box.mu.Unlock()
	l.until("the retry", func() bool { return len(box.mails()) == 1 })
	l.budget("openrouter", now)
	if len(box.mails()) != 1 {
		t.Errorf("%d mails", len(box.mails()))
	}
}

// TestBudgetMailRetryStops: the retries stop after the last delay, until the next evaluation.
func TestBudgetMailRetryStops(t *testing.T) {
	l, box := newBudgetLive(t, budgetSettings(""))
	l.life.budgets.delays = []time.Duration{time.Millisecond}
	l.orAgent("a")
	now := time.Now()
	l.spendOn("a", 10, now)
	tries := 0
	l.life.budgets.send = func(context.Context, []string, string, string) bool { tries++; return false }
	l.budget("openrouter", now)
	l.until("the one retry", func() bool { l.budget("openrouter", now); return tries >= 2 })
	_ = box
	l.life.mu.Lock()
	n := l.life.budgets.tries["openrouter:"+now.UTC().Format("2006-01-02")+":10"]
	l.life.mu.Unlock()
	if n != 1 {
		t.Errorf("%d tries recorded", n)
	}
}

// TestBudgetLowHome: only the settings home raises the 90% notice.
func TestBudgetLowHome(t *testing.T) {
	l, _ := newBudgetLive(t, strings.Replace(budgetSettings(""), `"peers":[]`, `"home":"peer1","peers":[]`, 1))
	l.costAgent("mgr", "claude", "claude-opus-5-5", "")
	l.costAgent("a", "opencode", "openrouter/x", "mgr")
	l.spendOn("a", 9, budgetT0)
	l.budget("openrouter", budgetT0)
	// cost_notices is created by the first notice, so no table means no warning.
	if l.query("SELECT count(*) FROM sqlite_master WHERE name = 'cost_notices'") == "0" {
		return
	}
	if got := l.notices(); len(got) != 0 {
		t.Errorf("a non-home machine warned: %v", got)
	}
}

// TestBudgetDecideSpend: the decision model's own spend crossing the global cap blocks and mails, with no agent report
// (src/decide.ts recordSpend calls ledgerChanged; decide.go's LedgerChanged hook, wired in the server, calls this).
func TestBudgetDecideSpend(t *testing.T) {
	l, box := newBudgetLive(t, budgetSettings(`"global":{"budget":{"usd":8,"per":"day"}},"accounts":{"other":{"match":{"harness":"codex"}}}`))
	l.costAgent("cx", "codex", "gpt-6.1-sol", "")
	decideSpend := func() {
		if err := l.db.RecordDecideSpend(l.ctx, "decide:test", 5, 1, 1); err != nil {
			t.Fatal(err)
		}
		l.life.LedgerChanged("")
		<-l.life.EvaluateBudgets("global", time.Now(), "")
	}
	decideSpend()
	if l.budgetOf("cx") != nil {
		t.Fatal("$5 of $8")
	}
	decideSpend()
	if b := l.budgetOf("cx"); b == nil || b.Reason != "The global day budget of $8 is spent" || len(box.mails()) != 1 {
		t.Errorf("%+v, %d mails", b, len(box.mails()))
	}
}

// TestBudgetReconciledMatchesTS: a reconciliation that shows the cap wasn't reached lifts the stop, and says so.
func TestBudgetReconciledMatchesTS(t *testing.T) {
	l, _ := newBudgetLive(t, budgetSettings(""))
	l.orAgent("a")
	l.spendOn("a", 10, budgetT0)
	l.budget("openrouter", budgetT0)
	// The correction as reconcileLedger makes it: the ledger write, then every budget with cause reconciled (TestReconLiftsBudget
	// runs it whole).
	l.exec("UPDATE usage SET cost_usd = 4 WHERE agent_id = 'a'")
	<-l.life.EvaluateBudgets("openrouter", budgetT0, budgetsReconciled)
	if l.budgetOf("a") != nil || !strings.Contains(last(l.eventsOf("a", "blocker:clear")), "the ledger was corrected to the billed amount and the budget is no longer spent") || l.agent("a").Lifecycle != "active" {
		t.Errorf("%+v %s", l.budgetOf("a"), last(l.eventsOf("a", "blocker:clear")))
	}
}

const sysAccount = `"openrouter-system":{"match":{"harness":"stam"},"budget":{"usd":%v,"per":"day"}}`

func sysSettings(usd float64) string {
	return budgetSettings(`"accounts":{"openrouter":{` + orMatch + `,"budget":{"usd":10,"per":"day"}},` + fmt.Sprintf(sysAccount, usd) + `}`)
}

// TestBudgetSystemApart: system calls count against openrouter-system's budget, not the agents'.
func TestBudgetSystemApart(t *testing.T) {
	l, _ := newBudgetLive(t, sysSettings(100))
	l.orAgent("a")
	if err := l.db.RecordDecideSpend(l.ctx, "decide:test", 5, 1, 1); err != nil {
		t.Fatal(err)
	}
	if usd, ok, _ := l.life.paidSpentIn(l.ctx, "openrouter-system", "day", time.Now()); !ok || usd != 5 {
		t.Errorf("system %v %v", usd, ok)
	}
	if usd, _, _ := l.life.paidSpentIn(l.ctx, "openrouter", "day", time.Now()); usd != 0 {
		t.Errorf("the agents' budget sees the system's spend: %v", usd)
	}
	<-l.life.OnSpend("openrouter", time.Now())
	if l.budgetOf("a") != nil {
		t.Error("the agent is stopped")
	}
}

// TestBudgetAgentsNotSystem: a spent agents budget stops agents but not system calls.
func TestBudgetAgentsNotSystem(t *testing.T) {
	l, _ := newBudgetLive(t, sysSettings(100))
	l.orAgent("a")
	l.spendOn("a", 10, budgetT0)
	l.budget("openrouter", budgetT0)
	if l.budgetOf("a") == nil || l.life.SystemHeld(l.ctx, budgetT0) != "" || l.life.ProviderHeld(l.ctx, "openrouter", budgetT0) != "" {
		t.Error("the agents' budget holds the system calls")
	}
}

// TestBudgetSystemSpent: a spent system budget holds stam's calls (decide's Held hook), leaves the agents running, and
// mails the human once in the system's words.
func TestBudgetSystemSpent(t *testing.T) {
	l, box := newBudgetLive(t, sysSettings(8))
	l.orAgent("a")
	for i := 0; i < 2; i++ {
		if err := l.db.RecordDecideSpend(l.ctx, "decide:test", 5, 1, 1); err != nil {
			t.Fatal(err)
		}
	}
	<-l.life.EvaluateAllBudgets(time.Now(), "")
	if got := l.life.SystemHeld(l.ctx, time.Now()); got != "the system day budget of $8 is spent" {
		t.Errorf("held %q", got)
	}
	if got := l.life.ProviderHeld(l.ctx, "openrouter", time.Now()); got != "the system day budget of $8 is spent" {
		t.Errorf("provider %q", got)
	}
	if l.budgetOf("a") != nil {
		t.Error("the system budget stopped an agent")
	}
	mails := box.mails()
	if len(mails) != 1 {
		t.Fatalf("%d mails", len(mails))
	}
	for _, s := range []string{"`cost.accounts.openrouter-system.budget.usd`", "Stam's own model calls (mail gate, titles, summaries, decisions) are skipped.",
		"The calls resume when the day rolls over", "- Keep stopped: the calls stay skipped"} {
		if !strings.Contains(mails[0], s) {
			t.Errorf("no %q in %s", s, mails[0])
		}
	}
	if strings.Contains(mails[0], "stopped the agents") || strings.Contains(mails[0], "They resume") {
		t.Errorf("agents' words: %s", mails[0])
	}
}

// TestBudgetProviderHeld: another provider's calls are held by its PROVIDER-system account's budget.
func TestBudgetProviderHeld(t *testing.T) {
	l, _ := newBudgetLive(t, budgetSettings(`"accounts":{"myazure-system":{"match":{"harness":"stam-azure"},"budget":{"usd":1,"per":"month"}}}`))
	if got := l.life.ProviderHeld(l.ctx, "myazure", budgetT0); got != "" {
		t.Errorf("unspent %q", got)
	}
	l.exec("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, paid_estimate_usd) VALUES ('stam', '2026-10-02', 'stam-azure', 'm', 'myazure-system', 0, 1)")
	if got := l.life.ProviderHeld(l.ctx, "myazure", budgetT0); got != "the myazure-system month budget of $1 is spent" {
		t.Errorf("spent %q", got)
	}
	if got := l.life.ProviderHeld(l.ctx, "openrouter", budgetT0); got != "" {
		t.Errorf("openrouter %q", got)
	}
}

// TestBudgetSystemLow: the system budget warns at 90% through cost notices, to the chief of staff.
func TestBudgetSystemLow(t *testing.T) {
	l, _ := newBudgetLive(t, sysSettings(5.5))
	l.costAgent("cos", "claude", "claude-opus-5-5", "")
	if err := l.db.RecordDecideSpend(l.ctx, "decide:test", 5, 1, 1); err != nil {
		t.Fatal(err)
	}
	<-l.life.EvaluateBudgets("openrouter-system", time.Now(), "")
	if got := l.query("SELECT managers FROM cost_notices WHERE account = 'openrouter-system' AND kind = 'budget-low'"); got != `["cos"]` {
		t.Errorf("managers %q", got)
	}
	if !strings.Contains(strings.Join(l.costMails(), "\n"), "Stam skips its own model calls (mail gate, titles, summaries, decisions) when it is spent") {
		t.Errorf("mail %v", l.costMails())
	}
}

// TestBudgetGlobalSystem: global spend counts system calls once.
func TestBudgetGlobalSystem(t *testing.T) {
	l, _ := newBudgetLive(t, budgetSettings(`"global":{"budget":{"usd":4,"per":"day"}},"accounts":{"openrouter-system":{"match":{"harness":"stam"}},"other":{"match":{"harness":"codex"}}}`))
	l.costAgent("cx", "codex", "gpt-6.1-sol", "")
	if err := l.db.RecordDecideSpend(l.ctx, "decide:test", 5, 1, 1); err != nil {
		t.Fatal(err)
	}
	l.budget("global", time.Now())
	if b := l.budgetOf("cx"); b == nil || b.Reason != "The global day budget of $4 is spent" {
		t.Errorf("%+v", b)
	}
	if usd, _ := l.life.paidSpentAll(l.ctx, "day", time.Now()); usd != 5 {
		t.Errorf("counted %v", usd)
	}
}

// TestSystemCallsMigrationMatchesTS: src/db.ts migrateSystemCalls moves stam's old rows to openrouter-system.
func TestSystemCallsMigrationMatchesTS(t *testing.T) {
	t.Skip("the one-off move of stam's old rows (src/db.ts migrateSystemCalls) is the TS daemon's: the Go daemon opens a database the TS daemon made and migrated")
}

// TestBudgetRolloverTimer: a stopped scope's timer lifts the stop at the next period, with no evaluation called.
func TestBudgetRolloverTimer(t *testing.T) {
	l, _ := newBudgetLive(t, budgetSettings(""))
	l.life.budgets.rolled = nil
	l.orAgent("a")
	now := time.Now()
	l.spendOn("a", 10, now)
	l.budget("openrouter", now)
	l.life.mu.Lock()
	timer := l.life.budgets.timers["openrouter"]
	l.life.mu.Unlock()
	if timer == nil {
		t.Fatal("no rollover timer")
	}
	// The rollover, brought forward: yesterday's spend no longer counts.
	l.exec("UPDATE usage SET day = '2000-01-01'")
	timer.Reset(time.Millisecond)
	l.until("the rollover's clear", func() bool { return l.budgetOf("a") == nil })
	// A cap has no rollover.
	l.setSettings(budgetSettings(`"accounts":{"openrouter":{` + orMatch + `,"budget":{"usd":10,"per":"cap"}}}`))
	l.budget("openrouter", now)
	l.life.mu.Lock()
	timer = l.life.budgets.timers["openrouter"]
	l.life.mu.Unlock()
	if timer != nil {
		t.Error("a cap has a rollover timer")
	}
}

// TestNextPeriod: the next day, Monday and first of the month, in UTC, and none for a cap.
func TestNextPeriod(t *testing.T) {
	for per, want := range map[string]string{"day": "2026-10-15", "week": "2026-10-19", "month": "2026-11-01", "": "2026-11-14"} {
		at, ok := nextPeriod(per, budgetT0)
		if !ok || at.Format("2006-01-02") != want || at.Location() != time.UTC {
			t.Errorf("%q: %v %v", per, at, ok)
		}
	}
	if _, ok := nextPeriod("cap", budgetT0); ok {
		t.Error("a cap rolls over")
	}
}

// TestPeriodStartMatchesTS: periodStart's first day, as src/readings.ts gives it (weeks from Monday, months from the
// first, in UTC; a per that is none of these by the day).
func TestPeriodStartMatchesTS(t *testing.T) {
	cases := []struct {
		per, at, want string
	}{
		{"day", "2026-10-14T23:59:59+02:00", "2026-10-14"},
		{"day", "2026-10-14T00:30:00+02:00", "2026-10-13"},
		{"week", "2026-10-14T12:00:00Z", "2026-10-12"},
		{"week", "2026-10-18T23:00:00Z", "2026-10-12"},
		{"week", "2026-10-19T00:00:00Z", "2026-10-19"},
		{"week", "2026-11-01T10:00:00Z", "2026-10-26"},
		{"month", "2026-10-31T23:00:00Z", "2026-10-01"},
		{"month", "2026-03-01T00:00:00Z", "2026-03-01"},
		{"odd", "2026-10-14T12:00:00Z", "2026-10-14"},
	}
	for _, c := range cases {
		at, _ := time.Parse(time.RFC3339, c.at)
		if got, ok := periodStart(c.per, at); !ok || got != c.want {
			t.Errorf("%s %s: %s", c.per, c.at, got)
		}
	}
	if _, ok := periodStart("cap", budgetT0); ok {
		t.Error("a cap has a start")
	}
}

// The provider budgets (test/provider-spend.test.mjs): a pay-per-token provider's spend is its tokens at the registry's
// prices.
const providerSettings = `{"providers":{"myazure":{"kind":"azure","endpoint":"https://r.openai.azure.com","apiVersion":"v1"}},"cost":{"subscriptionWarnPercent":[80,95],"dailyWarnUsd":null,"onError":"soft-stop","global":{"budget":{"usd":100,"per":"month"}},"accounts":{"az":{"match":{"harness":"opencode","model":"myazure/"},"budget":{"usd":5,"per":"month"}},"claude":{"match":{"harness":"claude"},"paid":true}}}}`

func newProviderLive(t *testing.T) *live {
	l, _ := newBudgetLive(t, providerSettings)
	if err := os.WriteFile(filepath.Join(l.home, "registry.json"), []byte(`{"prices":{"myazure/gpt-prod":{"input":2,"output":10,"cacheRead":0.5,"cacheWrite":null}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	return l
}

func (l *live) usageRow(agent, account, harness, model string, in, out, cr, cw, cost, estimate float64) {
	l.t.Helper()
	l.exec(`INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, paid_estimate_usd)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, agent, time.Now().UTC().Format("2006-01-02"), harness, model, account, cost, in, out, cr, cw, estimate)
}

func near(a, b float64) bool { return a-b < 1e-9 && b-a < 1e-9 }

// TestProviderSpendPriced: a provider account is pay-per-token, priced from its tokens at the registry's prices; a model
// with no price counts the cost the harness reported; a context suffix prices as its model.
func TestProviderSpendPriced(t *testing.T) {
	l := newProviderLive(t)
	set := l.life.settings.Get()
	if p := payPerTokenProvider(set, set.CostAccounts["az"], "az"); p != "myazure" {
		t.Errorf("provider %q", p)
	}
	if p := payPerTokenProvider(set, set.CostAccounts["claude"], "claude"); p != "" {
		t.Errorf("claude %q", p)
	}
	// 1M in at $2, 100k out at $10, 1M cache read at $0.5, 100k cache write at the input price $2.
	l.usageRow("a1", "az", "opencode", "myazure/gpt-prod", 1_000_000, 100_000, 1_000_000, 100_000, 99, 0)
	if usd, ok, _ := l.life.paidSpentIn(l.ctx, "az", "month", time.Now()); !ok || !near(usd, 3.7) {
		t.Errorf("priced %v", usd)
	}
	l.exec("DELETE FROM usage")
	l.usageRow("a1", "az", "opencode", "myazure/unpriced", 5_000_000, 0, 0, 0, 0.42, 0)
	if usd, _, _ := l.life.paidSpentIn(l.ctx, "az", "month", time.Now()); !near(usd, 0.42) {
		t.Errorf("unpriced %v", usd)
	}
	l.exec("DELETE FROM usage")
	l.usageRow("a1", "az", "opencode", "myazure/gpt-prod[1m]", 1_000_000, 0, 0, 0, 99, 0)
	if usd, _, _ := l.life.paidSpentIn(l.ctx, "az", "month", time.Now()); !near(usd, 2) {
		t.Errorf("suffix %v", usd)
	}
}

// TestProviderSpendGlobal: the global budget adds the priced spend to the other accounts' paid spend.
func TestProviderSpendGlobal(t *testing.T) {
	l := newProviderLive(t)
	l.usageRow("a1", "az", "opencode", "myazure/gpt-prod", 1_000_000, 0, 0, 0, 50, 0)
	l.usageRow("c1", "claude", "claude", "claude-opus-5-5", 1, 0, 0, 0, 7, 1.5)
	if usd, _ := l.life.paidSpentAll(l.ctx, "month", time.Now()); !near(usd, 3.5) {
		t.Errorf("all %v", usd)
	}
}

// TestProviderSpendHeld: a spent provider budget holds a new agent on that account.
func TestProviderSpendHeld(t *testing.T) {
	l := newProviderLive(t)
	l.usageRow("a1", "az", "opencode", "myazure/gpt-prod", 0, 600_000, 0, 0, 0, 0)
	if got := l.life.SpawnHeld(l.ctx, "az", time.Now()); got != "account az's month budget of $5 is spent" {
		t.Errorf("held %q", got)
	}
	l.exec("DELETE FROM usage")
	if got := l.life.SpawnHeld(l.ctx, "az", time.Now()); got != "" {
		t.Errorf("unspent %q", got)
	}
}

// TestPricesRegistry: the user registry replaces a shipped price by model and removes one with null; an entry with no
// numeric input has no price; a missing output or cache price is the input's.
func TestPricesRegistry(t *testing.T) {
	l, _ := newBudgetLive(t, budgetSettings(""))
	shipped := l.life.prices()
	if len(shipped) == 0 {
		t.Fatal("no shipped prices")
	}
	var some string
	for m := range shipped {
		some = m
		break
	}
	if err := os.WriteFile(filepath.Join(l.home, "registry.json"), []byte(`{"prices":{"`+some+`":null,"x/a":{"input":1},"x/b":{"input":"1"},"x/a[1m]":{"input":"2"},"x/c":{"input":1,"output":null,"cacheRead":2}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	p := l.life.prices()
	if _, ok := p[some]; ok {
		t.Error("a null entry kept its price")
	}
	if p["x/b"].valid {
		t.Error("a string input is a price")
	}
	if _, ok := priceUsd(p, "x/a[1m]", 1, 1, 1, 1); ok {
		t.Error("an entry with no price didn't hide the base model's")
	}
	if usd, ok := priceUsd(p, "x/c", 1e6, 1e6, 1e6, 1e6); !ok || usd != 5 {
		t.Errorf("x/c %v", usd)
	}
	if _, ok := priceUsd(p, "x/zz[1m]", 1, 1, 1, 1); ok {
		t.Error("an unknown model is priced")
	}
}

// The budgets across machines (test/peer-spend.test.mjs).
const peerSpendSettings = `{"peers":[{"name":"peer1","url":"http://127.0.0.1:1","token":"test-peer-token"}],"chiefOfStaff":"n-cos","cost":{"subscriptionWarnPercent":[],"accounts":{"openrouter":{` + orMatch + `,"budget":{"usd":10,"per":"day"}}}}}`

// spendPeers is a PeerSpend whose peers answer with fixed bodies, or fail.
type spendPeers struct {
	mu     sync.Mutex
	names  []string
	bodies map[string]string
	calls  int
}

func (p *spendPeers) Peers() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.names...)
}

func (p *spendPeers) Spend(_ context.Context, peer string) (int, []byte, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls++
	b, ok := p.bodies[peer]
	if !ok {
		return 0, nil, errors.New("unreachable")
	}
	return 200, []byte(b), nil
}

func peerTotals(usd float64) string {
	n := jsjson.Number(usd)
	t := `{"day":` + n + `,"week":` + n + `,"month":` + n + `,"cap":` + n + `}`
	return `{"global":` + t + `,"accounts":{"openrouter":` + t + `}}`
}

// setPeerSpend is src/peer-spend.ts setForTest: the peer's last answer, taken at at.
func (l *live) setPeerSpend(peer, body string, at time.Time) {
	l.t.Helper()
	v, err := jsjson.Parse([]byte(body))
	if err != nil {
		l.t.Fatal(err)
	}
	o, _ := v.(*jsjson.Object)
	l.life.mu.Lock()
	defer l.life.mu.Unlock()
	if l.life.spend.cache == nil {
		l.life.spend.cache, l.life.spend.wentStale = map[string]spendAnswer{}, map[string]bool{}
	}
	if _, ok := l.life.spend.cache[peer]; !ok {
		l.life.spend.order = append(l.life.spend.order, peer)
	}
	l.life.spend.cache[peer] = spendAnswer{at: ms(at), spend: o}
	// An answer just set hasn't gone stale yet, so a refresh that finds it old reports the change.
	delete(l.life.spend.wentStale, peer)
}

func newPeerSpendLive(t *testing.T) (*live, *humanBox, *spendPeers) {
	l, box := newBudgetLive(t, peerSpendSettings)
	peers := &spendPeers{names: []string{"peer1"}, bodies: map[string]string{}}
	l.life.SetPeerSpend(peers)
	return l, box, peers
}

// TestPeerSpendCounts: a peer's spend counts against the budget with the local spend.
func TestPeerSpendCounts(t *testing.T) {
	l, _, _ := newPeerSpendLive(t)
	l.orAgent("a")
	l.spendOn("a", 4, budgetT0)
	l.setPeerSpend("peer1", peerTotals(5), budgetT0)
	l.budget("openrouter", budgetT0)
	if l.budgetOf("a") != nil {
		t.Fatal("$9 across both is under $10")
	}
	l.setPeerSpend("peer1", peerTotals(6), budgetT0)
	l.budget("openrouter", budgetT0)
	if b := l.budgetOf("a"); b == nil || b.Reason != "The openrouter day budget of $10 is spent" {
		t.Errorf("%+v", b)
	}
	if got := l.life.SpawnHeld(l.ctx, "openrouter", budgetT0); got != "account openrouter's day budget of $10 is spent" {
		t.Errorf("held %q", got)
	}
}

// TestPeerSpendStale: a peer that stopped answering counts until its last answer is stale, then not; a peer no longer
// configured never counts.
func TestPeerSpendStale(t *testing.T) {
	l, _, peers := newPeerSpendLive(t)
	l.orAgent("a")
	l.spendOn("a", 4, budgetT0)
	l.setPeerSpend("peer1", peerTotals(7), budgetT0)
	if l.life.SpawnHeld(l.ctx, "openrouter", budgetT0.Add(10*time.Minute-time.Millisecond)) == "" {
		t.Error("a fresh peer doesn't count")
	}
	if got := l.life.SpawnHeld(l.ctx, "openrouter", budgetT0.Add(10*time.Minute+time.Millisecond)); got != "" {
		t.Errorf("a stale peer holds a spawn: %q", got)
	}
	peers.mu.Lock()
	peers.names = nil
	peers.mu.Unlock()
	if got := l.life.SpawnHeld(l.ctx, "openrouter", budgetT0); got != "" {
		t.Errorf("a peer no longer configured holds a spawn: %q", got)
	}
}

// TestPeerSpendStaleEnv: STAM_PEER_SPEND_STALE_MS sets how long a peer's answer counts.
func TestPeerSpendStaleEnv(t *testing.T) {
	t.Setenv("STAM_PEER_SPEND_STALE_MS", "1000")
	l, _, _ := newPeerSpendLive(t)
	l.setPeerSpend("peer1", peerTotals(7), budgetT0)
	if got := l.life.peersSpent("openrouter", "day", ms(budgetT0.Add(999*time.Millisecond))); got != 7 {
		t.Errorf("fresh %v", got)
	}
	if got := l.life.peersSpent("openrouter", "day", ms(budgetT0.Add(1001*time.Millisecond))); got != 0 {
		t.Errorf("stale %v", got)
	}
	if got := l.life.peersSpent("global", "cap", ms(budgetT0)); got != 7 {
		t.Errorf("global %v", got)
	}
	if got := l.life.peersSpent("nope", "cap", ms(budgetT0)); got != 0 {
		t.Errorf("an account the peer doesn't have %v", got)
	}
}

// TestPeerSpendHome: only the settings home mails the human; a non-home machine still blocks its own agents.
func TestPeerSpendHome(t *testing.T) {
	l, box, _ := newPeerSpendLive(t)
	l.orAgent("a")
	l.spendOn("a", 4, budgetT0)
	l.setPeerSpend("peer1", peerTotals(7), budgetT0)
	l.setSettings(strings.Replace(peerSpendSettings, `{"peers"`, `{"home":"peer1","peers"`, 1))
	l.budget("openrouter", budgetT0)
	if l.budgetOf("a") == nil || len(box.mails()) != 0 {
		t.Fatalf("non-home: %+v, %d mails", l.budgetOf("a"), len(box.mails()))
	}
	l.setSettings(peerSpendSettings)
	l.budget("openrouter", budgetT0.Add(time.Second))
	if len(box.mails()) != 1 {
		t.Errorf("the home mails once: %d", len(box.mails()))
	}
}

// TestLocalSpendMatchesTS: GET /api/usage/spend's body, this machine's totals by period, in TS's shape and key order.
func TestLocalSpendMatchesTS(t *testing.T) {
	l, _, _ := newPeerSpendLive(t)
	l.orAgent("a")
	l.spendOn("a", 3, budgetT0)
	s, err := l.life.LocalSpend(l.ctx, budgetT0)
	if err != nil {
		t.Fatal(err)
	}
	if got := jsjson.Stringify(s, ""); got != `{"global":{"day":3,"week":3,"month":3,"cap":3},"accounts":{"openrouter":{"day":3,"week":3,"month":3,"cap":3}}}` {
		t.Errorf("spend %s", got)
	}
	// A Codex account has no paid ledger: 0 in every period.
	l.setSettings(budgetSettings(""))
	s, _ = l.life.LocalSpend(l.ctx, budgetT0)
	if got := jsjson.Stringify(field(s, "accounts"), ""); got != `{"openrouter":{"day":3,"week":3,"month":3,"cap":3},"other":{"day":0,"week":0,"month":0,"cap":0}}` {
		t.Errorf("accounts %s", got)
	}
}

// TestPerMachineMatchesTS: src/peer-spend.ts perMachine, each machine's totals for usage_info.
func TestPerMachineMatchesTS(t *testing.T) {
	t.Skip("perMachine feeds GET /api/usage's paid_spend_by_machine, and /api/usage is not in the Go daemon yet, S-3545")
}

// TestPeerSpendRefresh: a refresh keeps each peer's answer and evaluates the budgets when one moved; a peer going stale
// evaluates once, and a late fresh answer re-arms it. A peer's bad answer keeps the last good one.
func TestPeerSpendRefresh(t *testing.T) {
	l, _, peers := newPeerSpendLive(t)
	l.orAgent("a")
	l.spendOn("a", 4, time.Now())
	peers.mu.Lock()
	peers.bodies["peer1"] = peerTotals(7)
	peers.mu.Unlock()
	now := time.Now()
	if !l.life.refreshPeerSpend(l.ctx, ms(now)) {
		t.Fatal("a first answer is a change")
	}
	l.until("the peer's spend to stop a", func() bool { return l.budgetOf("a") != nil })
	if l.life.refreshPeerSpend(l.ctx, ms(now)) {
		t.Error("the same answer is a change")
	}
	peers.mu.Lock()
	peers.bodies["peer1"] = `{"accounts":{}}`
	peers.mu.Unlock()
	if l.life.refreshPeerSpend(l.ctx, ms(now)) || l.life.peersSpent("openrouter", "day", ms(now)) != 7 {
		t.Error("an answer with no global replaced the last one")
	}
	peers.mu.Lock()
	delete(peers.bodies, "peer1")
	peers.mu.Unlock()
	later := ms(now.Add(10*time.Minute + time.Second))
	if !l.life.refreshPeerSpend(l.ctx, later) {
		t.Error("going stale isn't a change")
	}
	if l.life.refreshPeerSpend(l.ctx, later+1) {
		t.Error("staying stale is reported again")
	}
	// The evaluations queued so far run first, so the stop below lifts only through the explicit refresh, never through a
	// late evaluation that happens to see the old answer.
	<-l.life.EvaluateAllBudgets(time.Now(), "")
	if l.budgetOf("a") == nil {
		t.Fatal("lifted before the peer's answer is old")
	}
	// The stale peer stops counting, which lifts the stop (evaluated at the clock's now, a fresh answer's time aside).
	l.setPeerSpend("peer1", peerTotals(7), now.Add(-time.Hour))
	l.life.refreshPeerSpend(l.ctx, ms(time.Now()))
	l.until("the stale peer's stop to lift", func() bool { return l.budgetOf("a") == nil })
	peers.mu.Lock()
	peers.bodies["peer1"] = peerTotals(7)
	peers.mu.Unlock()
	if !l.life.refreshPeerSpend(l.ctx, later+2) {
		t.Error("a fresh answer after going stale isn't a change")
	}
}

// TestBudgetFallbackGlobal: the global budget's blocker takes cost.global.onExhausted as its fallback (src/cost-fallback.ts
// actionFor); an account's budget blocker takes the account's onBudgetExhausted, else the default.
func TestBudgetFallbackGlobal(t *testing.T) {
	l, _ := newBudgetLive(t, budgetSettings(`"global":{"budget":{"usd":4,"per":"day"},"onExhausted":"soft-stop"},"accounts":{"openrouter":{`+orMatch+`,"onBudgetExhausted":"hard-stop"},"other":{"match":{"harness":"codex"}}}`))
	if f := l.life.actionFor("global", "budget"); f.action != "soft-stop" || f.field != "global.onExhausted" {
		t.Errorf("global %+v", f)
	}
	if f := l.life.actionFor("openrouter", "budget"); f.action != "hard-stop" || f.field != "openrouter.onBudgetExhausted" {
		t.Errorf("openrouter %+v", f)
	}
	if f := l.life.actionFor("other", "budget"); f.action != "wait" || f.field != "" {
		t.Errorf("a configured account doesn't take the global action: %+v", f)
	}
	if f := l.life.actionFor("global", "window"); f.field != "" {
		t.Errorf("another kind takes it: %+v", f)
	}
	l.costAgent("mgr", "claude", "claude-opus-5-5", "")
	l.costAgent("cx", "codex", "gpt-6.1-sol", "mgr")
	l.spendOn("cx", 4, budgetT0)
	l.budget("global", budgetT0)
	if !strings.Contains(strings.Join(l.costMails(), "\n"), "stam applies the fallback: soft-stop (global.onExhausted).") {
		t.Errorf("notice %v", l.costMails())
	}
}

// TestBudgetOnUsage: a usage report on an account evaluates its budget (src/usage.ts report calls onSpend).
func TestBudgetOnUsage(t *testing.T) {
	l, _ := newBudgetLive(t, budgetSettings(""))
	l.orAgent("a")
	cost := 10.0
	var r usageReport
	r.counts[0] = &cost
	if err := l.life.reportUsage(l.ctx, l.agent("a"), r, time.Now()); err != nil {
		t.Fatal(err)
	}
	l.until("the report's budget stop", func() bool { return l.budgetOf("a") != nil })
}

// TestBudgetStartRules: the daemon's start evaluates every budget (src/daemon.ts evaluateAll).
func TestBudgetStartRules(t *testing.T) {
	l, _ := newBudgetLive(t, budgetSettings(""))
	l.orAgent("a")
	l.spendOn("a", 10, time.Now())
	l.life.StartRules()
	l.until("the start's budget stop", func() bool { return l.budgetOf("a") != nil })
}

// TestBudgetSettingsChange: a raise or a removal in settings.json lifts the stop on the next peer-spend tick, with no
// spend, peer change or explicit evaluation (src/daemon.ts evaluates every budget on a settings change).
func TestBudgetSettingsChange(t *testing.T) {
	t.Setenv("STAM_PEER_SPEND_MS", "20")
	for _, c := range []struct{ name, settings, why string }{
		{"raise", strings.Replace(budgetSettings(""), `"usd":10,`, `"usd":100,`, 1), "the budget was raised to $100"},
		{"remove", strings.Replace(budgetSettings(""), `,"budget":{"usd":10,"per":"day"}`, "", 1), "the budget was removed"},
	} {
		t.Run(c.name, func(t *testing.T) {
			l, _ := newBudgetLive(t, budgetSettings(""))
			l.orAgent("a")
			l.spendOn("a", 10, time.Now())
			l.life.StartRules()
			l.until("the start's budget stop", func() bool { return l.budgetOf("a") != nil })
			l.setSettings(c.settings)
			l.until("the stop lifted", func() bool { return l.budgetOf("a") == nil })
			if got := last(l.eventsOf("a", "blocker:clear")); !strings.Contains(got, c.why) {
				t.Errorf("clear %s", got)
			}
		})
	}
	// The first budget added to settings with none sets the stop the same way.
	t.Run("first", func(t *testing.T) {
		unbudgeted := strings.Replace(budgetSettings(""), `,"budget":{"usd":10,"per":"day"}`, "", 1)
		l, _ := newBudgetLive(t, unbudgeted)
		l.orAgent("a")
		l.spendOn("a", 10, time.Now())
		l.life.StartRules()
		l.budget("openrouter", time.Now()) // queued after the start's evaluation on the scope's chain
		if l.budgetOf("a") != nil {
			t.Fatal("stopped with no budget")
		}
		l.setSettings(budgetSettings(`"global":{"budget":{"usd":5,"per":"day"}}`))
		l.until("the global stop", func() bool { return l.budgetOf("a") != nil })
	})
	// The settings home moved here: this machine mails the human about the stop it already holds.
	t.Run("home", func(t *testing.T) {
		l, box := newBudgetLive(t, strings.Replace(budgetSettings(""), `"peers":[]`, `"home":"peer1","peers":[]`, 1))
		l.orAgent("a")
		l.spendOn("a", 10, time.Now())
		l.life.StartRules()
		l.until("the start's budget stop", func() bool { return l.budgetOf("a") != nil })
		if len(box.mails()) != 0 {
			t.Fatal("a machine that isn't the home mailed")
		}
		l.setSettings(budgetSettings(""))
		l.until("the home's mail", func() bool { return len(box.mails()) == 1 })
	})
}

// TestBudgetsMoved: what of the settings counts as the budgets' change. The first read only records them, even when
// nothing is configured; an account's provider and the providers' names count, since they make its spend priced.
func TestBudgetsMoved(t *testing.T) {
	az := `"az":{"match":{"harness":"opencode","model":"myazure/"},"budget":{"usd":5,"per":"month"}}`
	cases := []struct{ name, from, to string }{
		{"first global budget", `{"peers":[]}`, `{"peers":[],"cost":{"global":{"budget":{"usd":5,"per":"day"}}}}`},
		{"account provider", `{"peers":[],"cost":{"accounts":{` + az + `}}}`, `{"peers":[],"cost":{"accounts":{` + strings.Replace(az, `"budget"`, `"provider":"myazure","budget"`, 1) + `}}}`},
		{"home", `{"peers":[],"home":"peer1"}`, `{"peers":[]}`},
		{"providers", `{"peers":[],"cost":{"accounts":{` + az + `}}}`, `{"peers":[],"providers":{"myazure":{"kind":"azure","endpoint":"https://r.openai.azure.com","apiVersion":"v1"}},"cost":{"accounts":{` + az + `}}}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			l, _ := newBudgetLive(t, c.from)
			if l.life.budgetsMoved() {
				t.Fatal("the first read moved")
			}
			if l.life.budgetsMoved() {
				t.Fatal("unchanged settings moved")
			}
			l.setSettings(c.to)
			if !l.life.budgetsMoved() {
				t.Fatal("the change didn't move")
			}
			if l.life.budgetsMoved() {
				t.Fatal("moved twice for one change")
			}
		})
	}
}
