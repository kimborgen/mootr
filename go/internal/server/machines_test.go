package server

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"stam/internal/jsfmt"
)

// fixedProc is a /proc with one fixed reading (test/e2e-resource-warn.sh's): 2 cores, 4 of 16 GB of RAM used, no swap
// in use, and a load of 9/8/7.
func fixedProc(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	files := map[string]string{
		"stat":    "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0 0 0\ncpu1 50 0 50 400 0 0 0 0 0 0\n",
		"meminfo": "MemTotal:       16000000 kB\nMemFree:         1000000 kB\nMemAvailable:   12000000 kB\nSwapTotal:       2000000 kB\nSwapFree:        2000000 kB\n",
		"loadavg": "9.00 8.00 7.00 1/200 1234\n",
	}
	for name, text := range files {
		must(t, os.WriteFile(filepath.Join(dir, name), []byte(text), 0o600))
	}
	t.Setenv("STAM_PROC_DIR", dir)
}

func machineRows(t *testing.T, f *fixture, c call) []map[string]any {
	t.Helper()
	rec := f.do(c)
	if rec.Code != 200 {
		t.Fatalf("GET /api/machines: %d %s", rec.Code, rec.Body.String())
	}
	var rows []map[string]any
	must(t, json.Unmarshal(rec.Body.Bytes(), &rows))
	return rows
}

// The busy share is everything but idle and iowait, over the jiffies since the previous read; the reading is the mean
// over the last minute, the bytes and load from the latest sample.
func TestParseStatAndSummarize(t *testing.T) {
	total, cores := parseStat("cpu  10 0 10 70 10 0 0 0\ncpu0 5 0 5 35 5\ncpu1 5 0 5 35 5\nintr 1 2\n")
	if total != (cpuCounters{busy: 20, total: 100}) || len(cores) != 2 || cores[1] != (cpuCounters{busy: 10, total: 50}) {
		t.Fatalf("parseStat: %+v %+v", total, cores)
	}
	if got := cpuPct(cpuCounters{busy: 30, total: 120}, total); got != 50 {
		t.Errorf("cpuPct = %v, want 50", got)
	}
	if got := cpuPct(total, total); got != 0 {
		t.Errorf("no jiffies since the last read: %v", got)
	}
	if got := parseLoadavg("1.5 x 3 1/2 9"); !reflect.DeepEqual(got, []float64{1.5, 0, 3}) {
		t.Errorf("parseLoadavg = %v", got)
	}
	if got := diskPct(100, 10, 5); got != 90/0.95 {
		t.Errorf("diskPct = %v", got)
	}
	samples := []machineSample{
		{ts: 0, cpuPct: 90, cores: []float64{90}, ramPct: 10},
		{ts: 50_000, cpuPct: 10, cores: []float64{10, 20}, ramPct: 20, ramUsed: 1, ramTotal: 2, load: []float64{1, 2, 3}},
		{ts: 100_000, cpuPct: 20, cores: []float64{30, 40}, ramPct: 30, ramUsed: 3, ramTotal: 4, load: []float64{4, 5, 6}},
	}
	r := summarize(samples, "m", 100_000)
	if !r.Online || r.CPU.Pct != 15 || !reflect.DeepEqual(r.CPU.Cores, []float64{20, 30}) || r.CPU.Count != 2 || r.RAM.Pct != 25 ||
		r.RAM.Used != 3 || r.RAM.Total != 4 || !reflect.DeepEqual(r.Load, []float64{4, 5, 6}) || r.TS != 100_000 {
		t.Errorf("summarize: %+v", r)
	}
	// Nothing in the window: the latest sample alone.
	if r := summarize(samples, "m", 500_000); r.CPU.Pct != 20 || !r.Online {
		t.Errorf("a stale buffer: %+v", r)
	}
	if r := summarize(nil, "m", 1); r.Online || r.Name != "m" || r.CPU.Cores == nil || r.Load == nil {
		t.Errorf("no samples: %+v", r)
	}
}

