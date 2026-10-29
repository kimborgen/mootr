package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"stam/internal/auth"
	"stam/internal/config"
	"stam/internal/db"
)

// queueFixture is a fixture with developerCap 1, every seeded agent shut down, and boss (aboss) a developer that holds
// the one slot. Launches are recorded, not run (q.launch), and notices land in told.
type queueFixture struct {
	*fixture
	mu       sync.Mutex
	launched []string
	fail     map[string]error
	told     []string
}

const holderWorkspace = `{"spec":{"kind":"worktree"},"cwd":"/w/x","worktree":{"repo":"/w/r","path":"/w/x","branch":"stam/x"}}`

func newQueueFixture(t *testing.T) *queueFixture {
	f := &queueFixture{fixture: newFixture(t, nil), fail: map[string]error{}}
	must(t, os.WriteFile(filepath.Join(f.home, "settings.json"), []byte(`{"developerCap":1}`), 0o600))
	f.sql("UPDATE agents SET lifecycle = 'shut_down'")
	f.sql("UPDATE agents SET lifecycle = 'active', activity = 'working', workspace = ? WHERE id = 'aboss'", holderWorkspace)
	f.srv.devSlots.q.launch = func(_ context.Context, w *slotWaiter) error {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.launched = append(f.launched, w.Name)
		return f.fail[w.Name]
	}
	f.srv.noticeHook = func(agentID, text string) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.told = append(f.told, agentID+": "+text)
	}
	return f
}

// queue puts a waiter for name from by straight into the queue, as queueSpawnLocked does.
func (f *queueFixture) queue(name, by, urgent string) {
	f.t.Helper()
	slots := &f.srv.devSlots
	slots.mu.Lock()
	defer slots.mu.Unlock()
	body := `{"name":"` + name + `","type":"developer","by":"` + by + `"}`
	slots.q.enqueue(&slotWaiter{Name: name, Body: json.RawMessage(body), By: by, Urgent: urgent, At: nowMs()})
	must(f.t, f.srv.saveQueueLocked(slots.q.waiting))
}

func (f *queueFixture) waitingNames() []string {
	slots := &f.srv.devSlots
	slots.mu.Lock()
	defer slots.mu.Unlock()
	var out []string
	for _, w := range slots.q.waiting {
		out = append(out, w.Name)
	}
	return out
}

func (f *queueFixture) launches() []string {
	f.srv.bg.Wait()
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.launched)
}

// savedNames is the saved file's waiters, in order.
func (f *queueFixture) savedNames() []string {
	f.t.Helper()
	b, err := os.ReadFile(filepath.Join(f.home, "slot-queue.json"))
	must(f.t, err)
	var ws []slotWaiter
	must(f.t, json.Unmarshal(b, &ws))
	var out []string
	for _, w := range ws {
		out = append(out, w.Name)
	}
	return out
}

// toldEventually waits for a notice that holds want.
func (f *queueFixture) toldEventually(want string) {
	f.t.Helper()
	eventually(f.t, "the notice "+want, func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		return strings.Contains(strings.Join(f.told, "\n"), want)
	})
}

func (f *queueFixture) freeSlot() {
	f.sql("UPDATE agents SET lifecycle = 'shut_down' WHERE id = 'aboss'")
}

// spinUntilWaiting waits until n callers are blocked on devSlots' lock.
func spinUntilWaiting(t *testing.T, l *fifoLock, n int) {
	t.Helper()
	for end := time.Now().Add(10 * time.Second); l.waiting() != n; time.Sleep(time.Millisecond) {
		if time.Now().After(end) {
			t.Fatalf("%d callers blocked on the slot lock, want %d", l.waiting(), n)
		}
	}
}

