package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"stam/internal/db"
	"stam/internal/jsjson"
)

// The OpenRouter credit poll and the ledger's reconciliation (credits.go, ledgerrecon.go), after test/openrouter.test.mjs
// and test/ledger-recon.test.mjs: a stub stands in for openrouter.ai/api/v1 (STAM_OPENROUTER_URL), and the key is in the
// home's opencode.env, as there.

// orStub is the stubbed /credits and /key, each with its own status; hold, when set, keeps /credits waiting for it, and
// onKey runs while /key is answered.
type orStub struct {
	mu      sync.Mutex
	credits struct {
		status      int
		total, used jsjson.Value
	}
	key struct {
		status           int
		limit, remaining jsjson.Value
	}
	calls   []string
	reached chan struct{}
	hold    chan struct{}
	onKey   func()
}

func (s *orStub) setCredits(status int, total, used jsjson.Value) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.credits.status, s.credits.total, s.credits.used = status, total, used
}

func (s *orStub) setKey(status int, limit, remaining jsjson.Value) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.key.status, s.key.limit, s.key.remaining = status, limit, remaining
}

func (s *orStub) hits() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.calls...)
}

func (s *orStub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	s.calls = append(s.calls, r.URL.Path+" "+r.Header.Get("authorization"))
	hold, reached, onKey := s.hold, s.reached, s.onKey
	s.mu.Unlock()
	w.Header().Set("content-type", "application/json")
	answer := func(status int, data map[string]jsjson.Value) {
		w.WriteHeader(status)
		if status != 200 {
			fmt.Fprint(w, "{}")
			return
		}
		o := jsjson.NewObject()
		d := jsjson.NewObject()
		for _, k := range []string{"total_credits", "total_usage", "limit", "limit_remaining"} {
			if v, ok := data[k]; ok {
				d.Set(k, v)
			}
		}
		o.Set("data", d)
		fmt.Fprint(w, jsjson.Stringify(o, ""))
	}
	switch r.URL.Path {
	case "/api/v1/credits":
		if hold != nil {
			close(reached)
			<-hold
		}
		s.mu.Lock()
		c := s.credits
		s.mu.Unlock()
		answer(c.status, map[string]jsjson.Value{"total_credits": c.total, "total_usage": c.used})
	case "/api/v1/key":
		if onKey != nil {
			onKey()
		}
		s.mu.Lock()
		k := s.key
		s.mu.Unlock()
		answer(k.status, map[string]jsjson.Value{"limit": k.limit, "limit_remaining": k.remaining})
	default:
		w.WriteHeader(404)
		fmt.Fprint(w, "{}")
	}
}

// newCreditLive is a budget live with the stub serving OpenRouter and a key in opencode.env; the human's warning mail
// lands in the box.
func newCreditLive(t *testing.T, settings string) (*live, *orStub, *humanBox) {
	l, _ := newBudgetLive(t, settings)
	stub := &orStub{}
	stub.setCredits(200, 10.0, 1.0)
	stub.setKey(200, nil, nil)
	srv := httptest.NewServer(stub)
	t.Cleanup(srv.Close)
	t.Setenv("STAM_OPENROUTER_URL", srv.URL+"/api/v1")
	l.writeKey("test-key")
	box := &humanBox{}
	l.life.credits.send = box.send
	return l, stub, box
}

func (l *live) writeKey(key string) {
	l.t.Helper()
	if err := os.WriteFile(filepath.Join(l.home, "opencode.env"), []byte("OPENROUTER_API_KEY="+key+"\n"), 0o600); err != nil {
		l.t.Fatal(err)
	}
}

// creditEntryJSON is the stored openrouter entry, "" for none.
func (l *live) creditEntryJSON() string {
	l.t.Helper()
	data, _, ok, err := l.db.Subscription(l.ctx, "openrouter")
	if err != nil {
		l.t.Fatal(err)
	}
	if !ok {
		return ""
	}
	return data
}

func (l *live) creditsField(key string) jsjson.Value {
	l.t.Helper()
	v, _ := jsjson.Parse([]byte(l.creditEntryJSON()))
	return field(field(v, "credits"), key)
}

// poll is one whole poll, its evaluations included.
func (l *live) poll() {
	l.t.Helper()
	l.life.PollCredits(l.ctx)
	<-l.life.EvaluateAllBudgets(time.Now(), "")
}

func (l *live) lowMails(box *humanBox) int {
	n := 0
	for _, m := range box.mails() {
		if strings.Contains(m, "OpenRouter credit low") {
			n++
		}
	}
	return n
}

const humanImportant = `{"peers":[],"humanMail":{"when":"important"}}`