// GET /api/machines is this machine's reading and each peer's; a peer's own request (x-stam-local) gets only its own, and a
// peer that doesn't answer is offline. A peer row's origin is this daemon's own serve origin for it.
func TestMachinesRoute(t *testing.T) {
	fixedProc(t)
	_, ps := farDaemon(t)
	f := relayFixture(t, ps.ts.URL, "", nil)
	rows := machineRows(t, f, call{path: "/api/machines", token: sharedTok})
	if len(rows) != 2 || rows[0]["name"] != "here" || rows[1]["name"] != "far" || rows[0]["online"] != true || rows[1]["online"] != true {
		t.Fatalf("rows: %v", rows)
	}
	if _, ok := rows[0]["origin"]; ok {
		t.Errorf("this daemon serves no web UI, so its own row has no origin: %v", rows[0])
	}
	want := f.srv.peerServeOrigin(ps.ts.URL)
	if want == nil || rows[1]["origin"] != *want || rows[1]["origin"] != strings.ToLower(rows[1]["origin"].(string)) {
		t.Errorf("far's origin = %v, want %v", rows[1]["origin"], want)
	}
	if _, ok := rows[1]["terminalOrigin"]; ok {
		t.Errorf("terminalOrigin only with humanStrict: %v", rows[1])
	}
	if got := ps.last(t); got.path != "/api/machines" || got.header.Get("x-stam-local") != "1" {
		t.Errorf("far got %s %v", got.path, got.header)
	}
	cpu := rows[0]["cpu"].(map[string]any)
	ram := rows[0]["ram"].(map[string]any)
	if cpu["count"] != 2.0 || ram["total"] != 16000000.0*1024 || ram["used"] != 4000000.0*1024 {
		t.Errorf("here's reading: %v", rows[0])
	}
	if a, ok := rows[0]["agents"].(map[string]any); !ok || len(a) != 4 {
		t.Errorf("here's agents: %v", rows[0]["agents"])
	}

	local := machineRows(t, f, call{path: "/api/machines", token: peerTok, header: map[string]string{"X-Stam-Local": "1"}})
	if len(local) != 1 || local[0]["name"] != "here" {
		t.Errorf("a peer's own request: %v", local)
	}

	ps.ts.Close()
	rows = machineRows(t, f, call{path: "/api/machines", token: sharedTok})
	if len(rows) != 2 || rows[1]["name"] != "far" || rows[1]["online"] != false {
		t.Errorf("a down peer is offline, and the route still answers: %v", rows)
	}
}

// A peer's own origin and terminalOrigin are never passed on (S-544): only this daemon's, and only when it serves one.
func TestMachinesDropAPeersOrigin(t *testing.T) {
	stub := newPeerServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/health" {
			writeJSON(w, 200, map[string]any{"ok": true})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`[{"name":"far","online":true,"origin":"https://evil.example","terminalOrigin":"https://evil.example"}]`))
	}))
	for _, key := range []string{"", "k"} {
		f := relayFixture(t, stub.ts.URL, `"auth":{"humanStrict":true}`, map[string]string{"STAM_TEST_HUMAN_KEY": key})
		rows := machineRows(t, f, call{path: "/api/machines", token: sharedTok})
		if len(rows) != 2 {
			t.Fatalf("rows: %v", rows)
		}
		far := rows[1]
		if key == "" {
			if _, ok := far["origin"]; ok {
				t.Errorf("no serve origin, so none: %v", far)
			}
			if _, ok := far["terminalOrigin"]; ok {
				t.Errorf("no serve origin, so no terminal origin: %v", far)
			}
			continue
		}
		want := strings.ToLower(stub.ts.URL)
		if far["origin"] != want || far["terminalOrigin"] != want {
			t.Errorf("origins %v %v, want %s", far["origin"], far["terminalOrigin"], want)
		}
	}
}

