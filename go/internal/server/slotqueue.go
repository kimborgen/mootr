package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	neturl "net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"stam/internal/adapters/claude"
	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
	"stam/internal/peers"
)

// The developer slot queue (src/developer-cap.ts, src/daemon.ts queueSpawn, S-2053, S-2134, S-2579): a developer spawn
// at the cap, behind other waiters, or on a host without room (S-2120) waits here instead of a 409, and starts by
// itself when a slot frees. Urgent waiters go ahead of normal ones, first come first served within each class. The
// queue is saved to STAM_HOME/slot-queue.json after every change (launching waiters first, then the waiting ones, the
// file TS writes), and read back at start, so a restart or deploy loses no accepted request.
//
// Every read and change of the queue runs under devSlots.mu, the lock the cap's count and the slot reservation take:
// a spawn's count, its enqueue, a grant, a cancel and a duplicate drop are each one step under that lock, so two
// spawns can't both take the last slot, and a waiter is granted, cancelled or dropped exactly once. The checks a
// cancel makes (who the caller is, the waiter's owner and the owner's parents) are read inside that step.

// urgentReasons is src/developer-cap.ts URGENT_REASONS.
var urgentReasons = []string{"red-main", "deploy-hold", "approved-pr", "incident"}

// slotWaiter is src/developer-cap.ts Waiter, as the saved file holds it.
type slotWaiter struct {
	Name   string          `json:"name"`
	Body   json.RawMessage `json:"body"`
	By     string          `json:"by,omitempty"`
	Urgent string          `json:"urgent,omitempty"`
	At     float64         `json:"at"`
}

// slotQueue is the queue's state, guarded by devSlots.mu: the waiters in their order, and the granted ones whose spawn
// is launching (they stay in the saved file until it ends). kick wakes the pump.
type slotQueue struct {
	waiting   []*slotWaiter
	launching map[string]*slotWaiter
	kickOnce  sync.Once
	kick      chan struct{}
	// launch, when set, replaces a granted waiter's spawn: a test fails a launch there.
	launch func(ctx context.Context, w *slotWaiter) error
	// remote is the peers' last answer about each waiter's caller with no row here (checkCallers).
	remote map[string]remoteCaller
	// host, when set, is the host reading the load guard reads: a test fixes it, whatever the machine's load.
	host func() hostReading
}

// fifoLock is devSlots' lock: handed to the callers in the order they asked, and counting the ones waiting, so a test
// sees a competing spawn, grant or cancel blocked behind the holder (waiting), not only entered.
type fifoLock struct {
	mu   sync.Mutex
	held bool
	q    []chan struct{}
}

func (l *fifoLock) Lock() {
	l.mu.Lock()
	if !l.held {
		l.held = true
		l.mu.Unlock()
		return
	}
	ch := make(chan struct{})
	l.q = append(l.q, ch)
	l.mu.Unlock()
	<-ch
}

func (l *fifoLock) Unlock() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.q) == 0 {
		l.held = false
		return
	}
	ch := l.q[0]
	l.q = l.q[1:]
	close(ch)
}

// waiting is how many callers are blocked on the lock.
func (l *fifoLock) waiting() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.q)
}

// slotQueueFile is src/daemon.ts SLOT_QUEUE_FILE.
func (s *Server) slotQueueFile() string { return filepath.Join(s.cfg.Home, "slot-queue.json") }

// saveQueueLocked is src/developer-cap.ts saveQueueFile of the launching waiters and then `waiting`: a sibling temp file
// renamed over the old one, so a crash mid-write leaves the old complete file. An error means nothing was accepted.
func (s *Server) saveQueueLocked(waiting []*slotWaiter) error {
	q := &s.devSlots.q
	all := make([]*slotWaiter, 0, len(q.launching)+len(waiting))
	for _, w := range q.launching {
		all = append(all, w)
	}
	slices.SortFunc(all, func(a, b *slotWaiter) int { return strings.Compare(a.Name, b.Name) })
	all = append(all, waiting...)
	b, err := json.Marshal(all)
	if err != nil {
		return err
	}
	file := s.slotQueueFile()
	tmp := fmt.Sprintf("%s.%d.tmp", file, os.Getpid())
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}

// saveQueueLoggedLocked saves where nobody has been told yet: a failure is logged; enqueue refuses instead.
func (s *Server) saveQueueLoggedLocked() {
	if err := s.saveQueueLocked(s.devSlots.q.waiting); err != nil {
		slog.Error("slot queue: save", "err", err)
	}
}

func (q *slotQueue) indexOf(name string) int {
	return slices.IndexFunc(q.waiting, func(w *slotWaiter) bool { return w.Name == name })
}

