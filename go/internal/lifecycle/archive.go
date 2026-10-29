package lifecycle

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"regexp"
	"strings"
	"time"

	"stam/internal/db"
	"stam/internal/jsjson"
	"stam/internal/proctree"
)

// The archive (src/lifecycle.ts archive, archiveCascade and archiveLocked, S-1043, S-1373, S-2201): every archive asks
// the agent for its final round and runs at its next turn end or at the final-round deadline; a stopped, paused or gone
// agent archives at once. The archive stops the harness, confirms it stopped, and only then cleans up its worktree; a
// refusal (unpushed commits, a dirty worktree) leaves the agent and its worktree as they were.
//
// OpenCode's turn runs in its shared server, so its archive interrupts the session there and waits until the server no
// longer runs it (stopTurn, awaitTurnStop) before anything is cleaned up; a daemon without the server can't, and refuses.
// Not ported: the Codex harness's turn stop, so a Codex agent's archive is a 501 (and a pending archive of one is left
// for the TS daemon); the removal of the agent's scratch dirs (its Claude Code /tmp dir, its stam-wt and
// stam-test clones, a reviewer's clone), which TS does after the archive as best effort; and the retro lessons cache.

// ArchiveOpts is an archive's options: discard removes uncommitted worktree changes; force doesn't wait for the
// agent's current step and implies discard (S-1043); forceUnpushed leaves a branch with unpushed commits only local.
type ArchiveOpts struct {
	Force, Discard, ForceUnpushed bool
}

// archivePorted is whether this daemon can archive the agent: its harness has no turn of its own to stop, or it is
// OpenCode and the daemon has the shared server its turn runs in.
func (l *Lifecycle) archivePorted(a db.Agent) error {
	if a.Harness == "codex" || (a.Harness == "opencode" && l.opencode == nil) {
		return ErrNotPorted{What: "archiving a " + a.Harness + " agent"}
	}
	return nil
}

// unpushedGuard is src/lifecycle.ts unpushedGuard: the refusal of an archive that would remove a worktree whose branch
// holds unpushed commits. A worktree another agent still works in stays, so it has nothing to lose yet.
func (l *Lifecycle) unpushedGuard(ctx context.Context, a db.Agent) error {
	w := workspaceOf(a.Workspace)
	if w == nil || w.Worktree == nil {
		return nil
	}
	agents, err := l.db.ListAgents(ctx)
	if err != nil {
		return err
	}
	if len(worktreeUsers(w.Worktree.Path, a.ID, agents)) > 0 {
		return nil
	}
	why, err := workspaceUnpushedRefusal(ctx, w)
	if err != nil {
		return err
	}
	if why != "" {
		return fmt.Errorf("can't archive %s: %s", a.Name, why)
	}
	return nil
}

// Archive is src/lifecycle.ts archive. It decides and acts in the agent's serial, so two archives of one agent, or an
// archive and an unpause, can't both act on the state the other is changing: the second sees the first's result.
func (l *Lifecycle) Archive(ctx context.Context, a db.Agent, o ArchiveOpts) (string, error) {
	if err := l.archivePorted(a); err != nil {
		return "", err
	}
	var out string
	err := l.serial(ctx, a.ID, func(ctx context.Context) error {
		cur, err := l.db.GetAgent(ctx, a.ID)
		if err != nil {
			return err
		}
		if cur.Lifecycle == "archived" {
			return fmt.Errorf("%s is already archived", cur.Name)
		}
		if err := l.assertNoTransition(cur); err != nil {
			return err
		}
		// Unpushed commits refuse the archive now, before the final round is asked for or anything is stopped (S-2201).
		if !o.ForceUnpushed {
			if err := l.unpushedGuard(ctx, cur); err != nil {
				return err
			}
		}
		if err := l.CancelFallbacks(ctx, cur.ID, "the agent was archived"); err != nil {
			return err
		}
		// A stopped or paused agent can't take the wrap-up: it archives at once.
		if cur.Lifecycle == "shut_down" || cur.Lifecycle == "paused" {
			l.noteRoundSkipped(ctx, cur, string(cur.Lifecycle))
			out = "done"
			return l.archiveNow(ctx, cur, o)
		}
		// A workspaced agent whose harness is gone (no live pane, and the harness answered that no turn runs) has no step
		// to wait for, unless it is still starting. A Claude Code harness has no turn without its pane; an OpenCode one
		// whose server can't be asked gets the final round, with its deadline.
		if cur.Workspace != nil && *cur.Workspace != "" && cur.Activity != "starting" {
			if alive, known := l.harnessAlive(ctx, cur); known && !alive {
				l.noteRoundSkipped(ctx, cur, "harness_gone")
				out = "done"
				return l.archiveNow(ctx, cur, o)
			}
		}
		out, err = l.askFinalRound(ctx, cur, o)
		return err
	})
	return out, err
}

