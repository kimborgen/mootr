package main

import (
	"os"
	"strings"
	"testing"

	"stam/internal/jsfmt"
)

func TestReqNewSendsTheTSFields(t *testing.T) {
	s := newStub(t, map[string]func(int) (int, string){
		"POST /api/requirements": fixed(200, `{"key":"R-3","title":"No secrets in logs"}`),
	})
	o := runCLI(t, map[string]string{"STAM_URL": s.URL, "STAM_AGENT_ID": "a1"}, "", "req", "new", "No", "secrets", "in", "logs",
		"--threshold", "0.7", "--verify", "test:npm test", "--verify", "pattern", "--scope", "paths=src/**, docs/**", "--scope", "repos=stam2", "--severity", "high")
	if o.code != 0 || o.stdout != "R-3  No secrets in logs\n" {
		t.Fatalf("req new = %+v", o)
	}
	want := `{"severity":"high","threshold":0.7,"verification":[{"method":"test","detail":"npm test"},"pattern"],"scope":{"paths":["src/**","docs/**"],"repos":["stam2"]},"title":"No secrets in logs","by":"a1"}`
	if s.calls[0].body != want {
		t.Fatalf("body = %s\nwant %s", s.calls[0].body, want)
	}
}

func TestReqThresholdNotANumberIsNull(t *testing.T) {
	s := newStub(t, map[string]func(int) (int, string){
		"PATCH /api/requirements/R-1": fixed(200, `{"requirement":{"key":"R-1"},"changes":{"threshold":{"from":0.5,"to":null}}}`),
	})
	o := runCLI(t, map[string]string{"STAM_URL": s.URL}, "", "req", "set", "R-1", "--threshold", "lots")
	if o.code != 0 || o.stdout != "R-1: threshold: 0.5 -> -\n" || s.calls[0].body != `{"threshold":null}` {
		t.Fatalf("req set = %+v, body %s", o, s.calls[0].body)
	}
	if o := runCLI(t, map[string]string{"STAM_URL": s.URL}, "", "req", "set", "R-1"); o.code != 1 || !strings.Contains(o.stderr, "usage: stam req set REF") {
		t.Fatalf("req set without a change = %+v", o)
	}
	if o := runCLI(t, map[string]string{"STAM_URL": s.URL}, "", "req", "new", "x", "--scope", "nofield"); o.code != 1 || !strings.Contains(o.stderr, "--scope takes field=a,b (got nofield)") {
		t.Fatalf("bad scope = %+v", o)
	}
}

func TestReqCheckAndLsPrintTheTSLines(t *testing.T) {
	s := newStub(t, map[string]func(int) (int, string){
		"POST /api/requirements/check": fixed(200, `{"subject":"diff","results":[{"key":"R-1","verdict":"violates","p_violates":0.125,"cached":true},{"key":"R-2","verdict":"unknown"}]}`),
		"GET /api/requirements":        fixed(200, `[{"key":"R-1","status":"active","owner":null,"title":"A"},{"key":"R-22","title":"B","owner":"w"}]`),
	})
	vars := map[string]string{"STAM_URL": s.URL}
	o := runCLI(t, vars, "", "req", "check", "diff", "--text", "the change", "--keys", "R-1,R-2")
	if o.stdout != "diff\nR-1\tviolates\tp(violates) 0.13\t(cached)\nR-2\tunknown\tp(violates) -\n" {
		t.Fatalf("req check = %q", o.stdout)
	}
	if s.calls[0].body != `{"text":"the change","subject":"diff","keys":"R-1,R-2"}` {
		t.Fatalf("check body = %s", s.calls[0].body)
	}
	o = runCLI(t, vars, "", "req", "ls", "--status", "active", "no", "logs")
	if o.stdout != "R-1    active     -                A\nR-22   undefined  w                B\n" {
		t.Fatalf("req ls = %q", o.stdout)
	}
	if s.calls[1].path != "/api/requirements?status=active&text=no+logs" {
		t.Fatalf("ls path = %s", s.calls[1].path)
	}
	if o := runCLI(t, vars, "", "req"); o.code != 1 || !strings.Contains(o.stderr, reqUsage) {
		t.Fatalf("bare req = %+v", o)
	}
}