// enqueue is src/developer-cap.ts enqueueWaiter: w goes after the last waiter of its class or a more urgent one. Its
// place counts from 1.
func (q *slotQueue) enqueue(w *slotWaiter) int {
	at := len(q.waiting)
	if w.Urgent != "" {
		at = 0
		for i, x := range q.waiting {
			if x.Urgent != "" {
				at = i + 1
			}
		}
	}
	q.waiting = slices.Insert(q.waiting, at, w)
	return at + 1
}

func (q *slotQueue) drop(name string) {
	if i := q.indexOf(name); i >= 0 {
		q.waiting = slices.Delete(q.waiting, i, i+1)
	}
}

// without is the waiting list less w, for a save before w leaves memory.
func (q *slotQueue) without(w *slotWaiter) []*slotWaiter {
	return slices.DeleteFunc(slices.Clone(q.waiting), func(x *slotWaiter) bool { return x == w })
}

// queuedName is whether a spawn named name waits, or (unless granted, which is that spawn's own launch) launches.
func (q *slotQueue) queuedName(name string, granted bool) bool {
	if q.indexOf(name) >= 0 {
		return true
	}
	_, launching := q.launching[name]
	return launching && !granted
}

// hostReading is src/developer-cap.ts HostReading.
type hostReading struct{ load1, freeBytes float64 }

const (
	slotMaxLoad      = 5
	slotMinFreeBytes = 3 * gib
)

func (h hostReading) hasRoom() bool { return h.load1 < slotMaxLoad && h.freeBytes > slotMinFreeBytes }

// roomRefusal is src/developer-cap.ts roomRefusal: "queued: load 6.2" on a host without room, else "".
func (h hostReading) roomRefusal() string {
	if h.hasRoom() {
		return ""
	}
	var why []string
	if h.load1 >= slotMaxLoad {
		why = append(why, "load "+jsjson.ToFixed(h.load1, 1))
	}
	if h.freeBytes <= slotMinFreeBytes {
		why = append(why, jsjson.ToFixed(h.freeBytes/gib, 1)+" GB free")
	}
	return "queued: " + strings.Join(why, ", ")
}

// latest is the sampler's newest sample, or nil.
func (m *sampler) latest() *machineSample {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.buffer) == 0 {
		return nil
	}
	x := m.buffer[len(m.buffer)-1]
	return &x
}

// hostReading is src/daemon.ts hostReading with src/developer-cap.ts hostReadingFrom: the sampler's latest sample while
// it is fresh (two ticks) and valid, which STAM_PROC_DIR seeds for tests; else this machine's own /proc.
func (s *Server) hostReading() hostReading {
	if h := s.devSlots.q.host; h != nil {
		return h()
	}
	if x := s.machines.latest(); x != nil {
		age := nowMs() - x.ts
		if age >= 0 && age <= float64(2*sampleEvery.Milliseconds()) && x.ramTotal > 0 && len(x.load) > 0 {
			free := x.ramTotal - x.ramUsed
			if l := x.load[0]; !math.IsNaN(l) && !math.IsInf(l, 0) && l >= 0 && free >= 0 {
				return hostReading{load1: l, freeBytes: free}
			}
		}
	}
	return osReading()
}

// osReading is node:os loadavg()[0] and freemem() (MemAvailable). An unreadable /proc reads as room: the cap still holds.
func osReading() hostReading {
	h := hostReading{load1: 0, freeBytes: math.Inf(1)}
	if b, err := os.ReadFile("/proc/loadavg"); err == nil {
		if l := parseLoadavg(string(b)); len(l) > 0 {
			h.load1 = l[0]
		}
	}
	if b, err := os.ReadFile("/proc/meminfo"); err == nil {
		if m := parseMeminfo(string(b)); m["MemAvailable"] > 0 {
			h.freeBytes = m["MemAvailable"] * 1024
		}
	}
	return h
}

// holderInfo is src/developer-cap.ts HolderInfo.
type holderInfo struct {
	Name     string   `json:"name"`
	AgeMs    *float64 `json:"age_ms"`
	Activity *string  `json:"activity"`
}

// queuedReply is src/daemon.ts queueSpawn's reply.
type queuedReply struct {
	Queued      bool         `json:"queued"`
	Name        string       `json:"name"`
	Place       int          `json:"place"`
	QueueLength int          `json:"queue_length"`
	Urgent      *string      `json:"urgent"`
	Reason      *string      `json:"reason"`
	Holders     []string     `json:"holders"`
	HolderInfo  []holderInfo `json:"holder_info"`
	Cap         int          `json:"cap"`
	Machine     string       `json:"machine"`
}