// harnessRunning is src/lifecycle.ts harnessRunning: a workspaced agent's terminal is there with a live pane.
func (l *Lifecycle) harnessRunning(ctx context.Context, a db.Agent) bool {
	return a.Workspace != nil && *a.Workspace != "" && l.tmux.HasSession(ctx, a.ID) && !l.tmux.IsDead(ctx, a.ID)
}

// archivePending is the pending archive, in src/lifecycle.ts's key order.
func archivePending(o ArchiveOpts, at float64, midTurn bool) *jsjson.Object {
	return jsjson.NewObject("type", "archive", "force", o.Force, "discard", o.Discard, "forceUnpushed", o.ForceUnpushed, "at", at, "midTurn", midTurn)
}

// askFinalRound is src/lifecycle.ts askFinalRound: the wrap-up goes in and the pending archive waits for the agent's
// next turn end, at most the final-round deadline.
func (l *Lifecycle) askFinalRound(ctx context.Context, a db.Agent, o ArchiveOpts) (string, error) {
	if !running(a) {
		return "", fmt.Errorf("%s is %s", a.Name, a.Lifecycle)
	}
	at := nowMS() + l.finalRoundMS()
	pending := archivePending(o, at, !isIdle(a))
	if err := l.db.UpdateAgent(ctx, a.ID, db.Field{Col: "pending_action", Val: text(pending)}); err != nil {
		return "", err
	}
	if o.Force {
		l.event(ctx, a.ID, "archive:forced", atEvent{At: at})
	}
	if wrapUp, err := l.archiveWrapUp(); err == nil {
		l.prompt(ctx, a, wrapUp, "prompt")
	}
	l.event(ctx, a.ID, "pending", raw(pending))
	return l.waiting(a), nil
}

// optsOf is a pending archive's options.
func optsOf(p *jsjson.Object) ArchiveOpts {
	return ArchiveOpts{Force: ptruthy(p, "force"), Discard: ptruthy(p, "discard"), ForceUnpushed: ptruthy(p, "forceUnpushed")}
}

// archiveNow is src/lifecycle.ts archiveNow: the archive under the agent's transition lock and serial.
func (l *Lifecycle) archiveNow(ctx context.Context, a db.Agent, o ArchiveOpts) error {
	return l.serial(ctx, a.ID, func(ctx context.Context) error {
		release, err := l.acquire(a, "archive")
		if err != nil {
			return err
		}
		defer release()
		if l.acquired != nil {
			l.acquired(a.ID)
		}
		return l.archiveLocked(ctx, a, o)
	})
}

// ArchiveFailedDetail starts the activity_detail an archive that failed leaves on its agent: the developer slot queue
// reads it to keep that agent's slot held (S-4373).
const ArchiveFailedDetail = "archive failed: "

var pushHint = regexp.MustCompile(` is pushed|not on any remote`)

