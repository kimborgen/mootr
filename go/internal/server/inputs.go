package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"stam/internal/adapters/claude"
	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
)

// Suggested harness input (src/permissions.ts suggestInput and the rest, S-422; S-2848 B3b): an agent proposes the
// exact line to type into its own Claude Code input, such as `! git status`. The human approves it, through the web UI
// as trustedHuman proves it (the route checks that; nothing here takes `by` as proof), and stam types it in as written.
// Anyone who may answer a permission request can deny it.
//
// Each move of a suggestion is one conditional update (db.MoveInputRequest), so a replay, a second click or a race with
// the expiry finds nothing; the in-memory state below is under inputState.mu, and typing runs outside it, at most one
// at a time per agent.
//
// Not ported, answered 501 before anything is written: a suggestion whose reviewer runs on another machine (its mail
// would go through the peer).

// inputTTL is how long an approval waits for a free input box, from the approval (S-3830). A suggestion has no TTL: it
// waits until it is answered, withdrawn, or its agent ends.
const inputTTL = 30 * time.Minute

// mismatchRetry is how long the sweep waits before it types a held approval again after a box that didn't show the
// text (src/permissions.ts MISMATCH_RETRY_MS, a minute; STAM_TEST_MISMATCH_RETRY_MS in a test home). The agent's idle
// hook doesn't retry it either: it waits for the sweep.
func (s *Server) mismatchRetry() time.Duration {
	if s.cfg.TestMismatchRetry > 0 {
		return s.cfg.TestMismatchRetry
	}
	return time.Minute
}

// jsISO is Date#toISOString's format.
const jsISO = "2006-01-02T15:04:05.000Z"

// inputState is src/permissions.ts's module state for suggestions: the agents being typed into, the prompt each typed
// suggestion should submit, the requests whose blocking draft was told once (S-524), and why each held one is held.
type inputState struct {
	mu        sync.Mutex
	typing    map[string]bool
	submitted map[string]expectedPrompt
	draftTold map[string]bool
	heldWhy   map[string]string
	// seen marks a once-only thread note or notice per request, kind+"\x00"+id (S-3830), and retry is when the sweep may
	// next type a held approval whose box didn't show the text.
	seen  map[string]bool
	retry map[string]time.Time
}

type expectedPrompt struct {
	r     db.PermissionRequest
	until time.Time
}

// begin claims typing into the agent; false when an attempt already runs.
func (st *inputState) begin(id string) bool {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.typing[id] {
		return false
	}
	if st.typing == nil {
		st.typing = map[string]bool{}
	}
	st.typing[id] = true
	return true
}

func (st *inputState) end(id string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	delete(st.typing, id)
}

func (st *inputState) setWhy(id, why string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.heldWhy == nil {
		st.heldWhy = map[string]string{}
	}
	if why == "" {
		delete(st.heldWhy, id)
	} else {
		st.heldWhy[id] = why
	}
}

func (st *inputState) why(id string) (string, bool) {
	st.mu.Lock()
	defer st.mu.Unlock()
	w, ok := st.heldWhy[id]
	return w, ok
}

// tellDraft is whether the draft blocking request id is new, marking it told.
func (st *inputState) tellDraft(id string) bool {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.draftTold[id] {
		return false
	}
	if st.draftTold == nil {
		st.draftTold = map[string]bool{}
	}
	st.draftTold[id] = true
	return true
}

func (st *inputState) expect(id string, e expectedPrompt) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.submitted == nil {
		st.submitted = map[string]expectedPrompt{}
	}
	st.submitted[id] = e
}

func (st *inputState) takeExpected(id string) (expectedPrompt, bool) {
	st.mu.Lock()
	defer st.mu.Unlock()
	e, ok := st.submitted[id]
	delete(st.submitted, id)
	return e, ok
}

// ago is whether an ISO time is past; an empty one isn't (a suggestion has no TTL, S-3830).
func ago(iso string) bool { return iso != "" && iso <= time.Now().UTC().Format(jsISO) }

// once is whether a request is new under kind, marking it.
func (st *inputState) once(kind, id string) bool {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.seen == nil {
		st.seen = map[string]bool{}
	}
	key := kind + "\x00" + id
	if st.seen[key] {
		return false
	}
	st.seen[key] = true
	return true
}

// setRetry holds back the sweep's next try of request id until at.
func (st *inputState) setRetry(id string, at time.Time) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.retry == nil {
		st.retry = map[string]time.Time{}
	}
	st.retry[id] = at
}

// retryDue is whether the sweep may try request id now.
func (st *inputState) retryDue(id string) bool {
	st.mu.Lock()
	defer st.mu.Unlock()
	return time.Now().After(st.retry[id])
}

// forget drops what a finished approval kept (S-3830): typed or expired, nothing about it is needed again.
func (st *inputState) forget(id string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	delete(st.seen, "held\x00"+id)
	delete(st.seen, "mismatch\x00"+id)
	delete(st.retry, id)
}

// fencedExact is a fence longer than any run of backticks in the text, so the text shows exactly as written.
func fencedExact(text string) string {
	n := 3
	for _, f := range backticks.FindAllString(text, -1) {
		n = max(n, len(f)+1)
	}
	fence := strings.Repeat("`", n)
	return fence + "\n" + text + "\n" + fence
}