// slotHolders is src/developer-cap.ts slotHolders and holderInfo, read under devSlots.mu: the holders, then the spawns in
// flight (`NAME (starting)`), with each holder's age and activity.
func (s *Server) slotHolders(agents []db.Agent, now time.Time) ([]string, []holderInfo) {
	held := s.developerHolders(agents, now)
	byName := make(map[string]db.Agent, len(agents))
	for _, a := range agents {
		byName[a.Name] = a
	}
	names := append([]string(nil), held...)
	info := make([]holderInfo, 0, len(held))
	for _, n := range held {
		a := byName[n]
		h := holderInfo{Name: n}
		if at := jsMS(a.CreatedAt); !math.IsNaN(at) {
			age := math.Max(0, float64(now.UnixMilli())-at)
			h.AgeMs = &age
		}
		parts := nonEmpty(string(a.Activity))
		if a.ActivityDetail != nil && len([]rune(*a.ActivityDetail)) <= 20 {
			parts = nonEmpty(string(a.Activity), *a.ActivityDetail)
		}
		if act := strings.Join(parts, " "); act != "" {
			h.Activity = &act
		}
		info = append(info, h)
	}
	var starting []string
	for n := range s.devSlots.reserved {
		if !contains(held, n) {
			starting = append(starting, n)
		}
	}
	slices.Sort(starting)
	for _, n := range starting {
		names = append(names, n+" (starting)")
		act := "starting"
		info = append(info, holderInfo{Name: n, Activity: &act})
	}
	return names, info
}

// queueSpawnLocked is src/daemon.ts queueSpawn, under devSlots.mu: the spawn's body (as it was asked, with its name and
// owner) waits in the queue, saved before the reply says so. A bad urgent reason is a 400, a name already waiting a 409.
func (s *Server) queueSpawnLocked(body *jsjson.Object, name, reason, owner string, holders []string, info []holderInfo, cap int) (*queuedReply, error) {
	q := &s.devSlots.q
	urgent := ""
	if v, ok := body.Get("urgent"); ok && v != nil && v != false {
		u, isText := v.(string)
		if !isText || !slices.Contains(urgentReasons, u) {
			return nil, Errorf(http.StatusBadRequest, "urgent takes a reason: %s", strings.Join(urgentReasons, ", "))
		}
		urgent = u
	}
	if q.indexOf(name) >= 0 {
		return nil, Errorf(http.StatusConflict, "name %s is taken", name)
	}
	saved := jsjson.Clone(body).(*jsjson.Object)
	saved.Set("name", name)
	if owner != "" {
		saved.Set("by", owner)
	}
	w := &slotWaiter{Name: name, Body: json.RawMessage(jsjson.Stringify(saved, "")), By: owner, Urgent: urgent, At: nowMs()}
	place := q.enqueue(w)
	if err := s.saveQueueLocked(q.waiting); err != nil {
		q.drop(name)
		return nil, Errorf(http.StatusServiceUnavailable, "can't save the slot queue, so the spawn isn't queued: %s", err.Error())
	}
	r := &queuedReply{Queued: true, Name: name, Place: place, QueueLength: len(q.waiting), Holders: holders, HolderInfo: info, Cap: cap, Machine: s.cfg.Machine}
	if urgent != "" {
		r.Urgent = &urgent
	}
	if reason != "" {
		r.Reason = &reason
	}
	if r.Holders == nil {
		r.Holders = []string{}
	}
	s.kickSlotQueue()
	return r, nil
}

// kickSlotQueue asks the pump for a pass now, without waiting for its tick.
func (s *Server) kickSlotQueue() {
	select {
	case s.devSlots.q.kicks() <- struct{}{}:
	default:
	}
}

// kicks is the pump's kick channel, made once; it holds one kick, so a burst of changes asks for one pass.
func (q *slotQueue) kicks() chan struct{} {
	q.kickOnce.Do(func() { q.kick = make(chan struct{}, 1) })
	return q.kick
}

// StartSlotQueue is src/daemon.ts restoreSlotQueue and its 2 s pump: the saved queue read back, then a pass every 2 s
// and on each kick, on ctx (the daemon's lifetime, which no request's disconnect cancels).
func (s *Server) StartSlotQueue(ctx context.Context) {
	s.restoreSlotQueue(ctx)
	kick := s.devSlots.q.kicks()
	s.goBg(func() {
		t := time.NewTicker(2 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			case <-kick:
			}
			s.pumpSlotQueue(ctx)
		}
	})
}