func TestCreditPollStores(t *testing.T) {
	l, stub, box := newCreditLive(t, humanImportant)
	l.orAgent("a1")
	stub.setCredits(200, 10.0, 1.17)
	l.poll()
	if l.creditsField("total") != any(10.0) || l.creditsField("used") != any(1.17) || l.creditsField("key_limit") != nil {
		t.Errorf("entry %s", l.creditEntryJSON())
	}
	if r, _ := l.creditsField("remaining").(float64); math.Abs(r-8.83) > 1e-9 {
		t.Errorf("remaining %v", r)
	}
	if l.lowMails(box) != 0 {
		t.Error("above the threshold, a warning")
	}
	if h := strings.Join(stub.hits(), ","); !strings.Contains(h, "/api/v1/credits") || !strings.Contains(h, "/api/v1/key") {
		t.Errorf("hits %s", h)
	}
	// The entry's shape and key order are TS's.
	if !strings.HasPrefix(l.creditEntryJSON(), `{"credits":{"total":10,"used":1.17,"remaining":8.83`) || !strings.HasSuffix(l.creditEntryJSON(), `},"warned":null,"pending":false}`) {
		t.Errorf("entry %s", l.creditEntryJSON())
	}
	if _, err := time.Parse(time.RFC3339Nano, fmt.Sprint(l.creditsField("observed_at"))); err != nil {
		t.Errorf("observed_at %v", l.creditsField("observed_at"))
	}
}

// One poll uses one key: a rotation while /credits is pending does not reach /key.
func TestCreditPollOneKey(t *testing.T) {
	l, stub, _ := newCreditLive(t, humanImportant)
	stub.mu.Lock()
	stub.hold, stub.reached = make(chan struct{}), make(chan struct{})
	hold, reached := stub.hold, stub.reached
	stub.mu.Unlock()
	done := make(chan struct{})
	go func() { l.life.PollCredits(l.ctx); close(done) }()
	<-reached
	l.writeKey("rotated-key")
	close(hold)
	<-done
	if h := strings.Join(stub.hits(), ","); h != "/api/v1/credits Bearer test-key,/api/v1/key Bearer test-key" {
		t.Errorf("calls %s", h)
	}
}

func TestCreditPollKeyLimit(t *testing.T) {
	l, stub, _ := newCreditLive(t, humanImportant)
	stub.setKey(200, 5.0, 4.5)
	l.poll()
	if l.creditsField("remaining") != any(4.5) || l.creditsField("key_limit") != any(5.0) {
		t.Errorf("the smaller of account and key: %s", l.creditEntryJSON())
	}
	// A /credits 401 falls back to the key limit.
	l.exec("DELETE FROM subscriptions WHERE name = 'openrouter'")
	stub.setCredits(401, nil, nil)
	stub.setKey(200, 5.0, 1.5)
	l.poll()
	if l.creditsField("remaining") != any(1.5) || l.creditsField("key_limit") != any(5.0) || l.creditsField("total") != nil {
		t.Errorf("the key alone: %s", l.creditEntryJSON())
	}
}

// An error keeps the last valid reading, never zero; a /key error keeps the cap, and a recovered /key wins.
func TestCreditPollErrors(t *testing.T) {
	l, stub, box := newCreditLive(t, humanImportant)
	l.poll()
	if l.creditsField("remaining") != any(9.0) {
		t.Fatalf("entry %s", l.creditEntryJSON())
	}
	stub.setCredits(500, nil, nil)
	stub.setKey(429, nil, nil)
	l.poll()
	if l.creditsField("remaining") != any(9.0) || l.lowMails(box) != 0 {
		t.Errorf("after both failed: %s", l.creditEntryJSON())
	}
	// A failed /credits with a working /key keeps the account's last totals.
	stub.setKey(200, 5.0, 4.0)
	l.poll()
	if l.creditsField("total") != any(10.0) || l.creditsField("used") != any(1.0) || l.creditsField("remaining") != any(4.0) {
		t.Errorf("after /credits failed: %s", l.creditEntryJSON())
	}
	l.exec("DELETE FROM subscriptions WHERE name = 'openrouter'")
	stub.setCredits(200, 10.0, 1.0)
	stub.setKey(200, 5.0, 4.5)
	l.poll()
	stub.setCredits(200, 10.0, 3.0)
	stub.setKey(500, nil, nil)
	l.poll()
	if l.creditsField("remaining") != any(4.5) || l.creditsField("key_limit") != any(5.0) {
		t.Errorf("the last key remaining still caps: %s", l.creditEntryJSON())
	}
	stub.setKey(200, 5.0, 2.0)
	l.poll()
	if l.creditsField("remaining") != any(2.0) {
		t.Errorf("the recovered key wins: %s", l.creditEntryJSON())
	}
}