// Only the human may start a machine: neither an agent nor the shared token with a bare x-stam-human.
func TestStartMachineIsTheHumans(t *testing.T) {
	f := relayFixture(t, "http://127.0.0.1:1", "", nil)
	for _, c := range []call{
		{method: "POST", path: "/api/machines/far/start", token: agentTok},
		{method: "POST", path: "/api/machines/far/start", token: sharedTok, header: map[string]string{"X-Stam-Human": "1"}},
	} {
		rec := f.do(c)
		if rec.Code != 403 || !strings.HasPrefix(errorOf(t, rec), "only the human can start a machine, ") {
			t.Errorf("%s: %d %s", c.token, rec.Code, rec.Body.String())
		}
	}
	rec := f.do(call{method: "POST", path: "/api/machines/nosuch/start", token: sharedTok, header: humanHdr})
	if rec.Code != 404 || errorOf(t, rec) != "no machine nosuch" {
		t.Errorf("an unknown machine: %d %s", rec.Code, rec.Body.String())
	}
	rec = f.do(call{method: "POST", path: "/api/machines/far/start", token: sharedTok, header: humanHdr})
	if rec.Code != 503 || !strings.Contains(errorOf(t, rec), "no start command") || strings.Contains(rec.Body.String(), peerTok) || strings.Contains(rec.Body.String(), sharedTok) {
		t.Errorf("a peer with no start command: %d %s", rec.Code, rec.Body.String())
	}
	rec = f.do(call{method: "POST", path: "/api/machines/a%20b/start", token: sharedTok, header: humanHdr})
	if rec.Code != 404 {
		t.Errorf("a name the route doesn't match: %d %s", rec.Code, rec.Body.String())
	}
}

func TestHealthDB(t *testing.T) {
	f := newFixture(t, nil)
	rec := f.do(call{path: "/api/health/db", token: sharedTok})
	var got map[string]any
	must(t, json.Unmarshal(rec.Body.Bytes(), &got))
	if rec.Code != 200 || got["ok"] != true || got["machine"] != "test-machine" || got["agents"].(float64) < 1 {
		t.Errorf("%d %s", rec.Code, rec.Body.String())
	}
}

// GET /api/cache/agents lists this machine's agents with their account and latest cache window, then each peer's; a
// peer that doesn't answer is offline, one without the route outdated.
func TestCacheAgents(t *testing.T) {
	// A release without the route: up, but 404 for it.
	stub := newPeerServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/health" {
			writeJSON(w, 200, map[string]any{"ok": true})
			return
		}
		writeJSON(w, 404, map[string]any{"error": "no route"})
	}))
	f := relayFixture(t, stub.ts.URL, `"cost":{"accounts":{"max":{"match":{"harness":"claude"},"paid":true}}}`, nil)
	f.sql("UPDATE agents SET machine = 'here', harness = 'claude' WHERE id = 'achild'")
	f.sql(`INSERT INTO events (ts, type, agent_id, data) VALUES ('2026-10-01T00:00:00.000Z', 'cache:ttl', 'achild', '{"ttl":"1h"}')`)
	f.sql(`INSERT INTO events (ts, type, agent_id, data) VALUES ('2026-10-02T00:00:00.000Z', 'cache:ttl', 'achild', '{"ttl":"5m"}')`)
	rec := f.do(call{path: "/api/cache/agents", token: sharedTok})
	var got struct {
		Agents   []map[string]any `json:"agents"`
		Offline  []string         `json:"offline"`
		Outdated []string         `json:"outdated"`
	}
	must(t, json.Unmarshal(rec.Body.Bytes(), &got))
	if rec.Code != 200 || len(got.Agents) != 1 || len(got.Offline) != 0 || !reflect.DeepEqual(got.Outdated, []string{"far"}) {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	a := got.Agents[0]
	if a["id"] != "achild" || a["account"] != "max" || a["paid"] != true || a["ttl"] != "5m" || a["ttl_at"] != "2026-10-02T00:00:00.000Z" {
		t.Errorf("achild: %v", a)
	}
	if !strings.HasPrefix(rec.Body.String(), `{"agents":[{"id":"achild","name":`) {
		t.Errorf("key order: %s", rec.Body.String())
	}

	stub.ts.Close()
	rec = f.do(call{path: "/api/cache/agents", token: sharedTok})
	must(t, json.Unmarshal(rec.Body.Bytes(), &got))
	if rec.Code != 200 || !reflect.DeepEqual(got.Offline, []string{"far"}) || len(got.Outdated) != 0 {
		t.Errorf("a down peer: %d %s", rec.Code, rec.Body.String())
	}
}