func TestReqCheckWithNoResults(t *testing.T) {
	s := newStub(t, map[string]func(int) (int, string){
		"POST /api/requirements/check": fixed(200, `{"subject":"text","results":[]}`),
	})
	o := runCLI(t, map[string]string{"STAM_URL": s.URL}, "", "req", "check", "--text", "x")
	if o.stdout != "text: no requirement in scope, or no answer\n" || s.calls[0].body != `{"text":"x"}` {
		t.Fatalf("req check = %+v, body %s", o, s.calls[0].body)
	}
}

func TestToFixed2(t *testing.T) {
	for in, want := range map[string]string{"0.125": "0.13", "0.5": "0.50", "1": "1.00", "0.004": "0.00", "0.005": "0.01", "0.015": "0.01", "-0.125": "-0.13", "0.999": "1.00"} {
		v, _ := jsfmt.Parse([]byte(`{"p":` + in + `}`))
		if got := toFixed2(v, "p"); got != want {
			t.Errorf("toFixed2(%s) = %s, want %s", in, got, want)
		}
	}
	v, _ := jsfmt.Parse([]byte(`{"p":null}`))
	if toFixed2(v, "p") != "-" || toFixed2(v, "q") != "-" {
		t.Errorf("null or absent is not -")
	}
}

func TestRingStartSendsTheTSBody(t *testing.T) {
	s := newStub(t, map[string]func(int) (int, string){
		"POST /api/rings": fixed(200, `{"id":"r1","name":"design"}`),
	})
	o := runCLI(t, map[string]string{"STAM_URL": s.URL}, "", "ring", "design", "pick", "a", "db", "--members", "w1,,w2", "--spawn", "fast,claude-haiku-5-5,openrouter/x/y", "--decide", "--rounds", "3")
	if o.code != 0 || o.stdout != "ring design (r1) started; the result arrives in your inbox\n" {
		t.Fatalf("ring = %+v", o)
	}
	want := `{"name":"design","topic":"pick a db","format":"rounds","members":["w1","w2"],"spawn":[{"preset":"fast"},{"harness":"claude","model":"claude-haiku-5-5"},{"harness":"opencode","model":"openrouter/x/y"}],"moderator_decides":true,"max_rounds":"3","cwd":"/work/dir"}`
	if s.calls[0].body != want {
		t.Fatalf("body = %s\nwant %s", s.calls[0].body, want)
	}
}

func TestRingListAndShow(t *testing.T) {
	s := newStub(t, map[string]func(int) (int, string){
		"GET /api/rings":   fixed(200, `[{"id":"r1","name":"d","format":"rounds","status":"running","round":1,"max_rounds":3}]`),
		"GET /api/rings/d": fixed(200, `{"id":"r1","members":[]}`),
	})
	vars := map[string]string{"STAM_URL": s.URL}
	if o := runCLI(t, vars, "", "ring"); o.stdout != "r1  d  rounds  running  round 1/3\n" {
		t.Fatalf("ring ls = %q", o.stdout)
	}
	if o := runCLI(t, vars, "", "ring", "d"); o.stdout != "{\n  \"id\": \"r1\",\n  \"members\": []\n}\n" {
		t.Fatalf("ring show = %q", o.stdout)
	}
}

func TestPermissionsListsHumanThenDelegatedDialogs(t *testing.T) {
	s := newStub(t, map[string]func(int) (int, string){
		"GET /api/permissions": func(n int) (int, string) {
			if n == 1 {
				return 200, `[{"id":"p1","agent_id":"a1","action":"rm -rf build","reason":"clean","details":"in /w"},{"id":"p2","agent_id":"a2","action":"push","reason":"ship"}]`
			}
			return 200, `[{"id":"p3","agent_id":"a3","action":"Trust?","dialog":true,"with":["mgr","cos"]},{"id":"p4","agent_id":"a4","action":"x"},{"id":"p5","agent_id":"a5","action":"y","dialog":true}]`
		},
	})
	o := runCLI(t, map[string]string{"STAM_URL": s.URL}, "", "permissions")
	want := "p1  a1  rm -rf build\n        why: clean\n        details: in /w\np2  a2  push\n        why: ship\n" +
		"\nWith a parent or the chief of staff, who deny it or send it on to you:\np3  a3  Trust?\n        with: @mgr, @cos\np5  a5  y\n        with: its reviewers\n"
	if o.code != 0 || o.stdout != want {
		t.Fatalf("permissions = %q", o.stdout)
	}
	if s.calls[0].path != "/api/permissions?status=pending&audience=human" || s.calls[1].path != "/api/permissions?status=pending&audience=delegate" {
		t.Fatalf("paths = %s, %s", s.calls[0].path, s.calls[1].path)
	}
}