// Mails once per top-up and re-arms when the balance recovers; a top-up that stays below the threshold re-arms too.
func TestCreditWarning(t *testing.T) {
	l, stub, box := newCreditLive(t, humanImportant)
	l.orAgent("a1")
	l.poll()
	if l.lowMails(box) != 0 {
		t.Fatal("warned at $9")
	}
	stub.setCredits(200, 10.0, 9.2)
	l.poll()
	if l.lowMails(box) != 1 {
		t.Fatalf("%d warnings below $2", l.lowMails(box))
	}
	want := "human|[stam] OpenRouter credit low: $0.80 left|OpenRouter credit is down to $0.80, below your warning threshold of $2.00.\n\nAgents using OpenRouter: n-a1. Top up the balance at https://openrouter.ai/settings/credits before their turns start failing."
	if got := strings.TrimSpace(box.mails()[0]); got != want {
		t.Errorf("mail %q", got)
	}
	stub.setCredits(200, 10.0, 9.5)
	l.poll()
	if l.lowMails(box) != 1 {
		t.Error("a second warning for the same top-up")
	}
	stub.setCredits(200, 20.0, 0.0)
	l.poll()
	stub.setCredits(200, 20.0, 19.9)
	l.poll()
	if l.lowMails(box) != 2 {
		t.Errorf("%d warnings after recovering and dropping again", l.lowMails(box))
	}
	// A top-up that keeps the balance below $2 is warned about again.
	stub.setCredits(200, 22.0, 21.5)
	l.poll()
	if l.lowMails(box) != 3 {
		t.Errorf("%d warnings after a low top-up", l.lowMails(box))
	}
	// The managers of the OpenRouter agents hear first (cost-notices.ts lowCredits).
	if got := l.query("SELECT key FROM cost_notices WHERE kind = 'credits-low' ORDER BY rowid LIMIT 1"); got != "credits:2:10:null" {
		t.Errorf("notice key %q", got)
	}
}

// The warning goes to the human only when humanMail.when allows important; the notice goes regardless.
func TestCreditWarningNecessary(t *testing.T) {
	l, stub, box := newCreditLive(t, `{"peers":[]}`)
	l.costAgent("mgr", "claude", "claude-opus-5-5", "")
	l.costAgent("a1", "opencode", "openrouter/x", "mgr")
	stub.setCredits(200, 10.0, 9.0)
	l.poll()
	if l.lowMails(box) != 0 {
		t.Error("mailed the human at necessary")
	}
	if v, _ := jsjson.Parse([]byte(l.creditEntryJSON())); field(v, "warned") == nil {
		t.Errorf("not marked warned: %s", l.creditEntryJSON())
	}
	if l.query("SELECT count(*) FROM cost_notices WHERE kind = 'credits-low'") != "1" {
		t.Error("no notice")
	}
	if m := strings.Join(l.costMails(), "\n"); !strings.Contains(m, "OpenRouter credit low: $1.00 left") ||
		!strings.Contains(m, "The OpenRouter balance is $1.00, below the $2.00 warning threshold. OpenCode agents on OpenRouter stop when it reaches zero.") {
		t.Errorf("the manager's notice: %s", m)
	}
}

// A warning that couldn't be sent stays pending and is retried on the next poll.
func TestCreditWarningPending(t *testing.T) {
	l, stub, box := newCreditLive(t, humanImportant)
	stub.setCredits(200, 10.0, 9.0)
	l.life.credits.send = func(context.Context, []string, string, string) bool { return false }
	l.poll()
	if v, _ := jsjson.Parse([]byte(l.creditEntryJSON())); field(v, "pending") != any(true) {
		t.Errorf("not pending: %s", l.creditEntryJSON())
	}
	l.life.credits.send = box.send
	l.poll()
	if l.lowMails(box) != 1 {
		t.Error("the pending warning wasn't retried")
	}
	if v, _ := jsjson.Parse([]byte(l.creditEntryJSON())); field(v, "pending") != any(false) {
		t.Errorf("still pending: %s", l.creditEntryJSON())
	}
}

// A warning whose template doesn't render writes nothing, as TS's render throws into the poll's catch; the next poll,
// with the template back, stores the entry and mails.
func TestCreditWarningRenderFails(t *testing.T) {
	l, stub, box := newCreditLive(t, humanImportant)
	stub.setCredits(200, 10.0, 9.0)
	l.life.mu.Lock()
	l.life.credits.render = func(string, map[string]string) (string, error) { return "", errors.New("no template") }
	l.life.mu.Unlock()
	l.poll()
	if got := l.creditEntryJSON(); got != "" {
		t.Errorf("an entry was written: %s", got)
	}
	l.life.mu.Lock()
	l.life.credits.render = nil
	l.life.mu.Unlock()
	l.poll()
	if l.lowMails(box) != 1 || !strings.HasSuffix(l.creditEntryJSON(), `"pending":false}`) {
		t.Errorf("mails %d entry %s", l.lowMails(box), l.creditEntryJSON())
	}
}

func TestCreditNoKey(t *testing.T) {
	l, stub, _ := newCreditLive(t, humanImportant)
	if err := os.Remove(filepath.Join(l.home, "opencode.env")); err != nil {
		t.Fatal(err)
	}
	l.poll()
	if len(stub.hits()) != 0 || l.creditEntryJSON() != "" {
		t.Errorf("hits %v entry %q", stub.hits(), l.creditEntryJSON())
	}
}