// archiveLocked is src/lifecycle.ts archiveLocked. The order is the point: the unpushed guard before anything stops; the
// harness stopped and confirmed gone before the worktree is touched; the archive's rows written in one transaction
// after the cleanup; the ITSAs unowned last.
func (l *Lifecycle) archiveLocked(ctx context.Context, a db.Agent, o ArchiveOpts) error {
	cur, err := l.db.GetAgent(ctx, a.ID)
	if err != nil {
		return err
	}
	// A second caller (the deadline sweep and the dead-harness path) that lost the race must not archive it twice.
	if cur.Lifecycle == "archived" {
		return nil
	}
	failed := func(msg string) {
		l.update(ctx, a.ID, db.Field{Col: "activity_detail", Val: ArchiveFailedDetail + msg})
	}
	if !o.ForceUnpushed {
		if err := l.unpushedGuard(ctx, cur); err != nil {
			failed(err.Error())
			return err
		}
	}
	// A launch in flight must not revive the agent once the archive is under way (S-578), nor take the interrupts below.
	gen := l.nextGen(a.ID)
	// An OpenCode turn is confirmed stopped in the server before the harness goes, so an archive refused for a session
	// that still runs leaves the agent as it was, a paused one paused.
	if err := l.awaitTurnStop(ctx, cur, gen); err != nil {
		return fmt.Errorf("can't archive %s: its session still runs (%s); archive again once it stops", a.Name, err.Error())
	}
	if l.tmux.HasSession(ctx, a.ID) {
		if gen, err = l.quitHarnessGen(ctx, cur, "archiving"); err != nil {
			return fmt.Errorf("can't archive %s: its session still runs (%s); archive again once it stops", a.Name, err.Error())
		}
	} else if err := l.killPane(ctx, a.ID, gen, false); err != nil {
		return fmt.Errorf("can't archive %s: its session still runs (%s); archive again once it stops", a.Name, err.Error())
	} else {
		// Shut down earlier, its turn may still run in the OpenCode server.
		l.stopTurn(cur, gen)
	}
	if l.archiveStopped != nil {
		l.archiveStopped(a.ID)
	}
	if l.tmux.HasSession(ctx, a.ID) {
		return fmt.Errorf("can't archive %s: it was started again while archiving", a.Name)
	}
	// And again once the harness is gone, before anything is cleaned up or released: a prompt queued in the session may
	// have begun a turn meanwhile. Under quitHarness's generation, when it ran: a launch since gives the stop up.
	if err := l.awaitTurnStop(ctx, cur, gen); err != nil {
		// The harness is stopped and the worktree kept: recorded as a failed archive, so the slot queue keeps its slot.
		err = fmt.Errorf("can't archive %s: its session still runs (%s); archive again once it stops", a.Name, err.Error())
		failed(err.Error())
		return err
	}
	agents, err := l.db.ListAgents(ctx)
	if err != nil {
		return err
	}
	others := make([]db.Agent, 0, len(agents))
	for _, b := range agents {
		if b.ID != a.ID && b.Lifecycle != "archived" {
			others = append(others, b)
		}
	}
	w := workspaceOf(cur.Workspace)
	result := "nothing to clean up"
	var sharer *db.Agent
	if w != nil && w.Worktree != nil {
		if users := worktreeUsers(w.Worktree.Path, a.ID, agents); len(users) > 0 {
			sharer = &users[0]
		} else if err := proctree.StopAndConfirm(ctx, proctree.DirProcesses(w.Worktree.Path, a.ID), 5*time.Second); err != nil {
			// What the agent left running in its worktree goes before the worktree does (S-428).
			slog.Error("archive " + a.Name + ": " + err.Error())
		}
	}
	switch {
	case sharer != nil:
		result = fmt.Sprintf("kept worktree %s: %s still uses it", w.Worktree.Path, sharer.Name)
	case w != nil:
		result, err = cleanupWorkspace(ctx, w, o.Discard, o.ForceUnpushed, branchIsBase(w, others))
		if err != nil {
			msg := err.Error()
			failed(msg)
			hint := ". Commit or discard its changes (archive with discard, or force)."
			if pushHint.MatchString(msg) {
				hint = ""
			}
			return fmt.Errorf("can't archive %s: %s%s", a.Name, msg, hint)
		}
	}
	if err := l.db.MarkArchived(ctx, cur, db.Archived{Result: result, PausedBy: withoutRest(cur), QueueUnown: l.settings.Get().Itsa.Home != l.machine}); err != nil {
		return err
	}
	if p := l.promptParts(); p != nil {
		p.ForgetLessons(cur.ID)
	}
	l.orgMu.Lock()
	unown := l.unown
	l.orgMu.Unlock()
	if unown != nil {
		if err := unown(ctx, cur, "archived"); err != nil {
			slog.Error("ITSA owners: couldn't unown " + a.Name + "'s ITSAs: " + err.Error())
		}
	}
	l.withdrawInputs(ctx, cur, "the agent was archived")
	l.ForgetAgentNotices(ctx, cur.ID)
	l.tellAgentGone(ctx, cur.ID)
	return nil
}

