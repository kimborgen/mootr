package server

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"stam/internal/auth"
	"stam/internal/config"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
	"stam/internal/steps"
)

// Each computer's load (src/machines.ts, S-3807): CPU (total and per core), RAM and swap, sampled from /proc every 5 s,
// with a one-minute rolling average beside the latest raw values. GET /api/machines fans out to the peers, whose own
// request (x-stam-local) gets only their reading; a peer that doesn't answer is offline. The sampler also mails the
// resource warnings (settings.resourceWarn).

const (
	sampleEvery  = 5 * time.Second
	sampleWindow = 60_000.0
	gib          = 1 << 30
)

type cpuCounters struct{ busy, total float64 }

// machineSample is src/machines.ts Sample; diskPct is nil when statfs failed.
type machineSample struct {
	ts                                     float64
	cpuPct                                 float64
	cores                                  []float64
	ramPct, swapPct                        float64
	diskPct                                *float64
	ramUsed, ramTotal, swapUsed, swapTotal float64
	load                                   []float64
}

// sampler is this machine's: the counters of the previous read, so each tick's load is the share of the jiffies since
// it, and the samples of the last minute.
type sampler struct {
	mu        sync.Mutex
	prev      *cpuCounters
	prevCores []cpuCounters
	buffer    []machineSample
	// statfs reads a filesystem's blocks; a test replaces it.
	statfs func(path string) (blocks, bfree, bavail float64, err error)
}

func statfsRoot(path string) (float64, float64, float64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0, 0, err
	}
	return float64(st.Blocks), float64(st.Bfree), float64(st.Bavail), nil
}

func clampPct(n float64) float64 { return math.Max(0, math.Min(100, n)) }

// round1 is Math.round(n * 10) / 10.
func round1(n float64) float64 { return math.Floor(n*10+0.5) / 10 }

var statLine = regexp.MustCompile(`^cpu(\d*)\s+(.+)$`)

// parseStat is src/machines.ts parseStat: /proc/stat's cpu lines; busy is everything but idle and iowait.
func parseStat(text string) (cpuCounters, []cpuCounters) {
	var total cpuCounters
	var cores []cpuCounters
	for _, line := range strings.Split(text, "\n") {
		m := statLine.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		var nums []float64
		for _, f := range strings.Fields(m[2]) {
			n, err := strconv.ParseFloat(f, 64)
			if err != nil {
				n = 0
			}
			nums = append(nums, n)
		}
		sum := 0.0
		for _, n := range nums {
			sum += n
		}
		idle := 0.0
		if len(nums) > 3 {
			idle += nums[3]
		}
		if len(nums) > 4 {
			idle += nums[4]
		}
		c := cpuCounters{busy: sum - idle, total: sum}
		if m[1] == "" {
			total = c
			continue
		}
		i, _ := strconv.Atoi(m[1])
		for len(cores) <= i {
			cores = append(cores, cpuCounters{})
		}
		cores[i] = c
	}
	return total, cores
}

// cpuPct is the share of the jiffies between two reads that were busy.
func cpuPct(now, prev cpuCounters) float64 {
	dt := now.total - prev.total
	if dt <= 0 {
		return 0
	}
	return clampPct(100 * (now.busy - prev.busy) / dt)
}

var meminfoLine = regexp.MustCompile(`(?m)^(\w+):\s+(\d+)`)

func parseMeminfo(text string) map[string]float64 {
	out := map[string]float64{}
	for _, m := range meminfoLine.FindAllStringSubmatch(text, -1) {
		if _, ok := out[m[1]]; !ok {
			out[m[1]], _ = strconv.ParseFloat(m[2], 64)
		}
	}
	return out
}

func parseLoadavg(text string) []float64 {
	f := strings.Fields(text)
	if len(f) > 3 {
		f = f[:3]
	}
	out := make([]float64, len(f))
	for i, x := range f {
		// TS's Number() gives NaN, which JSON sends as null; a reading needs a number, so 0.
		n, _ := strconv.ParseFloat(x, 64)
		out[i] = n
	}
	return out
}

// diskPct is the used share of a filesystem as df reports it: blocks in use over those plus the ones users can still get.
func diskPct(blocks, bfree, bavail float64) float64 {
	used := blocks - bfree
	if denom := used + bavail; denom > 0 {
		return clampPct(100 * used / denom)
	}
	return 0
}

// procDir is STAM_PROC_DIR, else /proc: the checks seed a fixed reading this way.
func procDir() string {
	if d := os.Getenv("STAM_PROC_DIR"); d != "" {
		return d
	}
	return "/proc"
}