// restoreSlotQueue is src/daemon.ts restoreSlotQueue with src/developer-cap.ts loadQueueFile: a saved waiter whose agent
// row exists was launched before the restart and isn't queued again (its caller hears so); the rest wait again, in
// their order, ahead of any already queued. An unreadable file is moved aside to .bad, never taken for an empty queue.
func (s *Server) restoreSlotQueue(ctx context.Context) {
	file := s.slotQueueFile()
	b, err := os.ReadFile(file)
	if errors.Is(err, os.ErrNotExist) {
		return
	}
	var ws []*slotWaiter
	if err == nil {
		err = json.Unmarshal(b, &ws)
	}
	if err != nil {
		slog.Error("slot queue: restore: "+err.Error()+"; moved to "+file+".bad", "err", err)
		_ = os.Rename(file, file+".bad")
		return
	}
	var waiting, started []*slotWaiter
	for _, w := range ws {
		if w == nil || w.Name == "" || len(w.Body) == 0 || string(w.Body) == "null" {
			continue
		}
		if _, err := s.db.GetAgent(ctx, w.Name); err == nil {
			started = append(started, w)
		} else {
			waiting = append(waiting, w)
		}
	}
	slots := &s.devSlots
	slots.mu.Lock()
	var front []*slotWaiter
	for _, w := range waiting {
		if slots.q.indexOf(w.Name) < 0 {
			front = append(front, w)
		}
	}
	slots.q.waiting = append(front, slots.q.waiting...)
	slots.mu.Unlock()
	for _, w := range started {
		s.tellWaiter(ctx, w, fmt.Sprintf("Your queued spawn %s got a developer slot and started before a daemon restart; check it with find_agents.", w.Name))
	}
}

// waiterAlive is src/daemon.ts waiterAlive, under devSlots.mu: a waiter whose caller is archived here is dead. A caller
// with no row here (forgotten, or one on another machine) is dead when the peers' last answer (checkCallers, which also
// refreshes peer_agents) says no machine knows it or it is archived; it lives while a peer that may hold it can't be
// reached. With no answer, peer_agents decides: a row there not archived lives, and a caller in neither table is dead.
func (s *Server) waiterAlive(ctx context.Context, w *slotWaiter) bool {
	if w.By == "" {
		return true
	}
	a, err := s.db.GetAgent(ctx, w.By)
	if err == nil {
		return a.Lifecycle != "archived"
	}
	if !errors.Is(err, db.ErrNotFound) {
		return true
	}
	if r, ok := s.devSlots.q.remote[w.By]; ok {
		return !r.gone
	}
	seen, err := s.db.PeerAgentsMatching(ctx, w.By)
	if err != nil {
		return true
	}
	for _, p := range seen {
		if p.Lifecycle != "archived" {
			return true
		}
	}
	return false
}

// callerCheckEvery is how often the peers are asked again about a waiter's caller with no row here.
const callerCheckEvery = 30 * time.Second

// remoteCaller is the peers' last answer about a caller with no row here: gone when no machine knows it or it is archived.
type remoteCaller struct {
	gone bool
	at   time.Time
}

// checkCallers asks the peers about each waiter's caller that has no row here, at most every callerCheckEvery, before
// the pump takes the lock: the network is never called under it. A caller found here again is forgotten from the
// answers, and so is one no waiter names any more.
func (s *Server) checkCallers(ctx context.Context) {
	slots := &s.devSlots
	q := &slots.q
	slots.mu.Lock()
	var bys []string
	for _, w := range q.waiting {
		if w.By != "" && !slices.Contains(bys, w.By) {
			bys = append(bys, w.By)
		}
	}
	for by := range q.remote {
		if !slices.Contains(bys, by) {
			delete(q.remote, by)
		}
	}
	slots.mu.Unlock()
	for _, by := range bys {
		if _, err := s.db.GetAgent(ctx, by); !errors.Is(err, db.ErrNotFound) {
			continue
		}
		slots.mu.Lock()
		r, ok := q.remote[by]
		slots.mu.Unlock()
		if ok && time.Since(r.at) < callerCheckEvery {
			continue
		}
		gone := true
		if s.peers != nil {
			hit, located, err := s.peers.Locate(ctx, s.db, by)
			if err != nil {
				continue
			}
			switch located {
			case peers.Found:
				gone = hit != nil && hit.Agent.Lifecycle == "archived"
			case peers.Unreachable:
				gone = false
			}
		}
		slots.mu.Lock()
		if q.remote == nil {
			q.remote = map[string]remoteCaller{}
		}
		q.remote[by] = remoteCaller{gone: gone, at: time.Now()}
		slots.mu.Unlock()
	}
}

// pumpSlotQueue is src/daemon.ts pumpSlotQueue with src/developer-cap.ts demoteRevoked and grantSlots, in one step
// under devSlots.mu: incident waiters whose mark went wait as normal ones; waiters whose caller is archived are
// dropped; then, when the host has room, the free slots go to the head of the queue, each reserved in the same step as
// the count, so no spawn that arrives later can take it. Each granted waiter launches on its own goroutine on ctx.
func (s *Server) pumpSlotQueue(ctx context.Context) {
	s.checkCallers(ctx)
	s.grantStep(ctx)
}