type archiveFailedEvent struct {
	At    any    `json:"at"`
	Tries int    `json:"tries"`
	Error string `json:"error"`
}

// archiveFailedNotice is src/lifecycle.ts archiveFailedNotice: an archive no caller waits on failed; its reason stays on
// the agent and its live parents hear it, else the chief of staff.
func (l *Lifecycle) archiveFailedNotice(ctx context.Context, a db.Agent, msg, when string) {
	l.update(ctx, a.ID, db.Field{Col: "activity_detail", Val: ArchiveFailedDetail + msg})
	life := string(a.Lifecycle)
	if now, err := l.db.GetAgent(ctx, a.ID); err == nil {
		life = string(now.Lifecycle)
	}
	text := fmt.Sprintf("[stam] The archive of %s failed %s: %s. It is still %s.", a.Name, when, msg, life)
	parents, _ := l.db.ParentsOf(ctx, a)
	var who []string
	for _, p := range parents {
		if o, err := l.db.GetAgent(ctx, p); err != nil || o.Lifecycle == "active" {
			who = append(who, p)
		}
	}
	cos := l.chiefOfStaff(ctx)
	l.goBG(func(ctx context.Context) {
		told := false
		for _, p := range who {
			told = l.tellAnywhere(ctx, p, text) == "told" || told
		}
		if cos != "" && !told {
			l.tellAnywhere(ctx, cos, text)
		}
	})
}

// tellAnywhere is src/mail.ts tellAnywhere: a notice here, or on the daemon that holds the agent, once; "told",
// "absent", "unreachable", or "" when it failed.
func (l *Lifecycle) tellAnywhere(ctx context.Context, id, text string) string {
	l.orgMu.Lock()
	tellPeer := l.tellPeer
	l.orgMu.Unlock()
	if tellPeer == nil {
		if _, err := l.db.GetAgent(ctx, id); err != nil {
			return ""
		}
		l.QueueNotice(ctx, id, text, false)
		return "told"
	}
	r, err := tellPeer(ctx, id, text, "")
	if err != nil {
		return ""
	}
	return r
}

// archiveNowPending is src/lifecycle.ts archiveNowPending (S-2201): a pending archive that runs with no caller (a turn
// end, a dead harness) records its failure as archive:failed and tells the parent. A retryable failure is returned.
func (l *Lifecycle) archiveNowPending(ctx context.Context, a db.Agent, p *jsjson.Object, when string) error {
	err := l.archiveNow(ctx, a, optsOf(p))
	if err == nil {
		return nil
	}
	msg := err.Error()
	at, _ := p.Get("at")
	tries, _ := pnum(p, "tries")
	l.event(ctx, a.ID, "archive:failed", archiveFailedEvent{At: at, Tries: int(tries), Error: msg})
	if archiveRetryable(msg) {
		return err
	}
	l.archiveFailedNotice(ctx, a, msg, when)
	// At a turn end the agent just did its wrap-up and is still running: it is told too, so it can push.
	if now, gerr := l.db.GetAgent(ctx, a.ID); when == "when its turn ended" && gerr == nil && now.Lifecycle == "active" {
		l.QueueNotice(ctx, a.ID, "[stam] Your archive was refused: "+msg, false)
	}
	return nil
}

