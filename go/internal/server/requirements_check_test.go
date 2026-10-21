package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"stam/internal/decide"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
)

var peerLocal = map[string]string{"X-Stam-Local": "1"}

// until waits for a state, not for a time: it polls cond for up to five seconds.
func until(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if cond() {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// enforceBash writes the settings and an in-force enforcing requirement scoped to Bash, and returns its key.
func (f *fixture) enforceBash(settings string) string {
	f.t.Helper()
	writeFile(f.t, filepath.Join(f.home, "settings.json"), settings)
	return f.reqCreate(`{"title":"Never leak secrets","text":"Never print a secret","verification":["decision"],"scope":{"tools":["Bash"]},"mode":"enforce","owner":"child","status":"in_force"}`)
}

func (f *fixture) verdictCount() int { return f.count("SELECT count(*) FROM req_verdicts") }

// On the ITSA home a scoped tool is asked of the model and a violation is the answer to /api/steps/check, which the shim
// reads as a denial; anything the model does not condemn goes through.
func TestRequirementsToolCheckDenies(t *testing.T) {
	startDecideStub(t)
	f := newFixture(t, nil)
	f.enforceBash(reqSettings)
	if rec := f.check(sharedTok, `{"agent":"aboss","tool":"Bash","args":{"c":"ls"}}`); rec.Code != 200 || rec.Body.String() != `{"allow":true}` {
		t.Errorf("a tool the model passes: %d %s", rec.Code, rec.Body.String())
	}
	rec := f.check(sharedTok, `{"agent":"aboss","tool":"Bash","args":{"c":"REQ:R-1=violates"}}`)
	want := `{"allow":false,"requirement":"R-1","p":0.9,"error":"Denied by requirement R-1 (likely not met, p 0.90): Never print a secret. This is an indication from a model check, not proof. If it is wrong, say so to the requirement's owner (child)."}`
	if rec.Code != 200 || rec.Body.String() != want {
		t.Errorf("a violation: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.check(sharedTok, `{"agent":"aboss","tool":"Read"}`); rec.Code != 200 || rec.Body.String() != `{"allow":true}` {
		t.Errorf("a tool no requirement scopes: %d %s", rec.Code, rec.Body.String())
	}
	if n := f.verdictCount(); n != 2 {
		t.Errorf("verdicts: %d", n)
	}
}

// The peer routes answer only a peer; the index route is not read as a requirement's id.
func TestRequirementsPeerRoutes(t *testing.T) {
	startDecideStub(t)
	f := newFixture(t, nil)
	f.enforceBash(reqSettings)
	f.reqCreate(`{"title":"Edits","verification":["decision"],"scope":{"tools":["Edit","Bash"]},"mode":"enforce","status":"in_force"}`)
	for _, c := range []struct{ method, path, msg string }{
		{"POST", "/api/requirements/check-subject", "only a peer can forward a subject"},
		{"POST", "/api/requirements/check-tool", "only a peer can ask for a tool check"},
		{"GET", "/api/requirements/enforced-tools", "only a peer can read the enforced-tools index"},
		{"POST", "/api/requirements/enforced-tools/changed", "only a peer can say the index changed"},
	} {
		rec := f.post2(c.method, c.path, `{}`)
		if rec.Code != 403 || !strings.Contains(rec.Body.String(), c.msg) {
			t.Errorf("%s %s: %d %s", c.method, c.path, rec.Code, rec.Body.String())
		}
	}
	rec := f.do(call{path: "/api/requirements/enforced-tools", token: peerTok, header: peerLocal})
	if rec.Code != 200 || rec.Body.String() != `{"tools":["Bash","Edit"]}` {
		t.Errorf("the index: %d %s", rec.Code, rec.Body.String())
	}
	rec = f.do(call{method: "POST", path: "/api/requirements/check-subject", token: peerTok, header: peerLocal, body: `{"subject":{}}`})
	if rec.Code != 200 || rec.Body.String() != `{"accepted":false}` {
		t.Errorf("a subject that is not a mail: %d %s", rec.Code, rec.Body.String())
	}
	for name, body := range map[string]string{"no agent": `{"tool":"Bash"}`, "no tool": `{"agent":"aboss"}`, "bad budget": `{"agent":"aboss","tool":"Bash","budgetMs":"soon"}`} {
		rec := f.do(call{method: "POST", path: "/api/requirements/check-tool", token: peerTok, header: peerLocal, body: body})
		if rec.Code != 200 || rec.Body.String() != `{"allow":true}` {
			t.Errorf("%s: %d %s", name, rec.Code, rec.Body.String())
		}
	}
}

type fakeAsk struct {
	answers string
	fail    bool
	calls   atomic.Int32
}

func (a *fakeAsk) Decide(_ context.Context, _ jsjson.Value, _ []decide.Named, _ string, _ time.Duration) (*decide.Result, *decide.Failure) {
	a.calls.Add(1)
	if a.fail {
		return nil, &decide.Failure{Error: "boom"}
	}
	v, err := jsfmt.Parse([]byte(a.answers))
	if err != nil {
		panic(err)
	}
	return &decide.Result{Answers: v, Usage: jsfmt.Value{Kind: jsfmt.Object}}, nil
}

// A model that fails, or answers with probabilities that are not three numbers in 0..1, gives no verdict: nothing is
// stored and the tool goes through (src/req-check.ts: the requirement is skipped, the call fails open). A well-formed answer
// that violates denies.
func TestRequirementsToolCheckFailsOpenOnBadAnswers(t *testing.T) {
	f := newFixture(t, nil)
	f.enforceBash(reqSettings)
	ask := &fakeAsk{}
	f.srv.requirements.Ask = ask
	allow := func(args string) {
		t.Helper()
		if rec := f.check(sharedTok, `{"agent":"aboss","tool":"Bash","args":{"c":"`+args+`"}}`); rec.Code != 200 || rec.Body.String() != `{"allow":true}` {
			t.Errorf("%s: %d %s", args, rec.Code, rec.Body.String())
		}
	}
	ask.fail = true
	allow("model fails")
	ask.fail = false
	for name, answers := range map[string]string{
		"no answer":         `{}`,
		"no probabilities":  `{"R-1":{"choice":"violates"}}`,
		"above one":         `{"R-1":{"probabilities":{"conforms":0,"violates":1.5,"na":0}}}`,
		"below zero":        `{"R-1":{"probabilities":{"conforms":1,"violates":-0.5,"na":0}}}`,
		"a string":          `{"R-1":{"probabilities":{"conforms":0,"violates":"0.9","na":0}}}`,
		"null":              `{"R-1":{"probabilities":{"conforms":0,"violates":null,"na":0}}}`,
		"a missing key":     `{"R-1":{"probabilities":{"conforms":0.1,"violates":0.9}}}`,
		"an array":          `{"R-1":{"probabilities":[0.1,0.9,0]}}`,
		"wrong requirement": `{"R-2":{"probabilities":{"conforms":0,"violates":1,"na":0}}}`,
	} {
		ask.answers = answers
		allow(name)
	}
	if n := f.verdictCount(); n != 0 {
		t.Errorf("a bad answer stored %d verdicts", n)
	}
	ask.answers = `{"R-1":{"probabilities":{"conforms":0.1,"violates":0.9,"na":0}}}`
	if rec := f.check(sharedTok, `{"agent":"aboss","tool":"Bash","args":{"c":"good"}}`); !strings.Contains(rec.Body.String(), `"allow":false`) {
		t.Errorf("a well-formed violation: %d %s", rec.Code, rec.Body.String())
	}
	if n := f.verdictCount(); n != 1 {
		t.Errorf("verdicts: %d", n)
	}
}

// A model that does not answer within the budget lets the call through at the budget, not later.
func TestRequirementsToolCheckBudget(t *testing.T) {
	dir := startDecideStub(t)
	f := newFixture(t, nil)
	f.enforceBash(reqSettings)
	writeFile(t, filepath.Join(dir, "hang"), "1")
	t.Cleanup(func() { writeFile(t, filepath.Join(dir, "release"), "1") })
	start := time.Now()
	rec := f.do(call{method: "POST", path: "/api/requirements/check-tool", token: peerTok, header: peerLocal, body: `{"agent":"aboss","tool":"Bash","args":{"c":"STUB:HANG"},"budgetMs":300}`})
	if rec.Code != 200 || rec.Body.String() != `{"allow":true}` {
		t.Errorf("%d %s", rec.Code, rec.Body.String())
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Errorf("answered after %v, budget 300ms", d)
	}
	if n := f.verdictCount(); n != 0 {
		t.Errorf("a call that timed out stored %d verdicts", n)
	}
}

// The daily cap stops the model calls: once today's check spend reaches it, a tool goes through without a call.
func TestRequirementsDailyCap(t *testing.T) {
	dir := startDecideStub(t)
	f := newFixture(t, nil)
	f.enforceBash(`{"requirements":{"enabled":true,"dailyCapUsd":0.01},"itsa":{"ownerNotices":"off"}}`)
	calls := func() string { b, _ := os.ReadFile(filepath.Join(dir, "count")); return strings.TrimSpace(string(b)) }
	if rec := f.check(sharedTok, `{"agent":"aboss","tool":"Bash","args":{"c":"REQ:R-1=violates one"}}`); !strings.Contains(rec.Body.String(), `"allow":false`) {
		t.Fatalf("under the cap: %d %s", rec.Code, rec.Body.String())
	}
	if calls() != "1" {
		t.Fatalf("calls: %s", calls())
	}
	if rec := f.check(sharedTok, `{"agent":"aboss","tool":"Bash","args":{"c":"REQ:R-1=violates two"}}`); rec.Code != 200 || rec.Body.String() != `{"allow":true}` {
		t.Errorf("over the cap: %d %s", rec.Code, rec.Body.String())
	}
	if calls() != "1" || f.verdictCount() != 1 {
		t.Errorf("over the cap the model was asked: calls %s, verdicts %d", calls(), f.verdictCount())
	}
	// The cap says so once a day, in a `req:cap` event.
	f.check(sharedTok, `{"agent":"aboss","tool":"Bash","args":{"c":"REQ:R-1=violates three"}}`)
	if n := f.count("SELECT count(*) FROM events WHERE type = 'req:cap'"); n != 1 {
		t.Errorf("req:cap events: %d", n)
	}
	if got := dumpTyped(t, f, "SELECT data FROM events WHERE type = 'req:cap'"); !strings.Contains(jsfmt.Compact(got), `{\"spent\":0.02,\"cap\":0.01}`) {
		t.Errorf("req:cap data: %s", jsfmt.Compact(got))
	}
}

// A requirement change rebuilds the enforced-tools index; while it does, the index of before still serves, so a scoped tool
// is never let through unchecked: it is asked of the model on every call across the rebuild.
func TestRequirementsToolCheckAcrossARebuild(t *testing.T) {
	dir := startDecideStub(t)
	f := newFixture(t, nil)
	f.enforceBash(reqSettings)
	other := f.reqCreate(`{"title":"Other","status":"in_force"}`)
	hold, release := make(chan struct{}), make(chan struct{})
	f.srv.requirements.OnIndexBuild = func() {
		close(hold)
		<-release
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		f.post2("PATCH", "/api/requirements/"+other, `{"title":"Other, edited"}`)
	}()
	<-hold
	for i := 0; i < 3; i++ {
		rec := f.check(sharedTok, `{"agent":"aboss","tool":"Bash","args":{"c":"REQ:R-1=violates `+strings.Repeat("x", i+1)+`"}}`)
		if !strings.Contains(rec.Body.String(), `"allow":false`) {
			t.Errorf("call %d during the rebuild: %d %s", i, rec.Code, rec.Body.String())
		}
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "count")); strings.TrimSpace(string(b)) != "3" {
		t.Errorf("model calls during the rebuild: %s", b)
	}
	close(release)
	<-done
}

// A daemon that is not the home fetches the index as soon as requirements are switched on, not at the next poll.
func TestRequirementsRemoteIndexOnSwitchOn(t *testing.T) {
	var mu sync.Mutex
	var gets int
	home := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		gets++
		mu.Unlock()
		io.WriteString(w, `{"tools":["Edit"]}`)
	}))
	defer home.Close()
	t.Setenv("STAM_REQ_INDEX_MS", "600000")
	f := newFixture(t, nil)
	writeFile(t, filepath.Join(f.home, "settings.json"), `{"home":"farhome","peers":[{"name":"farhome","url":"`+home.URL+`","token":"t"}]}`)
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	f.srv.StartRequirements(ctx)
	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	n := gets
	mu.Unlock()
	if n != 0 {
		t.Fatalf("fetched with requirements off: %d", n)
	}
	writeFile(t, filepath.Join(f.home, "settings.json"), `{"requirements":{"enabled":true},"home":"farhome","peers":[{"name":"farhome","url":"`+home.URL+`","token":"t"}]}`)
	until(t, "the fetch after the switch", func() bool {
		f.srv.remoteIdx.mu.Lock()
		defer f.srv.remoteIdx.mu.Unlock()
		return f.srv.remoteIdx.have
	})
}