// tick is src/machines.ts tick: one read of /proc, kept in the buffer; nil when a file can't be read.
func (m *sampler) tick(now float64) *machineSample {
	dir := procDir()
	stat, err1 := os.ReadFile(dir + "/stat")
	meminfo, err2 := os.ReadFile(dir + "/meminfo")
	loadavg, err3 := os.ReadFile(dir + "/loadavg")
	if err1 != nil || err2 != nil || err3 != nil {
		return nil
	}
	total, cores := parseStat(string(stat))
	mem := parseMeminfo(string(meminfo))
	ramTotal := mem["MemTotal"] * 1024
	ramUsed := math.Max(0, mem["MemTotal"]-mem["MemAvailable"]) * 1024
	swapTotal := mem["SwapTotal"] * 1024
	swapUsed := math.Max(0, mem["SwapTotal"]-mem["SwapFree"]) * 1024
	statfs := m.statfs
	if statfs == nil {
		statfs = statfsRoot
	}
	var disk *float64
	if b, f, a, err := statfs("/"); err == nil {
		d := diskPct(b, f, a)
		disk = &d
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	s := machineSample{ts: now, cores: make([]float64, len(cores)), diskPct: disk, ramUsed: ramUsed, ramTotal: ramTotal,
		swapUsed: swapUsed, swapTotal: swapTotal, load: parseLoadavg(string(loadavg))}
	if m.prev != nil {
		s.cpuPct = cpuPct(total, *m.prev)
		for i, c := range cores {
			prev := c
			if i < len(m.prevCores) {
				prev = m.prevCores[i]
			}
			s.cores[i] = cpuPct(c, prev)
		}
	}
	if ramTotal > 0 {
		s.ramPct = clampPct(100 * ramUsed / ramTotal)
	}
	if swapTotal > 0 {
		s.swapPct = clampPct(100 * swapUsed / swapTotal)
	}
	m.prev, m.prevCores = &total, cores
	kept := m.buffer[:0:0]
	for _, x := range m.buffer {
		if now-x.ts <= sampleWindow {
			kept = append(kept, x)
		}
	}
	m.buffer = append(kept, s)
	return &s
}

// machineReading is src/machines.ts MachineReading, in its key order.
type machineReading struct {
	Name   string      `json:"name"`
	Online bool        `json:"online"`
	TS     float64     `json:"ts"`
	CPU    cpuReading  `json:"cpu"`
	RAM    memReading  `json:"ram"`
	Swap   memReading  `json:"swap"`
	Load   []float64   `json:"load"`
	Agents agentCounts `json:"agents"`
}

type cpuReading struct {
	Pct   float64   `json:"pct"`
	Cores []float64 `json:"cores"`
	Count int       `json:"count"`
}

type memReading struct {
	Pct   float64 `json:"pct"`
	Used  float64 `json:"used"`
	Total float64 `json:"total"`
}

// agentCounts is stam's agents on one machine by state: paused; and the active ones working, waiting (waiting or
// blocked), or idle (everything else).
type agentCounts struct {
	Working int `json:"working"`
	Waiting int `json:"waiting"`
	Idle    int `json:"idle"`
	Paused  int `json:"paused"`
}

func offlineReading(name string, now float64) machineReading {
	return machineReading{Name: name, TS: now, CPU: cpuReading{Cores: []float64{}}, Load: []float64{}}
}

// summarize is src/machines.ts summarize: each percentage the mean over the samples in the window, the raw bytes and
// the load from the latest one.
func summarize(samples []machineSample, name string, now float64) machineReading {
	var use []machineSample
	for _, s := range samples {
		if now-s.ts <= sampleWindow {
			use = append(use, s)
		}
	}
	if len(use) == 0 && len(samples) > 0 {
		use = samples[len(samples)-1:]
	}
	if len(use) == 0 {
		return offlineReading(name, now)
	}
	last := use[len(use)-1]
	mean := func(f func(s machineSample) float64) float64 {
		t := 0.0
		for _, s := range use {
			t += f(s)
		}
		return t / float64(len(use))
	}
	count := len(last.cores)
	cores := make([]float64, count)
	for i := range cores {
		cores[i] = round1(mean(func(s machineSample) float64 {
			if i < len(s.cores) {
				return s.cores[i]
			}
			return 0
		}))
	}
	return machineReading{
		Name: name, Online: true, TS: last.ts,
		CPU:  cpuReading{Pct: round1(mean(func(s machineSample) float64 { return s.cpuPct })), Cores: cores, Count: count},
		RAM:  memReading{Pct: round1(mean(func(s machineSample) float64 { return s.ramPct })), Used: last.ramUsed, Total: last.ramTotal},
		Swap: memReading{Pct: round1(mean(func(s machineSample) float64 { return s.swapPct })), Used: last.swapUsed, Total: last.swapTotal},
		Load: last.load,
	}
}

func nowMs() float64 { return float64(time.Now().UnixMilli()) }

// snapshot is this machine's current reading: one tick if nothing has been sampled yet.
func (m *sampler) snapshot(name string, now float64) machineReading {
	m.mu.Lock()
	empty := len(m.buffer) == 0
	m.mu.Unlock()
	if empty {
		m.tick(now)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return summarize(m.buffer, name, now)
}

// countAgents is src/machines.ts countAgents over this daemon's agents; shut-down and archived ones don't count.
func (s *Server) countAgents(ctx context.Context) (agentCounts, error) {
	var c agentCounts
	list, err := s.db.ListLiveAgents(ctx)
	if err != nil {
		return c, err
	}
	for _, a := range list {
		switch {
		case a.Lifecycle == "paused":
			c.Paused++
		case a.Lifecycle != "active":
		case a.Activity == "starting" || a.Activity == "working":
			c.Working++
		case a.Activity == "waiting" || a.Activity == "blocked":
			c.Waiting++
		default:
			c.Idle++
		}
	}
	return c, nil
}

// toValue is v as a decoded JSON value, keeping its key order.
func toValue(v any) jsfmt.Value {
	b, err := stringify(v)
	if err != nil {
		return jsfmt.NullValue()
	}
	out, err := jsfmt.Parse(b)
	if err != nil {
		return jsfmt.NullValue()
	}
	return out
}

// allMachines is src/machines.ts all: this machine's reading plus each peer's, as each sent it. local (a peer's own
// request) gets only this machine's, so a fan-out never loops.
func (s *Server) allMachines(ctx context.Context, local bool) ([]jsfmt.Value, error) {
	here := s.machines.snapshot(s.cfg.Machine, nowMs())
	counts, err := s.countAgents(ctx)
	if err != nil {
		return nil, err
	}
	here.Agents = counts
	out := []jsfmt.Value{toValue(here)}
	if local {
		return out, nil
	}
	ps := s.peers.Peers()
	rest := make([]jsfmt.Value, len(ps))
	var wg sync.WaitGroup
	for i, p := range ps {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rest[i] = toValue(offlineReading(p.Name, nowMs()))
			r, err := s.peers.Call(ctx, p, "GET", "/api/machines", nil, 4*time.Second, false, nil)
			if err != nil || r.Data.Kind != jsfmt.Array {
				return
			}
			for _, x := range r.Data.Items {
				if x.Kind == jsfmt.Object && x.Text("name") == p.Name {
					rest[i] = x
					return
				}
			}
			if len(r.Data.Items) > 0 {
				rest[i] = r.Data.Items[0]
			}
		}()
	}
	wg.Wait()
	return append(out, rest...), nil
}

// without is an object without the given keys; anything else as it is.
func without(v jsfmt.Value, keys ...string) jsfmt.Value {
	if v.Kind != jsfmt.Object {
		return v
	}
	out := jsfmt.Value{Kind: jsfmt.Object, Keys: []string{}, Items: []jsfmt.Value{}}
	for i, k := range v.Keys {
		drop := false
		for _, d := range keys {
			drop = drop || k == d
		}
		if !drop {
			out.Keys, out.Items = append(out.Keys, k), append(out.Items, v.Items[i])
		}
	}
	return out
}

// listMachines is GET /api/machines. Each row may carry `origin`, the serve origin the page sends that machine's human
// writes to (S-544), computed from this daemon's own peer list; a peer's own reading is never trusted for it. This
// daemon serves no web UI, so its own row has none.
func (s *Server) listMachines(r *http.Request, c auth.Resolved) (any, error) {
	rows, err := s.allMachines(r.Context(), c.Local)
	if err != nil {
		return nil, err
	}
	for i, row := range rows {
		row = without(row, "origin", "terminalOrigin")
		name := row.Text("name")
		if name != s.cfg.Machine {
			if p, ok := s.peers.ByName(name); ok {
				if o := s.peerServeOrigin(p.URL); o != nil {
					row.Set("origin", jsfmt.StringValue(*o))
					if s.settings.Get().Auth.HumanStrict {
						row.Set("terminalOrigin", jsfmt.StringValue(*o))
					}
				}
			}
		}
		rows[i] = row
	}
	return rows, nil
}

// num is a number at a path of v; ok is false when it isn't one.
func numAt(v jsfmt.Value, path ...string) (float64, bool) {
	for _, k := range path {
		var ok bool
		if v, ok = v.Get(k); !ok {
			return 0, false
		}
	}
	if v.Kind != jsfmt.Number {
		return 0, false
	}
	f, err := strconv.ParseFloat(v.Num, 64)
	return f, err == nil
}

func numOrNull(f float64, ok bool) jsfmt.Value {
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) {
		return jsfmt.NullValue()
	}
	return jsfmt.Value{Kind: jsfmt.Number, Num: jsjson.Number(f)}
}