// grantStep is the pump's one step under devSlots.mu, after checkCallers.
func (s *Server) grantStep(ctx context.Context) {
	slots := &s.devSlots
	q := &slots.q
	host := s.hostReading()
	cap := s.settings.Get().DeveloperCap
	home := s.settings.Get().Itsa.Home
	slots.mu.Lock()
	// The count is read before anything changes, so a failed read leaves the queue as it was.
	var holders []string
	if cap > 0 {
		agents, err := s.db.ListAgents(ctx)
		if err != nil {
			slots.mu.Unlock()
			slog.Error("slot queue: pump", "err", err)
			return
		}
		holders, _ = s.slotHolders(agents, time.Now())
	}
	before := len(q.waiting)
	// Off the ITSA home the mark is asked of the home, which this sweep doesn't wait for: such a waiter keeps its
	// priority here, and its launch checks the mark again (S-2421).
	var demoted []*slotWaiter
	if home == "" || home == s.cfg.Machine {
		for _, w := range slices.Clone(q.waiting) {
			if w.Urgent == "incident" && !s.incidentMarkedHere(ctx, waiterItsa(w)) {
				demoted = append(demoted, w)
			}
		}
	}
	for _, w := range demoted {
		q.drop(w.Name)
		w.Urgent = ""
		if v, err := jsjson.Parse(w.Body); err == nil {
			if o, ok := v.(*jsjson.Object); ok {
				o.Delete("urgent")
				w.Body = json.RawMessage(jsjson.Stringify(o, ""))
			}
		}
		at := slices.IndexFunc(q.waiting, func(x *slotWaiter) bool { return x.Urgent == "" && x.At > w.At })
		if at < 0 {
			at = len(q.waiting)
		}
		q.waiting = slices.Insert(q.waiting, at, w)
	}
	var dropped []*slotWaiter
	for _, w := range slices.Clone(q.waiting) {
		if !s.waiterAlive(ctx, w) {
			dropped = append(dropped, w)
			q.drop(w.Name)
		}
	}
	var granted []*slotWaiter
	if len(q.waiting) > 0 && host.hasRoom() {
		free := math.MaxInt
		if cap > 0 {
			free = cap - len(holders)
		}
		for len(q.waiting) > 0 && free > 0 {
			w := q.waiting[0]
			q.waiting = q.waiting[1:]
			if slots.reserved == nil {
				slots.reserved = map[string]bool{}
			}
			slots.reserved[w.Name] = true
			if q.launching == nil {
				q.launching = map[string]*slotWaiter{}
			}
			q.launching[w.Name] = w
			granted = append(granted, w)
			free--
		}
	}
	// The whole batch is in the saved snapshot before the first launch starts.
	if len(granted) > 0 || len(demoted) > 0 || len(q.waiting) != before {
		s.saveQueueLoggedLocked()
	}
	slots.mu.Unlock()
	for _, w := range demoted {
		s.tellWaiter(ctx, w, fmt.Sprintf("Your queued spawn %s lost its incident mark, so it waits as a normal spawn.", w.Name))
	}
	for _, w := range dropped {
		s.tellWaiter(ctx, w, fmt.Sprintf("Your queued spawn %s was dropped from the developer slot queue because its caller was archived or forgotten.", w.Name))
	}
	for _, w := range granted {
		if !s.goBg(func() { s.launchWaiter(ctx, w) }) {
			// Shutdown is waiting: the waiter stays in the saved file and is queued again at the next start.
			slots.mu.Lock()
			delete(slots.reserved, w.Name)
			delete(q.launching, w.Name)
			slots.mu.Unlock()
		}
	}
}

// waiterItsa is the `itsa` a waiter's spawn names.
func waiterItsa(w *slotWaiter) string {
	v, err := jsjson.Parse(w.Body)
	if err != nil {
		return ""
	}
	o, _ := v.(*jsjson.Object)
	if x, ok := o.Get("itsa"); ok && jsjson.Truthy(x) {
		return claude.JSString(x)
	}
	return ""
}

// launchWaiter is src/daemon.ts launchWaiter: the granted waiter's spawn, past the cap (its slot was reserved by the
// grant), as no caller's request: on ctx, the daemon's lifetime. Its caller hears that it started or why it failed;
// its slot and its place in the saved file go when the spawn ends, so a failed launch frees the slot for the next
// waiter. A launch cut short by shutdown leaves the file as it is, so the next start queues it again.
func (s *Server) launchWaiter(ctx context.Context, w *slotWaiter) {
	defer func() {
		slots := &s.devSlots
		slots.mu.Lock()
		delete(slots.reserved, w.Name)
		delete(slots.q.launching, w.Name)
		if ctx.Err() == nil {
			s.saveQueueLoggedLocked()
		}
		slots.mu.Unlock()
		s.kickSlotQueue()
	}()
	// A caller archived or forgotten since the grant gets no agent.
	s.devSlots.mu.Lock()
	alive := s.waiterAlive(ctx, w)
	s.devSlots.mu.Unlock()
	if !alive {
		return
	}
	launch := s.devSlots.q.launch
	if launch == nil {
		launch = s.spawnGranted
	}
	if err := launch(ctx, w); err != nil {
		if ctx.Err() != nil {
			return
		}
		s.tellWaiter(ctx, w, fmt.Sprintf("Your queued spawn %s got a developer slot but failed to start: %s", w.Name, err.Error()))
		return
	}
	if w.By != "" {
		s.dropQueuedDuplicates(ctx, w.Name, w.By)
	}
}

