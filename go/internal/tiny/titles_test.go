package tiny

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"

	"stam/internal/catalog"
	"stam/internal/db"
	"stam/internal/jsjson"
)

// mailRow is a mail in the in-memory store: what MailTitleRow reads, and the title and summary written back.
type mailRow struct {
	db.MailTitleRow
	title, summary string
}

func (s *store) addMail(id string, row mailRow) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.mail == nil {
		s.mail = map[string]*mailRow{}
	}
	s.mail[id] = &row
}

func (s *store) mailOf(id string) mailRow {
	s.mu.Lock()
	defer s.mu.Unlock()
	return *s.mail[id]
}

func (s *store) MailTitleRow(_ context.Context, id string) (db.MailTitleRow, error) {
	s.mu.Lock()
	m, ok := s.mail[id]
	var row db.MailTitleRow
	if ok {
		row = m.MailTitleRow
	}
	hook := s.readHook
	s.mu.Unlock()
	// The hook runs once the row is read, so a paused caller holds what it read.
	if hook != nil {
		hook(id)
	}
	if !ok {
		return row, db.ErrNotFound
	}
	return row, nil
}

func (s *store) SetMailTitle(_ context.Context, id, title, cfg string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.mail[id].title, s.mail[id].ConfigHash = title, &cfg
	return nil
}

func (s *store) SetMailTitleConfig(_ context.Context, id, cfg string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.mail[id].ConfigHash = &cfg
	return nil
}

func (s *store) SetMailSummary(_ context.Context, id, summary string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.mail[id].summary = summary
	return nil
}

const titleModelSettings = `{"mail":{"titles":{"model":"google/gemma-3-4b-it"}}}`

// shown is MailTitlesShown's answer as JSON.
func (f *fx) shown(ids ...string) string {
	f.t.Helper()
	out, err := f.steps.MailTitlesShown(context.Background(), ids)
	if err != nil {
		f.t.Fatal(err)
	}
	return jsjson.Stringify(out, "")
}

func str(s string) *string { return &s }