func TestAuthorizeAndDeny(t *testing.T) {
	s := newStub(t, map[string]func(int) (int, string){
		"POST /api/permissions/p1/answer": func(n int) (int, string) {
			switch n {
			case 1:
				return 200, `{"id":"p1","status":"approved","typed":true}`
			case 2:
				return 200, `{"id":"p1","status":"approved"}`
			}
			return 200, `{"id":"p1","status":"denied"}`
		},
	})
	vars := map[string]string{"STAM_URL": s.URL}
	if o := runCLI(t, vars, "", "authorize", "p1", "go", "ahead"); o.stdout != "p1: approved, typed into the agent's input as yours\n" {
		t.Fatalf("authorize typed = %+v", o)
	}
	if o := runCLI(t, vars, "", "authorize", "p1"); o.stdout != "p1: approved; the agent was busy or had a draft, so it got a notice instead\n" {
		t.Fatalf("authorize notice = %+v", o)
	}
	if o := runCLI(t, vars, "", "deny", "p1", "no"); o.stdout != "p1: denied\n" {
		t.Fatalf("deny = %+v", o)
	}
	bodies := []string{`{"approve":true,"note":"go ahead"}`, `{"approve":true,"note":""}`, `{"approve":false,"note":"no"}`}
	for i, b := range bodies {
		if s.calls[i].body != b {
			t.Errorf("call %d body = %s, want %s", i, s.calls[i].body, b)
		}
	}
}

func TestAnAgentCantAnswerFromTheCLI(t *testing.T) {
	s := newStub(t, map[string]func(int) (int, string){})
	for _, name := range []string{"STAM_AGENT_ID", "MOOTR_AGENT_ID"} {
		for _, cmd := range []string{"authorize", "deny"} {
			o := runCLI(t, map[string]string{"STAM_URL": s.URL, name: "a1"}, "", cmd, "p1")
			if o.code != 1 || !strings.Contains(o.stderr, "only the human answers permission requests from the CLI") {
				t.Fatalf("%s with %s = %+v", cmd, name, o)
			}
		}
	}
	if len(s.calls) != 0 {
		t.Fatalf("an agent's answer reached the daemon: %+v", s.calls)
	}
}

func TestAnswerIDIsOnePathSegment(t *testing.T) {
	s := newStub(t, map[string]func(int) (int, string){})
	runCLI(t, map[string]string{"STAM_URL": s.URL}, "", "authorize", "../agents/x")
	if len(s.calls) != 1 || s.calls[0].path != "/api/permissions/..%2Fagents%2Fx/answer" {
		t.Fatalf("calls = %+v", s.calls)
	}
}

func TestRingStartInsideAnAgentNamesItsCreator(t *testing.T) {
	s := newStub(t, map[string]func(int) (int, string){
		"POST /api/rings": fixed(200, `{"id":"r2","name":"mine"}`),
	})
	for _, name := range []string{"STAM_AGENT_ID", "MOOTR_AGENT_ID"} {
		o := runCLI(t, map[string]string{"STAM_URL": s.URL, name: "a7"}, "", "ring", "mine", "topic", "--members", "w1", "--cwd", "/c")
		if o.code != 0 || o.stdout != "ring mine (r2) started; the result arrives in your inbox\n" {
			t.Fatalf("ring with %s = %+v", name, o)
		}
	}
	want := `{"name":"mine","topic":"topic","format":"rounds","members":["w1"],"spawn":[],"cwd":"/c","by":"a7"}`
	for i, c := range s.calls {
		if c.body != want {
			t.Errorf("call %d body = %s\nwant %s", i, c.body, want)
		}
	}
}