// compactMachine is src/machines.ts compact, for usage_info: no per-core arrays, GB instead of bytes, and the one-minute
// load (null when the machine hasn't answered). A peer on an older release sends no agent counts: null.
func compactMachine(r jsfmt.Value) jsfmt.Value {
	out := jsfmt.Value{Kind: jsfmt.Object}
	if name, ok := r.Get("name"); ok {
		out.Set("name", name)
	}
	if online, ok := r.Get("online"); ok {
		out.Set("online", online)
	}
	out.Set("cores", numOrNull(numAt(r, "cpu", "count")))
	out.Set("cpu_pct", numOrNull(numAt(r, "cpu", "pct")))
	out.Set("ram_pct", numOrNull(numAt(r, "ram", "pct")))
	gb := func(path ...string) jsfmt.Value {
		f, ok := numAt(r, path...)
		return numOrNull(round1(f/gib), ok)
	}
	out.Set("ram_used_gb", gb("ram", "used"))
	out.Set("ram_total_gb", gb("ram", "total"))
	out.Set("swap_pct", numOrNull(numAt(r, "swap", "pct")))
	load := jsfmt.NullValue()
	if l, ok := r.Get("load"); ok && l.Kind == jsfmt.Array && len(l.Items) > 0 {
		load = l.Items[0]
	}
	out.Set("load_1m", load)
	agents := jsfmt.NullValue()
	if a, ok := r.Get("agents"); ok && a.Kind != jsfmt.Null {
		agents = a
	}
	out.Set("agents", agents)
	return out
}