// pollCreditsIfActive polls only with an OpenRouter agent active or held, and not twice in creditPollEvery.
func TestCreditPollIfActive(t *testing.T) {
	l, stub, _ := newCreditLive(t, humanImportant)
	l.life.pollCreditsIfActive(l.ctx)
	l.until("no poll", func() bool { return l.life.bgRunning.Load() == 0 })
	if len(stub.hits()) != 0 {
		t.Fatal("polled with no OpenRouter agent")
	}
	l.costAgent("held", "opencode", "openrouter/x", "")
	l.set("held", db.Field{Col: "lifecycle", Val: "paused"})
	if _, err := l.life.AddBlocker(l.ctx, "held", NewBlocker{Kind: "budget", Account: "openrouter", Reason: "r"}); err != nil {
		t.Fatal(err)
	}
	l.life.pollCreditsIfActive(l.ctx)
	l.until("the poll", func() bool { return l.creditEntryJSON() != "" && l.life.bgRunning.Load() == 0 })
	n := len(stub.hits())
	l.life.pollCreditsIfActive(l.ctx)
	l.until("no second poll", func() bool { return l.life.bgRunning.Load() == 0 })
	if len(stub.hits()) != n {
		t.Error("polled twice within five minutes")
	}
	// After a turn: an OpenRouter agent's, at most once a minute.
	l.life.credits.lastPoll = time.Now().Add(-2 * time.Minute)
	l.life.PollCreditsAfterTurn(db.Agent{Model: ptr("claude-opus-5-5")})
	l.until("no poll for another model", func() bool { return l.life.bgRunning.Load() == 0 })
	if len(stub.hits()) != n {
		t.Fatal("polled after a turn on another model")
	}
	l.life.PollCreditsAfterTurn(db.Agent{Model: ptr("openrouter/x")})
	l.until("the turn's poll", func() bool { return len(stub.hits()) == n+2 && l.life.bgRunning.Load() == 0 })
}

// The reconciliation (test/ledger-recon.test.mjs).

const reconSettings = `{"peers":[],"cost":{"accounts":{"openrouter":{"match":{"harness":"opencode","model":"openrouter/"}}}}}`

// newReconLive polls once at $10 used, the baseline.
func newReconLive(t *testing.T, settings string) (*live, *orStub) {
	l, stub, _ := newCreditLive(t, settings)
	stub.setCredits(200, 100.0, 10.0)
	l.poll()
	return l, stub
}

func (l *live) reconAgent(id string) {
	l.costAgent(id, "opencode", "openrouter/deepseek/deepseek-v4.1-flash", "")
}

// report is usage.report with a cumulative cost.
func (l *live) report(id string, usd float64) {
	l.t.Helper()
	if err := l.life.reportUsage(l.ctx, l.agent(id), usageReport{counts: [5]*float64{&usd}}, time.Now()); err != nil {
		l.t.Fatal(err)
	}
}

func (l *live) costOf(id string) float64 {
	l.t.Helper()
	var f float64
	fmt.Sscan(l.query("SELECT ROUND(SUM(cost_usd), 6) FROM usage WHERE agent_id = ?", id), &f)
	return f
}

func (l *live) pendingRecon() float64 {
	l.t.Helper()
	var f float64
	fmt.Sscan(l.query("SELECT ROUND(COALESCE(SUM(unreconciled_usd), 0), 6) FROM usage"), &f)
	return f
}

func (l *live) recon(col string) float64 {
	l.t.Helper()
	var f float64
	fmt.Sscan(l.query("SELECT "+col+" FROM ledger_recon WHERE id = 1"), &f)
	return f
}

func (l *live) pollAt(stub *orStub, used float64) {
	l.t.Helper()
	stub.setCredits(200, 100.0, used)
	l.poll()
}

func (l *live) decideRow(usd float64) {
	l.t.Helper()
	l.exec("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd) VALUES ('stam', ?, 'openrouter', 'decide:x', 'openrouter-system', ?)", time.Now().UTC().Format("2006-01-02"), usd)
	if err := l.db.AddExactPending(l.ctx, usd); err != nil {
		l.t.Fatal(err)
	}
}

func TestReconScales(t *testing.T) {
	l, stub := newReconLive(t, reconSettings)
	l.reconAgent("a")
	l.reconAgent("b")
	l.report("a", 1)
	l.report("b", 3)
	l.pollAt(stub, 12) // billed $2 against $4 reported
	if l.costOf("a") != 0.5 || l.costOf("b") != 1.5 || l.pendingRecon() != 0 {
		t.Errorf("a %v b %v pending %v", l.costOf("a"), l.costOf("b"), l.pendingRecon())
	}
}

func TestReconDuringPoll(t *testing.T) {
	l, stub := newReconLive(t, reconSettings)
	l.reconAgent("a")
	l.report("a", 1)
	snap, err := l.life.reconSnapshot(l.ctx)
	if err != nil {
		t.Fatal(err)
	}
	l.report("a", 2) // +$1 lands before the bill is reconciled
	if err := l.life.reconcileLedger(l.ctx, snap, 10.5); err != nil {
		t.Fatal(err)
	}
	if l.costOf("a") != 1.5 || l.pendingRecon() != 1 {
		t.Errorf("0.5 scaled, 1 still reported: %v %v", l.costOf("a"), l.pendingRecon())
	}
	l.pollAt(stub, 11)
	if l.costOf("a") != 1 {
		t.Errorf("cost %v", l.costOf("a"))
	}
}