// TestMailTitlesShown: src/mail-title.ts mailTitlesShown (S-1843), as test/mail-title.test.mjs checks it. A stale title,
// or one with no hash, is asked again once and lands with the current hash; a current one, a peer's copy and an unknown
// mail are never asked; with the model off nothing is; a failed call or a summary-only answer isn't asked again.
func TestMailTitlesShown(t *testing.T) {
	f := newFx(t)
	f.settings(titleModelSettings)
	m := "google/gemma-3-4b-it"
	cur := ConfigHash(m, catalog.MailTitlePrompt)
	f.st.addMail("stale", mailRow{MailTitleRow: db.MailTitleRow{Subject: "Old title here", ConfigHash: str("other")}, title: "Old"})
	f.st.addMail("bare", mailRow{MailTitleRow: db.MailTitleRow{Subject: "No hash yet"}, title: "Bare"})
	f.st.addMail("current", mailRow{MailTitleRow: db.MailTitleRow{Subject: "Fresh", ConfigHash: &cur}, title: "Fresh"})
	f.st.addMail("peer", mailRow{MailTitleRow: db.MailTitleRow{Subject: "From a peer", ConfigHash: str(db.PeerTitleConfig)}})

	if got := f.shown("stale", "bare", "current", "peer", "nope"); got != `{"enabled":true,"pending":["stale","bare"]}` {
		t.Fatalf("first view: %s", got)
	}
	f.until("both titles", func() bool {
		return f.st.mailOf("stale").title == "Old title here" && f.st.mailOf("bare").title == "No hash yet"
	})
	f.until("the queue to drain", func() bool { return f.shown("stale", "bare") == `{"enabled":true,"pending":[]}` })
	if got := f.st.mailOf("stale").ConfigHash; got == nil || *got != cur {
		t.Errorf("the new title's hash = %v, want the current one", got)
	}
	before := f.calls()
	if got := f.shown("stale", "bare", "current", "peer"); got != `{"enabled":true,"pending":[]}` || f.calls() != before {
		t.Errorf("a second view asked again: %s, %d calls", got, f.calls()-before)
	}
	if before != 2 {
		t.Errorf("calls = %d, want 2 (one each)", before)
	}

	// The model off: nothing is asked, and the stale title stays.
	f.settings(`{}`)
	f.st.addMail("off", mailRow{MailTitleRow: db.MailTitleRow{Subject: "Stale while off", ConfigHash: str("other")}, title: "Kept"})
	if got := f.shown("off"); got != `{"enabled":false,"pending":[]}` || f.st.mailOf("off").title != "Kept" {
		t.Errorf("the model off: %s, title %q", got, f.st.mailOf("off").title)
	}

	// A failed call keeps the old title, leaves the pending list once it ends, and isn't asked again for the config.
	f.settings(titleModelSettings)
	f.st.addMail("fails", mailRow{MailTitleRow: db.MailTitleRow{Subject: "Breaks STUB:FAIL", ConfigHash: str("other")}, title: "Old one"})
	if got := f.shown("fails"); got != `{"enabled":true,"pending":["fails"]}` {
		t.Fatalf("the failing mail: %s", got)
	}
	f.until("the failed call to end", func() bool { return f.shown("fails") == `{"enabled":true,"pending":[]}` })
	if f.st.mailOf("fails").title != "Old one" || f.st.count("mail-title:error") != 1 {
		t.Errorf("after the failure: title %q, %d error events", f.st.mailOf("fails").title, f.st.count("mail-title:error"))
	}

	// A mail to the human gets a title and summary from one call; a summary-only answer is current for its config.
	f.st.addMail("human", mailRow{MailTitleRow: db.MailTitleRow{Subject: "For you", Body: "SUMMARY=Pick_one__-_1h", ToHuman: true}})
	f.st.addMail("onlysum", mailRow{MailTitleRow: db.MailTitleRow{Subject: "No title STUB:NOTITLE", Body: "SUMMARY=Just_this", ToHuman: true}, title: "Old"})
	f.shown("human", "onlysum")
	f.until("the human's summaries", func() bool { return f.st.mailOf("human").summary != "" && f.st.mailOf("onlysum").summary != "" })
	f.until("the queue to drain", func() bool { return f.shown("human", "onlysum") == `{"enabled":true,"pending":[]}` })
	if h := f.st.mailOf("human"); h.title != "For you" || h.summary != "Pick one\n- 1h" {
		t.Errorf("the human's mail: %q %q", h.title, h.summary)
	}
	sum := ConfigHash(m, catalog.MailSummaryPrompt)
	if o := f.st.mailOf("onlysum"); o.title != "Old" || o.summary != "Just this" || o.ConfigHash == nil || *o.ConfigHash != sum {
		t.Errorf("the summary-only answer: %q %q %v", o.title, o.summary, o.ConfigHash)
	}
	before = f.calls()
	f.shown("onlysum")
	if f.calls() != before {
		t.Error("the summary-only mail was asked again")
	}
}