// healthDB is GET /api/health/db, the deploy watcher's DB sample (S-474): local only, so its time is the DB's.
func (s *Server) healthDB(r *http.Request, _ auth.Resolved) (any, error) {
	n, err := s.db.HealthDB(r.Context())
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "machine": s.cfg.Machine, "agents": n}, nil
}

// machinePath is the TS route's ([\w.-]+).
var machinePath = regexp.MustCompile(`^[\w.-]+$`)

// startMachine is POST /api/machines/:id/start (S-1526): it starts a stopped peer, as a spawn on it does; one that is
// already up answers at once. Only the human may.
func (s *Server) startMachine(r *http.Request, _ auth.Resolved) (any, error) {
	id := r.PathValue("id")
	if !machinePath.MatchString(id) {
		return nil, Errorf(http.StatusNotFound, "no route %s %s", r.Method, r.URL.Path)
	}
	if !s.trustedHuman(r) {
		return nil, Errorf(http.StatusForbidden, "only the human can start a machine, %s", s.humanWays("stam"))
	}
	p, ok := s.peers.ByName(id)
	if !ok {
		return nil, Errorf(http.StatusNotFound, "no machine %s", id)
	}
	if err := s.peers.EnsureUp(p); err != nil {
		return nil, Errorf(http.StatusServiceUnavailable, "%s", err.Error())
	}
	return map[string]bool{"ok": true}, nil
}

// cacheAgent is src/cache-panel.ts CacheAgent.
type cacheAgent struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Machine   string  `json:"machine"`
	Harness   string  `json:"harness"`
	Model     *string `json:"model"`
	Lifecycle string  `json:"lifecycle"`
	Account   *string `json:"account"`
	Paid      bool    `json:"paid"`
	TTL       *string `json:"ttl"`
	TTLAt     *string `json:"ttl_at"`
}