// TestSlotQueueOrder: urgent waiters go after the last urgent one and ahead of the normal ones, first come first served
// within each class; an incident whose mark is gone drops back to its arrival place among the normal ones.
func TestSlotQueueOrder(t *testing.T) {
	f := newQueueFixture(t)
	f.queue("n1", "achild", "")
	f.queue("u1", "achild", "red-main")
	f.queue("n2", "achild", "")
	f.queue("i1", "achild", "incident")
	f.queue("u2", "achild", "approved-pr")
	if got := strings.Join(f.waitingNames(), " "); got != "u1 i1 u2 n1 n2" {
		t.Fatalf("the order: %s", got)
	}
	// i1 names no ITSA, so the pump finds no mark: it waits as a normal spawn, after n1 and n2 (it came after both).
	f.srv.pumpSlotQueue(context.Background())
	if got := strings.Join(f.waitingNames(), " "); got != "u1 u2 n1 n2 i1" {
		t.Errorf("after the demotion: %s", got)
	}
	if got := strings.Join(f.savedNames(), " "); got != "u1 u2 n1 n2 i1" {
		t.Errorf("the saved order: %s", got)
	}
	if n := len(f.launches()); n != 0 {
		t.Errorf("%d launches with the slot held", n)
	}
}

// TestSlotQueueCountInterleaved: the cap's count and the slot's reservation are one step under the lock. A spawn at
// cap-1 is held under the lock after its count; a second spawn is observed blocked on that lock (its waiting count),
// not only entered; once the first reserves the last slot, the second counts it and is queued, never a second holder.
func TestSlotQueueCountInterleaved(t *testing.T) {
	f, repo := worktreeFixture(t)
	must(t, os.WriteFile(filepath.Join(f.home, "settings.json"), []byte(`{"developerCap":2}`), 0o600))
	if rec := f.spawnIn(repo, `"name":"h1","type":"developer"`); rec.Code != 200 {
		t.Fatalf("the holder: %d %s", rec.Code, rec.Body)
	}
	slots := &f.srv.devSlots
	held, release := make(chan struct{}), make(chan struct{})
	slots.inCount = func(name string) {
		if name == "a" {
			close(held)
			<-release
		}
	}
	first, second := make(chan *httptest.ResponseRecorder), make(chan *httptest.ResponseRecorder)
	go func() { first <- f.spawnIn(repo, `"name":"a","type":"developer"`) }()
	<-held
	go func() { second <- f.spawnIn(repo, `"name":"b","type":"developer"`) }()
	spinUntilWaiting(t, &slots.mu, 1)
	close(release)
	a, b := <-first, <-second
	if a.Code != 200 || strings.Contains(a.Body.String(), `"queued":true`) {
		t.Errorf("a, which counted first: %d %s", a.Code, a.Body)
	}
	if b.Code != 200 || !strings.Contains(b.Body.String(), `"queued":true,"name":"b","place":1`) {
		t.Errorf("b, blocked behind a's count: %d %s", b.Code, b.Body)
	}
	if n := f.count("SELECT count(*) FROM agents WHERE name IN ('h1', 'a', 'b')"); n != 2 {
		t.Errorf("%d developers for a cap of 2", n)
	}
}

// TestSlotQueueGrantRacesCancel: a grant and a cancel of the same waiter, both blocked on the lock, give exactly one
// outcome, in either order: cancelled and never launched, or launched and the cancel refused (409).
func TestSlotQueueGrantRacesCancel(t *testing.T) {
	for _, grantFirst := range []bool{true, false} {
		f := newQueueFixture(t)
		f.queue("w1", "achild", "")
		f.freeSlot()
		slots := &f.srv.devSlots
		slots.mu.Lock()
		pumped := make(chan struct{})
		var cancelErr error
		cancelled := make(chan struct{})
		grant := func() { go func() { f.srv.grantStep(context.Background()); close(pumped) }() }
		cancel := func() {
			go func() {
				_, cancelErr = f.srv.cancelQueued(context.Background(), "w1", auth.Resolved{Caller: auth.Caller{Kind: auth.Agent, Agent: "achild"}})
				close(cancelled)
			}()
		}
		if grantFirst {
			grant()
			spinUntilWaiting(t, &slots.mu, 1)
			cancel()
		} else {
			cancel()
			spinUntilWaiting(t, &slots.mu, 1)
			grant()
		}
		spinUntilWaiting(t, &slots.mu, 2)
		slots.mu.Unlock()
		<-pumped
		<-cancelled
		launched := f.launches()
		var e *Error
		switch {
		case grantFirst && (len(launched) != 1 || !errors.As(cancelErr, &e) || e.Status != 409):
			t.Errorf("grant first: launched %v, cancel %v", launched, cancelErr)
		case !grantFirst && (len(launched) != 0 || cancelErr != nil):
			t.Errorf("cancel first: launched %v, cancel %v", launched, cancelErr)
		}
		if names := f.savedNames(); len(names) != 0 {
			t.Errorf("grant first %v: the saved queue still holds %v", grantFirst, names)
		}
	}
}

