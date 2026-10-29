// Package tiny is the tiny-model steps that run in the human's view: tool-call summaries (src/tool-summaries.ts), tool
// names (src/tool-names.ts), block summaries (src/block-summaries.ts) and the mail titles a view shows
// (src/mail-title.ts), with where their calls are asked and booked (src/tiny-spend.ts). Each is lazy: the view asks for what it shows, a call is asked once at a time through a bounded
// queue, a few at once, with a short timeout and no retry, and a failure is remembered until a restart.
//
// A call through `provider:model` is asked only when the provider has a key and its system budget is not spent, and its
// spend is booked to <provider>-system (openrouter-system for OpenRouter's). No key or credential value is ever in an
// event or a log line: a failed call's event holds the model layer's fixed text.
//
// Deviation: TS's queues start their calls on setImmediate; here a goroutine per call slot, with the same order and caps.
package tiny

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log/slog"

	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/llm"
)

// Store is where the steps read and write: *db.DB.
type Store interface {
	AddEvent(ctx context.Context, agentID, typ string, data any) error
	RecordSpend(ctx context.Context, purpose, provider, account string, cost float64, tokensIn, tokensOut int64) error
	AddExactPending(ctx context.Context, usd float64) error
	ToolSummary(ctx context.Context, agentID, callID, hash string) (db.ToolSummary, error)
	SetToolSummary(ctx context.Context, agentID, callID, hash, tool, doing, model, configHash string) error
	ToolName(ctx context.Context, harness, name string) (string, error)
	SetToolName(ctx context.Context, harness, name, label, model string) error
	BlockSummary(ctx context.Context, hash string) (summary string, configHash *string, err error)
	SetBlockSummary(ctx context.Context, hash, summary, model, configHash string) error
	MailTitleRow(ctx context.Context, id string) (db.MailTitleRow, error)
	SetMailTitle(ctx context.Context, id, title, configHash string) error
	SetMailTitleConfig(ctx context.Context, id, configHash string) error
	SetMailSummary(ctx context.Context, id, summary string) error
}

// Options is what the steps need from the daemon.
type Options struct {
	LLM      *llm.Layer
	Settings func() config.Settings
	Store    Store
	// Held is why stam's own calls through the provider may not run now, its system budget spent, or ""; nil holds
	// nothing.
	Held func(provider string) string
	// LedgerChanged runs after a call's cost is booked, when it isn't zero; nil runs nothing.
	LedgerChanged func()
}

// Steps runs the tiny-model steps.
type Steps struct {
	o      Options
	sums   *summaries
	names  *names
	blocks *blocks
	titles *titles
}

// New returns the steps.
func New(o Options) *Steps {
	s := &Steps{o: o}
	s.sums = newSummaries(s)
	s.names = newNames(s)
	s.blocks = newBlocks(s)
	s.titles = newTitles(s)
	return s
}

// Refresh is the steps' settings listener (onSettingsChange): a step turned off drops what it queued and stops its calls
// in flight.
func (s *Steps) Refresh() {
	if !s.summaryConfig().on() {
		s.sums.lane.stop()
	}
	if s.nameModel() == "" {
		s.names.lane.stop()
	}
	if s.blockModel() == "" {
		s.blocks.stop()
	}
	if s.titleModel() == "" {
		s.titles.lane.stop()
	}
}

// sha is the sha256 hex of a text.
func sha(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

// askBlocked is src/tiny-spend.ts askBlocked: why the model's provider can't be asked now (no key, or its system budget
// spent), else "".
func (s *Steps) askBlocked(model string) string {
	if !s.o.LLM.HasKey(model) {
		return "no API key"
	}
	if s.o.Held == nil {
		return ""
	}
	p, _ := s.o.LLM.ParseModelRef(model)
	return s.o.Held(p)
}

// spendTo is src/tiny-spend.ts spendTo: the provider and account a call books to; OpenRouter's default for its own.
type spendTo struct{ provider, account string }

func spendFor(provider string) *spendTo {
	if provider == llm.DefaultProvider {
		return nil
	}
	return &spendTo{provider, provider + "-system"}
}

// served is the model a result names for the record: a non-default provider's keeps its prefix, so the record names who
// served it.
func served(to *spendTo, model string) string {
	if to == nil {
		return model
	}
	return to.provider + ":" + model
}

// recordSpend is src/decide.ts recordSpend: the usage row on the provider's system account and a `decide` event. A
// response's cost through OpenRouter is billed money, added to the reconcile's exact pending total, and any cost has the
// budgets evaluated.
func (s *Steps) recordSpend(ctx context.Context, purpose, model string, r llm.Result, to *spendTo) {
	ctx = context.WithoutCancel(ctx)
	at := spendTo{llm.DefaultProvider, db.SystemAccount}
	if to != nil {
		at = *to
	}
	cost := 0.0
	if r.Cost != nil {
		cost = *r.Cost
	}
	in, out := int64(r.InputTokens), int64(r.OutputTokens)
	if err := s.o.Store.RecordSpend(ctx, purpose, at.provider, at.account, cost, in, out); err != nil {
		slog.Warn("tiny: the spend was not recorded", "purpose", purpose)
	}
	if at.provider == llm.DefaultProvider {
		if err := s.o.Store.AddExactPending(ctx, cost); err != nil {
			slog.Warn("tiny: the exact pending cost was not recorded", "purpose", purpose)
		}
	}
	if cost > 0 && s.o.LedgerChanged != nil {
		s.o.LedgerChanged()
	}
	type event struct {
		Purpose   string  `json:"purpose"`
		Model     string  `json:"model"`
		Cost      float64 `json:"cost"`
		TokensIn  int64   `json:"tokens_in"`
		TokensOut int64   `json:"tokens_out"`
		Provider  string  `json:"provider,omitempty"`
		Account   string  `json:"account,omitempty"`
	}
	e := event{Purpose: purpose, Model: model, Cost: cost, TokensIn: in, TokensOut: out}
	if to != nil {
		e.Provider, e.Account = to.provider, to.account
	}
	s.event(ctx, "decide", e)
}

// event records a step's event; a failure to record it is logged, never the caller's.
func (s *Steps) event(ctx context.Context, typ string, data any) {
	if err := s.o.Store.AddEvent(context.WithoutCancel(ctx), "stam", typ, data); err != nil {
		slog.Warn("tiny: an event was not recorded", "type", typ)
	}
}