// spawnGranted runs a granted waiter's spawn: spawnWrite with its saved body, not the human's, slot granted.
func (s *Server) spawnGranted(ctx context.Context, w *slotWaiter) error {
	v, err := jsjson.Parse(w.Body)
	if err != nil {
		return err
	}
	body, ok := v.(*jsjson.Object)
	if !ok {
		return fmt.Errorf("the saved spawn is not an object")
	}
	out, err := s.spawnWrite(ctx, auth.Resolved{Caller: auth.Caller{Kind: auth.None}}, write{body: body, granted: true})
	if err != nil {
		return err
	}
	if a, ok := out.(spawnView); ok {
		s.tellWaiter(ctx, w, fmt.Sprintf("Your queued spawn %s got a developer slot and started (%s).", w.Name, a.ID))
	}
	return nil
}

// tellWaiter is src/daemon.ts tellWaiter with src/developer-cap.ts deliverWaiterNotice: the caller here or on a peer,
// an unreachable machine retried 6 times (STAM_WAITER_NOTICE_MS apart, default 10 s); a caller no daemon knows, an
// archived one, or one still unreachable at the end hands the notice to the chief of staff, so a dropped or failed
// spawn is never silent. It runs in the daemon's background work (its context ends at shutdown, whatever the caller's
// request does), through the notice queue (tellWhere), never the mail.
func (s *Server) tellWaiter(ctx context.Context, w *slotWaiter, text string) {
	slog.Info("slot queue: " + w.Name + ": " + text)
	s.background(ctx, func(ctx context.Context) { s.deliverWaiterNotice(ctx, w, text) })
}

func (s *Server) deliverWaiterNotice(ctx context.Context, w *slotWaiter, text string) {
	toCos := func(why string) {
		id := s.chiefOfStaffID(ctx)
		if id == "" || id == w.By {
			return
		}
		by := w.By
		if by == "" {
			by = "a caller"
		}
		if err := s.tellAnywhere(ctx, id, fmt.Sprintf("[stam] %s (it couldn't reach %s: %s)", text, by, why)); err != nil {
			slog.Warn("slot queue: notice to the chief of staff", "err", err)
		}
	}
	delay := 10 * time.Second
	if n, err := time.ParseDuration(envVar("WAITER_NOTICE_MS") + "ms"); err == nil && n > 0 {
		delay = n
	}
	func() {
		if w.By == "" {
			toCos("the spawn named no caller")
			return
		}
		last := "unreachable"
		for i := 0; i <= 6; i++ {
			if a, err := s.db.GetAgent(ctx, w.By); err == nil && a.Lifecycle == "archived" {
				last = "absent"
			} else if got, err := s.tellWhere(ctx, w.By, text, ""); err != nil {
				last = "refused"
			} else {
				last = got
			}
			if last == "told" || last == "absent" {
				break
			}
			if i < 6 {
				select {
				case <-ctx.Done():
					return
				case <-time.After(delay):
				}
			}
		}
		switch last {
		case "told":
		case "absent":
			toCos("no machine knows that caller")
		case "refused":
			toCos("the notice was refused")
		default:
			toCos("its machine is unreachable")
		}
	}()
}

// envVar is src/env.ts envVar: MOOTR_NAME, else STAM_NAME.
func envVar(name string) string {
	if v, ok := os.LookupEnv("MOOTR_" + name); ok {
		return v
	}
	return os.Getenv("STAM_" + name)
}

var slotNameRe = regexp.MustCompile(`^[\w-]+$`)

func (s *Server) slotQueueRoutes() {
	s.handle("POST /api/slot-queue/{name}/cancel", s.cancelSpawnRoute)
	s.handle("POST /api/slot-queue/{name}/duplicate", s.dropDuplicateRoute)
}

// cancelSpawnRoute is POST /api/slot-queue/:name/cancel (S-2134, S-2579): agent_control cancel.
func (s *Server) cancelSpawnRoute(r *http.Request, c auth.Resolved) (any, error) {
	name := r.PathValue("name")
	if !slotNameRe.MatchString(name) {
		return nil, Errorf(http.StatusNotFound, "no route %s %s", r.Method, r.URL.Path)
	}
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	var by jsjson.Value
	if w.body != nil {
		by, _ = w.body.Get("by")
	}
	ctx := context.WithoutCancel(r.Context())
	caller, err := s.cancelCaller(ctx, c, by)
	if err != nil {
		return nil, err
	}
	return s.cancelSpawn(ctx, name, caller, c.Local)
}

