package server

import (
	"context"
	"fmt"
	"log/slog"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"stam/internal/config"
	"stam/internal/jsfmt"
	"stam/internal/process"
)

// The runner's live actions (src/process-run.ts scriptRunner and humanAsker, S-949, S-950), under process.run `on`: a script node
// the runner enters runs its script, and a human node whose answer leaves it opens the ask. Agent nodes (S-1038) are not ported:
// entering one answers 501 before the write (stageEntryRefusal).

// liveRunner is the state of the live actions.
type liveRunner struct {
	mu sync.Mutex
	// running is the id#script of each script run in flight; opening the ids whose ask is being opened.
	running, opening map[string]bool
	// scripts counts the script runs in flight: they may take minutes and are detached, so shutdown does not wait for them.
	// The short actions (an ask, a stage move) are counted in Server.bg instead. WaitProcessRuns waits for both.
	scripts sync.WaitGroup
	// spawn starts a script and waits for it; nil runs it detached with node (a test sets it).
	spawn func(script string, args []string, checkout string) (process.ScriptResult, error)
	// inFlight counts the process spawns in flight per machine ("" for this one) and spawnAgent starts one (nil: not ported). Both
	// belong to the agent runner (process_agent.go); mu guards inFlight.
	inFlight   map[string]int
	spawnAgent func(ctx context.Context, in spawnInput) (string, error)
	// claimStep is a test hook at the two steps of a spawn's claim: "before" the lock and "inside" the transaction, after its checks
	// and before the claim is written.
	claimStep func(id, step string)
}

// WaitProcessRuns blocks until every live action started so far has ended.
func (s *Server) WaitProcessRuns() {
	s.bg.Wait()
	s.runner.scripts.Wait()
}

// WaitBackground blocks until the background goroutines that use the database have ended: the caller ends their context first.
func (s *Server) WaitBackground() {
	s.bgMu.Lock()
	s.bgWaited = true
	s.bgMu.Unlock()
	s.bg.Wait()
}

// goBg runs fn in a goroutine counted in bg, unless shutdown is already waiting: it reports whether fn started.
func (s *Server) goBg(fn func()) bool {
	s.bgMu.Lock()
	if s.bgWaited {
		s.bgMu.Unlock()
		return false
	}
	s.bg.Add(1)
	s.bgMu.Unlock()
	go func() {
		defer s.bg.Done()
		fn()
	}()
	return true
}

// deployCheckout is src/workspace.ts deployCheckout: the checkout a script runs in.
func (s *Server) deployCheckout() string {
	root := ""
	if s.tpl != nil {
		root = s.tpl.Root
	}
	return config.DeployCheckout(s.cfg.DeployRepo, root)
}

// onItsaHome is whether this daemon is the ITSA home, where gh runs.
func (s *Server) onItsaHome() bool {
	home := s.settings.Get().Itsa.Home
	return home == "" || home == s.cfg.Machine
}

func (s *Server) spawnScript(script string, args []string, checkout string) (process.ScriptResult, error) {
	if s.runner.spawn != nil {
		return s.runner.spawn(script, args, checkout)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		return process.ScriptResult{Code: -1}, err
	}
	return process.RunDetached(process.Detached{Node: node, Script: script, Args: args, Cwd: checkout, LogDir: filepath.Join(s.cfg.Home, "process-run")})
}

// goLive runs fn off the caller's goroutine, counted in bg; goScript is the same for a script run.
func (s *Server) goLive(fn func()) {
	if !s.goBg(fn) {
		logRun("process-run: not started: the daemon is stopping")
	}
}

func (s *Server) goScript(fn func()) { s.goIn(&s.runner.scripts, fn) }

func (s *Server) goIn(wg *sync.WaitGroup, fn func()) {
	wg.Add(1)
	go func() {
		defer wg.Done()
		fn()
	}()
}

func logRun(line string) { slog.Info(line) }

