package lifecycle

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"

	"stam/internal/db"
)

// The tests of costnotices.go, after test/cost-notices.test.mjs: agents are rows with no harness (a blocker on one only
// records it), and stam's mail goes to a recording stub.

const costSettings = `{"chiefOfStaff":"n-cos","cost":{"accounts":{"max":{"match":{"harness":"claude"},"paid":false}},"instructions":"Never spend extra credits."}}`

// costBox records the mail cost notices send, with an id per mail, the system senders they name, and the withdrawals
// of the human's copies.
type costBox struct {
	mu        sync.Mutex
	sent      []string
	senders   []string
	withdrawn []string
}

func (b *costBox) send(_ context.Context, name string, to []string, subject, body string) (string, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.sent = append(b.sent, strings.Join(to, ",")+"|"+subject+"|"+body)
	b.senders = append(b.senders, name)
	return fmt.Sprintf("m%d", len(b.sent)), true
}

func (b *costBox) withdraw(_ context.Context, ids []string, by, note string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.withdrawn = append(b.withdrawn, strings.Join(ids, ",")+"|"+by+"|"+note)
}

func (b *costBox) mails() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.sent...)
}

func (b *costBox) systemSenders() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.senders...)
}

func (b *costBox) withdrawals() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.withdrawn...)
}