// cancelCaller is src/daemon.ts cancelCaller: the OpenCode server acts as the agent its request names (by); with none it
// is refused, never the shared token's boss. Any other caller is as it is.
func (s *Server) cancelCaller(ctx context.Context, c auth.Resolved, by jsjson.Value) (auth.Resolved, error) {
	if c.Kind != auth.OpenCode {
		return c, nil
	}
	if jsjson.Truthy(by) {
		if a, err := s.db.GetAgent(ctx, claude.JSString(by)); err == nil {
			out := c
			out.Caller = auth.Caller{Kind: auth.Agent, Agent: a.ID}
			return out, nil
		}
	}
	return auth.Resolved{}, Errorf(http.StatusForbidden, "the OpenCode server's cancel must name its agent (by)")
}

// cancelSpawn is src/daemon.ts cancelSpawn: this machine's queue first; a name it doesn't hold goes to each peer with the
// caller's identity, and the peer runs the same one-step check as a local cancel, so a grant racing it gives one
// outcome. A forwarded request (local) never forwards again. A peer that can't be reached or can't tell is named.
func (s *Server) cancelSpawn(ctx context.Context, name string, c auth.Resolved, local bool) (any, error) {
	slots := &s.devSlots
	slots.mu.Lock()
	known := slots.q.queuedName(name, false)
	slots.mu.Unlock()
	if local || known || s.peers == nil {
		return s.cancelQueued(ctx, name, c)
	}
	via := s.viaOf(ctx, c)
	if c.Kind == auth.Agent && via == nil {
		return nil, Errorf(http.StatusForbidden, "can't forward a cancel with no caller")
	}
	var unsure []string
	for _, p := range s.peers.Peers() {
		r, err := s.peers.Call(ctx, p, "POST", "/api/slot-queue/"+neturl.PathEscape(name)+"/cancel", map[string]any{}, 15*time.Second, false, via)
		if err != nil {
			unsure = append(unsure, fmt.Sprintf("%s is unreachable (%s)", p.Name, err.Error()))
			continue
		}
		msg := r.Data.Text("error")
		switch {
		case r.Status == http.StatusOK:
			return r.Data, nil
		case r.Status == http.StatusNotFound && strings.HasPrefix(msg, "no queued spawn named "):
			continue
		case r.Status == http.StatusForbidden || r.Status == http.StatusConflict:
			if msg == "" {
				msg = fmt.Sprintf("%s: HTTP %d", p.Name, r.Status)
			}
			return nil, Errorf(r.Status, "%s", msg)
		}
		line := fmt.Sprintf("%s answered HTTP %d", p.Name, r.Status)
		if msg != "" {
			line += ": " + msg
		}
		unsure = append(unsure, line+", so it may run an older release")
	}
	if len(unsure) > 0 {
		return nil, Errorf(http.StatusBadGateway, "can't tell whether %s is queued on another machine: %s", name, strings.Join(unsure, "; "))
	}
	return s.cancelQueued(ctx, name, c)
}

// cancelReply is src/daemon.ts cancelQueuedSpawn's reply.
type cancelReply struct {
	Cancelled bool   `json:"cancelled"`
	Name      string `json:"name"`
	Machine   string `json:"machine"`
}

// cancelQueued is src/daemon.ts cancelQueuedSpawn with src/developer-cap.ts cancelState and mayCancelWaiter, in one step
// under devSlots.mu: who may cancel (the caller, the caller's parents, the chief of staff, the assistant, or a caller
// that is no agent) is read inside it, so a grant can't slip between the check and the removal. A spawn already
// granted a slot is a 409, since its agent is starting. The file is saved without the waiter before it leaves memory.
func (s *Server) cancelQueued(ctx context.Context, name string, c auth.Resolved) (any, error) {
	slots := &s.devSlots
	slots.mu.Lock()
	q := &slots.q
	if _, ok := q.launching[name]; ok {
		slots.mu.Unlock()
		return nil, Errorf(http.StatusConflict, "%s already got a developer slot and is starting, so it can't be cancelled", name)
	}
	i := q.indexOf(name)
	if i < 0 {
		slots.mu.Unlock()
		return nil, Errorf(http.StatusNotFound, "no queued spawn named %s", name)
	}
	w := q.waiting[i]
	me := ""
	if c.Kind == auth.Agent {
		me = c.Caller.Agent
	}
	boss := c.Kind != auth.Agent && c.Kind != auth.OpenCode
	if !boss && me != "" {
		boss = c.Caller.Boss || s.chiefOfStaffID(ctx) == me || s.isAssistant(ctx, me)
	}
	if !boss && !s.mayCancelWaiter(ctx, w, me) {
		slots.mu.Unlock()
		who := "this caller"
		if me != "" {
			who = s.agentLabel(ctx, me)
		}
		return nil, Errorf(http.StatusForbidden, "%s can't cancel %s: only its caller, the caller's parents, and the chief of staff may", who, name)
	}
	if err := s.saveQueueLocked(q.without(w)); err != nil {
		slots.mu.Unlock()
		return nil, Errorf(http.StatusServiceUnavailable, "can't save the slot queue, so %s stays queued: %s", name, err.Error())
	}
	q.drop(name)
	slots.mu.Unlock()
	if w.By != "" && w.By != me {
		s.tellWaiter(ctx, w, fmt.Sprintf("Your queued spawn %s was cancelled.", name))
	}
	return cancelReply{Cancelled: true, Name: name, Machine: s.cfg.Machine}, nil
}