var retryableArchive = regexp.MustCompile(`its session still runs|it was started again while archiving`)

// archiveRetryable is src/lifecycle.ts archiveRetryable: a stop that couldn't be confirmed may still finish on its own.
func archiveRetryable(msg string) bool { return retryableArchive.MatchString(msg) }

const (
	archiveRetryMS    = 30_000
	archiveRetryMaxMS = 10 * 60_000
	archiveRetryTries = 5
)

// runDueArchives is the archive half of src/lifecycle.ts runDueArchives (S-1043): a pending archive past its deadline
// runs whatever its turn does. A pending archive with no deadline gets one; a failure is recorded and the pending
// cleared, except a stop that couldn't be confirmed yet, which is put back, backing off.
func (l *Lifecycle) runDueArchives(ctx context.Context, now float64) {
	agents, err := l.db.ListPendingAgents(ctx)
	if err != nil {
		return
	}
	for _, a := range agents {
		p := pendingStop(a)
		if p == nil || pstr(p, "type") != "archive" || l.archivePorted(a) != nil {
			continue
		}
		at, ok := pnum(p, "at")
		if !phas(p, "at") {
			// Rewritten in place, only as it was listed: a pending that ran or changed since stays as it is, and a
			// failed write leaves the old one, never none.
			next := copyObject(p)
			next.Set("at", nowMS()+l.finalRoundMS())
			if _, err := l.db.ReplacePendingAction(ctx, a.ID, *a.PendingAction, text(next)); err != nil {
				slog.Error("archive " + a.Name + ": " + err.Error())
			}
			continue
		}
		if !ok || at > now {
			continue
		}
		fresh, cur, err := l.takePending(ctx, a.ID, func(_ db.Agent, cur *jsjson.Object) bool {
			curAt, ok := pnum(cur, "at")
			return pstr(cur, "type") == "archive" && ok && curAt == at
		})
		if err != nil || cur == nil || fresh.Lifecycle == "archived" {
			continue
		}
		if err := l.archiveNow(ctx, fresh, optsOf(cur)); err != nil {
			msg := err.Error()
			tries, _ := pnum(cur, "tries")
			l.event(ctx, a.ID, "archive:failed", archiveFailedEvent{At: at, Tries: int(tries), Error: msg})
			n := int(tries) + 1
			if archiveRetryable(msg) && n <= archiveRetryTries {
				after := math.Min(archiveRetryMS*math.Pow(2, float64(n-1)), archiveRetryMaxMS)
				next := copyObject(cur)
				next.Set("tries", float64(n))
				next.Set("at", nowMS()+after)
				l.update(ctx, a.ID, db.Field{Col: "pending_action", Val: text(next)})
			} else {
				// A cleanup failure needs a person, not a retry loop.
				l.archiveFailedNotice(ctx, fresh, msg, "at its final-round deadline")
			}
			continue
		}
		l.event(ctx, a.ID, "archive:final-round-timeout", atEvent{At: at})
		l.noteRoundSkipped(ctx, fresh, "deadline_no_round")
	}
}

// CascadeReport is src/lifecycle.ts CascadeReport: the children archived, asked for their final round, kept, failed,
// moved or kept standing, and the ids the cascade follows next.
type CascadeReport struct {
	Archived  []string `json:"archived"`
	Archiving []string `json:"archiving"`
	Kept      []string `json:"kept"`
	Failed    []string `json:"failed"`
	Moved     []string `json:"moved"`
	Stayed    []string `json:"stayed"`
	IDs       []string `json:"ids"`
}