func TestReconCarry(t *testing.T) {
	l, stub := newReconLive(t, reconSettings)
	l.reconAgent("a")
	l.pollAt(stub, 11) // billed $1, nothing reported yet
	if l.recon("carry") != 1 {
		t.Fatalf("carry %v", l.recon("carry"))
	}
	l.report("a", 1.5)
	l.pollAt(stub, 11) // no new bill; the carried $1 meets $1.5
	if l.costOf("a") != 1 || l.recon("carry") != 0 {
		t.Errorf("cost %v carry %v", l.costOf("a"), l.recon("carry"))
	}
	l.report("a", 2.5)
	l.pollAt(stub, 11) // no bill and no carry left
	if l.costOf("a") != 2 || l.pendingRecon() != 1 {
		t.Errorf("cost %v pending %v", l.costOf("a"), l.pendingRecon())
	}
}

func TestReconExcess(t *testing.T) {
	l, stub := newReconLive(t, reconSettings)
	l.reconAgent("a")
	l.report("a", 1)
	l.pollAt(stub, 15) // $5 billed against $1 reported
	if l.costOf("a") != 1 || l.recon("carry") != 4 {
		t.Errorf("cost %v carry %v", l.costOf("a"), l.recon("carry"))
	}
	l.pollAt(stub, 15)
	if l.recon("carry") != 0 {
		t.Errorf("the carry lasts one poll: %v", l.recon("carry"))
	}
}