// TestSlotQueueRestart: a restart keeps the saved waiters in their order, a waiter whose row exists (it launched before
// the restart) isn't queued again and its caller hears so, and each restored waiter is granted exactly once.
func TestSlotQueueRestart(t *testing.T) {
	f := newQueueFixture(t)
	f.queue("n1", "achild", "")
	f.queue("n2", "achild", "")
	f.queue("u1", "achild", "deploy-hold")
	f.queue("gone", "achild", "")
	// gone's agent row exists: its launch got that far before the restart.
	f.sql("UPDATE agents SET name = 'gone' WHERE id = 'agone'")
	srv := New(f.cfg, config.NewSettingsFile(f.home, f.cfg.Machine), f.db, f.hub, nil)
	srv.devSlots.q.host = f.srv.devSlots.q.host
	srv.devSlots.q.launch = f.srv.devSlots.q.launch
	srv.noticeHook = f.srv.noticeHook
	f.srv = srv
	srv.restoreSlotQueue(context.Background())
	if got := strings.Join(f.waitingNames(), " "); got != "u1 n1 n2" {
		t.Fatalf("restored: %s", got)
	}
	f.toldEventually("achild: Your queued spawn gone got a developer slot and started before a daemon restart")
	must(t, os.WriteFile(filepath.Join(f.home, "settings.json"), []byte(`{"developerCap":0}`), 0o600))
	f.srv.pumpSlotQueue(context.Background())
	f.srv.pumpSlotQueue(context.Background())
	// The launches run on their own goroutines, so they may finish in any order; each runs once.
	got := f.launches()
	slices.Sort(got)
	if strings.Join(got, " ") != "n1 n2 u1" {
		t.Errorf("launched: %v", got)
	}
	if names := f.savedNames(); len(names) != 0 {
		t.Errorf("the saved queue after the launches: %v", names)
	}
}

// TestSlotQueueLaunchFails: a granted waiter whose launch fails frees its slot, so the next pump grants the next
// waiter; its caller hears why.
func TestSlotQueueLaunchFails(t *testing.T) {
	f := newQueueFixture(t)
	f.queue("w1", "achild", "")
	f.queue("w2", "achild", "")
	f.fail["w1"] = errors.New("workspace: no repo")
	f.freeSlot()
	f.srv.pumpSlotQueue(context.Background())
	if got := strings.Join(f.launches(), " "); got != "w1" {
		t.Fatalf("the first pump launched %s", got)
	}
	if got := strings.Join(f.waitingNames(), " "); got != "w2" {
		t.Errorf("waiting after w1's grant: %s", got)
	}
	f.srv.pumpSlotQueue(context.Background())
	if got := strings.Join(f.launches(), " "); got != "w1 w2" {
		t.Errorf("after w1's failed launch: %s", got)
	}
	f.toldEventually("achild: Your queued spawn w1 got a developer slot but failed to start: workspace: no repo")
}

