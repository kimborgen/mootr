package lifecycle

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"stam/internal/db"
	"stam/internal/tmux"
)

// holdArchive makes the next archive stop once it holds the agent's transition lock, before it stops anything, and
// returns a channel closed when it got there and a release.
func (l *live) holdArchive() (at chan struct{}, release func()) {
	at, gate := make(chan struct{}), make(chan struct{})
	l.life.mu.Lock()
	l.life.acquired = func(string) {
		l.life.mu.Lock()
		l.life.acquired = nil
		l.life.mu.Unlock()
		close(at)
		<-gate
	}
	l.life.mu.Unlock()
	return at, func() { close(gate) }
}

// waitSerial returns a channel closed when the next caller waits for an agent's serial.
func (l *live) waitSerial() chan struct{} {
	waiting := make(chan struct{})
	l.life.mu.Lock()
	l.life.serialWaiting = func(string) {
		l.life.mu.Lock()
		l.life.serialWaiting = nil
		l.life.mu.Unlock()
		close(waiting)
	}
	l.life.mu.Unlock()
	return waiting
}

type archiveResult struct {
	out string
	err error
}

// TestArchiveConcurrent: two archives of one paused agent at once. The second waits for the first's serial, sees the
// agent archived, and is refused; the harness stops and the archive is recorded once.
func TestArchiveConcurrent(t *testing.T) {
	l := newLive(t)
	l.spawn("aar1")
	l.idle("aar1")
	if _, err := l.life.Pause(l.ctx, l.agent("aar1"), "human"); err != nil {
		t.Fatal(err)
	}
	at, release := l.holdArchive()
	first := make(chan archiveResult, 1)
	go func() {
		out, err := l.life.Archive(l.ctx, l.agent("aar1"), ArchiveOpts{})
		first <- archiveResult{out, err}
	}()
	<-at
	waiting := l.waitSerial()
	second := make(chan archiveResult, 1)
	go func() {
		out, err := l.life.Archive(l.ctx, l.agent("aar1"), ArchiveOpts{})
		second <- archiveResult{out, err}
	}()
	<-waiting
	select {
	case r := <-second:
		t.Fatalf("the second archive ran inside the first: %+v", r)
	default:
	}
	if a := l.agent("aar1"); a.Lifecycle != "paused" || !l.tmux.HasSession(l.ctx, "aar1") {
		t.Errorf("while the first is held: %s, session %v", a.Lifecycle, l.tmux.HasSession(l.ctx, "aar1"))
	}
	release()
	if r := <-first; r.err != nil || r.out != "done" {
		t.Fatalf("the first archive: %+v", r)
	}
	if r := <-second; r.err == nil || r.err.Error() != "n-aar1 is already archived" {
		t.Errorf("the second archive: %+v", r)
	}
	if a := l.agent("aar1"); a.Lifecycle != "archived" || l.tmux.HasSession(l.ctx, "aar1") {
		t.Errorf("after: %s, session %v", a.Lifecycle, l.tmux.HasSession(l.ctx, "aar1"))
	}
	if n := l.countEvents("aar1", "archive"); n != 1 {
		t.Errorf("%d archive events", n)
	}
}

// TestArchiveVsUnpause: an unpause that arrives while an archive runs waits for it, and is refused: it never brings
// the agent back half archived.
func TestArchiveVsUnpause(t *testing.T) {
	l := newLive(t)
	l.spawn("aar2")
	l.idle("aar2")
	if _, err := l.life.Pause(l.ctx, l.agent("aar2"), "human"); err != nil {
		t.Fatal(err)
	}
	at, release := l.holdArchive()
	archived := make(chan archiveResult, 1)
	go func() {
		out, err := l.life.Archive(l.ctx, l.agent("aar2"), ArchiveOpts{})
		archived <- archiveResult{out, err}
	}()
	<-at
	waiting := l.waitSerial()
	unpaused := make(chan archiveResult, 1)
	go func() {
		out, err := l.life.Unpause(l.ctx, l.agent("aar2"), "human", false)
		unpaused <- archiveResult{out, err}
	}()
	<-waiting
	release()
	if r := <-archived; r.err != nil {
		t.Fatal(r.err)
	}
	if r := <-unpaused; r.err == nil || r.err.Error() != "n-aar2 is archived" {
		t.Errorf("the unpause: %+v", r)
	}
	if a := l.agent("aar2"); a.Lifecycle != "archived" || l.tmux.HasSession(l.ctx, "aar2") {
		t.Errorf("after: %s", a.Lifecycle)
	}
}