func newReport() *CascadeReport {
	return &CascadeReport{Archived: []string{}, Archiving: []string{}, Kept: []string{}, Failed: []string{}, Moved: []string{}, Stayed: []string{}, IDs: []string{}}
}

// RemoteAnswer is one machine's answer to the cascade over the children it holds (POST /api/archive-children).
type RemoteAnswer struct {
	Machine string
	Report  *CascadeReport
	Error   string
}

// RemoteCascade asks the other machines to cascade over the children they hold of parents (S-1378).
type RemoteCascade func(ctx context.Context, parents, fallback []string) []RemoteAnswer

type parentsEvent struct {
	Parents []string `json:"parents"`
	By      string   `json:"by"`
	Reason  string   `json:"reason,omitempty"`
}

// ArchiveCascade is src/lifecycle.ts archiveCascade (S-1373): the agent's own archive first, so its refusals come before
// any child is touched, then each idle or stopped child the same way, here and on every peer, round by round.
func (l *Lifecycle) ArchiveCascade(ctx context.Context, a db.Agent, o ArchiveOpts, remote RemoteCascade) (string, error) {
	base, err := l.Archive(ctx, a, o)
	if err != nil {
		return "", err
	}
	parents, err := l.db.ParentsOf(ctx, a)
	if err != nil {
		return "", err
	}
	var fallback []string
	for _, p := range parents {
		if o, err := l.db.GetAgent(ctx, p); err != nil || o.Lifecycle != "archived" {
			fallback = append(fallback, p)
		}
	}
	if len(fallback) == 0 {
		if cos := l.chiefOfStaff(ctx); cos != "" && cos != a.ID {
			fallback = []string{cos}
		}
	}
	rep := newReport()
	done := map[string]bool{}
	seen := map[string]bool{a.ID: true}
	frontier := []string{a.ID}
	for round := 0; len(frontier) > 0 && round < 10; round++ {
		var ids []string
		for _, id := range frontier {
			if !done[id] {
				done[id] = true
				ids = append(ids, id)
			}
		}
		if len(ids) == 0 {
			break
		}
		from := len(rep.IDs)
		for _, id := range ids {
			if err := l.cascadeChildren(ctx, id, fallback, rep, seen); err != nil {
				return "", err
			}
		}
		next := append([]string{}, rep.IDs[from:]...)
		var answers []RemoteAnswer
		if remote != nil {
			answers = remote(ctx, ids, fallback)
		}
		for _, r := range answers {
			if r.Report == nil {
				why := r.Error
				if why == "" {
					why = "no answer"
				}
				rep.Failed = append(rep.Failed, fmt.Sprintf("children on %s (%s; it may still be running there)", r.Machine, why))
				continue
			}
			on := func(list []string) []string {
				out := make([]string, len(list))
				for i, x := range list {
					out[i] = x + " on " + r.Machine
				}
				return out
			}
			rep.Archived = append(rep.Archived, on(r.Report.Archived)...)
			rep.Archiving = append(rep.Archiving, on(r.Report.Archiving)...)
			rep.Kept = append(rep.Kept, on(r.Report.Kept)...)
			rep.Failed = append(rep.Failed, on(r.Report.Failed)...)
			rep.Moved = append(rep.Moved, on(r.Report.Moved)...)
			rep.Stayed = append(rep.Stayed, on(r.Report.Stayed)...)
			next = append(next, r.Report.IDs...)
			rep.IDs = append(rep.IDs, r.Report.IDs...)
		}
		frontier = next
	}
	var notes []string
	if len(rep.Archived) > 0 {
		notes = append(notes, "also archived idle "+strings.Join(rep.Archived, ", "))
	}
	if len(rep.Archiving) > 0 {
		notes = append(notes, "asked idle "+strings.Join(rep.Archiving, ", ")+" for their final round")
	}
	if len(rep.Kept) > 0 {
		to := l.names(ctx, fallback)
		if to == "" {
			to = "nobody"
		}
		notes = append(notes, "left alone, now reporting to "+to+": "+strings.Join(rep.Kept, ", "))
	}
	if len(rep.Moved) > 0 {
		notes = append(notes, "moved standing "+strings.Join(rep.Moved, ", "))
	}
	if len(rep.Stayed) > 0 {
		notes = append(notes, "kept standing "+strings.Join(rep.Stayed, ", ")+" unarchived")
	}
	if len(rep.Failed) > 0 {
		notes = append(notes, "couldn't archive "+strings.Join(rep.Failed, ", "))
	}
	if len(notes) == 0 {
		return base, nil
	}
	return base + "; " + strings.Join(notes, "; "), nil
}