// TestSlotQueueCancelWho: only the waiter's caller, the caller's parents (parent_id and adopting parents) and the boss
// cancel; another agent is a 403 and the waiter stays; a launching waiter is a 409 and an unknown name a 404.
func TestSlotQueueCancelWho(t *testing.T) {
	f := newQueueFixture(t)
	as := func(id string) auth.Resolved { return auth.Resolved{Caller: auth.Caller{Kind: auth.Agent, Agent: id}} }
	f.queue("w1", "achild", "")
	var e *Error
	if _, err := f.srv.cancelQueued(context.Background(), "w1", as("agone")); !errors.As(err, &e) || e.Status != 403 {
		t.Errorf("a sibling's cancel: %v", err)
	}
	if got := strings.Join(f.savedNames(), " "); got != "w1" {
		t.Errorf("the refused cancel changed the saved queue: %s", got)
	}
	for i, who := range []auth.Resolved{as("aboss"), as("acodex"), as("achild"), {Caller: auth.Caller{Kind: auth.Shared}}} {
		if i > 0 {
			f.queue("w1", "achild", "")
		}
		if _, err := f.srv.cancelQueued(context.Background(), "w1", who); err != nil {
			t.Errorf("%s's cancel: %v", who.Caller.Agent, err)
		}
	}
	if _, err := f.srv.cancelQueued(context.Background(), "w1", as("achild")); !errors.As(err, &e) || e.Status != 404 {
		t.Errorf("a second cancel: %v", err)
	}
	f.srv.devSlots.mu.Lock()
	f.srv.devSlots.q.launching = map[string]*slotWaiter{"w9": {Name: "w9", By: "achild"}}
	f.srv.devSlots.mu.Unlock()
	if _, err := f.srv.cancelQueued(context.Background(), "w9", as("achild")); !errors.As(err, &e) || e.Status != 409 {
		t.Errorf("a launching waiter's cancel: %v", err)
	}
}

// TestSlotQueueDuplicate: a peer's duplicate drops only the same name from the same caller; an agent's token is refused.
func TestSlotQueueDuplicate(t *testing.T) {
	f := newQueueFixture(t)
	f.queue("w1", "achild", "")
	if rec := f.do(call{method: "POST", path: "/api/slot-queue/w1/duplicate", token: agentTok, body: `{"caller":"achild"}`}); rec.Code != 403 {
		t.Errorf("an agent's duplicate drop: %d %s", rec.Code, rec.Body)
	}
	if rec := f.do(call{method: "POST", path: "/api/slot-queue/w1/duplicate", token: sharedTok, body: `{"caller":"agone"}`}); rec.Code != 200 || rec.Body.String() != `{"dropped":false}` {
		t.Errorf("another caller's duplicate: %d %s", rec.Code, rec.Body)
	}
	if got := strings.Join(f.savedNames(), " "); got != "w1" {
		t.Errorf("another caller's duplicate dropped w1: %s", got)
	}
	if rec := f.do(call{method: "POST", path: "/api/slot-queue/w1/duplicate", token: sharedTok, body: `{"caller":"achild"}`}); rec.Code != 200 || rec.Body.String() != `{"dropped":true}` {
		t.Errorf("the same caller's duplicate: %d %s", rec.Code, rec.Body)
	}
	if names := f.savedNames(); len(names) != 0 {
		t.Errorf("the dropped duplicate is still saved: %v", names)
	}
}

// TestSlotQueueRoomGuard: a free slot on a host without room queues the spawn with the reason.
func TestSlotQueueRoomGuard(t *testing.T) {
	h := hostReading{load1: 9, freeBytes: 2 * gib}
	if got := h.roomRefusal(); got != "queued: load 9.0, 2.0 GB free" {
		t.Errorf("the reason: %q", got)
	}
	if (hostReading{load1: 1, freeBytes: 4 * gib}).roomRefusal() != "" {
		t.Error("a quiet host has no room")
	}
}

// TestSlotQueueForgottenCaller: a waiter whose caller has no row here and that no machine knows (forgotten) is dropped
// at the next pump, never launched, and the chief of staff hears so; a waiter with no caller stays.
func TestSlotQueueForgottenCaller(t *testing.T) {
	f := newQueueFixture(t)
	f.queue("w1", "agone", "")
	f.queue("w2", "", "")
	f.sql("DELETE FROM agents WHERE id = 'agone'")
	f.srv.pumpSlotQueue(context.Background())
	if got := strings.Join(f.waitingNames(), " "); got != "w2" {
		t.Errorf("waiting after the pump: %s", got)
	}
	if got := strings.Join(f.savedNames(), " "); got != "w2" {
		t.Errorf("saved after the pump: %s", got)
	}
	f.freeSlot()
	f.srv.pumpSlotQueue(context.Background())
	if got := strings.Join(f.launches(), " "); got != "w2" {
		t.Errorf("launched: %s", got)
	}
}

