package server

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"

	"stam/internal/jsfmt"
	"stam/internal/process"
)

// The process runner (src/process-run.ts, S-946): what an ITSA's `stage` entering a node does, and the guard that keeps a stage
// move on the process's edges (src/process.ts stageGuard, S-924). The ITSAs of a kind follow the first process that applies to it.
//
// Ported: the guard, the stage a close sets (S-1398) and its one-off backfill, `process.run` off and dry-run (an entry the runner
// would act on is logged and recorded on the ITSA), and under `on` the script runner and the human asker (process_live.go).
// Not ported, so a write that would reach it answers 501 before anything is written:
//
//	agent nodes        an entry into one, in any mode but off: what it does reads the live agents of the ITSA
//	script nodes       an entry with no itsa.prOpen.github, where TS reads the repo from the checkout's origin
//
// The start and verdict listeners come from watch events, which this daemon does not read.

// stageMemo is the node each ITSA was last recorded at: an entry that repeats it is ignored (stageEntryListener's `at`).
type stageMemo struct {
	mu sync.Mutex
	at map[string]string
	// order is held from the commit of a stage change to the end of its listeners, so the entries follow commit order: two
	// concurrent stage writes never reorder `at`. The listeners' slow work (a script, an ask) runs off it.
	order sync.Mutex
	// queued counts the writes waiting for order; beforeEntry, when set, runs at the start of each entry (a test hook).
	queued      atomic.Int32
	beforeEntry func(to string)
	// beforeObservers, when set, runs after the stage listeners and before the observers of a status change (a test hook).
	beforeObservers func()
}

// waiting is how many stage writes are queued behind another one's listeners.
func (m *stageMemo) waiting() int { return int(m.queued.Load()) }

// stageEntry is one change of an ITSA's stage.
type stageEntry struct {
	id, key, kind string
	from, to      string
	actor         string
}

// strOf is a JSON value as a string when it is one, else "".
func strOf(v jsfmt.Value) string {
	if v.Kind == jsfmt.String {
		return v.Str
	}
	return ""
}

func (s *Server) runMode() string { return s.settings.Get().Process.Run }

// processOf is the first loaded process that applies to the kind; nil when none does or the folder can't be read (a process
// that throws never blocks a change).
func (s *Server) processOf(kind string) *process.Def {
	loaded, err := s.processesHere()
	if err != nil {
		return nil
	}
	return process.ProcessOf(loaded.Processes, kind)
}

// closeNodeOfKind is the stage an ITSA of the kind takes when it closes: its process's end node, or "".
func (s *Server) closeNodeOfKind(kind string) string {
	if p := s.processOf(kind); p != nil {
		return process.CloseNodeOf(p, s.isClosedStatus)
	}
	return ""
}

// stageGuard refuses a stage move the ITSA's process doesn't allow (src/process.ts stageGuard). A move to the process's end node
// is allowed from any stage once the ITSA is closed.
func (s *Server) stageGuard(kind, status, from, to string) error {
	p := s.processOf(kind)
	if p == nil {
		return nil
	}
	if s.isClosedStatus(status) && to == process.CloseNodeOf(p, s.isClosedStatus) {
		return nil
	}
	if why := process.StageRefusal(p, from, to); why != "" {
		return itsaErr("%s", why)
	}
	return nil
}

// prRepo is itsa.prOpen.github, "" when it is not set (TS then reads the origin of the prOpen checkout, which is not ported).
func (s *Server) prRepo() string { return s.settings.Get().Itsa.PrOpenGithub }

// stageEntryRefusal answers 501 when entering `to` would do what this daemon cannot, before the stage is written. Whether the
// entry acts on the node is the same test the listener makes. id is the ITSA ("" when it is not made yet).
func (s *Server) stageEntryRefusal(ctx context.Context, id, kind, to, actor string) error {
	return s.stageEntryRefusalAs(ctx, id, kind, to, actor, nil)
}

// stageEntryRefusalAs is stageEntryRefusal for a change that also sets the owner (nil: it doesn't), which the stored ITSA doesn't
// show yet.
func (s *Server) stageEntryRefusalAs(ctx context.Context, id, kind, to, actor string, owner *string) error {
	mode := s.runMode()
	if mode == "off" || to == "" {
		return nil
	}
	p := s.processOf(kind)
	if p == nil {
		return nil
	}
	n := p.Nodes[to]
	if n == nil {
		return nil
	}
	switch {
	case n.Kind == "agent":
		return s.agentRefusal(ctx, id, p, to, actor, owner)
	case n.Kind == "script" && n.Run != "" && s.prRepo() == "":
		return unported("entering the script node %s of process %s names the repo of the ITSA's pull request from the checkout's origin, which is not ported to the Go daemon yet (set itsa.prOpen.github)", to, p.ID)
	}
	return nil
}