// moveInputNotice moves an input request and writes its input-answered notice in one transaction (S-3923): the move
// happens only with its row. moved is false when the move didn't happen.
func (s *Server) moveInputNotice(ctx context.Context, a db.Agent, r db.PermissionRequest, from, to string, f db.MoveInput, result string) (bool, error) {
	text, err := s.render("input-answered", map[string]string{"id": r.ID, "result": result})
	if err != nil {
		return false, err
	}
	moved, row, err := s.db.MoveInputRequestNoticed(ctx, r.ID, from, to, f, &db.NewAnswerNotice{AgentID: a.ID, Text: text})
	if err != nil || !moved {
		return false, err
	}
	s.queueAnswerRow(ctx, a.ID, text, row)
	return true, nil
}

// inputNoticeStored is inputNotice whose row keeps `stored` instead of the notice's text, for a draft's text (S-3923).
func (s *Server) inputNoticeStored(ctx context.Context, a db.Agent, r db.PermissionRequest, result, stored string) {
	text, err := s.render("input-answered", map[string]string{"id": r.ID, "result": result})
	if err != nil {
		slog.Error("input notice", "err", err)
		return
	}
	if s.noticeHook != nil {
		s.noticeHook(a.ID, text)
	} else if s.life != nil {
		keep, err := s.render("input-answered", map[string]string{"id": r.ID, "result": stored})
		if err != nil {
			slog.Error("input notice", "err", err)
			return
		}
		s.life.QueueAnswerNoticeStored(ctx, a.ID, text, keep)
	}
}

func (s *Server) inputNotice(ctx context.Context, a db.Agent, r db.PermissionRequest, result string) {
	text, err := s.render("input-answered", map[string]string{"id": r.ID, "result": result})
	if err != nil {
		slog.Error("input notice", "err", err)
		return
	}
	s.queueAnswerNotice(ctx, a.ID, text)
}

// permissionError records a failure stam can't answer to anyone as the agent's permission-error event, as TS's
// String(e).
func (s *Server) permissionError(ctx context.Context, id string, err error) {
	if err := s.db.AddEvent(ctx, id, "permission-error", "Error: "+err.Error()); err != nil {
		slog.Error("permission-error event", "err", err)
	}
}

// The events' data keeps TS's key order.
type withdrawnEvent struct {
	ID   string `json:"id"`
	Note string `json:"note"`
}

type inputRequestedEvent struct {
	ID     string `json:"id"`
	Action string `json:"action"`
	Kind   string `json:"kind"`
}

type inputAnsweredEvent struct {
	ID      string `json:"id"`
	Approve bool   `json:"approve"`
	By      string `json:"by"`
	Kind    string `json:"kind"`
}

type inputIDEvent struct {
	ID string `json:"id"`
}

type inputHeldEvent struct {
	ID  string  `json:"id"`
	Why string  `json:"why"`
	Box *string `json:"box,omitempty"`
}

type inputCancelledEvent struct {
	ID     string  `json:"id"`
	Status *string `json:"status,omitempty"`
}

type inputExpiredEvent struct {
	ID  string `json:"id"`
	Was string `json:"was"`
	Why string `json:"why,omitempty"`
}

type inputSubmittedEvent struct {
	ID      string `json:"id"`
	Matched bool   `json:"matched"`
	Prompt  string `json:"prompt"`
	Via     string `json:"via,omitempty"`
}

type inputMismatchEvent struct {
	ID     string `json:"id"`
	Prompt string `json:"prompt,omitempty"`
	Via    string `json:"via,omitempty"`
}

// suggestInput is src/permissions.ts suggestInput: the agent's text checked, its earlier suggestions replaced, the new
// one created with a wait on the human, and mailed to the human and the reviewers in a thread of its own.
func (s *Server) suggestInput(ctx context.Context, a db.Agent, raw jsjson.Value, reason string) (jsfmt.Value, error) {
	if a.Harness != "claude" {
		return jsfmt.Value{}, fmt.Errorf("suggest_input types into a Claude Code input box only; %s runs %s, whose input stam can't type into this way. Use request_permission instead", a.Name, a.Harness)
	}
	if problem := claude.InputProblem(raw); problem != "" {
		return jsfmt.Value{}, errors.New(problem)
	}
	text := raw.(string)
	if s.tpl == nil {
		return jsfmt.Value{}, unported("suggested input needs the templates, which this server has not loaded")
	}
	reviewers, err := s.reviewers(ctx, a)
	if err != nil {
		return jsfmt.Value{}, err
	}
	for _, id := range reviewers {
		if _, err := s.db.GetAgent(ctx, id); errors.Is(err, db.ErrNotFound) {
			return jsfmt.Value{}, unported("%s's reviewer %s runs on another machine, and mailing it the suggestion is not ported to the Go daemon yet", a.Name, s.agentLabel(ctx, id))
		} else if err != nil {
			return jsfmt.Value{}, err
		}
	}
	sum := sha256.Sum256([]byte(text))
	r, replaced, err := s.db.CreateInputRequest(ctx, db.NewInput{AgentID: a.ID, Reason: reason, Text: text, SHA256: hex.EncodeToString(sum[:])})
	if err != nil {
		return jsfmt.Value{}, err
	}
	const note = "a newer suggestion replaced it"
	for _, old := range replaced {
		if err := s.db.AddEvent(ctx, a.ID, "permission:withdrawn", withdrawnEvent{ID: old.ID, Note: note}); err != nil {
			return jsfmt.Value{}, err
		}
		if old.Was == "pending" {
			ids, err := s.db.PermissionMailIDs(ctx, old.ID)
			if err != nil {
				return jsfmt.Value{}, err
			}
			s.withdrawQuietly(ctx, ids, "stam", "Withdrawn: "+note)
		}
	}
	s.orgResync(ctx, a.ID)
	pub, err := s.publicRequest(ctx, r.ID)
	if err != nil {
		return jsfmt.Value{}, err
	}
	why := reason
	if why == "" {
		why = "(none given)"
	}
	body, err := s.render("permission-input", map[string]string{"requester": a.Name, "machine": pub.Text("machine"), "reason": why, "text": fencedExact(text), "id": r.ID})
	if err != nil {
		return jsfmt.Value{}, err
	}
	to := append([]string{humanBox}, reviewers...)
	if _, err := s.send(ctx, &sendIn{from: a.ID, to: to, subject: sliceUnits("Input for "+a.Name+": "+text, 200), body: body, permissionID: r.ID, newThread: true, inferred: map[string]bool{}}); err != nil {
		return jsfmt.Value{}, err
	}
	if err := s.db.AddEvent(ctx, a.ID, "permission:requested", inputRequestedEvent{ID: r.ID, Action: r.Action, Kind: "input"}); err != nil {
		return jsfmt.Value{}, err
	}
	return pub, nil
}