// A failed transaction scales nothing and moves no baseline; a retry scales once.
func TestReconAtomic(t *testing.T) {
	l, _ := newReconLive(t, reconSettings)
	l.reconAgent("a")
	l.report("a", 4)
	snap, err := l.life.reconSnapshot(l.ctx)
	if err != nil {
		t.Fatal(err)
	}
	l.exec("CREATE TRIGGER boom BEFORE UPDATE OF unreconciled_usd ON usage BEGIN SELECT RAISE(ABORT, 'crash'); END")
	if err := l.life.reconcileLedger(l.ctx, snap, 12); err == nil || !strings.Contains(err.Error(), "crash") {
		t.Fatalf("err %v", err)
	}
	if l.costOf("a") != 4 || l.pendingRecon() != 4 || l.recon("billed_used") != 10 {
		t.Errorf("cost %v pending %v billed %v", l.costOf("a"), l.pendingRecon(), l.recon("billed_used"))
	}
	l.exec("DROP TRIGGER boom")
	if err := l.life.reconcileLedger(l.ctx, snap, 12); err != nil {
		t.Fatal(err)
	}
	if l.costOf("a") != 2 {
		t.Errorf("cost %v", l.costOf("a"))
	}
	again, err := l.life.reconSnapshot(l.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := l.life.reconcileLedger(l.ctx, again, 12); err != nil || l.costOf("a") != 2 {
		t.Errorf("the same total again: %v %v", err, l.costOf("a"))
	}
}

func TestReconByMatch(t *testing.T) {
	l, stub := newReconLive(t, `{"peers":[],"cost":{"accounts":{"cheap":{"match":{"harness":"opencode","model":"openrouter/"}}}}}`)
	l.reconAgent("a")
	l.report("a", 2)
	if got := l.query("SELECT account FROM usage WHERE agent_id = 'a'"); got != "cheap" {
		t.Fatalf("account %q", got)
	}
	l.pollAt(stub, 11)
	if l.costOf("a") != 1 {
		t.Errorf("cost %v", l.costOf("a"))
	}
}

// A total that went down only moves the baseline: nothing is scaled, and the pending amounts are cleared.
func TestReconTotalDown(t *testing.T) {
	l, stub := newReconLive(t, reconSettings)
	l.reconAgent("a")
	l.report("a", 1)
	l.pollAt(stub, 5)
	if l.costOf("a") != 1 || l.pendingRecon() != 0 || l.recon("billed_used") != 5 || l.recon("carry") != 0 {
		t.Errorf("cost %v pending %v billed %v carry %v", l.costOf("a"), l.pendingRecon(), l.recon("billed_used"), l.recon("carry"))
	}
}

// A report landing while /credits is answered waits for the next poll: the snapshot is taken before the call.
func TestReconReportDuringCredits(t *testing.T) {
	l, stub := newReconLive(t, reconSettings)
	l.reconAgent("a")
	l.report("a", 1)
	stub.setCredits(200, 100.0, 10.5)
	stub.mu.Lock()
	stub.hold, stub.reached = make(chan struct{}), make(chan struct{})
	hold, reached := stub.hold, stub.reached
	stub.mu.Unlock()
	done := make(chan struct{})
	go func() { l.life.PollCredits(l.ctx); close(done) }()
	<-reached
	l.report("a", 2) // +$1 while the bill for the first $1 is on its way
	close(hold)
	<-done
	stub.mu.Lock()
	stub.hold = nil
	stub.mu.Unlock()
	if l.costOf("a") != 1.5 || l.pendingRecon() != 1 {
		t.Errorf("0.5 scaled, 1 still reported: %v %v", l.costOf("a"), l.pendingRecon())
	}
}

// Decision costs are exact: out of the bill first and never scaled.
func TestReconDecisionExact(t *testing.T) {
	l, stub := newReconLive(t, reconSettings)
	l.reconAgent("a")
	l.report("a", 1)
	l.decideRow(0.2)
	l.pollAt(stub, 10.7) // billed $0.7: $0.2 decision, $0.5 for OpenCode's $1
	if l.costOf("a") != 0.5 || l.costOf("stam") != 0.2 {
		t.Errorf("a %v stam %v", l.costOf("a"), l.costOf("stam"))
	}
}

func TestReconDecisionPartial(t *testing.T) {
	l, stub := newReconLive(t, reconSettings)
	for _, usd := range []float64{0, -0.5, math.NaN()} {
		if err := l.db.AddExactPending(l.ctx, usd); err != nil {
			t.Fatal(err)
		}
	}
	if l.recon("exact_pending") != 0 {
		t.Fatalf("a cost that isn't positive added %v", l.recon("exact_pending"))
	}
	if err := l.db.AddExactPending(l.ctx, 0.2); err != nil {
		t.Fatal(err)
	}
	l.pollAt(stub, 10)
	if !near(l.recon("exact_pending"), 0.2) {
		t.Errorf("no bill: %v", l.recon("exact_pending"))
	}
	l.pollAt(stub, 10.1)
	if !near(l.recon("exact_pending"), 0.1) {
		t.Errorf("half billed: %v", l.recon("exact_pending"))
	}
	l.pollAt(stub, 10.2)
	if !near(l.recon("exact_pending"), 0) {
		t.Errorf("all billed: %v", l.recon("exact_pending"))
	}
}

func TestReconDecisionCarry(t *testing.T) {
	l, stub := newReconLive(t, reconSettings)
	l.reconAgent("a")
	l.pollAt(stub, 11) // billed $1 with nothing reported: carried
	l.report("a", 1)
	if err := l.db.AddExactPending(l.ctx, 0.3); err != nil {
		t.Fatal(err)
	}
	l.pollAt(stub, 11)
	if l.costOf("a") != 0.7 || !near(l.recon("exact_pending"), 0) {
		t.Errorf("cost %v exact %v", l.costOf("a"), l.recon("exact_pending"))
	}
}

func TestReconDecisionBeforeCredits(t *testing.T) {
	l, _ := newReconLive(t, reconSettings)
	l.reconAgent("a")
	l.report("a", 1)
	snap, err := l.life.reconSnapshot(l.ctx)
	if err != nil {
		t.Fatal(err)
	}
	l.decideRow(0.2)
	if err := l.life.reconcileLedger(l.ctx, snap, 10.7); err != nil {
		t.Fatal(err)
	}
	if !near(l.costOf("a")+l.costOf("stam"), 0.7) || l.recon("exact_pending") != 0 {
		t.Errorf("a %v stam %v exact %v", l.costOf("a"), l.costOf("stam"), l.recon("exact_pending"))
	}
}

// A decision completing during the /key call is not read as part of the /credits bill.
func TestReconDecisionDuringKey(t *testing.T) {
	l, stub := newReconLive(t, reconSettings)
	l.reconAgent("a")
	l.report("a", 1)
	stub.mu.Lock()
	stub.onKey = func() { l.decideRow(0.2) }
	stub.mu.Unlock()
	l.pollAt(stub, 10.5)
	stub.mu.Lock()
	stub.onKey = nil
	stub.mu.Unlock()
	if l.costOf("a") != 0.5 || !near(l.recon("exact_pending"), 0.2) {
		t.Errorf("a %v exact %v", l.costOf("a"), l.recon("exact_pending"))
	}
	l.pollAt(stub, 10.7)
	if l.costOf("a") != 0.5 || !near(l.recon("exact_pending"), 0) || !near(l.costOf("a")+l.costOf("stam"), 0.7) {
		t.Errorf("a %v stam %v exact %v", l.costOf("a"), l.costOf("stam"), l.recon("exact_pending"))
	}
}

// A reconciliation lifts a stop set at list price, naming it (src/reconcile.ts ledgerChanged('reconciled')).
func TestReconLiftsBudget(t *testing.T) {
	l, stub := newReconLive(t, `{"peers":[],"cost":{"accounts":{"openrouter":{"match":{"harness":"opencode","model":"openrouter/"},"budget":{"usd":3,"per":"day"}}}}}`)
	l.reconAgent("a")
	l.report("a", 4)
	<-l.life.EvaluateBudgets("openrouter", time.Now(), "")
	if l.budgetOf("a") == nil {
		t.Fatal("not stopped at $4 of $3")
	}
	l.pollAt(stub, 12) // billed $2
	l.until("the stop lifted", func() bool { return l.budgetOf("a") == nil })
	if got := last(l.eventsOf("a", "blocker:clear")); !strings.Contains(got, "the ledger was corrected to the billed amount") {
		t.Errorf("clear %s", got)
	}
}

// The system reserve (test/budgets.test.mjs): the agents' OpenRouter scope is held while the last credit reading is at
// or below the reserve, whatever the agents spent.

// creditReading stores a credit reading as the poll would, observed at observed.
func (l *live) creditReading(remaining, total float64, observed time.Time) {
	l.t.Helper()
	c := map[string]any{"total": total, "used": total - remaining, "remaining": remaining, "key_limit": nil, "key_remaining": nil, "observed_at": iso(observed)}
	b, _ := json.Marshal(map[string]any{"credits": c})
	if err := l.db.SaveSubscription(l.ctx, "openrouter", string(b), iso(time.Now())); err != nil {
		l.t.Fatal(err)
	}
}

func reserveSettings(extra string) string {
	return budgetSettings(`"accounts":{"openrouter":{` + orMatch + `},"other":{"match":{"harness":"codex"}}` + extra + `}`)
}

const sysBudget = `,"openrouter-system":{"match":{"harness":"stam"},"budget":{"usd":4,"per":"day"}}`

func TestBudgetReserveMatchesTS(t *testing.T) {
	t.Run("hold and top-up", func(t *testing.T) {
		l, _ := newBudgetLive(t, reserveSettings(""))
		l.orAgent("a")
		l.costAgent("cx", "codex", "gpt-6.1-sol", "")
		l.creditReading(3, 20, time.Now())
		l.budget("openrouter", time.Now())
		if l.budgetOf("a") != nil || l.life.SpawnHeld(l.ctx, "openrouter", time.Now()) != "" {
			t.Fatal("held above the reserve")
		}
		l.creditReading(1, 20, time.Now())
		l.budget("openrouter", time.Now())
		if b := l.budgetOf("a"); b == nil || b.Reason != reserveBlock {
			t.Fatalf("blocker %+v", b)
		}
		if b := l.budgetOf("a"); b.Clear == nil || *b.Clear != `{"reserve":true}` {
			t.Errorf("clear %v", b.Clear)
		}
		if got := l.life.SpawnHeld(l.ctx, "openrouter", time.Now()); got != "The OpenRouter credit is at the $1 kept for stam's own model calls; it clears on a top-up" {
			t.Errorf("spawn %q", got)
		}
		if l.life.SpawnHeld(l.ctx, "other", time.Now()) != "" || l.budgetOf("cx") != nil {
			t.Error("another account held")
		}
		l.creditReading(8, 30, time.Now())
		l.budget("openrouter", time.Now())
		if l.budgetOf("a") != nil || l.life.SpawnHeld(l.ctx, "openrouter", time.Now()) != "" {
			t.Error("a top-up didn't clear it")
		}
		if got := last(l.eventsOf("a", "cost:rule")); !strings.Contains(got, `"cleared":"the OpenRouter credit was topped up above the system reserve"`) {
			t.Errorf("event %s", got)
		}
	})
	t.Run("system budget", func(t *testing.T) {
		l, _ := newBudgetLive(t, reserveSettings(sysBudget))
		l.orAgent("a")
		l.creditReading(3, 20, time.Now())
		l.budget("openrouter", time.Now())
		if l.budgetOf("a") == nil {
			t.Fatal("$3 left is under the unspent $4")
		}
		l.exec("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd) VALUES ('stam', ?, 'openrouter', 'decide:x', 'openrouter-system', 3)", time.Now().UTC().Format("2006-01-02"))
		l.budget("openrouter", time.Now())
		if l.budgetOf("a") != nil {
			t.Error("after $3 of system calls the reserve is $1, and $3 left is above it")
		}
	})
	t.Run("notice", func(t *testing.T) {
		l, _ := newBudgetLive(t, reserveSettings(""))
		l.costAgent("n-cos", "claude", "claude-opus-5-5", "")
		l.orAgent("a")
		l.creditReading(1.8, 20, time.Now())
		l.budget("openrouter", time.Now())
		l.budget("openrouter", time.Now())
		if l.budgetOf("a") != nil {
			t.Fatal("held when near")
		}
		count := func() string { return l.query("SELECT count(*) FROM cost_notices WHERE kind = 'reserve-near'") }
		if count() != "1" || !strings.Contains(l.query("SELECT managers FROM cost_notices WHERE kind = 'reserve-near'"), `"n-cos"`) {
			t.Errorf("notices %s %s", count(), l.query("SELECT managers FROM cost_notices WHERE kind = 'reserve-near'"))
		}
		if got := l.query("SELECT key FROM cost_notices WHERE kind = 'reserve-near'"); got != "reserve-near:20:null" {
			t.Errorf("notice %q", got)
		}
		if m := strings.Join(l.costMails(), "\n"); !strings.Contains(m, "OpenRouter credit near the system reserve: $1.80 left") ||
			!strings.Contains(m, "The OpenRouter balance is $1.80; $1.00 of it is kept for stam's own model calls (mail gate, titles, summaries, decisions). When the balance falls to $1.00, stam holds the agents on OpenRouter and refuses new ones until the human tops up.") {
			t.Errorf("mail %s", m)
		}
		l.creditReading(0.5, 20, time.Now())
		l.budget("openrouter", time.Now())
		if l.budgetOf("a") == nil || count() != "1" {
			t.Errorf("held %v notices %s", l.budgetOf("a") != nil, count())
		}
		l.creditReading(1.6, 40, time.Now())
		l.budget("openrouter", time.Now())
		if count() != "2" {
			t.Errorf("a top-up didn't re-arm: %s", count())
		}
	})
	t.Run("creditReserve", func(t *testing.T) {
		l, _ := newBudgetLive(t, reserveSettings(""))
		l.creditReading(3, 20, time.Now())
		if r, left := l.life.CreditReserve(l.ctx, time.Now()); r != 1 || left == nil || *left != 3 {
			t.Errorf("%v %v", r, left)
		}
		l.creditReading(3, 20, time.Now().Add(-3*time.Hour))
		if r, left := l.life.CreditReserve(l.ctx, time.Now()); r != 1 || left != nil {
			t.Errorf("stale: %v %v", r, left)
		}
	})
	t.Run("every scope", func(t *testing.T) {
		l, _ := newBudgetLive(t, reserveSettings(""))
		l.orAgent("a")
		l.creditReading(0.5, 20, time.Now())
		<-l.life.EvaluateAllBudgets(time.Now(), "")
		if l.budgetOf("a") == nil {
			t.Error("evaluating every scope with no budget set skipped the reserve")
		}
	})
	t.Run("own budget wins", func(t *testing.T) {
		l, _ := newBudgetLive(t, budgetSettings(""))
		l.orAgent("a")
		l.spendOn("a", 10, time.Now())
		l.creditReading(0.5, 20, time.Now())
		l.budget("openrouter", time.Now())
		if b := l.budgetOf("a"); b == nil || !strings.Contains(b.Reason, "openrouter day budget of $10 is spent") {
			t.Errorf("blocker %+v", b)
		}
	})
	t.Run("stale", func(t *testing.T) {
		l, _ := newBudgetLive(t, reserveSettings(""))
		l.orAgent("a")
		var polls int
		var mu sync.Mutex
		l.life.credits.poll = func() { mu.Lock(); polls++; mu.Unlock() }
		l.creditReading(0.5, 20, time.Now().Add(-time.Hour))
		l.budget("openrouter", time.Now())
		if l.budgetOf("a") != nil || l.life.SpawnHeld(l.ctx, "openrouter", time.Now()) != "" {
			t.Error("an hour-old reading held")
		}
		mu.Lock()
		defer mu.Unlock()
		if polls == 0 {
			t.Error("the stale reading wasn't refreshed")
		}
	})
	t.Run("hold through stale", func(t *testing.T) {
		l, _ := newBudgetLive(t, reserveSettings(""))
		l.orAgent("a")
		var polls int
		var mu sync.Mutex
		l.life.credits.poll = func() { mu.Lock(); polls++; mu.Unlock() }
		count := func() int { mu.Lock(); defer mu.Unlock(); return polls }
		l.creditReading(0.5, 20, time.Now())
		l.budget("openrouter", time.Now())
		if l.budgetOf("a") == nil {
			t.Fatal("not held")
		}
		before := count()
		if !strings.Contains(l.life.SpawnHeld(l.ctx, "openrouter", time.Now()), "kept for stam's own model calls") || count() <= before {
			t.Error("a refused spawn didn't ask for a fresh balance")
		}
		before = count()
		l.creditReading(0.5, 20, time.Now().Add(-time.Hour))
		l.budget("openrouter", time.Now())
		if l.budgetOf("a") == nil || count() <= before {
			t.Error("a stale reading lifted the hold, or didn't poll")
		}
		l.creditReading(9, 30, time.Now())
		l.budget("openrouter", time.Now())
		if l.budgetOf("a") != nil || l.life.SpawnHeld(l.ctx, "openrouter", time.Now()) != "" {
			t.Error("a fresh top-up didn't release it")
		}
	})
	t.Run("moving reserve", func(t *testing.T) {
		l, _ := newBudgetLive(t, reserveSettings(sysBudget))
		l.orAgent("a")
		l.creditReading(3, 20, time.Now())
		l.budget("openrouter", time.Now())
		sets := func() int { return strings.Count(strings.Join(l.eventsOf("a", "cost:rule"), "\n"), `"action":"set"`) }
		if sets() != 1 {
			t.Fatalf("%d sets", sets())
		}
		l.exec("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd) VALUES ('stam', ?, 'openrouter', 'decide:x', 'openrouter-system', 0.5)", time.Now().UTC().Format("2006-01-02"))
		l.creditReading(2.9, 20, time.Now())
		l.budget("openrouter", time.Now())
		if sets() != 1 {
			t.Errorf("the reserve moved from $4 to $3.5: %d sets", sets())
		}
	})
}

// A poll stores the reading and evaluates the agents' scope, so a balance down to the reserve holds with no other trigger.
func TestCreditPollHoldsReserve(t *testing.T) {
	l, stub, _ := newCreditLive(t, reserveSettings(""))
	l.orAgent("a")
	stub.setCredits(200, 10.0, 9.5)
	l.life.PollCredits(l.ctx)
	l.until("the reserve hold", func() bool { b := l.budgetOf("a"); return b != nil && b.Reason == reserveBlock })
}