// archiveFixture is a worktree fixture with developerCap 1, h1 a developer holding the slot, and w1 queued behind it.
// Launches are recorded, not run.
func archiveFixture(t *testing.T) (*fixture, *[]string, *sync.Mutex) {
	f := typeSpawnFixtureTmux(t, sessionTmux(t))
	home, err := filepath.EvalSymlinks(f.home)
	must(t, err)
	repo, origin := filepath.Join(home, "repo"), filepath.Join(home, "origin.git")
	gitIn(t, home, "init", "-q", "--bare", "-b", "main", origin)
	gitIn(t, home, "init", "-q", "-b", "main", repo)
	gitIn(t, repo, "commit", "-q", "--allow-empty", "-m", "base")
	gitIn(t, repo, "remote", "add", "origin", origin)
	gitIn(t, repo, "push", "-q", "origin", "main")
	must(t, os.WriteFile(filepath.Join(f.home, "settings.json"), []byte(`{"developerCap":1}`), 0o600))
	if rec := f.spawnIn(repo, `"name":"h1","type":"developer"`); rec.Code != 200 {
		t.Fatalf("the holder: %d %s", rec.Code, rec.Body)
	}
	if rec := f.spawnIn(repo, `"name":"w1","type":"developer"`); !strings.Contains(rec.Body.String(), `"queued":true`) {
		t.Fatalf("w1: %d %s", rec.Code, rec.Body)
	}
	// Idle just now, so it holds its slot.
	f.sql("UPDATE agents SET activity = 'idle', idle_since = ? WHERE name = 'h1'", time.Now().UTC().Format("2006-01-02T15:04:05.000Z"))
	var mu sync.Mutex
	var launched []string
	f.srv.devSlots.q.launch = func(_ context.Context, w *slotWaiter) error {
		mu.Lock()
		defer mu.Unlock()
		launched = append(launched, w.Name)
		return nil
	}
	return f, &launched, &mu
}

// askArchive asks for name's archive, which waits for its final round (its harness runs).
func (f *fixture) askArchive(name, body string) {
	f.t.Helper()
	if rec := f.human("POST", "/api/agents/"+name+"/archive", body); rec.Code != 200 || !strings.Contains(rec.Body.String(), "waiting for "+name) {
		f.t.Fatalf("the archive of %s: %d %s", name, rec.Code, rec.Body)
	}
}

// TestSlotQueueArchiveHoldsSlot: a holder whose archive sits between its harness stop and its row's archived keeps its
// slot, so the waiter stays queued; once the archive has removed the worktree and finished, the slot goes to the waiter.
func TestSlotQueueArchiveHoldsSlot(t *testing.T) {
	f, launched, mu := archiveFixture(t)
	id := f.agentField("h1", "id")
	stopped, release := make(chan struct{}), make(chan struct{})
	f.srv.life.SetArchiveStopped(func(a string) {
		if a == id {
			close(stopped)
			<-release
		}
	})
	f.askArchive("h1", `{}`)
	done := make(chan struct{})
	go func() { f.srv.life.TestRunDueArchives(context.Background(), nowMs()+3_600_000); close(done) }()
	select {
	case <-stopped:
	case <-done:
		t.Fatalf("the archive ended before its harness stop: %s", f.agentField("h1", "activity_detail"))
	}
	if got := f.agentField("h1", "lifecycle"); got == "active" || got == "archived" {
		t.Fatalf("h1 mid-archive is %s; the test needs it past the harness stop", got)
	}
	f.srv.pumpSlotQueue(context.Background())
	f.srv.bg.Wait()
	mu.Lock()
	early := len(*launched)
	mu.Unlock()
	if early != 0 {
		t.Errorf("a waiter launched while h1's archive was in flight")
	}
	close(release)
	<-done
	if got := f.agentField("h1", "lifecycle"); got != "archived" {
		t.Fatalf("h1 is %s after its archive", got)
	}
	f.srv.pumpSlotQueue(context.Background())
	f.srv.bg.Wait()
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(*launched, " ") != "w1" {
		t.Errorf("launched after the archive: %v", *launched)
	}
}