// Checks of one subject that run at once store one verdict per requirement: the cache key is unique and a loser of the race
// reads the winner's row, so every caller gets the same verdict ids.
func TestRequirementsConcurrentChecks(t *testing.T) {
	startDecideStub(t)
	f := newFixture(t, nil)
	writeFile(t, filepath.Join(f.home, "settings.json"), reqSettings)
	f.reqCreate(`{"title":"Be kind","verification":["decision"],"mode":"observe","status":"in_force"}`)
	f.reqCreate(`{"title":"Be short","verification":["decision"],"mode":"inform","status":"in_force"}`)
	const n = 8
	bodies := make([]string, n)
	var wg sync.WaitGroup
	for i := range bodies {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rec := f.post2("POST", "/api/requirements/check", `{"text":"the same text"}`)
			bodies[i] = rec.Body.String()
		}()
	}
	wg.Wait()
	ids := map[string]bool{}
	for _, b := range bodies {
		v, err := jsfmt.Parse([]byte(b))
		must(t, err)
		rs, _ := v.Get("results")
		if len(rs.Items) != 2 {
			t.Fatalf("results: %s", b)
		}
		for _, r := range rs.Items {
			id, _ := r.Get("id")
			ids[r.Text("key")+"="+id.Num] = true
		}
	}
	if len(ids) != 2 || f.verdictCount() != 2 {
		t.Errorf("ids %v, verdict rows %d", ids, f.verdictCount())
	}
}