// denyInput is src/permissions.ts denyInput: a denial types nothing. An approval never comes this way: only
// approveInput, called by the route once trustedHuman holds, approves a suggestion.
func (s *Server) denyInput(ctx context.Context, r db.PermissionRequest, a db.Agent, approve bool, by, text, who string) (jsfmt.Value, error) {
	if approve {
		pub, err := s.db.PublicRequest(ctx, r, s.cfg.Machine)
		if err != nil {
			return jsfmt.Value{}, err
		}
		return jsfmt.Value{}, fmt.Errorf("only the human approves suggested input, from stam's web UI on %s; deny it, or leave it to the human", pub.Text("machine"))
	}
	n, err := s.answeredNotice(r.ID, r.Action, false, who, text)
	if err != nil {
		return jsfmt.Value{}, err
	}
	// The denial and its notice's row commit together (S-3923).
	moved, row, err := s.db.MoveInputRequestNoticed(ctx, r.ID, "pending", "denied", db.MoveInput{By: &by, Note: &text, Settle: true}, &db.NewAnswerNotice{AgentID: a.ID, Text: n})
	if err != nil {
		return jsfmt.Value{}, err
	}
	if !moved {
		return jsfmt.Value{}, s.notPending(ctx, r.ID)
	}
	s.queueAnswerRow(ctx, a.ID, n, row)
	if err := s.db.AddEvent(ctx, a.ID, "permission:answered", answeredEvent{ID: r.ID, Approve: false, By: by, Typed: false}); err != nil {
		return jsfmt.Value{}, err
	}
	s.orgResync(ctx, a.ID)
	return s.publicRequest(ctx, r.ID)
}

// inputRefused is src/permissions.ts InputRefused: an approval refused for the state the suggestion is in (409).
type inputRefused struct{ msg string }

func (e *inputRefused) Error() string { return e.msg }

func inputRefusal(format string, args ...any) error {
	return &inputRefused{fmt.Sprintf(format, args...)}
}

// approveInput is src/permissions.ts approveInput, the human's approval; the caller has proven the human
// (trustedHuman). sha must be the stored text's, so the human approves the text they saw; the move out of pending is
// one conditional update. The approval holds for the agent's harness session as it is now, and is typed into no
// other. A second tap on a held approval is a state, not an error (S-524): it answers with the request as it is, and
// tries typing again.
func (s *Server) approveInput(ctx context.Context, id string, sha jsjson.Value) (jsfmt.Value, error) {
	r, ok, err := s.db.PermissionRequestByID(ctx, id)
	if err != nil {
		return jsfmt.Value{}, err
	}
	if !ok || r.Kind != "input" {
		return jsfmt.Value{}, inputRefusal("no input suggestion %s", id)
	}
	a, err := s.db.GetAgent(ctx, r.AgentID)
	if errors.Is(err, db.ErrNotFound) {
		return jsfmt.Value{}, inputRefusal("the agent that suggested %s is gone", id)
	} else if err != nil {
		return jsfmt.Value{}, err
	}
	given, isText := sha.(string)
	first := false
	switch {
	case r.Status == "held" && isText && given == r.SHA256:
		if ago(r.ExpiresAt) {
			s.ExpireInputs(ctx)
			return jsfmt.Value{}, inputRefusal("request %s expired at %s", id, r.ExpiresAt)
		}
	case r.Status != "pending":
		return jsfmt.Value{}, inputRefusal("request %s is already %s", id, r.Status)
	case !isText || given != r.SHA256:
		return jsfmt.Value{}, inputRefusal("text_sha256 doesn't match request %s's text; reload it and approve what it shows", id)
	default:
		by, note, session, expires := humanBox, "approved", deref(a.SessionID), time.Now().Add(inputTTL).UTC().Format(jsISO)
		moved, err := s.db.MoveInputRequest(ctx, id, "pending", "held", db.MoveInput{By: &by, Note: &note, Session: &session, Expires: &expires, Settle: true})
		if err != nil {
			return jsfmt.Value{}, err
		}
		if !moved {
			return jsfmt.Value{}, s.notApproved(ctx, id)
		}
		if err := s.db.AddEvent(ctx, a.ID, "permission:answered", inputAnsweredEvent{ID: id, Approve: true, By: humanBox, Kind: "input"}); err != nil {
			return jsfmt.Value{}, err
		}
		s.orgResync(ctx, a.ID)
		first = true
	}
	s.inputs.setWhy(id, "")
	if r, _, err = s.db.PermissionRequestByID(ctx, id); err != nil {
		return jsfmt.Value{}, err
	}
	outcome, err := s.tryHeld(ctx, a, r, first)
	if err != nil {
		return jsfmt.Value{}, err
	}
	out, err := s.publicRequest(ctx, id)
	if err != nil {
		return jsfmt.Value{}, err
	}
	out.Set("typed", jsfmt.Value{Kind: jsfmt.Bool, Bool: outcome == "typed"})
	out.Set("outcome", jsfmt.StringValue(outcome))
	if why, ok := s.inputs.why(id); outcome == "held" && ok {
		out.Set("why", jsfmt.StringValue(why))
	}
	return out, nil
}