// mayCancelWaiter is src/developer-cap.ts mayCancelWaiter for a caller that isn't the boss: the waiter's caller, or one
// of that caller's parents. A spawn with no known caller is the boss's alone.
func (s *Server) mayCancelWaiter(ctx context.Context, w *slotWaiter, me string) bool {
	if w.By == "" || me == "" {
		return false
	}
	if me == w.By {
		return true
	}
	extra, err := s.db.ExtraParents(ctx)
	if err != nil {
		return false
	}
	owner, err := s.db.GetAgent(ctx, w.By)
	if err == nil {
		up, _ := s.ancestors(ctx, owner, extra)
		return up[me]
	}
	// A caller on another machine: the parents its peer last listed, and those parents' own ancestors here.
	parents, err := s.db.PeerParentsOf(ctx, w.By)
	if err != nil {
		return false
	}
	for _, p := range parents {
		if p == me {
			return true
		}
		if pa, err := s.db.GetAgent(ctx, p); err == nil {
			if up, _ := s.ancestors(ctx, pa, extra); up[me] {
				return true
			}
		}
	}
	return false
}

// dropDuplicateRoute is src/daemon.ts dropQueuedDuplicate: a peer's spawn named name from caller started there, so this
// machine's queued spawn of that name from that caller would start a duplicate, and is dropped. Only a peer or the
// human may ask, never an agent; a waiter of another caller, or one already launching, stays.
func (s *Server) dropDuplicateRoute(r *http.Request, c auth.Resolved) (any, error) {
	name := r.PathValue("name")
	if c.IsAgent() {
		return nil, Errorf(http.StatusForbidden, "only a peer drops a queued duplicate")
	}
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	by := ""
	if w.body != nil {
		if v, _ := w.body.Get("caller"); jsjson.Truthy(v) {
			by = claude.JSString(v)
		}
	}
	out := jsfmt.Value{Kind: jsfmt.Object}
	out.Set("dropped", jsfmt.Value{Kind: jsfmt.Bool})
	if by == "" {
		return out, nil
	}
	slots := &s.devSlots
	slots.mu.Lock()
	q := &slots.q
	i := slices.IndexFunc(q.waiting, func(x *slotWaiter) bool { return x.Name == name && x.By == by })
	if i < 0 {
		slots.mu.Unlock()
		if _, ok := q.launching[name]; ok {
			out.Set("launching", jsfmt.Value{Kind: jsfmt.Bool, Bool: true})
		}
		return out, nil
	}
	waiter := q.waiting[i]
	if err := s.saveQueueLocked(q.without(waiter)); err != nil {
		slots.mu.Unlock()
		return nil, Errorf(http.StatusServiceUnavailable, "can't save the slot queue, so %s stays queued: %s", name, err.Error())
	}
	q.drop(name)
	slots.mu.Unlock()
	s.tellWaiter(context.WithoutCancel(r.Context()), waiter, fmt.Sprintf("Your queued spawn %s was dropped: %s started on another machine from the same caller.", name, name))
	out.Set("dropped", jsfmt.Value{Kind: jsfmt.Bool, Bool: true})
	return out, nil
}

// dropQueuedDuplicates is src/daemon.ts dropQueuedDuplicates: after a spawn of name from by starts here, each peer drops
// its queued duplicate. A daemon-to-daemon call (no via), fire and forget in the daemon's background work, on a context
// no request cancels; the outcome is logged.
func (s *Server) dropQueuedDuplicates(ctx context.Context, name, by string) {
	if s.peers == nil {
		return
	}
	for _, p := range s.peers.Peers() {
		s.background(ctx, func(ctx context.Context) {
			r, err := s.peers.Call(ctx, p, "POST", "/api/slot-queue/"+neturl.PathEscape(name)+"/duplicate", map[string]any{"caller": by}, 8*time.Second, false, (*peers.Via)(nil))
			if err != nil {
				slog.Error(fmt.Sprintf("slot queue: %s duplicate check for %s", p.Name, name), "err", err)
				return
			}
			if d, ok := r.Data.Get("dropped"); r.Status == http.StatusOK && ok && d.Bool {
				slog.Info(fmt.Sprintf("slot queue: %s dropped its queued duplicate %s from %s", p.Name, name, by))
			}
		})
	}
}