// localCacheAgents is src/cache-panel.ts localCacheAgents: this machine's agents that aren't archived, each with the
// account it bills to and its latest detected cache window.
func (s *Server) localCacheAgents(ctx context.Context) ([]jsfmt.Value, error) {
	ttls, err := s.db.CacheTTLs(ctx)
	if err != nil {
		return nil, err
	}
	list, err := s.db.ListLiveAgents(ctx)
	if err != nil {
		return nil, err
	}
	set := s.settings.Get()
	out := []jsfmt.Value{}
	for _, a := range list {
		if a.Machine != s.cfg.Machine {
			continue
		}
		row := cacheAgent{ID: a.ID, Name: a.Name, Machine: a.Machine, Harness: a.Harness, Model: a.Model, Lifecycle: string(a.Lifecycle)}
		if acct := set.AccountFor(a.Harness, a.Model); acct != "" {
			row.Account = &acct
			if p := set.CostAccounts[acct].Paid; p != nil {
				row.Paid = *p
			}
		}
		if t, ok := ttls[a.ID]; ok {
			row.TTL, row.TTLAt = t.TTL, &t.TS
		}
		out = append(out, toValue(row))
	}
	return out, nil
}

// cacheAgents is GET /api/cache/agents (S-2239): this machine's agents plus each peer's. A peer that doesn't answer is
// named in `offline`; one that answers 404 runs a release without this route and is named in `outdated`.
func (s *Server) cacheAgents(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	here, err := s.localCacheAgents(ctx)
	if err != nil {
		return nil, err
	}
	offline, outdated := []string{}, []string{}
	if c.Local {
		return map[string]any{"agents": here, "offline": offline, "outdated": outdated}, nil
	}
	ps := s.peers.Peers()
	rest := make([][]jsfmt.Value, len(ps))
	state := make([]string, len(ps))
	var wg sync.WaitGroup
	for i, p := range ps {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, err := s.peers.Call(ctx, p, "GET", "/api/cache/agents", nil, 4*time.Second, false, nil)
			switch {
			case err != nil:
				state[i] = "offline"
			case res.Status == http.StatusNotFound:
				state[i] = "outdated"
			default:
				list, ok := res.Data.Get("agents")
				if res.Status != http.StatusOK || !ok || list.Kind != jsfmt.Array {
					state[i] = "offline"
					return
				}
				rest[i] = list.Items
			}
		}()
	}
	wg.Wait()
	agents := here
	for i, p := range ps {
		switch state[i] {
		case "offline":
			offline = append(offline, p.Name)
		case "outdated":
			outdated = append(outdated, p.Name)
		}
		agents = append(agents, rest[i]...)
	}
	return map[string]any{"agents": agents, "offline": offline, "outdated": outdated}, nil
}

// --- Resource warnings ---
//
// Each kind across its line mails, then not again for repeatMinutes, even if it recovers and crosses again in that
// time. CPU load is the 5-minute load average per core. The root disk mails once per crossing: when it goes over its
// line, then not again until it drops diskClearMargin below it and crosses once more. When each kind last mailed lives
// in settings (resourceWarn.lastWarned), so a restart keeps it.

const diskClearMargin = 5

var warnLabel = map[string]string{"cpu": "CPU load", "ram": "RAM", "swap": "swap", "disk": "disk"}

// overLines is src/machines.ts overLines: the kinds across their lines in one sample, each with the sentence that says why.
func overLines(m machineSample, cfg config.ResourceWarn) map[string]string {
	out := map[string]string{}
	cores := len(m.cores)
	perCore := 0.0
	if cores > 0 && len(m.load) > 1 {
		perCore = m.load[1] / float64(cores)
	}
	if cores > 0 && perCore > cfg.LoadPerCore {
		out["cpu"] = fmt.Sprintf("The 5-minute load is %s per core on %d cores (line %s).", steps.ToFixed(perCore, 2), cores, jsjson.Number(cfg.LoadPerCore))
	}
	availGb := (m.ramTotal - m.ramUsed) / gib
	if m.ramTotal > 0 && availGb < cfg.RamAvailableGb {
		out["ram"] = fmt.Sprintf("%s GB of RAM is available (line %s GB).", steps.ToFixed(availGb, 1), jsjson.Number(cfg.RamAvailableGb))
	}
	if m.swapTotal > 0 && m.swapPct > cfg.SwapPct {
		out["swap"] = fmt.Sprintf("Swap is %s%% used (line %s%%).", jsjson.Number(math.Floor(m.swapPct+0.5)), jsjson.Number(cfg.SwapPct))
	}
	return out
}