// usage_info's machines are compact: no per-core arrays, GB, the one-minute load.
func TestUsageMachinesCompact(t *testing.T) {
	fixedProc(t)
	f := newFixture(t, nil)
	rows, err := f.srv.allMachines(t.Context(), true)
	must(t, err)
	b, err := json.Marshal(compactMachine(rows[0]))
	must(t, err)
	want := `{"name":"test-machine","online":true,"cores":2,"cpu_pct":0,"ram_pct":25,"ram_used_gb":3.8,"ram_total_gb":15.3,"swap_pct":0,"load_1m":9,"agents":{`
	if !strings.HasPrefix(string(b), want) {
		t.Errorf("compact = %s\nwant prefix %s", b, want)
	}
	off, err := json.Marshal(compactMachine(toValue(offlineReading("gone", 1))))
	must(t, err)
	if string(off) != `{"name":"gone","online":false,"cores":0,"cpu_pct":0,"ram_pct":0,"ram_used_gb":0,"ram_total_gb":0,"swap_pct":0,"load_1m":null,"agents":{"working":0,"waiting":0,"idle":0,"paused":0}}` {
		t.Errorf("offline compact = %s", off)
	}
	oldRow, err := jsfmt.Parse([]byte(`{"name":"old","online":true}`))
	must(t, err)
	old, err := json.Marshal(compactMachine(oldRow))
	must(t, err)
	if string(old) != `{"name":"old","online":true,"cores":null,"cpu_pct":null,"ram_pct":null,"ram_used_gb":null,"ram_total_gb":null,"swap_pct":null,"load_1m":null,"agents":null}` {
		t.Errorf("an older peer's reading = %s", old)
	}
}