// runScript is src/process-run.ts scriptRunner: `node SCRIPT ARGS` for the ITSA, off the request. One run per ITSA and script at a
// time: a second entry while one runs is ignored. Exit 0 does nothing more (merge-pr.mjs marks the stage, and the deploy watcher
// moves it on). A real refusal sends the stage back to `code` and mails the ITSA's owner the last lines of output, and nobody
// else. A run that ended any other way leaves the stage and tells the owner it had no verdict.
func (s *Server) runScript(ctx context.Context, id string, p *process.Def, a process.EntryAction) {
	ctx = context.WithoutCancel(ctx)
	key := id + "#" + a.Script
	s.goScript(func() {
		checkout := s.deployCheckout()
		full := process.ScriptPath(checkout, a.Script)
		switch {
		case full == "":
			logRun(fmt.Sprintf("process-run: %s: refused %s: only scripts under %s/scripts/ run", id, a.Script, checkout))
			return
		case !s.onItsaHome():
			logRun(fmt.Sprintf("process-run: %s: %s needs gh and runs only on the ITSA home; skipped here", id, a.Script))
			return
		case len(a.Args) == 0:
			logRun(fmt.Sprintf("process-run: %s: %s skipped: the ITSA has no pull request link", id, a.Script))
			return
		}
		s.runner.mu.Lock()
		if s.runner.running[key] {
			s.runner.mu.Unlock()
			logRun(fmt.Sprintf("process-run: %s: %s is already running; this entry is ignored", id, a.Script))
			return
		}
		if s.runner.running == nil {
			s.runner.running = map[string]bool{}
		}
		s.runner.running[key] = true
		s.runner.mu.Unlock()
		defer func() {
			s.runner.mu.Lock()
			delete(s.runner.running, key)
			s.runner.mu.Unlock()
		}()

		r, err := s.spawnScript(full, a.Args, checkout)
		if err != nil {
			logRun(fmt.Sprintf("process-run: %s: %s failed to run: %v", id, a.Script, err))
			return
		}
		cmd := a.Script + " " + strings.Join(a.Args, " ")
		if r.Code == 0 && r.Signal == "" {
			logRun(fmt.Sprintf("process-run: %s: %s finished", id, cmd))
			return
		}
		refused := r.IsRefusal()
		verdict := "ended without a verdict"
		if refused {
			verdict = "refused"
		}
		end := "exit " + exitText(r)
		logRun(fmt.Sprintf("process-run: %s: %s %s (%s)", id, cmd, verdict, end))
		// TS words the mail as if the stage always went back to code; here it says so only when it did.
		moved, notMoved := false, "the process has no code node"
		if refused && p.Nodes["code"] != nil {
			f := jsfmt.Value{Kind: jsfmt.Object}
			fields := jsfmt.Value{Kind: jsfmt.Object}
			fields.Set("stage", jsfmt.StringValue("code"))
			f.Set("fields", fields)
			if _, err := s.setItsa(ctx, id, f, process.RunnerActor); err != nil {
				logRun(fmt.Sprintf("process-run: %s: moving the stage back to code failed: %v", id, err))
				notMoved = err.Error()
			} else {
				moved = true
			}
		}
		x, found, err := s.db.FindItsa(ctx, id)
		if err != nil || !found || x.Text("owner") == "" {
			return
		}
		what := "merge run ended without a verdict: " + cmd
		lead := fmt.Sprintf("The process %s ran `%s` and it ended (%s) without a verdict. The stage is unchanged.", p.ID, cmd, end)
		if refused && moved {
			what = a.Script + " refused PR " + strings.Join(a.Args, " ") + ": stage is back to code"
			lead = fmt.Sprintf("The process %s ran `%s` and it exited %s. The stage is back to `code`.", p.ID, cmd, exitText(r))
		} else if refused {
			what = a.Script + " refused PR " + strings.Join(a.Args, " ") + ": stage not moved"
			lead = fmt.Sprintf("The process %s ran `%s` and it exited %s. The stage could not be moved back to `code` (%s); it is unchanged.", p.ID, cmd, exitText(r), notMoved)
		}
		if !s.sendFromStam(ctx, []string{x.Text("owner")}, what, lead+"\n\n```\n"+process.Tail(r.Output, 20)+"\n```") {
			logRun(fmt.Sprintf("process-run: %s: mailing the owner failed", id))
		}
	})
}

// exitText is how TS prints a result's exit: the code, or "null, SIGNAL" for a run a signal ended.
func exitText(r process.ScriptResult) string {
	if r.Signal != "" {
		return "null, " + r.Signal
	}
	return fmt.Sprint(r.Code)
}