// TestMailTitlesQueue: a mail being asked is pending without a second call; no key asks nothing; turning the model off
// drops what waits and cancels the calls in flight; only the first ShownMax ids are looked at; the body is cut.
func TestMailTitlesQueue(t *testing.T) {
	f := newFx(t)
	f.settings(titleModelSettings)
	f.hang()
	f.st.addMail("held", mailRow{MailTitleRow: db.MailTitleRow{Subject: "Held STUB:HANG"}})
	if got := f.shown("held"); got != `{"enabled":true,"pending":["held"]}` {
		t.Fatalf("the held mail: %s", got)
	}
	f.until("the held call", func() bool { return f.calls() == 1 })
	if got := f.shown("held"); got != `{"enabled":true,"pending":["held"]}` || f.calls() != 1 {
		t.Errorf("a second view of a mail in flight: %s, %d calls", got, f.calls())
	}
	// Two run at once; a third waits in the queue.
	f.st.addMail("held2", mailRow{MailTitleRow: db.MailTitleRow{Subject: "Held too STUB:HANG"}})
	f.st.addMail("waits", mailRow{MailTitleRow: db.MailTitleRow{Subject: "Waits STUB:HANG"}})
	f.shown("held2", "waits")
	f.until("the second held call", func() bool { return f.calls() == 2 })
	if q := f.steps.titles.lane.queued(); len(q) != 1 || q[0] != "waits" {
		t.Errorf("the queue = %v, want [waits]", q)
	}
	f.settings(`{}`)
	f.until("the canceled calls", func() bool { return f.st.count("mail-title:canceled") == 2 })
	f.release()
	if q := f.steps.titles.lane.queued(); len(q) != 0 || f.st.mailOf("waits").title != "" {
		t.Errorf("turning the model off left %v queued, title %q", q, f.st.mailOf("waits").title)
	}

	// No key: enabled, but nothing is asked.
	f.settings(titleModelSettings)
	f.setEnv("OPENROUTER_API_KEY", "")
	f.st.addMail("nokey", mailRow{MailTitleRow: db.MailTitleRow{Subject: "No key"}})
	if got := f.shown("nokey"); got != `{"enabled":true,"pending":[]}` {
		t.Errorf("no key: %s", got)
	}
	f.setEnv("OPENROUTER_API_KEY", "test-key")

	// Only the first ShownMax ids count.
	ids := make([]string, ShownMax+1)
	for i := range ids {
		ids[i] = "x" + strings.Repeat("i", i)
	}
	f.st.addMail(ids[ShownMax], mailRow{MailTitleRow: db.MailTitleRow{Subject: "Past the cap"}})
	if got := f.shown(ids...); got != `{"enabled":true,"pending":[]}` {
		t.Errorf("an id past the cap was asked: %s", got)
	}

	// The model sees 2000 characters of an agent's mail and 3000 of the human's: a marker at 2500 fails only the latter.
	body := strings.Repeat("a ", 1250) + "STUB:FAIL"
	f.st.addMail("agentlong", mailRow{MailTitleRow: db.MailTitleRow{Subject: "Long to agent", Body: body}})
	f.st.addMail("humanlong", mailRow{MailTitleRow: db.MailTitleRow{Subject: "Long to human", Body: body, ToHuman: true}})
	f.shown("agentlong", "humanlong")
	f.until("both calls to end", func() bool { return f.shown("agentlong", "humanlong") == `{"enabled":true,"pending":[]}` })
	if f.st.mailOf("agentlong").title != "Long to agent" || f.st.mailOf("humanlong").title != "" {
		t.Errorf("the cut bodies: agent %q, human %q", f.st.mailOf("agentlong").title, f.st.mailOf("humanlong").title)
	}
}

// pauseReads makes the first n MailTitleRow calls for id wait once they have read the row: reached[i] closes when the
// i-th gets there, and closing release[i] lets it go on. Later calls, and calls for other ids, don't wait.
func (f *fx) pauseReads(id string, n int) (reached, release []chan struct{}) {
	for i := 0; i < n; i++ {
		reached, release = append(reached, make(chan struct{})), append(release, make(chan struct{}))
	}
	// Not a sync.Once: its Do would hold a second caller until the first returns.
	var calls atomic.Int32
	f.st.mu.Lock()
	f.st.readHook = func(got string) {
		if got != id {
			return
		}
		if i := int(calls.Add(1)) - 1; i < n {
			close(reached[i])
			<-release[i]
		}
	}
	f.st.mu.Unlock()
	return reached, release
}

// pauseRead is pauseReads for one call.
func (f *fx) pauseRead(id string) (reached, release chan struct{}) {
	a, b := f.pauseReads(id, 1)
	return a[0], b[0]
}

// busy is whether a job for key is queued or running.
func (l *lane) busy(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.jobs[key] != nil
}

// shownAsync runs MailTitlesShown in another goroutine; its answer, or its error, comes on the channel.
func (f *fx) shownAsync(ids ...string) chan string {
	out := make(chan string, 1)
	go func() {
		got, err := f.steps.MailTitlesShown(context.Background(), ids)
		if err != nil {
			out <- "error: " + err.Error()
			return
		}
		out <- jsjson.Stringify(got, "")
	}()
	return out
}