// TestArchiveFinalRound: an idle agent is asked for its final round; the archive runs at its turn end.
func TestArchiveFinalRound(t *testing.T) {
	l := newLive(t)
	l.spawn("aar3")
	l.idle("aar3")
	// The route turns force into discard too (an omitted discard); the lifecycle takes them as given.
	out, err := l.life.Archive(l.ctx, l.agent("aar3"), ArchiveOpts{Force: true, Discard: true})
	if err != nil || out != "waiting for n-aar3 to finish its step" {
		t.Fatalf("archive: %q %v", out, err)
	}
	p := pendingOf(l.agent("aar3"))
	if p == nil || pstr(p, "type") != "archive" || !ptruthy(p, "force") || !ptruthy(p, "discard") || !phas(p, "at") {
		t.Fatalf("pending = %s", pendingText(l.agent("aar3")))
	}
	if !l.has("aar3", "archive:forced") {
		t.Error("no archive:forced event")
	}
	l.hook("aar3", "Stop")
	l.until("the archive at the turn end", func() bool { return l.agent("aar3").Lifecycle == "archived" })
	if l.tmux.HasSession(l.ctx, "aar3") {
		t.Error("the harness still runs")
	}
	if !l.has("aar3", "archive:round-skipped") {
		t.Error("no archive:round-skipped event")
	}
}

// TestArchiveAfterRestart: a pending archive written before a daemon restart runs in the new daemon at its deadline,
// and one with no deadline gets one first, rewritten in place: a trigger fails any write that sets a pending action
// where there was none, as a crash between a clear and its rewrite would leave it, and the archive must survive it.
func TestArchiveAfterRestart(t *testing.T) {
	l := newLive(t)
	l.spawn("aar4")
	l.set("aar4", db.Field{Col: "pending_action", Val: `{"type":"archive","force":false,"discard":false,"forceUnpushed":false,"midTurn":true}`})
	execOn(t, l, `CREATE TRIGGER no_rewrite BEFORE UPDATE OF pending_action ON agents
		WHEN OLD.pending_action IS NULL AND NEW.pending_action IS NOT NULL BEGIN SELECT RAISE(ABORT, 'crashed'); END`)
	life := New(l.ctx, l.opts)
	life.runDueArchives(l.ctx, nowMS())
	execOn(t, l, "DROP TRIGGER no_rewrite")
	p := pendingOf(l.agent("aar4"))
	at, ok := pnum(p, "at")
	if !ok || l.agent("aar4").Lifecycle != "active" {
		t.Fatalf("an archive with no deadline: %s", pendingText(l.agent("aar4")))
	}
	life.runDueArchives(l.ctx, at+1)
	if a := l.agent("aar4"); a.Lifecycle != "archived" || l.tmux.HasSession(l.ctx, "aar4") {
		t.Errorf("after the deadline: %s", a.Lifecycle)
	}
	if !l.has("aar4", "archive:final-round-timeout") {
		t.Error("no archive:final-round-timeout event")
	}
}