func newCostLive(t *testing.T, settings string) (*live, *costBox) {
	l := newLive(t)
	l.setSettings(settings)
	all, err := l.db.ListAgents(l.ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range all {
		l.set(a.ID, db.Field{Col: "lifecycle", Val: "archived"})
	}
	box := &costBox{}
	l.life.SetCostMail(box.send, box.withdraw)
	l.costs = box
	return l, box
}

// member makes an agent row under parent ("" for none), idle, with no harness.
func (l *live) member(id, parent string) {
	l.t.Helper()
	var p *string
	if parent != "" {
		p = &parent
	}
	if _, err := l.db.CreateAgent(l.ctx, db.NewAgent{ID: id, Name: "n-" + id, Role: "developer", Machine: "test-machine", Harness: "claude", Cwd: l.work, ParentID: p}); err != nil {
		l.t.Fatal(err)
	}
	l.set(id, db.Field{Col: "lifecycle", Val: "active"}, db.Field{Col: "activity", Val: "idle"})
}

func (l *live) exec(q string, args ...any) {
	l.t.Helper()
	if err := l.db.Write(l.ctx, func(conn *sqlite.Conn) error { return sqlitex.Execute(conn, q, &sqlitex.ExecOptions{Args: args}) }); err != nil {
		l.t.Fatal(err)
	}
}

// notices is every stored notice as "kind|managers|agent", oldest first.
func (l *live) notices() []string {
	l.t.Helper()
	q := l.query("SELECT kind, managers, COALESCE(agent_id, '') FROM cost_notices ORDER BY rowid")
	if q == "" {
		return nil
	}
	return strings.Split(q, "\n")
}

func (l *live) noticeID(kind string) string {
	l.t.Helper()
	return l.query("SELECT id FROM cost_notices WHERE kind = ? ORDER BY rowid DESC LIMIT 1", kind)
}

// TestNoticesManagerOf: a child is managed by its parents, every one of them; a root by the chief of staff; the chief of
// staff by no one.
func TestNoticesManagerOf(t *testing.T) {
	l, _ := newCostLive(t, costSettings)
	l.member("cos", "")
	l.member("cost", "cos")
	l.member("dev", "cost")
	l.member("orphan", "")
	l.member("p2", "cos")
	l.member("multi", "cost")
	l.exec("INSERT INTO agent_parents (child_id, parent_id) VALUES ('multi', 'p2')")
	for id, want := range map[string]string{"dev": "cost", "cost": "cos", "cos": "", "orphan": "cos", "multi": "cost,p2"} {
		if got := strings.Join(l.life.managerOf(l.ctx, id), ","); got != want {
			t.Errorf("managerOf(%s) = %q, want %q", id, got, want)
		}
	}
}

// TestNoticesBlocker: a blocker set and its clear reach the blocked agent's manager, and a refresh doesn't. The notice
// carries the event id, the blocker, the fallback, the share line (the manager's tree's, none with no samples), the
// user's instructions and the options; an idle manager gets it as mail.
func TestNoticesBlocker(t *testing.T) {
	l, box := newCostLive(t, costSettings)
	l.member("cos", "")
	l.member("cost", "cos")
	l.member("dev", "cost")
	l.exec("INSERT INTO window_readings (name, window, at, used_percentage, resets_at) VALUES ('claude', 'five_hour', '2026-10-22T00:00:00.000Z', 50, NULL)")
	l.addBlocker("dev", "window", "max", "five_hour at 100%")
	if got := strings.Join(l.notices(), " "); got != `blocker-set|["cost"]|dev` {
		t.Fatalf("notices %s", got)
	}
	id := l.noticeID("blocker-set")
	l.until("the manager's mail", func() bool { return len(box.mails()) == 1 })
	mail := box.mails()[0]
	for _, want := range []string{
		"cost|[stam] Cost notice " + id + ": n-dev blocked: window on max|Cost notice " + id + ": n-dev blocked: window on max",
		"Stam set a cost blocker on n-dev: five_hour at 100%.\nIf no manager acts on this agent within 15 minutes, stam applies the fallback: wait (the default).",
		"This tree's estimated share of the five-hour window on max: about 0% (stam's estimate, never a rule).",
		"Your user's cost instructions:\nNever spend extra credits.",
		"Pause the tree until the window resets",
		"When this is handled, call `cost_ack` with event=" + id + ".",
	} {
		if !strings.Contains(mail, want) {
			t.Errorf("notice lacks %q:\n%s", want, mail)
		}
	}
	if e := lastEvent(t, l, "cost", "cost:notice"); e != `{"event":"`+id+`","kind":"blocker-set","account":"max"}` {
		t.Errorf("cost:notice %s", e)
	}
	l.addBlocker("dev", "window", "max", "five_hour still at 100%")
	if len(l.notices()) != 1 {
		t.Errorf("a refresh notified: %v", l.notices())
	}
	// The same set again for that generation (its since) is the stored notice, not a second one.
	since := l.query("SELECT since FROM blockers WHERE agent_id = 'dev' AND kind = 'window'")
	l.life.blockerChanged(l.ctx, "dev", "window", "max", "set", "five_hour at 100%", since, time.Now())
	if len(l.notices()) != 1 || len(box.mails()) != 1 {
		t.Errorf("a repeated set notified: %v %d mails", l.notices(), len(box.mails()))
	}
	l.clearBlocker("dev", "window", "max", "five_hour reads 12%")
	if got := l.notices(); len(got) != 2 || got[1] != `blocker-clear|["cost"]|dev` {
		t.Errorf("notices %v", got)
	}
	l.until("the clear's mail", func() bool { return len(box.mails()) == 2 })
	if m := box.mails()[1]; !strings.Contains(m, "n-dev unblocked: window on max") || !strings.Contains(m, "The blocker on n-dev cleared: five_hour reads 12%.") {
		t.Errorf("clear mail %s", m)
	}
	// A blocker with no subscription window, and one on an account no reading covers yet.
	l.addBlocker("dev", "manual", "", "paused by the manager")
	l.until("the manual blocker's mail", func() bool { return len(box.mails()) == 3 })
	if m := box.mails()[2]; !strings.Contains(m, "No subscription window for this blocker.") || strings.Contains(m, "If no manager acts") {
		t.Errorf("manual mail %s", m)
	}
}

// TestNoticesDelivery: a working manager gets the notice in its turn and no mail; with no manager the human gets it as
// mail from system:cost only when humanMail.when allows important, and nothing is recorded otherwise. An archived or shut-down agent gets
// no notice.
func TestNoticesDelivery(t *testing.T) {
	l, box := newCostLive(t, costSettings)
	l.member("cos", "")
	l.member("cost", "cos")
	l.member("dev", "cost")
	l.set("cost", db.Field{Col: "activity", Val: "working"})
	l.addBlocker("dev", "error", "max", "a provider error")
	id := l.noticeID("blocker-set")
	if n := l.lastNotice("cost"); !strings.HasPrefix(n, "Cost notice "+id+": n-dev blocked: error on max") {
		t.Errorf("in-turn notice %q", n)
	}
	if !strings.Contains(l.lastNotice("cost"), "stam applies the fallback: soft-stop (onError).") {
		t.Errorf("the error fallback: %q", l.lastNotice("cost"))
	}
	if len(box.mails()) != 0 {
		t.Errorf("a working manager was mailed: %v", box.mails())
	}

	l.setSettings(`{"humanMail":{"when":"important"},"cost":{"accounts":{"max":{"match":{"harness":"claude"}}}}}`)
	l.member("orphan", "")
	l.addBlocker("orphan", "window", "max", "five_hour at 100%")
	if got := l.notices(); len(got) != 2 || got[1] != `blocker-set|["human"]|orphan` {
		t.Fatalf("notices %v", got)
	}
	l.until("the human's mail", func() bool { return len(box.mails()) == 1 })
	if m := box.mails()[0]; !strings.HasPrefix(m, "human|[stam] Cost notice ") {
		t.Errorf("human mail %s", m)
	}
	if got := box.systemSenders(); len(got) != 1 || got[0] != "cost" {
		t.Errorf("sent from %v, not system:cost", got)
	}
	// The send lands in the mail box before its id is stored, so wait for the stored id.
	l.until("the human_mail_id", func() bool {
		return l.query("SELECT human_mail_id FROM cost_notices WHERE agent_id = 'orphan'") != "NULL"
	})
	if got := l.query("SELECT human_mail_id FROM cost_notices WHERE agent_id = 'orphan'"); got != "m1" {
		t.Errorf("human_mail_id %s", got)
	}
	l.setSettings(`{"humanMail":{"when":"necessary"},"cost":{"accounts":{"max":{"match":{"harness":"claude"}}}}}`)
	l.clearBlocker("orphan", "window", "max", "")
	if len(l.notices()) != 2 {
		t.Errorf("recorded with no one to tell: %v", l.notices())
	}

	l.setSettings(costSettings)
	l.member("gone", "cost")
	l.set("gone", db.Field{Col: "lifecycle", Val: "shut_down"})
	l.addBlocker("gone", "window", "max", "five_hour at 100%")
	if len(l.notices()) != 2 {
		t.Errorf("a shut-down agent's notice: %v", l.notices())
	}
}

// TestNoticesAck: an ack records who handled the notice and when, as a cost:ack event, and refuses a second ack and an
// unknown event. A manager's ack withdraws the human's copy, also when it lands before that mail's id is stored; the
// human's own ack withdraws nothing.
func TestNoticesAck(t *testing.T) {
	l, box := newCostLive(t, costSettings)
	l.member("cos", "")
	l.member("cost", "cos")
	l.member("dev", "cost")
	l.addBlocker("dev", "window", "max", "five_hour at 100%")
	id := l.noticeID("blocker-set")
	r, err := l.life.AckCostNotice(l.ctx, id, "cost", "cost_ack")
	if err != nil || r != (AckResult{OK: true, Event: id}) {
		t.Fatalf("ack %+v %v", r, err)
	}
	if got := l.query("SELECT acked_by, acked_at IS NOT NULL FROM cost_notices WHERE id = ?", id); got != "cost|1" {
		t.Errorf("stored %s", got)
	}
	if e := lastEvent(t, l, "cost", "cost:ack"); e != `{"event":"`+id+`","via":"cost_ack"}` {
		t.Errorf("cost:ack %s", e)
	}
	if r, _ := l.life.AckCostNotice(l.ctx, id, "cos", "cost_ack"); r.OK || r.Error != id+" was already acknowledged by cost" {
		t.Errorf("second ack %+v", r)
	}
	if got := l.query("SELECT acked_by FROM cost_notices WHERE id = ?", id); got != "cost" {
		t.Errorf("a second ack took it over: %s", got)
	}
	if r, _ := l.life.AckCostNotice(l.ctx, "cn-nope", "cost", "cost_ack"); r.OK || r.Error != "no cost notice cn-nope" {
		t.Errorf("unknown %+v", r)
	}
	if len(box.withdrawals()) != 0 {
		t.Errorf("withdrew with no human copy: %v", box.withdrawals())
	}

	// The human's copies: an ack after the mail went, and one before its id was stored.
	l.setSettings(`{"humanMail":{"when":"important"},"cost":{"accounts":{"max":{"match":{"harness":"claude"}}}}}`)
	l.member("o1", "")
	l.member("o2", "")
	l.addBlocker("o1", "window", "max", "five_hour at 100%")
	l.until("the human's mail", func() bool { return l.query("SELECT human_mail_id FROM cost_notices WHERE agent_id = 'o1'") != "NULL" })
	n1 := l.query("SELECT id FROM cost_notices WHERE agent_id = 'o1'")
	if r, _ := l.life.AckCostNotice(l.ctx, n1, "cost", "cost_ack"); !r.OK {
		t.Fatalf("ack %+v", r)
	}
	if got := strings.Join(box.withdrawals(), " "); got != "m2|cost|Withdrawn by @n-cost: cost notice "+n1+" handled" {
		t.Errorf("withdrawals %s", got)
	}
	l.life.SetCostMail(nil, box.withdraw)
	l.addBlocker("o2", "window", "max", "five_hour at 100%")
	n2 := l.query("SELECT id FROM cost_notices WHERE agent_id = 'o2'")
	if r, _ := l.life.AckCostNotice(l.ctx, n2, "cost", "cost_ack"); !r.OK {
		t.Fatalf("ack %+v", r)
	}
	l.life.setHumanMail(l.ctx, n2, "m9")
	if got := box.withdrawals(); len(got) != 2 || got[1] != "m9|cost|Withdrawn by @n-cost: cost notice "+n2+" handled" {
		t.Errorf("late withdrawal %v", got)
	}
	l.addBlocker("o1", "error", "max", "a provider error")
	n3 := l.noticeID("blocker-set")
	l.life.setHumanMail(l.ctx, n3, "m10")
	if r, _ := l.life.AckCostNotice(l.ctx, n3, humanID, "cost_ack"); !r.OK || len(box.withdrawals()) != 2 || l.countEvents(humanID, "cost:ack") != 0 {
		t.Errorf("the human's ack %+v, withdrawals %v", r, box.withdrawals())
	}
}

// TestNoticeAllocationRecipients: an allocation notice goes to the tree's manager and its root, each once; a root with no
// manager hears it alone, never the human, even when humanMail.when allows important; a missing root raises nothing.
// TestAllocationsMatchesTS compares the notices themselves with src/allocations.ts.
func TestNoticeAllocationRecipients(t *testing.T) {
	l, box := newCostLive(t, `{"humanMail":{"when":"important"},"cost":{"accounts":{"max":{"match":{"harness":"claude"}}}}}`)
	l.member("top", "")
	l.member("kid", "top")
	e := allocationNotice{allocation: "al-1", root: "kid", account: "max", kind: "usd", period: "day", used: 8, of: 10, usedPercent: 80, threshold: 80, basis: "b"}
	if l.life.allocationWarning(l.ctx, e, time.Now()) == nil {
		t.Fatal("no notice")
	}
	e.allocation, e.root = "al-2", "top"
	if l.life.allocationWarning(l.ctx, e, time.Now()) == nil {
		t.Fatal("no notice for a root with no manager")
	}
	e.allocation, e.root = "al-3", "no-such-agent"
	if l.life.allocationWarning(l.ctx, e, time.Now()) != nil {
		t.Error("a notice for a missing root")
	}
	// A root that is its own parent is its manager too, and still hears once.
	l.member("loop", "")
	l.exec("INSERT INTO agent_parents (child_id, parent_id) VALUES ('loop', 'loop')")
	e.allocation, e.root = "al-4", "loop"
	l.life.allocationWarning(l.ctx, e, time.Now())
	if got := l.notices(); len(got) != 3 || got[0] != `allocation|["top","kid"]|kid` || got[1] != `allocation|["top"]|top` || got[2] != `allocation|["loop"]|loop` {
		t.Errorf("notices %v", got)
	}
	if got := l.costMails(); len(got) != 4 {
		t.Errorf("mails %v", got)
	}
	if got := box.systemSenders(); len(got) != 4 || got[0] != "cost" {
		t.Errorf("senders %v", got)
	}
}

// TestNoticeSwitchedMatchesTS: src/cost-notices.ts switched, the notice cost_switch sends the successor's parents and
// the manager that asked, is compared with TS in TestSwitchMoveMatchesTS (each case's switched lines: the mail, the
// in-turn notice to a working parent, the human when nobody else hears it, and the cost:switched events). This runs
// its cases that send it.
func TestNoticeSwitchedMatchesTS(t *testing.T) {
	runSwitchDiff(t, "move", "ancestor", "human")
}

// TestNoticeShareMatchesTS: the share line is the manager's tree's estimate of the window's current period, after
// src/cost-notices.ts shareLine: dev (under cost) and other and third (under cos) each ran a third of the stam tokens of
// a 4-point rise, so dev's and cost's trees have about 1.33% (rounded to cents) and cos's all 4. The estimate itself is
// TestAttributionMatchesTS's.
func TestNoticeShareMatchesTS(t *testing.T) {
	l, box := newCostLive(t, costSettings)
	l.member("cos", "")
	l.member("cost", "cos")
	l.member("dev", "cost")
	l.member("other", "cos")
	l.member("third", "cos")
	now := time.Now()
	resets := float64(now.Add(4 * time.Hour).Unix())
	for _, r := range [][2]float64{{-20, 10}, {-10, 14}} {
		l.exec("INSERT INTO window_readings (name, window, at, used_percentage, resets_at) VALUES ('claude', 'five_hour', ?, ?, ?)", iso(now.Add(time.Duration(r[0])*time.Minute)), r[1], resets)
	}
	for _, id := range []string{"dev", "other", "third"} {
		l.exec("INSERT INTO usage_samples (agent_id, account, harness, model, bucket, tokens_in) VALUES (?, 'max', 'claude', 'claude-opus-5-5', ?, 1000)", id,
			iso(time.UnixMilli(int64(floorBucket(ms(now.Add(-15*time.Minute)))))))
	}
	want := map[string]string{"cost": "about 1.33%", "cos": "about 4%", "dev": "about 1.33%"}
	for m, share := range want {
		if got := l.life.shareLine(l.ctx, m, "max", "five_hour"); got != "This tree's estimated share of the five-hour window on max: "+share+" (stam's estimate, never a rule)." {
			t.Errorf("%s: %s", m, got)
		}
	}
	if got := l.life.shareLine(l.ctx, "cost", "max", "seven_day"); got != "No seven-day reading yet to estimate this tree's share of max." {
		t.Errorf("no reading: %s", got)
	}
	if got := l.life.shareLine(l.ctx, "cost", "global", "five_hour"); got != "No five-hour reading yet to estimate this tree's share of global." {
		t.Errorf("no account: %s", got)
	}
	// A blocker's notice carries the line for each window the account has readings in.
	l.addBlocker("dev", "window", "max", "five_hour at 100%")
	l.until("the manager's mail", func() bool { return len(box.mails()) == 1 })
	if m := box.mails()[0]; !strings.Contains(m, "This tree's estimated share of the five-hour window on max: about 1.33% (stam's estimate, never a rule).") {
		t.Errorf("notice %s", m)
	}
}