// The warnings: cpu, ram and swap mail at most once per repeatMinutes; the disk once per crossing, re-armed only once it
// drops diskClearMargin below its line. When each last mailed is kept in settings.
func TestResourceWarnings(t *testing.T) {
	f := newFixture(t, nil)
	must(t, os.WriteFile(filepath.Join(f.home, "settings.json"), []byte(`{"chiefOfStaff":"cos","resourceWarn":{"diskPct":90}}`), 0o600))
	disk := func(p float64) *float64 { return &p }
	hot := machineSample{cores: []float64{0, 0}, load: []float64{9, 8, 7}, ramUsed: 4 * gib, ramTotal: 16 * gib, diskPct: disk(95)}
	type mail struct{ subject, body string }
	var sent []mail
	send := func(subject, body string) { sent = append(sent, mail{subject, body}) }
	warn := func(m machineSample, now float64) []string {
		sent = nil
		return f.srv.warnResources(m, f.srv.settings.Get().ResourceWarn, send, now)
	}

	if got := warn(hot, 1_000_000); !reflect.DeepEqual(got, []string{"cpu", "disk"}) {
		t.Fatalf("a hot sample sends %v", got)
	}
	if sent[0].subject != "Resource warning on test-machine: CPU load" ||
		!strings.Contains(sent[0].body, "The 5-minute load is 4.00 per core on 2 cores (line 2).") ||
		!strings.Contains(sent[1].body, "The root filesystem is 95% used (line 90%).") {
		t.Errorf("mails: %+v", sent)
	}
	b, err := os.ReadFile(filepath.Join(f.home, "settings.json"))
	must(t, err)
	var file struct {
		ChiefOfStaff string `json:"chiefOfStaff"`
		ResourceWarn struct {
			DiskPct    float64             `json:"diskPct"`
			LastWarned map[string]*float64 `json:"lastWarned"`
		} `json:"resourceWarn"`
	}
	must(t, json.Unmarshal(b, &file))
	if lw := file.ResourceWarn.LastWarned; file.ChiefOfStaff != "cos" || file.ResourceWarn.DiskPct != 90 || lw["cpu"] == nil || *lw["cpu"] != 1_000_000 ||
		lw["disk"] == nil || *lw["disk"] != 1_000_000 || lw["ram"] != nil {
		t.Errorf("settings.json: %s", b)
	}

	if got := warn(hot, 1_000_000+29*60_000); len(got) != 0 {
		t.Errorf("inside repeatMinutes: %v", got)
	}
	if got := warn(hot, 1_000_000+30*60_000); !reflect.DeepEqual(got, []string{"cpu"}) {
		t.Errorf("after repeatMinutes the cpu again, the disk not: %v", got)
	}
	cool := hot
	cool.diskPct = disk(80)
	cool.load = []float64{0, 0, 0}
	if got := warn(cool, 3_000_000); len(got) != 0 {
		t.Errorf("a cool sample: %v", got)
	}
	if lw := f.srv.settings.Get().ResourceWarn.LastWarned; lw["disk"] != nil {
		t.Errorf("below the clear line the disk re-arms: %v", lw["disk"])
	}
	if got := warn(hot, 3_000_001); !reflect.DeepEqual(got, []string{"disk"}) {
		t.Errorf("the disk crosses again: %v", got)
	}

	must(t, os.WriteFile(filepath.Join(f.home, "settings.json"), []byte(`{"resourceWarn":{"enabled":false}}`), 0o600))
	if got := warn(hot, 9_000_000); len(got) != 0 {
		t.Errorf("disabled: %v", got)
	}
}

// Storing lastWarned keeps the rest of resourceWarn as the file has it at the write: an edit made after the sample read
// the settings isn't reverted.
func TestResourceWarnKeepsAnEdit(t *testing.T) {
	f := newFixture(t, nil)
	path := filepath.Join(f.home, "settings.json")
	must(t, os.WriteFile(path, []byte(`{"resourceWarn":{"diskPct":90}}`), 0o600))
	cfg := f.srv.settings.Get().ResourceWarn
	must(t, os.WriteFile(path, []byte(`{"chiefOfStaff":"cos","resourceWarn":{"diskPct":70,"recipients":["ops"],"note":"kept"}}`), 0o600))
	hot := machineSample{cores: []float64{0}, load: []float64{0, 0, 0}, diskPct: func() *float64 { d := 95.0; return &d }()}
	if got := f.srv.warnResources(hot, cfg, func(string, string) {}, 5_000); !reflect.DeepEqual(got, []string{"disk"}) {
		t.Fatalf("sent %v", got)
	}
	b, err := os.ReadFile(path)
	must(t, err)
	var file struct {
		ChiefOfStaff string         `json:"chiefOfStaff"`
		ResourceWarn map[string]any `json:"resourceWarn"`
	}
	must(t, json.Unmarshal(b, &file))
	rw := file.ResourceWarn
	last, _ := rw["lastWarned"].(map[string]any)
	if file.ChiefOfStaff != "cos" || rw["diskPct"] != 70.0 || !reflect.DeepEqual(rw["recipients"], []any{"ops"}) || rw["note"] != "kept" || last["disk"] != 5_000.0 {
		t.Errorf("settings.json: %s", b)
	}
	if _, ok := rw["enabled"]; ok {
		t.Errorf("a key the file didn't hold was written: %s", b)
	}
}