// names is ids as agent names where this daemon has them, comma-separated.
func (l *Lifecycle) names(ctx context.Context, ids []string) string {
	out := make([]string, len(ids))
	for i, id := range ids {
		out[i] = id
		if a, err := l.db.GetAgent(ctx, id); err == nil {
			out[i] = a.Name
		}
	}
	return strings.Join(out, ", ")
}

// CascadeForPeer is src/lifecycle.ts cascadeForPeer, what a peer's POST /api/archive-children runs: the cascade over
// the children this machine holds of each parent id. A parent that is a live agent here is skipped: its own children
// were cascaded when it was archived.
func (l *Lifecycle) CascadeForPeer(ctx context.Context, parents, fallback []string) (*CascadeReport, error) {
	rep := newReport()
	seen := map[string]bool{}
	for _, p := range parents {
		seen[p] = true
	}
	for _, p := range parents {
		if here, err := l.db.GetAgent(ctx, p); err == nil && here.Lifecycle != "archived" {
			continue
		}
		if err := l.cascadeChildren(ctx, p, fallback, rep, seen); err != nil {
			return nil, err
		}
	}
	return rep, nil
}

// parentLive is src/lifecycle.ts parentLive: here and not archived, or a peer's agent last seen not archived.
func (l *Lifecycle) parentLive(ctx context.Context, id string) bool {
	if o, err := l.db.GetAgent(ctx, id); err == nil {
		return o.Lifecycle != "archived"
	}
	if life, ok, err := l.db.PeerAgentLifecycle(ctx, id); err == nil && ok {
		return life != "archived"
	}
	_, ok, _ := l.db.PeerAgentByID(ctx, id)
	return ok
}

// canControl is src/lifecycle.ts canControl (S-2452): the chief of staff and the assistant act for any agent, any other
// parent only when it is registered here.
func (l *Lifecycle) canControl(ctx context.Context, id string) bool {
	if l.chiefOfStaff(ctx) == id {
		return true
	}
	_, err := l.db.GetAgent(ctx, id)
	return err == nil
}