// TestMailTitlesAdmitAfterEnd: request A reads a stale mail and pauses before it queues it. Request B queues the same
// mail, and its call stores the current title and ends. A then must not queue its stale snapshot: it reads the mail
// again, finds it current, and the model is asked once.
func TestMailTitlesAdmitAfterEnd(t *testing.T) {
	f := newFx(t)
	f.settings(titleModelSettings)
	f.st.addMail("m", mailRow{MailTitleRow: db.MailTitleRow{Subject: "Raced title", ConfigHash: str("other")}, title: "Old"})
	reached, release := f.pauseRead("m")
	a := f.shownAsync("m")
	<-reached
	if got := f.shown("m"); got != `{"enabled":true,"pending":["m"]}` {
		t.Fatalf("request B: %s", got)
	}
	f.until("B's call to end", func() bool {
		return !f.steps.titles.lane.busy("m") && f.st.mailOf("m").title == "Raced title"
	})
	close(release)
	if got := <-a; got != `{"enabled":true,"pending":[]}` {
		t.Errorf("request A after B's call ended: %s", got)
	}
	if q := f.steps.titles.lane.queued(); len(q) != 0 || f.calls() != 1 {
		t.Errorf("the mail was asked again: queue %v, %d calls", q, f.calls())
	}
}

// TestMailTitlesAdmitAfterStop: a request reads a stale mail with the model on and pauses; the model is turned off,
// and the stop finds nothing to clear. The request then must not queue the mail: admission refuses while the step is
// off.
func TestMailTitlesAdmitAfterStop(t *testing.T) {
	f := newFx(t)
	f.settings(titleModelSettings)
	f.st.addMail("m", mailRow{MailTitleRow: db.MailTitleRow{Subject: "Stopped", ConfigHash: str("other")}, title: "Old"})
	reached, release := f.pauseRead("m")
	a := f.shownAsync("m")
	<-reached
	f.settings(`{}`)
	close(release)
	if got := <-a; got != `{"enabled":true,"pending":[]}` {
		t.Errorf("the request after the stop: %s", got)
	}
	if f.steps.titles.lane.busy("m") || len(f.steps.titles.lane.queued()) != 0 {
		t.Errorf("a job survived the stop: queue %v", f.steps.titles.lane.queued())
	}
}

// TestMailTitlesAdmitPastOthers: other mails' calls end during each of the target's reads, more times than admit
// reads again. Their ends say nothing about the target, so it must still be queued (and pending), never dropped.
func TestMailTitlesAdmitPastOthers(t *testing.T) {
	f := newFx(t)
	f.settings(titleModelSettings)
	f.st.addMail("target", mailRow{MailTitleRow: db.MailTitleRow{Subject: "Target title", ConfigHash: str("other")}, title: "Old"})
	others := []string{"o1", "o2", "o3"}
	for _, id := range others {
		f.st.addMail(id, mailRow{MailTitleRow: db.MailTitleRow{Subject: "Other " + id, ConfigHash: str("other")}})
	}
	// Each read of the target waits while another mail is asked and its call ends. With the fix the target is queued
	// after its first read; a lane-wide count would read it again after each, and give up after the third.
	reached, release := f.pauseReads("target", len(others))
	a := f.shownAsync("target")
	got := ""
	for i, id := range others {
		select {
		case <-reached[i]:
		case got = <-a:
		}
		if got != "" {
			break
		}
		if out := f.shown(id); out != `{"enabled":true,"pending":["`+id+`"]}` {
			t.Fatalf("%s: %s", id, out)
		}
		f.until(id+"'s call to end", func() bool { return !f.steps.titles.lane.busy(id) && f.st.mailOf(id).title != "" })
		close(release[i])
	}
	if got == "" {
		got = <-a
	}
	if got != `{"enabled":true,"pending":["target"]}` {
		t.Fatalf("the target after other calls ended: %s", got)
	}
	f.until("the target's title", func() bool { return f.st.mailOf("target").title == "Target title" })
	if f.calls() != 2 {
		t.Errorf("calls = %d, want 2 (one other, then the target)", f.calls())
	}
	f.steps.titles.lane.mu.Lock()
	watched := len(f.steps.titles.lane.watch)
	f.steps.titles.lane.mu.Unlock()
	if watched != 0 {
		t.Errorf("%d watches left after every admission ended", watched)
	}
}