// onStage is stageEntryListener: after a stage change commits, one log line and one record on the ITSA per entry. It never fails
// the change. What the entry does for real is returned, not started: the caller starts it once the change's own observers have run,
// so an ask the entry opens is not settled or withdrawn by the observers of the same write.
func (s *Server) onStage(ctx context.Context, c stageEntry) (start func()) {
	if h := s.stages.beforeEntry; h != nil {
		h(c.to)
	}
	s.stages.mu.Lock()
	if s.stages.at == nil {
		s.stages.at = map[string]string{}
	}
	if c.to == "" {
		delete(s.stages.at, c.id)
		s.stages.mu.Unlock()
		return nil
	}
	if s.stages.at[c.id] == c.to {
		s.stages.mu.Unlock()
		return nil
	}
	s.stages.at[c.id] = c.to
	s.stages.mu.Unlock()

	mode := s.runMode()
	if mode == "off" {
		return nil
	}
	p := s.processOf(c.kind)
	if p == nil {
		return nil
	}
	rows, err := s.db.ItsaLinks(ctx, c.id)
	if err != nil {
		slog.Error("process-run: links", "itsa", c.key, "err", err)
		return nil
	}
	links := make([]process.Link, len(rows))
	for i, l := range rows {
		links[i] = process.Link{System: l.Text("system"), URL: l.Text("url")}
	}
	text, live := process.RunText(p, c.to, c.actor, mode, links, s.prRepo(), s.agentContext(ctx, c.id))
	if text == "" {
		return nil
	}
	slog.Info("process-run (" + mode + ") " + c.id + ": " + text)
	s.noteProcessRun(ctx, c.id, text)
	node := p.Nodes[c.to]
	return func() {
		for _, a := range live {
			switch a.Do {
			case "run":
				s.runScript(ctx, c.id, p, a)
			case "ask":
				s.openAsk(ctx, c.id, p, node, a, c.from, c.actor)
			case "spawn", "mail":
				s.agentRun(ctx, c.id, p, a)
			}
		}
	}
}

// noteProcessRun is the runner's line on the ITSA's history: an event with no actor, never mail.
func (s *Server) noteProcessRun(ctx context.Context, id, text string) {
	ev := jsfmt.Value{Kind: jsfmt.Object}
	ev.Set("text", jsfmt.StringValue(text))
	if err := s.db.NoteItsa(ctx, id, "process-run", ev); err != nil {
		slog.Error("process-run: record", "itsa", id, "err", err)
	}
}

// answerEntry is a status change as the answer listener reads it.
type answerEntry struct {
	id, kind, stage string
	actor           string
	from, to        string
	owner           *string
}

// answerTarget is the node a human's answer moves the stage to: the answer is an Approve, an Answer or a Request changes by the
// human, which moves the ITSA out of a human status, and its stage is a human node with an `answered` edge. "" when it is not.
func (s *Server) answerTarget(c answerEntry) (*process.Def, string) {
	if c.actor != humanBox || c.stage == "" || !s.isHumanStatus(c.from) || s.isHumanStatus(c.to) {
		return nil, ""
	}
	p := s.processOf(c.kind)
	if p == nil {
		return nil, ""
	}
	return p, process.AnswerEdge(p, c.stage)
}

func (s *Server) isHumanStatus(name string) bool {
	st, ok := s.statusOf(name)
	return ok && st.Human
}

// answerRefusal answers 501 when the human's answer would move the stage into a node the runner cannot enter yet (process.run on):
// the answer is the human's own change, so it is refused before it is written rather than left half done.
func (s *Server) answerRefusal(ctx context.Context, c answerEntry) error {
	if s.runMode() != "on" {
		return nil
	}
	if p, to := s.answerTarget(c); p != nil && to != "" {
		return s.stageEntryRefusalAs(ctx, c.id, c.kind, to, process.RunnerActor, c.owner)
	}
	return nil
}

// onAnswer is answerListener: it records the move the human's answer makes, or would make in dry-run; under on the stage moves,
// as the runner.
func (s *Server) onAnswer(ctx context.Context, c answerEntry) (start func()) {
	mode := s.runMode()
	if mode == "off" {
		return nil
	}
	p, to := s.answerTarget(c)
	if p == nil || to == "" {
		return nil
	}
	verb := "would move"
	if mode == "on" {
		verb = "moves"
	}
	text := "process " + p.ID + ": the human answered (" + c.from + " -> " + c.to + "), so stage " + c.stage + " " + verb + " to " + to
	slog.Info("process-run (" + mode + ") " + c.id + ": " + text)
	s.noteProcessRun(ctx, c.id, text)
	if mode != "on" {
		return nil
	}
	return func() {
		ctx := context.WithoutCancel(ctx)
		s.goLive(func() {
			if err := s.moveStage(ctx, c.id, to); err != nil {
				slog.Error("process-run: moving "+c.id+" to "+to+" failed", "err", err)
			}
		})
	}
}

// StartProcessRun is what the daemon does once at start for the process runner: the closed-stage backfill, on the ITSA home only
// (the ITSAs live there and other daemons keep no copy).
func (s *Server) StartProcessRun(ctx context.Context) {
	if s.settings.Get().Itsa.Home == s.cfg.Machine {
		s.backfillClosedStages(ctx)
	}
}

// backfillClosedStages is the one-off fix of the ITSAs closed before closing set the stage (src/itsa.ts backfillClosedStage).
// Only the ITSA home runs it.
func (s *Server) backfillClosedStages(ctx context.Context) {
	loaded, err := s.processesHere()
	if err != nil {
		return
	}
	var kinds []string
	for _, p := range loaded.Processes {
		kinds = append(kinds, p.AppliesToKind...)
	}
	n, ran, err := s.db.BackfillClosedStage(ctx, s.closeNodeOfKind, kinds, s.isClosedStatus)
	switch {
	case err != nil:
		slog.Error("closed-stage-done migration failed", "err", err)
	case ran:
		slog.Info("closed-stage-done migration", "set stage done on", n)
	}
}