// gitRun runs git in dir.
func gitRun(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// worktreeAgent makes a repo with an origin, a worktree on branch for the agent, and a commit there only; it returns
// the worktree's path.
func (l *live) worktreeAgent(id, branch string) string {
	l.t.Helper()
	origin, repo, wt := filepath.Join(l.base, "origin-"+id), filepath.Join(l.base, "repo-"+id), filepath.Join(l.base, "wt-"+id)
	gitRun(l.t, l.base, "init", "-q", "--bare", "-b", "main", origin)
	gitRun(l.t, l.base, "init", "-q", "-b", "main", repo)
	gitRun(l.t, repo, "commit", "-q", "--allow-empty", "-m", "base")
	gitRun(l.t, repo, "remote", "add", "origin", origin)
	gitRun(l.t, repo, "push", "-q", "origin", "main")
	gitRun(l.t, repo, "worktree", "add", "-q", "-b", branch, wt)
	gitRun(l.t, wt, "commit", "-q", "--allow-empty", "-m", "work")
	ws := `{"spec":{"kind":"dir","path":"` + repo + `"},"cwd":"` + wt + `","worktree":{"repo":"` + repo + `","path":"` + wt + `","branch":"` + branch + `"}}`
	l.set(id, db.Field{Col: "workspace", Val: ws})
	return wt
}

// TestArchiveWorktree: unpushed commits refuse the archive and leave the agent and its worktree as they were; once the
// branch is pushed, the archive stops the harness first, then removes the worktree and keeps the branch, which has
// commits of its own.
func TestArchiveWorktree(t *testing.T) {
	l := newLive(t)
	l.spawn("aar5")
	l.idle("aar5")
	wt := l.worktreeAgent("aar5", "stam/aar5")
	if _, err := l.life.Pause(l.ctx, l.agent("aar5"), "human"); err != nil {
		t.Fatal(err)
	}
	_, err := l.life.Archive(l.ctx, l.agent("aar5"), ArchiveOpts{})
	if err == nil || !strings.Contains(err.Error(), "can't archive n-aar5: branch stam/aar5 has 1 commit not on any remote") {
		t.Fatalf("the unpushed archive: %v", err)
	}
	if _, serr := os.Stat(wt); serr != nil || l.agent("aar5").Lifecycle != "paused" || !l.tmux.HasSession(l.ctx, "aar5") {
		t.Fatalf("a refused archive changed something: %v %s", serr, l.agent("aar5").Lifecycle)
	}
	gitRun(t, wt, "push", "-q", "origin", "stam/aar5")
	out, err := l.life.Archive(l.ctx, l.agent("aar5"), ArchiveOpts{})
	if err != nil || out != "done" {
		t.Fatalf("archive: %q %v", out, err)
	}
	a := l.agent("aar5")
	if a.Lifecycle != "archived" || a.ActivityDetail == nil || *a.ActivityDetail != "removed worktree "+wt+"; branch stam/aar5 kept: it has commits of its own" {
		t.Errorf("after: %s %v", a.Lifecycle, a.ActivityDetail)
	}
	if _, err := os.Stat(wt); !os.IsNotExist(err) {
		t.Errorf("the worktree is still there: %v", err)
	}
	// The harness's stop is recorded before the archive's event, which carries the worktree's removal.
	evs, err := l.db.ListEvents(l.ctx, "aar5", 50, "")
	if err != nil {
		t.Fatal(err)
	}
	var types []string
	stop, archived := -1, -1
	for i, e := range evs {
		types = append(types, e.Type)
		if e.Data != nil && strings.Contains(*e.Data, `"archiving"`) && stop < 0 {
			stop = i
		}
		if e.Type == "archive" {
			archived = i
		}
	}
	if stop < 0 || archived < stop {
		t.Errorf("the harness didn't stop before the archive: %v", types)
	}
}

// TestArchiveCascade: archiving a parent archives its stopped child, asks its idle child for its final round, and
// keeps a working child under the parent's own parent.
func TestArchiveCascade(t *testing.T) {
	l := newLive(t)
	l.spawn("acp")
	l.spawn("acm", "acp")
	l.spawn("acs", "acm")
	l.spawn("aci", "acm")
	l.spawn("acw", "acm")
	l.idle("aci")
	l.set("acw", db.Field{Col: "activity", Val: "working"})
	if err := l.life.Shutdown(l.ctx, l.agent("acs")); err != nil {
		t.Fatal(err)
	}
	if _, err := l.life.Pause(l.ctx, l.agent("acm"), "human"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(10 * time.Millisecond)
	out, err := l.life.ArchiveCascade(l.ctx, l.agent("acm"), ArchiveOpts{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	want := "done; also archived idle n-acs; asked idle n-aci for their final round; left alone, now reporting to n-acp: n-acw (working)"
	if out != want {
		t.Errorf("cascade = %q\nwant %q", out, want)
	}
	if l.agent("acs").Lifecycle != "archived" || pstr(pendingOf(l.agent("aci")), "type") != "archive" {
		t.Errorf("children: %s, %s", l.agent("acs").Lifecycle, pendingText(l.agent("aci")))
	}
	parents, err := l.db.ParentsOf(l.ctx, l.agent("acw"))
	if err != nil || strings.Join(parents, ",") != "acp" {
		t.Errorf("the working child's parents = %v %v", parents, err)
	}
}

// TestArchiveHarnessGone: a pending archive whose harness died runs at once, without waiting for a turn end that
// never comes; one past its deadline is left to runDueArchives.
func TestArchiveHarnessGone(t *testing.T) {
	l := newLive(t)
	l.spawn("aar6")
	l.spawn("aar7")
	future := fmt.Sprintf(`{"type":"archive","force":false,"discard":false,"forceUnpushed":false,"at":%d,"midTurn":true}`, int64(nowMS())+600_000)
	past := `{"type":"archive","force":false,"discard":false,"forceUnpushed":false,"at":1,"midTurn":true}`
	l.set("aar6", db.Field{Col: "pending_action", Val: future})
	l.set("aar7", db.Field{Col: "pending_action", Val: past})
	for _, id := range []string{"aar6", "aar7"} {
		if err := l.tmux.KillSession(l.ctx, id); err != nil {
			t.Fatal(err)
		}
		if err := l.life.runPendingOnDead(l.ctx, l.agent(id)); err != nil {
			t.Fatal(err)
		}
	}
	if a := l.agent("aar6"); a.Lifecycle != "archived" || a.PendingAction != nil {
		t.Errorf("the gone harness's archive: %s %s", a.Lifecycle, pendingText(a))
	}
	if evs := l.events("aar6", "archive:round-skipped"); len(evs) != 1 || !strings.Contains(evs[0], "harness_gone") {
		t.Errorf("round-skipped = %v", evs)
	}
	if a := l.agent("aar7"); a.Lifecycle == "archived" || pendingText(a) != past {
		t.Errorf("an archive past its deadline ran on the dead-harness path: %s %s", a.Lifecycle, pendingText(a))
	}
}

// TestArchiveRetry: a stop that can't be confirmed (the session came back) is put back with a backing-off deadline,
// then archives on a later try; after the last try it is given up and the reason stays on the agent.
func TestArchiveRetry(t *testing.T) {
	l := newLive(t)
	l.spawn("aar8")
	revive := func(id string) {
		if err := l.tmux.NewSession(l.ctx, id, l.work, tmux.Env{}, []string{"sleep", "60"}); err != nil {
			t.Error(err)
		}
	}
	l.life.archiveStopped = revive
	l.set("aar8", db.Field{Col: "pending_action", Val: `{"type":"archive","force":false,"discard":false,"forceUnpushed":false,"at":1,"midTurn":false}`})
	retry := func(want int, after float64) float64 {
		t.Helper()
		before := nowMS()
		p := pendingOf(l.agent("aar8"))
		at, _ := pnum(p, "at")
		l.life.runDueArchives(l.ctx, at+1)
		p = pendingOf(l.agent("aar8"))
		tries, _ := pnum(p, "tries")
		next, _ := pnum(p, "at")
		if p == nil || int(tries) != want || next < before+after || next > nowMS()+after {
			t.Fatalf("after try %d: %s", want, pendingText(l.agent("aar8")))
		}
		return next
	}
	retry(1, 30_000)
	retry(2, 60_000)
	l.life.archiveStopped = nil
	at, _ := pnum(pendingOf(l.agent("aar8")), "at")
	l.life.runDueArchives(l.ctx, at+1)
	if a := l.agent("aar8"); a.Lifecycle != "archived" {
		t.Fatalf("the third try: %s %s", a.Lifecycle, pendingText(a))
	}
	if n := l.countEvents("aar8", "archive:failed"); n != 2 {
		t.Errorf("%d archive:failed events", n)
	}

	l.spawn("aar9")
	l.life.archiveStopped = revive
	l.set("aar9", db.Field{Col: "pending_action", Val: `{"type":"archive","force":false,"discard":false,"forceUnpushed":false,"at":1,"midTurn":false,"tries":5}`})
	l.life.runDueArchives(l.ctx, nowMS())
	l.life.archiveStopped = nil
	a := l.agent("aar9")
	if a.PendingAction != nil || a.Lifecycle == "archived" || a.ActivityDetail == nil || !strings.HasPrefix(*a.ActivityDetail, "archive failed: can't archive n-aar9: it was started again while archiving") {
		t.Errorf("after the last try: %s %s %v", a.Lifecycle, pendingText(a), a.ActivityDetail)
	}
	if err := l.tmux.KillSession(l.ctx, "aar9"); err != nil {
		t.Fatal(err)
	}
}

// TestArchiveDirty: a worktree with uncommitted changes refuses an archive without discard, after the harness stopped,
// and keeps the worktree and the agent unarchived; with discard it archives and the worktree goes.
func TestArchiveDirty(t *testing.T) {
	l := newLive(t)
	l.spawn("aar10")
	wt := l.worktreeAgent("aar10", "stam/aar10")
	gitRun(t, wt, "push", "-q", "origin", "stam/aar10")
	if err := os.WriteFile(filepath.Join(wt, "notes.txt"), []byte("wip"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := l.life.Pause(l.ctx, l.agent("aar10"), "human"); err != nil {
		t.Fatal(err)
	}
	_, err := l.life.Archive(l.ctx, l.agent("aar10"), ArchiveOpts{})
	if err == nil || !strings.Contains(err.Error(), "contains modified or untracked files") || !strings.HasSuffix(err.Error(), "Commit or discard its changes (archive with discard, or force).") {
		t.Fatalf("the dirty archive: %v", err)
	}
	if _, serr := os.Stat(filepath.Join(wt, "notes.txt")); serr != nil || l.agent("aar10").Lifecycle == "archived" {
		t.Fatalf("a refused archive removed something: %v %s", serr, l.agent("aar10").Lifecycle)
	}
	if out, err := l.life.Archive(l.ctx, l.agent("aar10"), ArchiveOpts{Discard: true}); err != nil || out != "done" {
		t.Fatalf("archive with discard: %q %v", out, err)
	}
	if _, err := os.Stat(wt); !os.IsNotExist(err) || l.agent("aar10").Lifecycle != "archived" {
		t.Errorf("after discard: %v %s", err, l.agent("aar10").Lifecycle)
	}
}

// TestArchiveWorktreeAfterStop: the worktree goes only once the harness is gone. A session started again while the
// archive stopped it refuses the archive, and the worktree and its files stay; a failed removal is reported on the agent.
func TestArchiveWorktreeAfterStop(t *testing.T) {
	l := newLive(t)
	l.spawn("aar11")
	wt := l.worktreeAgent("aar11", "stam/aar11")
	gitRun(t, wt, "push", "-q", "origin", "stam/aar11")
	if _, err := l.life.Pause(l.ctx, l.agent("aar11"), "human"); err != nil {
		t.Fatal(err)
	}
	l.life.archiveStopped = func(id string) {
		if _, err := os.Stat(wt); err != nil {
			t.Errorf("the worktree went before the harness stopped: %v", err)
		}
		if err := l.tmux.NewSession(l.ctx, id, l.work, tmux.Env{}, []string{"sleep", "60"}); err != nil {
			t.Error(err)
		}
	}
	_, err := l.life.Archive(l.ctx, l.agent("aar11"), ArchiveOpts{Discard: true})
	l.life.archiveStopped = nil
	if err == nil || !strings.Contains(err.Error(), "it was started again while archiving") {
		t.Fatalf("the archive of a revived session: %v", err)
	}
	if _, serr := os.Stat(wt); serr != nil || l.agent("aar11").Lifecycle == "archived" {
		t.Fatalf("the worktree went while a session ran: %v %s", serr, l.agent("aar11").Lifecycle)
	}
	if err := l.tmux.KillSession(l.ctx, "aar11"); err != nil {
		t.Fatal(err)
	}
	must(t, os.WriteFile(filepath.Join(wt, "notes.txt"), []byte("wip"), 0o600))
	if _, err := l.life.Archive(l.ctx, l.agent("aar11"), ArchiveOpts{}); err == nil {
		t.Fatal("a failed removal archived")
	}
	if a := l.agent("aar11"); a.Lifecycle == "archived" || a.ActivityDetail == nil || !strings.Contains(*a.ActivityDetail, "archive failed: ") || !strings.Contains(*a.ActivityDetail, "contains modified or untracked files") {
		t.Errorf("the failed removal isn't on the agent: %s %v", a.Lifecycle, a.ActivityDetail)
	}
}

// TestArchiveWorktreeUninspectable: a worktree whose folder can't be inspected (a permission error, not "not found")
// is not taken for gone: the archive is refused, with force_unpushed too, and the worktree stays.
func TestArchiveWorktreeUninspectable(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads any folder")
	}
	l := newLive(t)
	l.spawn("aar12")
	wt := l.worktreeAgent("aar12", "stam/aar12")
	// The worktree moves under a folder no one may search, so a stat of it fails with EACCES.
	locked := filepath.Join(l.base, "locked")
	must(t, os.MkdirAll(locked, 0o700))
	moved := filepath.Join(locked, "wt")
	gitRun(t, wt, "worktree", "move", wt, moved)
	repo := filepath.Join(l.base, "repo-aar12")
	ws := `{"spec":{"kind":"dir","path":"` + repo + `"},"cwd":"` + moved + `","worktree":{"repo":"` + repo + `","path":"` + moved + `","branch":"stam/aar12"}}`
	l.set("aar12", db.Field{Col: "workspace", Val: ws})
	if _, err := l.life.Pause(l.ctx, l.agent("aar12"), "human"); err != nil {
		t.Fatal(err)
	}
	must(t, os.Chmod(locked, 0))
	t.Cleanup(func() { _ = os.Chmod(locked, 0o700) })
	for _, o := range []ArchiveOpts{{}, {ForceUnpushed: true, Discard: true}} {
		_, err := l.life.Archive(l.ctx, l.agent("aar12"), o)
		if err == nil || !strings.Contains(err.Error(), "couldn't inspect the worktree "+moved) {
			t.Errorf("archive %+v: %v", o, err)
		}
		if a := l.agent("aar12"); a.Lifecycle == "archived" {
			t.Fatalf("archive %+v archived an uninspectable worktree", o)
		}
	}
	must(t, os.Chmod(locked, 0o700))
	if _, err := os.Stat(filepath.Join(moved, ".git")); err != nil {
		t.Errorf("the worktree went: %v", err)
	}
}

// TestArchiveTellsEventsTheAgentIsGone (S-4317): an archive hands the event service the agent's id once, after the
// agent is archived, with no lifecycle lock held (the hook waits on deliveries, which call back into the lifecycle).
func TestArchiveTellsEventsTheAgentIsGone(t *testing.T) {
	l := newLive(t)
	l.spawn("aev1")
	l.idle("aev1")
	if _, err := l.life.Pause(l.ctx, l.agent("aev1"), "human"); err != nil {
		t.Fatal(err)
	}
	var gone []string
	l.life.SetAgentGone(func(_ context.Context, id string) {
		// Taking and releasing the lifecycle's locks here would deadlock if the archive still held one.
		l.life.mu.Lock()
		l.life.mu.Unlock()
		l.life.orgMu.Lock()
		l.life.orgMu.Unlock()
		gone = append(gone, id+" "+string(l.agent(id).Lifecycle))
	})
	if _, err := l.life.Archive(l.ctx, l.agent("aev1"), ArchiveOpts{}); err != nil {
		t.Fatal(err)
	}
	if len(gone) != 1 || gone[0] != "aev1 archived" {
		t.Errorf("the hook heard %v", gone)
	}
}

// An archive refused after the harness stopped, because a turn began meanwhile (the second turn-stop check), records
// itself as a failed archive, so the developer slot queue keeps the agent's slot while its worktree stays (S-4373).
func TestArchiveRecheckFailureRecorded(t *testing.T) {
	s := newStopLive(t)
	a := s.ocRow("ats16", "shut_down", false)
	s.life.archiveStopped = func(string) {
		s.set(func(s *stopLive) { s.stubborn = true; s.active["ses_ats16"] = true })
	}
	if _, err := s.life.Archive(s.ctx, a, ArchiveOpts{}); err == nil || !strings.Contains(err.Error(), "its session still runs") {
		t.Fatalf("archive: %v", err)
	}
	got := s.agent("ats16")
	if got.Lifecycle != "shut_down" || got.ActivityDetail == nil || !strings.HasPrefix(*got.ActivityDetail, ArchiveFailedDetail+"can't archive n-ats16: its session still runs") {
		t.Errorf("after the refused archive: %s %q", got.Lifecycle, detailOf(got))
	}
}