// openAsk is src/process-run.ts humanAsker: it opens a human node's ask through the existing flow, the comment first, then the move
// to the human status for `ask`, which mails the human once. An ITSA already waiting on the human is left alone. A failed comment
// stops it; a failed move is logged.
func (s *Server) openAsk(ctx context.Context, id string, p *process.Def, node *process.Node, a process.EntryAction, from, actor string) {
	ctx = context.WithoutCancel(ctx)
	s.goLive(func() {
		s.runner.mu.Lock()
		if s.runner.opening[id] {
			s.runner.mu.Unlock()
			return
		}
		if s.runner.opening == nil {
			s.runner.opening = map[string]bool{}
		}
		s.runner.opening[id] = true
		s.runner.mu.Unlock()
		defer func() {
			s.runner.mu.Lock()
			delete(s.runner.opening, id)
			s.runner.mu.Unlock()
		}()

		x, found, err := s.db.FindItsa(ctx, id)
		if err != nil {
			logRun(fmt.Sprintf("process-run: %s: %v", id, err))
			return
		}
		if !found {
			return
		}
		if status := x.Text("status"); s.isHumanStatus(status) {
			logRun(fmt.Sprintf("process-run: %s: already waits on the human (%s); the ask is not opened again", id, status))
			return
		}
		may, err := s.mayAsk(ctx, actor)
		if err != nil {
			logRun(fmt.Sprintf("process-run: %s: %v", id, err))
			return
		}
		if !may {
			who := actor
			if who == "" {
				who = "someone"
			}
			logRun(fmt.Sprintf("process-run: %s: %s moved it to `%s` but may not mail the human, so the ask is not opened; its parent decides", id, who, node.ID))
			return
		}
		where := ""
		if from != "" {
			where = " The ITSA moved from `" + from + "` to `" + node.ID + "`."
		}
		label := node.Label
		if label == "" {
			label = node.ID
		}
		body := fmt.Sprintf("Process %s: %s.%s It waits on you (%s); answer, approve or request changes on this ITSA.", p.ID, label, where, a.Ask)
		if quoted := s.latestComment(ctx, x); quoted != "" {
			var lines []string
			for _, l := range strings.Split(strings.TrimSpace(quoted), "\n") {
				lines = append(lines, "> "+l)
			}
			body += "\n\nThe latest comment:\n\n" + strings.Join(lines, "\n")
		}
		in := jsfmt.Value{Kind: jsfmt.Object}
		in.Set("by", jsfmt.StringValue(process.RunnerActor))
		in.Set("body", jsfmt.StringValue(body))
		in.Set("agents_only", jsfmt.Value{Kind: jsfmt.Bool, Bool: true})
		if _, err := s.post(ctx, id, in, false); err != nil {
			logRun(fmt.Sprintf("process-run: %s: the ask comment failed, so the status stays: %v", id, err))
			return
		}
		f := jsfmt.Value{Kind: jsfmt.Object}
		f.Set("status", jsfmt.StringValue(a.Status))
		if _, err := s.setItsa(ctx, id, f, process.RunnerActor); err != nil {
			logRun(fmt.Sprintf("process-run: %s: moving to %s failed: %v", id, a.Status, err))
		}
	})
}

// mayAsk is whether actor, who moved the ITSA into the node, may have it ask the human: the runner itself, a system sender, the
// human, or an agent whose model may mail the human (the same rule `itsa.set` applies to a move into a human status).
func (s *Server) mayAsk(ctx context.Context, actor string) (bool, error) {
	if actor == "" || strings.HasPrefix(actor, "system:") || actor == humanBox {
		return true, nil
	}
	_, _, blocked, err := s.humanMailBlock(ctx, actor)
	return !blocked, err
}

// latestComment is the ITSA's latest comment or update by anyone but a system sender, so the human sees the real question, or "".
func (s *Server) latestComment(ctx context.Context, x jsfmt.Value) string {
	thread := x.Text("thread_id")
	if thread == "" {
		return ""
	}
	mails, err := s.db.ThreadMail(ctx, thread, "")
	if err != nil {
		return ""
	}
	for i := len(mails) - 1; i >= 0; i-- {
		m := mails[i]
		if k := m.Text("kind"); (k == "comment" || k == "update") && !strings.HasPrefix(m.Text("from_id"), "system:") {
			return m.Text("body")
		}
	}
	return ""
}

// moveStage is the answer listener's live move (src/process-run.ts answerListener): the stage follows the human node's
// `answered` edge, as the runner.
func (s *Server) moveStage(ctx context.Context, id, stage string) error {
	f := jsfmt.Value{Kind: jsfmt.Object}
	fields := jsfmt.Value{Kind: jsfmt.Object}
	fields.Set("stage", jsfmt.StringValue(stage))
	f.Set("fields", fields)
	_, err := s.setItsa(ctx, id, f, process.RunnerActor)
	return err
}