// warnResources is src/machines.ts warnResources: it calls send for each kind that mails now, and stores the times in
// settings when they changed. It returns the kinds sent.
func (s *Server) warnResources(m machineSample, cfg config.ResourceWarn, send func(subject, body string), now float64) []string {
	sent := []string{}
	lines := map[string]string{}
	if cfg.Enabled {
		lines = overLines(m, cfg)
	}
	last := map[string]*float64{}
	for k, v := range cfg.LastWarned {
		last[k] = v
	}
	for _, kind := range []string{"cpu", "ram", "swap"} {
		line, ok := lines[kind]
		if !ok {
			continue
		}
		if prev := last[kind]; prev != nil && now-*prev < cfg.RepeatMinutes*60_000 {
			continue
		}
		t := now
		last[kind] = &t
		sent = append(sent, kind)
		send(fmt.Sprintf("Resource warning on %s: %s", s.cfg.Machine, warnLabel[kind]),
			fmt.Sprintf("%s\n\nStam mails this again every %s minutes while it stays across. Settings > Resources sets the lines.", line, jsjson.Number(cfg.RepeatMinutes)))
	}
	if cfg.Enabled && m.diskPct != nil {
		line := cfg.DiskPct
		clear := line - diskClearMargin
		if *m.diskPct < clear {
			last["disk"] = nil
		} else if *m.diskPct > line && last["disk"] == nil {
			t := now
			last["disk"] = &t
			sent = append(sent, "disk")
			send(fmt.Sprintf("Resource warning on %s: disk", s.cfg.Machine),
				fmt.Sprintf("The root filesystem is %s%% used (line %s%%).\n\nStam mails this once, and again only after it drops below %s%% and crosses %s%% once more.",
					jsjson.Number(math.Floor(*m.diskPct+0.5)), jsjson.Number(line), jsjson.Number(clear), jsjson.Number(line)))
		}
	}
	if len(sent) > 0 || !sameTime(last["disk"], cfg.LastWarned["disk"]) {
		cfg.LastWarned = last
		s.storeResourceWarn(cfg)
	}
	return sent
}

func sameTime(a, b *float64) bool { return (a == nil) == (b == nil) && (a == nil || *a == *b) }

// storeResourceWarn is setSetting('resourceWarn', …) for lastWarned only, the machine-local part, set on the file's own
// resourceWarn as it is at the write. TS writes the whole key on the settings home, from the sample's read of the
// settings; a human edit of the lines or recipients in between would be reverted, so the rest of the key is left as it is.
func (s *Server) storeResourceWarn(cfg config.ResourceWarn) {
	last := jsjson.NewObject()
	for _, k := range config.ResourceWarnKinds {
		var v jsjson.Value
		if t := cfg.LastWarned[k]; t != nil {
			v = *t
		}
		last.Set(k, v)
	}
	err := s.settings.Update(func(current string) (string, error) {
		user := config.ParseObject(current)
		rw, _ := user.Get("resourceWarn")
		o, ok := rw.(*jsjson.Object)
		if !ok {
			o = jsjson.NewObject()
		}
		o.Set("lastWarned", last)
		user.Set("resourceWarn", o)
		return config.Text(user), nil
	})
	if err != nil {
		// The error names the file, never its contents.
		slog.Warn("resource warnings: storing lastWarned failed", "err", err)
	}
}

// mailWarning is src/machines.ts mailWarning: the configured recipients (none means the chief of staff), from the system
// sender system:resources, so no agent seems to report it.
func (s *Server) mailWarning(ctx context.Context, subject, body string) {
	set := s.settings.Get()
	to := set.ResourceWarn.Recipients
	if len(to) == 0 && set.ChiefOfStaff != "" {
		to = []string{set.ChiefOfStaff}
	}
	if len(to) == 0 {
		return
	}
	s.sendFromSystem(ctx, "resources", to, subject, body)
}

// StartMachines runs the sampler: a tick now, then every 5 s, each judged for the resource warnings (src/machines.ts
// startSampler).
func (s *Server) StartMachines(ctx context.Context) {
	s.machines.tick(nowMs())
	go func() {
		t := time.NewTicker(sampleEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				m := s.machines.tick(nowMs())
				if m == nil {
					continue
				}
				s.warnResources(*m, s.settings.Get().ResourceWarn, func(subject, body string) {
					s.goBg(func() { s.mailWarning(ctx, subject, body) })
				}, nowMs())
			}
		}
	}()
}

func (s *Server) machineRoutes() {
	s.handle("GET /api/health/db", s.healthDB)
	s.handle("GET /api/machines", s.listMachines)
	s.handle("GET /api/cache/agents", s.cacheAgents)
	s.handle("POST /api/machines/{id}/start", s.startMachine)
}
