package tiny

import (
	"context"
	"errors"
	"log/slog"
	"sync"

	"stam/internal/catalog"
	"stam/internal/db"
	"stam/internal/jsjson"
	"stam/internal/llm"
)

// Mail titles shown (src/mail-title.ts mailTitlesShown, S-1843): the human's view names the mails it shows, and a title
// or summary asked with another model or prompt hash, or none, is stale and asked again, once, through a bounded queue,
// two at a time. The old text shows until the new one lands; a mail whose call failed isn't asked again for that config
// until a restart. Nothing is asked with the model off, and a peer's copy is never asked here.
//
// Not ported: maybeTitleMail, the title of a mail as it is stored, and the title sent on to the peers that hold the mail;
// the Go daemon stores no mail of its own yet. A job here has no peers, as a view's job has none in TS.

const (
	titlePurpose   = "mail-title"
	titleConc      = 2
	titleQueueMax  = 100
	titleBody      = 2000
	titleBodyHuman = 3000
	// ShownMax is how many of a request's mails are looked at.
	ShownMax = 40
)

type titles struct {
	s    *Steps
	lane *lane
	mu   sync.Mutex
	// failed holds the mails, with the config they were asked with, whose call failed or gave no title since this
	// process started.
	failed map[string]bool
}

func newTitles(s *Steps) *titles {
	return &titles{s: s, lane: newLane(titleConc, titleQueueMax, func() bool { return s.titleModel() != "" }), failed: map[string]bool{}}
}

// titleModel is mail.titles.model, "" while the step is off.
func (s *Steps) titleModel() string { return s.o.Settings().Tiny.MailTitlesModel }

func (t *titles) isFailed(id, cfg string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.failed[id+"\x00"+cfg]
}

func (t *titles) fail(id, cfg string) {
	t.mu.Lock()
	t.failed[id+"\x00"+cfg] = true
	t.mu.Unlock()
}

// MailTitlesShown is mailTitlesShown: {enabled, pending}, pending being the mails still being asked, so the view asks
// again until they land. Nothing waits for a model: a stale mail is only queued.
func (s *Steps) MailTitlesShown(ctx context.Context, ids []string) (*jsjson.Object, error) {
	t := s.titles
	m := s.titleModel()
	pending := []jsjson.Value{}
	if m == "" {
		return jsjson.NewObject("enabled", false, "pending", pending), nil
	}
	canAsk := s.askBlocked(m) == ""
	for _, id := range ids[:min(len(ids), ShownMax)] {
		queued, err := t.admit(ctx, id, m, canAsk)
		if err != nil {
			return nil, err
		}
		if queued {
			pending = append(pending, id)
		}
	}
	return jsjson.NewObject("enabled", true, "pending", pending), nil
}

// admitTries bounds how often admit reads a mail again because a job for it ended while it read.
const admitTries = 3

// admit is one mail of mailTitlesShown: whether it is queued or being asked, queuing it when its title is stale. TS
// does this synchronously; here the store read happens outside the lane's lock, so a job for the mail that ends
// meanwhile (its title stored, or its failure remembered) makes add refuse, and the mail is read again rather than
// asked twice. A mail still refused that way after admitTries reads counts as pending, so the view asks again; it is
// never dropped unasked.
func (t *titles) admit(ctx context.Context, id, m string, canAsk bool) (bool, error) {
	for try := 0; try < admitTries; try++ {
		queued, stale, err := t.admitOnce(ctx, id, m, canAsk)
		if err != nil || !stale {
			return queued, err
		}
	}
	return true, nil
}

// admitOnce is one read of admit: stale when a job for the mail ended since the read began.
func (t *titles) admitOnce(ctx context.Context, id, m string, canAsk bool) (queued, stale bool, err error) {
	s := t.s
	busy, tk := t.lane.peek(id)
	defer t.lane.done(tk)
	if busy {
		return true, false, nil
	}
	row, err := s.o.Store.MailTitleRow(ctx, id)
	if errors.Is(err, db.ErrNotFound) {
		return false, false, nil
	}
	if err != nil {
		return false, false, err
	}
	// A peer's copy is the peer's to regenerate, never this daemon's.
	if row.ConfigHash != nil && *row.ConfigHash == db.PeerTitleConfig {
		return false, false, nil
	}
	cfg := ConfigHash(m, catalog.MailTitleInstructions(s.o.Settings(), row.ToHuman))
	if row.ConfigHash != nil && *row.ConfigHash == cfg || t.isFailed(id, cfg) || !canAsk {
		return false, false, nil
	}
	body := jsSlice(row.Body, titleBody)
	if row.ToHuman {
		body = jsSlice(row.Body, titleBodyHuman)
	}
	queued, stale = t.lane.add(tk, func(ctx context.Context) { t.title(ctx, id, row.Subject, body, row.ToHuman) })
	return queued, stale, nil
}

// title is src/mail-title.ts title: one call for a mail's title, and for a mail to the human its summary too. An answer
// with either is stored as current for the config it was asked with; one with neither, or a failed call, is remembered.
func (t *titles) title(ctx context.Context, id, subject, body string, summary bool) {
	s := t.s
	m := s.titleModel()
	if m == "" || !s.o.LLM.HasKey(m) {
		return
	}
	prompt := catalog.MailTitleInstructions(s.o.Settings(), summary)
	cfg := ConfigHash(m, prompt)
	if held := s.askBlocked(m); held != "" {
		s.event(ctx, "mail-title:skipped", struct {
			ID     string `json:"id"`
			Reason string `json:"reason"`
		}{id, held})
		return
	}
	maxTokens := 16
	if summary {
		maxTokens = 260
	}
	zero := 0.0
	r, err := s.o.LLM.Complete(ctx, llm.Request{
		Model:       m,
		Messages:    []llm.Message{{Role: "system", Content: prompt}, {Role: "user", Content: "Subject: " + subject + "\n\n" + body}},
		MaxTokens:   maxTokens,
		Temperature: &zero,
		Timeout:     callTimeout,
	})
	if err != nil {
		// A canceled call was turned off, not failed.
		typ := "mail-title:canceled"
		if ctx.Err() == nil {
			typ = "mail-title:error"
			t.fail(id, cfg)
		}
		s.event(ctx, typ, struct {
			ID    string `json:"id"`
			Error string `json:"error"`
		}{id, err.Error()})
		return
	}
	p, _ := s.o.LLM.ParseModelRef(m)
	to := spendFor(p)
	s.recordSpend(ctx, titlePurpose, served(to, r.Model), r, to)
	text := ""
	if r.Text != nil {
		text = *r.Text
	}
	var title, sum string
	if summary {
		title, sum = ParseBoth(text)
	} else {
		title = CleanTitle(text)
	}
	if title == "" && sum == "" {
		t.fail(id, cfg)
		return
	}
	wctx := context.WithoutCancel(ctx)
	var errs []error
	if title != "" {
		errs = append(errs, s.o.Store.SetMailTitle(wctx, id, title, cfg))
	} else {
		errs = append(errs, s.o.Store.SetMailTitleConfig(wctx, id, cfg))
	}
	if sum != "" {
		errs = append(errs, s.o.Store.SetMailSummary(wctx, id, sum))
	}
	if errors.Join(errs...) != nil {
		slog.Warn("tiny: a mail title was not stored", "mail", id)
	}
}