// TestSlotQueueFailedArchiveHolds: an archive whose worktree cleanup fails (uncommitted changes) leaves its holder shut
// down with its worktree, and the holder keeps its slot, so the cap holds; once it is archived, the slot is granted.
func TestSlotQueueFailedArchiveHolds(t *testing.T) {
	f, launched, mu := archiveFixture(t)
	tree := filepath.Join(f.home, "worktrees", "repo-h1")
	must(t, os.WriteFile(filepath.Join(tree, "dirty.txt"), []byte("x"), 0o600))
	gitIn(t, tree, "add", "dirty.txt")
	f.askArchive("h1", `{}`)
	f.srv.life.TestRunDueArchives(context.Background(), nowMs()+3_600_000)
	if got := f.agentField("h1", "lifecycle"); got != "shut_down" {
		t.Fatalf("h1 after the failed archive is %s (%s)", got, f.agentField("h1", "activity_detail"))
	}
	f.srv.pumpSlotQueue(context.Background())
	f.srv.bg.Wait()
	mu.Lock()
	early := len(*launched)
	mu.Unlock()
	if early != 0 {
		t.Errorf("a waiter launched beside the failed archive's holder")
	}
	if rec := f.human("POST", "/api/agents/h1/archive", `{"discard":true}`); rec.Code != 200 {
		t.Fatalf("the archive with discard: %d %s", rec.Code, rec.Body)
	}
	if got := f.agentField("h1", "lifecycle"); got != "archived" {
		t.Fatalf("h1 after the discard archive is %s (%s)", got, f.agentField("h1", "activity_detail"))
	}
	f.srv.pumpSlotQueue(context.Background())
	f.srv.bg.Wait()
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(*launched, " ") != "w1" {
		t.Errorf("launched after the archive: %v", *launched)
	}
}

// TestSlotQueuePeerCaller: a waiter forwarded for an agent of a peer lives while the peer says it runs, and is dropped,
// never launched, once the peer says it is archived. Its parent there may cancel through its peer row.
func TestSlotQueuePeerCaller(t *testing.T) {
	var lifecycle atomic.Value
	lifecycle.Store("active")
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/agents/rboss" || r.URL.Path == "/api/agents/rkid" {
			name := strings.TrimPrefix(r.URL.Path, "/api/agents/")
			io.WriteString(w, `{"id":"`+name+`","name":"`+name+`","machine":"far","lifecycle":"`+lifecycle.Load().(string)+`","parents":["aboss"]}`)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(peer.Close)
	f := newQueueFixture(t)
	writeFile(t, filepath.Join(f.home, "settings.json"), `{"developerCap":1,"peers":[{"name":"far","url":"`+peer.URL+`","token":"test-peer-token"}]}`)
	f.queue("w1", "rboss", "")
	f.srv.pumpSlotQueue(context.Background())
	if got := strings.Join(f.waitingNames(), " "); got != "w1" {
		t.Fatalf("a live peer caller's waiter: %s", got)
	}
	lifecycle.Store("archived")
	// The peers are asked again after callerCheckEvery; the test forgets the last answer instead of waiting.
	f.srv.devSlots.mu.Lock()
	f.srv.devSlots.q.remote = nil
	f.srv.devSlots.mu.Unlock()
	f.srv.pumpSlotQueue(context.Background())
	if got := f.waitingNames(); len(got) != 0 {
		t.Errorf("an archived peer caller's waiter stays: %v", got)
	}
	f.freeSlot()
	f.srv.pumpSlotQueue(context.Background())
	if got := f.launches(); len(got) != 0 {
		t.Errorf("launched: %v", got)
	}
	// A peer caller's parent, as its peer row lists it, cancels; another agent can't.
	must(t, f.db.RememberPeerAgent(context.Background(), db.PeerAgentSeen{ID: "rkid", Name: "rkid", Machine: "far", Lifecycle: "active", Parents: []string{"aboss"}}))
	f.queue("w2", "rkid", "")
	as := func(id string) auth.Resolved { return auth.Resolved{Caller: auth.Caller{Kind: auth.Agent, Agent: id}} }
	var e *Error
	if _, err := f.srv.cancelQueued(context.Background(), "w2", as("agone")); !errors.As(err, &e) || e.Status != 403 {
		t.Errorf("a stranger's cancel of a peer caller's waiter: %v", err)
	}
	if _, err := f.srv.cancelQueued(context.Background(), "w2", as("aboss")); err != nil {
		t.Errorf("the peer caller's parent's cancel: %v", err)
	}
}