// tryHeld types the agent's oldest held approval, so approvals go in the order the human gave them (S-3830). r's own
// outcome is "held" while an earlier one waits, why "queued".
func (s *Server) tryHeld(ctx context.Context, a db.Agent, r db.PermissionRequest, first bool) (string, error) {
	held, err := s.db.InputRequests(ctx, "held", a.ID)
	if err != nil || len(held) == 0 {
		return "held", err
	}
	if held[0].ID == r.ID {
		return s.typeHeld(ctx, r, first)
	}
	if r.Status == "held" {
		if _, err := s.held(ctx, a, r, first, "queued"); err != nil {
			return "", err
		}
	}
	return "held", nil
}

// notApproved refuses an approval whose move found the request no longer pending.
func (s *Server) notApproved(ctx context.Context, id string) error {
	r, _, err := s.db.PermissionRequestByID(ctx, id)
	if err != nil {
		return err
	}
	return inputRefusal("request %s is already %s", id, r.Status)
}

// testBarrier holds the typing right before Enter, for tests (S-422): with STAM_TEST_INPUT_BARRIER set to a folder
// holding a `hold` file, it writes `at` there and waits until `hold` is gone. Only in a test home. The Go daemon has a
// second stop, after the claim and before Enter: `hold-enter` and `at-enter` (suffix "-enter").
func (s *Server) testBarrier(suffix string) {
	dir := s.cfg.TestInputBarrier
	hold := filepath.Join(dir, "hold"+suffix)
	if dir == "" || !fileExists(hold) {
		return
	}
	if err := os.WriteFile(filepath.Join(dir, "at"+suffix), nil, 0o600); err != nil {
		slog.Error("input barrier", "err", err)
	}
	for i := 0; i < 600 && fileExists(hold); i++ {
		time.Sleep(100 * time.Millisecond)
	}
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// typeHeld is src/permissions.ts typeHeld: a held approval typed into its own agent's input, at most one at a time per
// agent. "held" when the box isn't free yet: the agent is busy, shows a dialog, or someone's draft is in it. Right
// before Enter, one conditional update moves it from held to approved only if it is still held and not expired, and
// the agent's session is still the approved one; else what was typed is erased ("cancelled"), so a suggestion
// withdrawn or expired mid-typing is never sent. Typed input starts a turn, the human's own: a held agent gets it with
// a cost:override event, and one taken over by another agent gets none.
func (s *Server) typeHeld(ctx context.Context, r db.PermissionRequest, first bool) (string, error) {
	a, err := s.db.GetAgent(ctx, r.AgentID)
	if errors.Is(err, db.ErrNotFound) || (err == nil && (s.life == nil || a.Harness != "claude")) {
		return "held", nil
	} else if err != nil {
		return "", err
	}
	if !s.inputs.begin(a.ID) {
		return "held", nil
	}
	defer s.inputs.end(a.ID)
	// Still held, by the same text, and not expired: an expiry or a newer suggestion may have come.
	now, ok, err := s.db.PermissionRequestByID(ctx, r.ID)
	if err != nil || !ok || now.Status != "held" || now.SHA256 != r.SHA256 || ago(now.ExpiresAt) {
		return "held", err
	}
	sameSession := func() bool {
		fresh, err := s.db.GetAgent(ctx, a.ID)
		return err == nil && deref(fresh.SessionID) == now.SessionID
	}
	if !sameSession() {
		return "expired", s.expireHeld(ctx, a, now, "its harness session changed after you approved it")
	}
	if a.Activity != "idle" && a.Activity != "waiting" {
		return s.held(ctx, a, now, first, "busy")
	}
	if ok, reason := s.life.AdmitHuman(ctx, a.ID); !ok {
		note := "not typed: " + reason
		moved, err := s.moveInputNotice(ctx, a, r, "held", "failed", db.MoveInput{Note: &note}, "was approved, but stam didn't type it: "+reason+".")
		if err != nil {
			return "", err
		}
		if moved {
			s.noteOutcome(ctx, a, r, "failed", "stam didn't type it: "+reason+".")
		}
		return "failed", nil
	}
	// The transcript's size right before Enter: a bash-mode command is looked for after it.
	var offset int64
	var claimErr error
	// Claude Code runs no UserPromptSubmit for a bash-mode command (2.1.296): its transcript shows it instead. A slash
	// command runs none either, and isn't checked. Any other prompt is expected from the claim on, before Enter, so a
	// UserPromptSubmit that comes as Enter lands finds it.
	expects := !strings.HasPrefix(now.Text, "!") && !strings.HasPrefix(now.Text, "/")
	expected := false
	proceed := func(stillTyped func() bool) bool {
		s.testBarrier("")
		// The box is read again right before Enter: a key typed since the lifecycle's check is never sent with the text.
		if !stillTyped() {
			return false
		}
		offset = s.transcriptSize(ctx, a.ID)
		// The session check is part of the claim, so a hook that changes the session can't come in between.
		moved, err := s.db.MoveInputRequest(ctx, r.ID, "held", "approved", db.MoveInput{Unexpired: true, SameSession: true})
		claimErr = err
		if err != nil || !moved {
			return false
		}
		if expects {
			s.inputs.expect(a.ID, expectedPrompt{r: now, until: time.Now().Add(s.inputExpect)})
			expected = true
		}
		s.testBarrier("-enter")
		return true
	}
	var done string
	if err := s.life.HoldingPushes(a.ID, func() error {
		done = s.life.TypeLiteralInput(ctx, a, now.Text, proceed)
		return nil
	}); err != nil {
		return "", err
	}
	if expected && done != "typed" {
		s.inputs.takeExpected(a.ID)
	}
	if claimErr != nil {
		return "", claimErr
	}
	status := func() (*string, error) {
		x, ok, err := s.db.PermissionRequestByID(ctx, r.ID)
		if err != nil || !ok {
			return nil, err
		}
		return &x.Status, nil
	}
	switch done {
	case "typed":
		if strings.HasPrefix(now.Text, "!") {
			s.life.Go(func(lctx context.Context) { s.checkTranscript(lctx, a, now, offset) })
		}
		s.inputs.setWhy(r.ID, "")
		s.inputs.forget(r.ID)
		if err := s.db.AddEvent(ctx, a.ID, "input:typed", inputIDEvent{ID: r.ID}); err != nil {
			return "", err
		}
		s.inputNotice(ctx, a, r, "was approved by your user (the human) and typed into your input as written.")
		s.noteOutcome(ctx, a, r, "typed", "sent to its input exactly as approved.")
		return "typed", nil
	case "cancelled":
		st, err := status()
		if err != nil {
			return "", err
		}
		if err := s.db.AddEvent(ctx, a.ID, "input:cancelled", inputCancelledEvent{ID: r.ID, Status: st}); err != nil {
			return "", err
		}
		// Still held means only the session changed under it.
		if st != nil && *st == "held" {
			return "cancelled", s.expireHeld(ctx, a, now, "its harness session changed while stam typed it")
		}
		return "cancelled", nil
	case "unsent":
		// The claim went through but Enter didn't: the approval was never sent, so it fails, and both sides hear. A
		// shutdown's cancel can't stop this settle half way and leave the request approved.
		ctx := context.WithoutCancel(ctx)
		why := "the agent's pane changed or tmux failed"
		note := "typed, but Enter not sent: " + why
		// The failed state and its notice's row commit together (S-3923): the approval never reads as failed without its row.
		moved, err := s.moveInputNotice(ctx, a, r, "approved", "failed", db.MoveInput{Note: &note}, "was approved, but after typing it stam couldn't press Enter, so it erased what it typed where it still could and sent nothing. Suggest it again if you still need it.")
		if err != nil {
			return "", err
		}
		if moved {
			if err := s.db.AddEvent(ctx, a.ID, "input:failed", inputIDEvent{ID: r.ID}); err != nil {
				return "", err
			}
			// Written here rather than from a template: input-expired-human says nothing was typed, and here it was.
			body := "You approved @" + a.Name + "'s suggested input " + r.ID + ". stam typed it, but couldn't press Enter (" + why +
				"), so it wasn't sent. stam erased the text where the pane was still the agent's; if that failed, it may still be in the input box. It can suggest it again."
			s.tellHuman(ctx, a, r, "[stam] Approved input for "+a.Name+" was not sent", body)
		}
		return "failed", nil
	case "failed":
		// The box didn't show exactly the text: nothing was sent, and the approval stays held until the box is clear (S-3830).
		if err := s.db.AddEvent(ctx, a.ID, "input:failed", inputIDEvent{ID: r.ID}); err != nil {
			return "", err
		}
		return s.held(ctx, a, now, first, "mismatch")
	}
	// An erase that found the screen not as typed is "failed" even when cancelled; the request moved on.
	if st, err := status(); err != nil {
		return "", err
	} else if st == nil || *st != "held" {
		return "cancelled", nil
	}
	return s.held(ctx, a, now, first, done)
}

// held is src/permissions.ts held: the approval waits for the box, and the agent hears why once. A draft in the box is
// named on the card while it blocks (S-534), and the first time it blocks the agent is told what to clear and the chief
// of staff why.
func (s *Server) held(ctx context.Context, a db.Agent, r db.PermissionRequest, first bool, why string) (string, error) {
	s.inputs.setWhy(r.ID, why)
	var box *string
	if why == "draft" {
		text, ok := s.life.InputText(ctx, a)
		shown := sliceUnits(text, 200)
		if err := s.db.SetHeldBox(ctx, r.ID, &shown); err != nil {
			return "", err
		}
		if ok {
			box = &shown
		}
	} else if err := s.db.SetHeldBox(ctx, r.ID, nil); err != nil {
		return "", err
	}
	switch {
	case why == "queued":
		return "held", nil
	case why == "mismatch":
		// Typed and erased again by the next try: the sweep waits before it tries again (S-3830).
		s.inputs.setRetry(r.ID, time.Now().Add(s.mismatchRetry()))
		if s.inputs.once("mismatch", r.ID) {
			if err := s.db.AddEvent(ctx, a.ID, "input:held", inputHeldEvent{ID: r.ID, Why: why}); err != nil {
				return "", err
			}
			s.inputNotice(ctx, a, r, "was approved by your user (the human), but after typing it your input box didn't show exactly the text with nothing under it, so stam erased what it typed and sent nothing. It stays approved: stam types it once your input box is clear, until "+r.ExpiresAt+".")
		}
	case why == "draft":
		if !s.inputs.tellDraft(r.ID) {
			return "held", nil
		}
		if err := s.db.AddEvent(ctx, a.ID, "input:held", inputHeldEvent{ID: r.ID, Why: why, Box: box}); err != nil {
			return "", err
		}
		shown := "text"
		if box != nil {
			shown = "`" + strings.ReplaceAll(*box, "`", "'") + "`"
		}
		// The draft's text is the agent's to see now, and never stored: the row keeps the notice with the draft left out (S-3923).
		draftNotice := func(box string) string {
			return "was approved by your user (the human), but stam can't type it: your input box holds " + box + ", which stam didn't type. Clear your input box (Ctrl+U) and stam types it at once; until " + r.ExpiresAt + "."
		}
		s.inputNoticeStored(ctx, a, r, draftNotice(shown), draftNotice("(a draft, not stored)"))
		if cos := s.chiefOfStaffID(ctx); cos != "" && cos != a.ID {
			body := "Your user approved input " + r.ID + " for @" + a.Name + ", but its input box holds " + shown + ", which stam didn't type. stam told the agent to clear it; the approval expires at " + r.ExpiresAt + "."
			if _, err := s.send(ctx, &sendIn{from: a.ID, to: []string{cos}, subject: "Approved input for " + a.Name + " is held by text in its box", body: body, fromStam: true, inferred: map[string]bool{}}); err != nil {
				s.permissionError(ctx, a.ID, err)
			}
		}
	case first:
		if err := s.db.AddEvent(ctx, a.ID, "input:held", inputHeldEvent{ID: r.ID, Why: why}); err != nil {
			return "", err
		}
		s.inputNotice(ctx, a, r, "was approved by your user (the human). End your turn so stam can type it into your input; you continue after. stam types it as soon as you are idle with an empty box, until "+r.ExpiresAt+".")
	}
	return "held", nil
}

// noteOutcome is one line in the request's thread, for the end states only: typed or failed (S-3830). Held and
// withdrawn aren't noted.
func (s *Server) noteOutcome(ctx context.Context, a db.Agent, r db.PermissionRequest, outcome, line string) {
	s.tellHuman(ctx, a, r, "[stam] Input for "+a.Name+": "+outcome, strings.ToUpper(outcome[:1])+outcome[1:]+": "+line)
}

// expireHeld is src/permissions.ts expireHeld: a held approval that won't be typed. The agent hears, and the human is
// told once in its thread.
func (s *Server) expireHeld(ctx context.Context, a db.Agent, r db.PermissionRequest, why string) error {
	moved, err := s.moveInputNotice(ctx, a, r, "held", "expired", db.MoveInput{Note: &why}, "expired: "+why+", so nothing was typed.")
	if err != nil || !moved {
		return err
	}
	s.inputs.forget(r.ID)
	if err := s.db.AddEvent(ctx, a.ID, "input:expired", inputExpiredEvent{ID: r.ID, Was: "held", Why: why}); err != nil {
		return err
	}
	body, err := s.render("input-expired-human", map[string]string{"requester": a.Name, "id": r.ID, "why": why})
	if err != nil {
		return err
	}
	s.tellHuman(ctx, a, r, "[stam] Approved input for "+a.Name+" expired untyped", body)
	return nil
}

// inputNoteWithheldEvent is a thread note withheld from a placed ask (S-3830): its subject, not its body.
type inputNoteWithheldEvent struct {
	ID      string `json:"id"`
	Subject string `json:"subject"`
}

// tellHuman is stam's reply to the human in the suggestion's own thread; a failure is a permission-error event. Under a
// placed ask it isn't posted: the thread is shared, and mail has no sealed kind in the Go daemon yet (S-3830), so the
// note is withheld and an event says so.
func (s *Server) tellHuman(ctx context.Context, a db.Agent, r db.PermissionRequest, subject, body string) {
	m, placed, _, err := s.db.PermissionMailPlaced(ctx, r.ID)
	if err == nil && placed {
		if err := s.db.AddEvent(ctx, a.ID, "input:note-withheld", inputNoteWithheldEvent{ID: r.ID, Subject: subject}); err != nil {
			s.permissionError(ctx, a.ID, err)
		}
		return
	}
	if err == nil {
		_, err = s.send(ctx, &sendIn{from: a.ID, to: []string{humanBox}, subject: subject, body: body, replyTo: m, fromStam: true, inferred: map[string]bool{}})
	}
	if err != nil {
		s.permissionError(ctx, a.ID, err)
	}
}

// PromptSubmitted is src/permissions.ts promptSubmitted, for the lifecycle's UserPromptSubmit hook: the first prompt
// after a typed suggestion must be its text; if it isn't, the human is told once.
func (s *Server) PromptSubmitted(ctx context.Context, agentID, prompt string) {
	e, ok := s.inputs.takeExpected(agentID)
	if !ok || time.Now().After(e.until) {
		return
	}
	text := e.r.Text
	p := jsjson.Trim(prompt)
	matched := p == jsjson.Trim(text) || (strings.HasPrefix(text, "!") && p == jsjson.Trim(text[1:]))
	if err := s.db.AddEvent(ctx, agentID, "input:submitted", inputSubmittedEvent{ID: e.r.ID, Matched: matched, Prompt: sliceUnits(prompt, 200)}); err != nil {
		slog.Error("input:submitted", "err", err)
	}
	if matched {
		return
	}
	a, err := s.db.GetAgent(ctx, agentID)
	if err != nil {
		return
	}
	long := sliceUnits(prompt, 2000)
	if err := s.db.AddEvent(ctx, a.ID, "input:mismatch", inputMismatchEvent{ID: e.r.ID, Prompt: long}); err != nil {
		slog.Error("input:mismatch", "err", err)
	}
	s.mismatch(ctx, a, e.r, fencedExact(long))
}

func (s *Server) mismatch(ctx context.Context, a db.Agent, r db.PermissionRequest, prompt string) {
	body, err := s.render("input-mismatch-human", map[string]string{"requester": a.Name, "id": r.ID, "prompt": prompt})
	if err != nil {
		s.permissionError(ctx, a.ID, err)
		return
	}
	s.tellHuman(ctx, a, r, "[stam] Input for "+a.Name+" submitted something else", body)
}

func (s *Server) transcriptSize(ctx context.Context, id string) int64 {
	a, err := s.db.GetAgent(ctx, id)
	if err != nil || deref(a.TranscriptPath) == "" {
		return 0
	}
	fi, err := os.Stat(*a.TranscriptPath)
	if err != nil {
		return 0
	}
	return fi.Size()
}

// rowTail is src/permissions.ts RowTail: where a poll left off in a transcript, the next byte to read, and a last row
// still being written.
type rowTail struct {
	pos   int64
	carry []byte
}

// rows is src/permissions.ts tailRows: the whole rows appended to path since the last call, so a poll reads only new
// bytes, never the whole transcript. A last row without its newline waits in carry for the next call.
func (t *rowTail) rows(path string) (string, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if fi.Size() < t.pos {
		t.pos, t.carry = fi.Size(), nil
	}
	if fi.Size() > t.pos {
		f, err := os.Open(path)
		if err != nil {
			return "", err
		}
		defer f.Close()
		buf := make([]byte, fi.Size()-t.pos)
		n, err := f.ReadAt(buf, t.pos)
		if err != nil && err != io.EOF {
			return "", err
		}
		t.carry = append(t.carry, buf[:n]...)
		t.pos += int64(n)
	}
	end := bytes.LastIndexByte(t.carry, '\n') + 1
	rows := string(t.carry[:end])
	t.carry = append([]byte(nil), t.carry[end:]...)
	return rows, nil
}

// checkTranscript is src/permissions.ts checkTranscript: a typed bash-mode command must show in the agent's transcript
// within bashExpect (claude.BashInputRecorded). Only what was appended after Enter counts (from offset), since the
// agent's own suggest_input call earlier in the transcript holds the text too. If another command shows first, or none
// does, the human is told once.
func (s *Server) checkTranscript(ctx context.Context, a db.Agent, r db.PermissionRequest, offset int64) {
	tail := &rowTail{pos: offset}
	for until := time.Now().Add(s.bashExpect); time.Now().Before(until); {
		seen := "none"
		if fresh, err := s.db.GetAgent(ctx, a.ID); err == nil && deref(fresh.TranscriptPath) != "" {
			if rows, err := tail.rows(*fresh.TranscriptPath); err == nil && rows != "" {
				seen = claude.BashInputRecorded(rows, r.Text)
			}
		}
		if seen == "match" {
			if err := s.db.AddEvent(ctx, a.ID, "input:submitted", inputSubmittedEvent{ID: r.ID, Matched: true, Prompt: sliceUnits(r.Text, 200), Via: "transcript"}); err != nil {
				slog.Error("input:submitted", "err", err)
			}
			return
		}
		if seen == "other" {
			break
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
	if err := s.db.AddEvent(ctx, a.ID, "input:mismatch", inputMismatchEvent{ID: r.ID, Via: "transcript"}); err != nil {
		slog.Error("input:mismatch", "err", err)
	}
	s.mismatch(ctx, a, r, fencedExact("(the command is not in its transcript)"))
}

// TypeHeldInput is src/permissions.ts typeHeldInput, for the lifecycle's hook: the agent went idle or waiting, so its
// held approval, if any, is typed now. The pane may still be drawing the box, so it tries a few times; the sweep tries
// again later.
func (s *Server) TypeHeldInput(ctx context.Context, agentID string) error {
	for i := 0; i < 6; i++ {
		held, err := s.db.InputRequests(ctx, "held", agentID)
		if err != nil || len(held) == 0 {
			return err
		}
		if outcome, err := s.typeHeld(ctx, held[0], false); err != nil || outcome != "held" {
			return err
		}
		// A box that didn't show the text waits for the sweep's retry: the hook doesn't type it again (S-3830).
		if !s.inputs.retryDue(held[0].ID) {
			return nil
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(300 * time.Millisecond):
		}
	}
	return nil
}

// WithdrawPending is src/permissions.ts withdrawPendingInputs: the agent's suggestions still pending when it stops, is
// archived or is forgotten are withdrawn, their asks pulled and waits cleared (Settle) (S-3830).
func (s *Server) WithdrawPending(ctx context.Context, a db.Agent, note string) error {
	pending, err := s.db.InputRequests(ctx, "pending", a.ID)
	if err != nil {
		return err
	}
	for _, r := range pending {
		moved, err := s.db.MoveInputRequest(ctx, r.ID, "pending", "withdrawn", db.MoveInput{Note: &note, Settle: true})
		if err != nil {
			return err
		}
		if !moved {
			continue
		}
		if err := s.db.AddEvent(ctx, a.ID, "permission:withdrawn", withdrawnEvent{ID: r.ID, Note: note}); err != nil {
			return err
		}
		ids, err := s.db.PermissionMailIDs(ctx, r.ID)
		if err != nil {
			return err
		}
		s.withdrawQuietly(ctx, ids, "stam", "Withdrawn: "+note)
	}
	s.orgResync(ctx, a.ID)
	return nil
}

// ExpireInputs is src/permissions.ts expireInputs: an approval past its TTL expires (a held one tells the human once, in its
// thread, and types nothing), and a held one whose agent went busy drops the box text its card showed. A suggestion has
// no TTL (S-3830).
func (s *Server) ExpireInputs(ctx context.Context) {
	held, err := s.db.InputRequests(ctx, "held", "")
	if err != nil {
		slog.Error("expire inputs", "err", err)
		return
	}
	for _, r := range held {
		a, err := s.db.GetAgent(ctx, r.AgentID)
		if err != nil {
			continue
		}
		if ago(r.ExpiresAt) {
			if err := s.expireHeld(ctx, a, r, "it expired at "+r.ExpiresAt+" before the input box was free"); err != nil {
				s.permissionError(ctx, a.ID, err)
			}
		} else if a.Activity != "idle" && a.Activity != "waiting" && strings.HasPrefix(r.Row.Text("note"), "box:") {
			// The agent went busy: the box text the card showed is stale.
			if err := s.db.SetHeldBox(ctx, r.ID, nil); err != nil {
				slog.Error("expire inputs", "err", err)
			}
		}
	}
}

// retryHeldInputs is src/permissions.ts retryHeldInputs, every few seconds: the expiry sweep, then each agent's oldest
// held approval, while the agent is idle and its retry isn't held back, is tried again.
func (s *Server) retryHeldInputs(ctx context.Context) {
	s.ExpireInputs(ctx)
	held, err := s.db.InputRequests(ctx, "held", "")
	if err != nil {
		slog.Error("suggested input", "err", err)
		return
	}
	headed := map[string]bool{}
	for _, r := range held {
		if headed[r.AgentID] {
			continue
		}
		headed[r.AgentID] = true
		a, err := s.db.GetAgent(ctx, r.AgentID)
		if err != nil || (a.Activity != "idle" && a.Activity != "waiting") || !s.inputs.retryDue(r.ID) {
			continue
		}
		if _, err := s.typeHeld(ctx, r, false); err != nil {
			s.permissionError(ctx, r.AgentID, err)
		}
	}
}

// suggestInputRoute is POST /api/suggest-input: an agent suggests input for its own harness only (S-422). The agent is
// the one its own token names, never a body field, and never one a peer forwards.
func (s *Server) suggestInputRoute(r *http.Request, c auth.Resolved) (any, error) {
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	if c.Kind == auth.OpenCode {
		return nil, Errorf(http.StatusForbidden, "suggest_input types into a Claude Code input box only; stam can't type into an OpenCode agent's input this way. Use request_permission instead")
	}
	if w.local || c.Kind != auth.Agent || c.Agent == "" {
		return nil, Errorf(http.StatusForbidden, "only an agent suggests input, for itself, with its own token")
	}
	ctx := context.WithoutCancel(r.Context())
	a, err := s.db.GetAgent(ctx, c.Agent)
	if errors.Is(err, db.ErrNotFound) {
		return nil, Errorf(http.StatusConflict, "%s runs on another machine; suggest input through its own daemon", c.Agent)
	} else if err != nil {
		return nil, err
	}
	if a.Harness != "claude" {
		return nil, Errorf(http.StatusForbidden, "suggest_input types into a Claude Code input box only; %s runs %s, whose input stam can't type into this way. Use request_permission instead", a.Name, a.Harness)
	}
	out, err := s.suggestInput(ctx, a, get(w.body, "text"), textOf(w.body, "reason"))
	if err != nil {
		var he *Error
		if errors.As(err, &he) {
			return nil, err
		}
		return nil, Errorf(http.StatusBadRequest, "%s", err.Error())
	}
	return out, nil
}

// approveInputRoute is the answer route's approval of a suggestion: only the human as trustedHuman proves it, on the
// daemon that has the request; never a token, `by`, or an answer a peer forwarded. Its denial is answered like any
// request's.
func (s *Server) approveInputRoute(ctx context.Context, w write, c auth.Resolved, id string) (any, error) {
	if w.local {
		return nil, &Error{Status: http.StatusConflict, Message: fmt.Sprintf("approve %s from stam's web UI on %s; an approval forwarded from another machine is never accepted", id, s.cfg.Machine), Extra: map[string]any{"machine": s.cfg.Machine}}
	}
	if !c.Owned {
		return nil, Errorf(http.StatusForbidden, "only the human approves suggested input, from stam's web UI on %s, %s", s.cfg.Machine, s.humanWays("stam"))
	}
	out, err := s.approveInput(ctx, id, get(w.body, "text_sha256"))
	var ir *inputRefused
	if errors.As(err, &ir) {
		return nil, Errorf(http.StatusConflict, "%s", ir.msg)
	}
	if err != nil {
		return nil, err
	}
	return out, nil
}