// A daemon that is not the home keeps a copy of the home's index: it fetches at boot and every poll, and the home's push
// fetches it at once, so a tool a requirement newly names is checked from its first call.
func TestRequirementsRemoteIndexPollAndPush(t *testing.T) {
	var mu sync.Mutex
	tools := `[]`
	var gets, checks int
	home := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch r.URL.Path {
		case "/api/requirements/enforced-tools":
			gets++
			io.WriteString(w, `{"tools":`+tools+`}`)
		case "/api/requirements/check-tool":
			checks++
			io.WriteString(w, `{"allow":false,"requirement":"R-1","p":0.9,"error":"Denied by requirement R-1 (likely not met, p 0.90): no edits."}`)
		default:
			w.WriteHeader(404)
		}
	}))
	defer home.Close()
	setTools := func(v string) { mu.Lock(); tools = v; mu.Unlock() }
	count := func() int { mu.Lock(); defer mu.Unlock(); return gets }
	settings := `{"requirements":{"enabled":true},"home":"farhome","peers":[{"name":"farhome","url":"` + home.URL + `","token":"t"}]}`
	edit := `{"agent":"aboss","tool":"Edit"}`

	// The poll: a short interval picks up a change without any call or push.
	t.Setenv("STAM_REQ_INDEX_MS", "40")
	f := newFixture(t, nil)
	writeFile(t, filepath.Join(f.home, "settings.json"), settings)
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	f.srv.StartRequirements(ctx)
	until(t, "the boot fetch", func() bool { return count() > 0 })
	if rec := f.check(sharedTok, edit); rec.Body.String() != `{"allow":true}` {
		t.Errorf("a tool not in the index yet: %s", rec.Body.String())
	}
	setTools(`["Edit"]`)
	until(t, "the poll to see Edit", func() bool {
		return strings.Contains(f.check(sharedTok, edit).Body.String(), `"allow":false`)
	})
	stop()

	// The push: with a poll of a minute the home's note is what brings the change.
	t.Setenv("STAM_REQ_INDEX_MS", "60000")
	setTools(`[]`)
	f2 := newFixture(t, nil)
	writeFile(t, filepath.Join(f2.home, "settings.json"), settings)
	ctx2, stop2 := context.WithCancel(context.Background())
	defer stop2()
	f2.srv.StartRequirements(ctx2)
	until(t, "the boot fetch", func() bool { return count() > 0 })
	before := count()
	until(t, "the empty index", func() bool {
		f2.srv.remoteIdx.mu.Lock()
		defer f2.srv.remoteIdx.mu.Unlock()
		return f2.srv.remoteIdx.have
	})
	setTools(`["Edit"]`)
	if rec := f2.check(sharedTok, edit); rec.Body.String() != `{"allow":true}` {
		t.Errorf("before the push: %s", rec.Body.String())
	}
	rec := f2.do(call{method: "POST", path: "/api/requirements/enforced-tools/changed", token: peerTok, header: peerLocal, body: `{}`})
	if rec.Code != 200 || rec.Body.String() != `{"scheduled":true}` {
		t.Fatalf("changed: %d %s", rec.Code, rec.Body.String())
	}
	until(t, "the push to bring Edit", func() bool { return strings.Contains(f2.check(sharedTok, edit).Body.String(), `"allow":false`) })
	if count() <= before {
		t.Errorf("no fetch after the push")
	}
}

// The home tells its peers when a requirement changes (src/requirements.ts rebuildEnforcedTools).
func TestRequirementsHomePushesIndexChange(t *testing.T) {
	startDecideStub(t)
	var mu sync.Mutex
	var pushes []string
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		pushes = append(pushes, r.Method+" "+r.URL.Path)
		mu.Unlock()
		io.WriteString(w, `{"scheduled":true}`)
	}))
	defer peer.Close()
	f := newFixture(t, nil)
	writeFile(t, filepath.Join(f.home, "settings.json"), `{"requirements":{"enabled":true},"peers":[{"name":"other","url":"`+peer.URL+`","token":"t"}]}`)
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	f.srv.StartRequirements(ctx)
	f.reqCreate(`{"title":"Never leak secrets","verification":["decision"],"scope":{"tools":["Bash"]},"mode":"enforce","status":"in_force"}`)
	until(t, "the push", func() bool { mu.Lock(); defer mu.Unlock(); return len(pushes) > 0 })
	mu.Lock()
	defer mu.Unlock()
	if pushes[0] != "POST /api/requirements/enforced-tools/changed" {
		t.Errorf("pushed: %v", pushes)
	}
}