// cascadeChildren is src/lifecycle.ts cascadeChildren: each child of parentID here is archived the same way when it is
// idle or stopped, else kept and reparented to the fallback, so it isn't orphaned. A standing child is never archived
// with its parent.
func (l *Lifecycle) cascadeChildren(ctx context.Context, parentID string, fallback []string, rep *CascadeReport, seen map[string]bool) error {
	reparent := func(c db.Agent, rest, to []string) error {
		all := append([]string{}, rest...)
		for _, p := range to {
			if !contains(all, p) {
				all = append(all, p)
			}
		}
		if err := l.db.SetParents(ctx, c.ID, all, nil); err != nil {
			return err
		}
		now, err := l.db.GetAgent(ctx, c.ID)
		if err != nil {
			return err
		}
		ps, err := l.db.ParentsOf(ctx, now)
		if err != nil {
			return err
		}
		l.event(ctx, c.ID, "parents", parentsEvent{Parents: ps, By: parentID, Reason: "parent archived"})
		for _, p := range to {
			text := fmt.Sprintf("[stam] %s now reports to you: its parent was archived and %s is still %s.", c.Name, c.Name, c.Activity)
			if _, err := l.db.GetAgent(ctx, p); err != nil {
				// A fallback parent on another machine: its daemon queues the notice.
				l.goBG(func(ctx context.Context) { l.tellAnywhere(ctx, p, text) })
				continue
			}
			l.QueueNotice(ctx, p, text, true)
			l.observeOrg(ctx, db.ActivityChange{Kind: "sync", ID: p})
		}
		return nil
	}
	keep := func(c db.Agent, label string, rest []string) error {
		rep.Kept = append(rep.Kept, label)
		return reparent(c, rest, fallback)
	}
	kids, err := l.db.ChildrenOf(ctx, parentID)
	if err != nil {
		return err
	}
	for _, id := range kids {
		c, err := l.db.GetAgent(ctx, id)
		if errors.Is(err, db.ErrNotFound) {
			continue
		}
		if err != nil {
			return err
		}
		if c.Lifecycle == "archived" || seen[c.ID] {
			continue
		}
		seen[c.ID] = true
		parents, err := l.db.ParentsOf(ctx, c)
		if err != nil {
			return err
		}
		var rest []string
		for _, p := range parents {
			if p != parentID {
				rest = append(rest, p)
			}
		}
		// Another live parent keeps the child; only this parent is dropped.
		live := false
		for _, p := range rest {
			live = live || l.parentLive(ctx, p)
		}
		if live {
			if err := l.db.SetParents(ctx, c.ID, rest, parentsEvent{Parents: nonNil(rest), By: parentID, Reason: "parent archived"}); err != nil {
				return err
			}
			rep.Kept = append(rep.Kept, fmt.Sprintf("%s (also reports to %s)", c.Name, l.names(ctx, rest)))
			continue
		}
		// S-2452: a standing child moves to the new parents that can control it here, or stays unarchived.
		if c.Standing != 0 {
			var can []string
			for _, p := range fallback {
				if l.canControl(ctx, p) {
					can = append(can, p)
				}
			}
			if len(can) > 0 {
				if err := reparent(c, rest, can); err != nil {
					return err
				}
				rep.Moved = append(rep.Moved, c.Name+" to "+l.names(ctx, can))
			} else if len(fallback) > 0 {
				rep.Stayed = append(rep.Stayed, fmt.Sprintf("%s (%s can't control it on this machine)", c.Name, l.names(ctx, fallback)))
			} else {
				rep.Stayed = append(rep.Stayed, c.Name+" (no chief of staff or live parent to take it)")
			}
			continue
		}
		busy, err := l.db.IsBusy(ctx, c)
		if err != nil {
			return err
		}
		// A resting child with no wait is as idle as an idle one (S-1982).
		idle := c.Lifecycle == "shut_down" || (running(c) && c.Activity == "idle") || (db.RestOwned(c) && !busy)
		if !idle {
			if err := keep(c, fmt.Sprintf("%s (%s)", c.Name, c.Activity), rest); err != nil {
				return err
			}
			continue
		}
		r, err := l.Archive(ctx, c, ArchiveOpts{})
		if err != nil {
			rep.Failed = append(rep.Failed, fmt.Sprintf("%s (%s)", c.Name, err.Error()))
			if err := keep(c, fmt.Sprintf("%s (%s, archive failed)", c.Name, c.Activity), rest); err != nil {
				return err
			}
			continue
		}
		if r == "done" {
			rep.Archived = append(rep.Archived, c.Name)
		} else {
			if err := reparent(c, rest, fallback); err != nil {
				return err
			}
			rep.Archiving = append(rep.Archiving, c.Name)
		}
		rep.IDs = append(rep.IDs, c.ID)
		if err := l.cascadeChildren(ctx, c.ID, fallback, rep, seen); err != nil {
			return err
		}
	}
	return nil
}

func nonNil(list []string) []string {
	if list == nil {
		return []string{}
	}
	return list
}