func TestReqShowSeedAndLink(t *testing.T) {
	dir := t.TempDir()
	list, obj, bare := dir+"/list.json", dir+"/obj.json", dir+"/bare.json"
	os.WriteFile(list, []byte(`[{"title":"A"},{"title":"B"}]`), 0o600)
	os.WriteFile(obj, []byte(`{"requirements":[{"title":"C"}]}`), 0o600)
	os.WriteFile(bare, []byte(`{"other":1}`), 0o600)
	s := newStub(t, map[string]func(int) (int, string){
		"GET /api/requirements/R-1": fixed(200, `{"key":"R-1","links":[]}`),
		"POST /api/requirements/batch": func(n int) (int, string) {
			switch n {
			case 1:
				return 200, `{"requirements":[{"key":"R-8","title":"A"},{"key":"R-9","title":"B"}],"approval":{"itsa":"S-40","to":"chief of staff"}}`
			case 2:
				return 200, `{"requirements":[{"key":"R-10","title":"C"}],"approval":{"error":"no chief of staff"}}`
			}
			return 200, `{"requirements":[]}`
		},
		"POST /api/requirements/R-1/links":     fixed(200, `{"id":4,"target_kind":"itsa","role":"implements","target":"S-3"}`),
		"DELETE /api/requirements/R-1/links/4": fixed(200, `{}`),
	})
	vars := map[string]string{"STAM_URL": s.URL, "STAM_AGENT_ID": "a1"}
	steps := []struct {
		args []string
		out  string
		body string
	}{
		{[]string{"req", "show", "R-1"}, "{\n  \"key\": \"R-1\",\n  \"links\": []\n}\n", ""},
		{[]string{"req", "seed", list}, "R-8    A\nR-9    B\n2 drafts; approval ask S-40 (to chief of staff)\n", `{"requirements":[{"title":"A"},{"title":"B"}],"by":"a1"}`},
		{[]string{"req", "seed", obj}, "R-10   C\n1 drafts; no ask: no chief of staff\n", `{"requirements":[{"title":"C"}],"by":"a1"}`},
		{[]string{"req", "seed", bare}, "0 drafts\n", `{"by":"a1"}`},
		{[]string{"req", "link", "R-1", "S-3", "--kind", "itsa", "--role", "implements"}, "link 4: itsa implements S-3\n", `{"target":"S-3","target_kind":"itsa","role":"implements"}`},
		{[]string{"req", "link", "R-1", "--remove", "4"}, "removed link 4\n", ""},
	}
	for i, st := range steps {
		o := runCLI(t, vars, "", st.args...)
		if o.code != 0 || o.stdout != st.out {
			t.Fatalf("%v = %+v", st.args, o)
		}
		if s.calls[i].body != st.body {
			t.Errorf("%v body = %s, want %s", st.args, s.calls[i].body, st.body)
		}
	}
	if o := runCLI(t, vars, "", "req", "link", "R-1"); o.code != 1 || !strings.Contains(o.stderr, "usage: stam req link REF TARGET [--kind K] [--role R]\n") {
		t.Fatalf("link without a target = %+v", o)
	}
	if o := runCLI(t, vars, "", "req", "seed", dir+"/missing.json"); o.code != 1 {
		t.Fatalf("seed of a missing file = %+v", o)
	}
}

// A reference typed on the command line stays one path segment: a slash or a query in it can't reach another route.
func TestReqAndRingRefsAreOnePathSegment(t *testing.T) {
	s := newStub(t, map[string]func(int) (int, string){})
	vars := map[string]string{"STAM_URL": s.URL}
	runs := [][]string{
		{"req", "show", "../agents/x"},
		{"req", "set", "R-1/../x", "--status", "draft"},
		{"req", "link", "R-1?a=b", "S-1"},
		{"req", "link", "R-1", "--remove", "4/../9"},
		{"ring", "a/b"},
	}
	want := []string{
		"/api/requirements/..%2Fagents%2Fx",
		"/api/requirements/R-1%2F..%2Fx",
		"/api/requirements/R-1%3Fa=b/links",
		"/api/requirements/R-1/links/4%2F..%2F9",
		"/api/rings/a%2Fb",
	}
	for _, args := range runs {
		runCLI(t, vars, "", args...)
	}
	if len(s.calls) != len(want) {
		t.Fatalf("calls = %+v", s.calls)
	}
	for i, w := range want {
		if s.calls[i].path != w {
			t.Errorf("%v path = %s, want %s", runs[i], s.calls[i].path, w)
		}
	}
}
