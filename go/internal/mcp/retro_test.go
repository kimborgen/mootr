package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"reflect"
	"strings"
	"testing"
	"time"

	"stam/internal/client"
	"stam/internal/jsfmt"
)

// retroScenario is one scripted daemon: the routes it answers, by "METHOD /path", with a reply or {$status, $error}.
type retroScenario struct {
	By     string                     `json:"by"`
	Args   map[string]any             `json:"args"`
	Routes map[string]json.RawMessage `json:"routes"`
}

type retroCall struct {
	Method string `json:"method"`
	Path   string `json:"path"`
	Body   any    `json:"body"`
}

type retroResult struct {
	Out   *string     `json:"out,omitempty"`
	Err   *string     `json:"err,omitempty"`
	Calls []retroCall `json:"calls"`
}

// runGoScenario runs RunRetro against the scenario's routes, as retroref.mjs runs the TS one.
func runGoScenario(t *testing.T, sc retroScenario) retroResult {
	t.Helper()
	res := retroResult{Calls: []retroCall{}}
	call := func(_ context.Context, method, path string, body any, _ time.Duration) (jsfmt.Value, error) {
		var b any
		if body != nil {
			enc, err := json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(enc, &b); err != nil {
				t.Fatal(err)
			}
		}
		res.Calls = append(res.Calls, retroCall{method, path, b})
		r, ok := sc.Routes[method+" "+path]
		if !ok {
			return jsfmt.Value{}, &client.Error{Status: 404, Message: "no route " + method + " " + path}
		}
		var e struct {
			Status int    `json:"$status"`
			Error  string `json:"$error"`
		}
		if json.Unmarshal(r, &e) == nil && e.Status != 0 {
			return jsfmt.Value{}, &client.Error{Status: e.Status, Message: e.Error}
		}
		return jsfmt.Parse(r)
	}
	args, err := json.Marshal(sc.Args)
	if err != nil {
		t.Fatal(err)
	}
	a, err := jsfmt.Parse(args)
	if err != nil {
		t.Fatal(err)
	}
	out, err := RunRetro(context.Background(), call, sc.By, a)
	if err != nil {
		msg := err.Error()
		res.Err = &msg
	} else {
		res.Out = &out
	}
	return res
}

func routes(kv ...any) map[string]json.RawMessage {
	out := map[string]json.RawMessage{}
	for i := 0; i+1 < len(kv); i += 2 {
		b, err := json.Marshal(kv[i+1])
		if err != nil {
			panic(err)
		}
		out[kv[i].(string)] = b
	}
	return out
}

func merge(ms ...map[string]json.RawMessage) map[string]json.RawMessage {
	out := map[string]json.RawMessage{}
	for _, m := range ms {
		for k, v := range m {
			out[k] = v
		}
	}
	return out
}

func refuse(status int, msg string) map[string]any {
	return map[string]any{"$status": status, "$error": msg}
}

// The secrets the screens hold: none may reach a filed body.
const (
	screenToken = "Zk3pQ9vL2mXc7nB4hR8sT1yU"           // gitleaks:allow
	ghToken     = "ghp_abcdefghijklmnopqrstuvwxyz0123" // gitleaks:allow
)

func retroScenarios() []retroScenario {
	base := routes(
		"GET /api/itsas?kind=retros", []any{map[string]any{"id": "ir", "key": "S-2", "title": "Retros"}},
		"GET /api/agents?as=a1&ids=a1", []any{map[string]any{"id": "a0", "name": "other"}, map[string]any{"id": "a1", "name": "dev", "model": "claude-opus-5-5", "type": "developer"}},
		"GET /api/itsas?participant=a1", []any{
			map[string]any{"key": "S-7", "kind": "issue", "updated_at": "2026-10-02"},
			map[string]any{"key": "S-8", "kind": "issue", "updated_at": "2026-10-03"},
			map[string]any{"key": "S-9", "kind": "retro", "updated_at": "2026-10-04"},
			map[string]any{"key": "S-6", "kind": "issue", "closed_at": "x", "updated_at": "2026-10-05"},
		},
		"POST /api/itsas", map[string]any{"id": "in", "key": "S-50", "title": "x"},
	)
	file := func(args map[string]any) map[string]any {
		out := map[string]any{"kind": "improve", "title": "  Idle   pane waits ", "summary": "Wait\ton  the pane.", "details": "  It waited.\n\nLong.  ", "target": "type-developer"}
		for k, v := range args {
			out[k] = v
		}
		return out
	}
	rows := routes(
		"GET /api/itsas?kind=retro", []any{
			map[string]any{"id": "r1", "key": "S-11", "title": "Idle pane waits", "summary": "Waiting on an idle pane", "status": "idea", "body": "Kind: improve\nTarget: x\n\nThe pane stayed idle for ten minutes."},
			map[string]any{"id": "r2", "key": "S-12", "title": "Merge gate", "summary": "Gate flakes", "status": "idea", "body": "Kind: idea\n\nphone check flaked"},
			map[string]any{"id": "r3", "key": "S-13", "title": "Closed", "summary": "pane", "status": "done", "closed_at": "x", "body": ""},
			map[string]any{"id": "r4", "key": "S-14", "title": "Hidden pane", "summary": "pane idle", "status": "idea", "body": "Kind: went_well\n\nidle"},
		},
		"GET /api/itsas?kind=feedback-report", []any{
			map[string]any{"id": "f1", "key": "S-21", "title": "send_mail reply_to", "summary": "reply_to ignored", "status": "backlog", "body": "Kind: bug\nTool: send_mail\nReporter: a2\n\nThe pane reply went nowhere."},
		},
		"GET /api/itsas/r1/plus-ones", map[string]any{"count": 2},
		"GET /api/itsas/r2/plus-ones", map[string]any{"count": 1},
		"GET /api/itsas/r4/plus-ones", refuse(403, "not on the board"),
		"GET /api/itsas/f1/plus-ones", map[string]any{"count": "0"},
	)
	report := routes(
		"GET /api/itsas?kind=feedback", []any{map[string]any{"id": "fb", "key": "S-3", "title": "Feedback"}},
		"GET /api/itsas?parent=fb&kind=feedback-report", []any{
			map[string]any{"id": "f1", "key": "S-21", "title": "send_mail reply_to", "summary": "Reply_to is ignored!"},
			map[string]any{"id": "f2", "key": "S-22", "title": "closed", "summary": "the pane is stuck", "closed_at": "x"},
		},
		"GET /api/itsas/f1", map[string]any{"id": "f1", "body": "Kind: bug\nTool: send_mail\nReporter: a2\n\nDetails."},
		"POST /api/itsas/f1/post", map[string]any{"id": "m1"},
		"POST /api/itsas", map[string]any{"id": "fn", "key": "S-60"},
		"GET /api/chief-of-staff", map[string]any{"chiefOfStaff": "cos", "setting": "cos"},
		"POST /api/mail", map[string]any{"id": "m2"},
	)
	screen := routes(
		"GET /api/agents?state=all", []any{nil, map[string]any{"name": "nameless"}, map[string]any{"id": "a5", "name": "worker"}, map[string]any{"id": "a6", "name": "helper"}},
		"GET /api/agents/a5/events?type=first-prompt:screen&limit=1", []any{map[string]any{"ts": "2026-10-25T09:00:00.000Z",
			"data": fmt.Sprintf(`{"screen":["\u001b[1mready\u001b[0m   ","token=%s","export GH=%s","curl -H 'Authorization: Bearer abc.def'","%s"]}`, screenToken[:10], ghToken, strings.Repeat("x", 5)+"```")}},
		"GET /api/agents/a5/events?type=input:screen&limit=1", []any{},
		"GET /api/agents/a6/events?type=first-prompt:screen&limit=1", refuse(403, "a6 is not in your tree"),
		"GET /api/agents/a6/events?type=input:screen&limit=1", []any{map[string]any{"ts": "t", "data": `{"now":["line ` + screenToken + `", 7]}`}},
	)
	issue := func(args map[string]any) map[string]any {
		out := map[string]any{"kind": "stam_issue", "feedback_kind": "bug", "title": "Pane stuck", "summary": "  The pane is stuck. ", "details": "It stuck.", "tool": " send_mail "}
		for k, v := range args {
			out[k] = v
		}
		return out
	}
	return []retroScenario{
		{By: "a1", Args: file(map[string]any{"evidence": " gate ", "evidence_detail": " phone\n360 failed ", "when": " on a UI change "}), Routes: base},
		{By: "a1", Args: file(map[string]any{"kind": "idea", "target": nil, "title": ""}), Routes: base},
		{By: "a1", Args: file(map[string]any{"kind": nil}), Routes: base},
		{By: "a1", Args: file(map[string]any{"target": " None "}), Routes: base},
		{By: "a1", Args: file(map[string]any{"evidence": "vibes"}), Routes: base},
		{By: "a1", Args: file(map[string]any{"summary": " \n "}), Routes: base},
		{By: "a1", Args: file(map[string]any{"details": "   "}), Routes: base},
		// No Retros yet: it is created under S-1's root, else S-1, else as a root.
		{By: "a1", Args: file(nil), Routes: merge(base, routes("GET /api/itsas?kind=retros", []any{map[string]any{"id": "x", "title": "retros"}},
			"GET /api/itsas/S-1", map[string]any{"id": "i1", "parent_chain": []any{map[string]any{"id": "i0"}}}))},
		{By: "a1", Args: file(nil), Routes: merge(base, routes("GET /api/itsas?kind=retros", []any{}, "GET /api/itsas/S-1", map[string]any{"id": "i1", "parent_chain": []any{}}))},
		{By: "a1", Args: file(nil), Routes: merge(base, routes("GET /api/itsas?kind=retros", []any{}))},
		{By: "a9", Args: file(nil), Routes: merge(base, routes("GET /api/agents?as=a9&ids=a9", []any{}, "GET /api/itsas?participant=a9", []any{}))},
		{By: "a1", Args: file(nil), Routes: merge(base, routes("POST /api/itsas", refuse(403, "you may not file here")))},
		// Search: by meaning, by keyword, nothing, and only stopwords.
		{By: "a1", Args: map[string]any{"search": "the idle pane"}, Routes: merge(rows, routes("GET /api/itsas/search?q=the+idle+pane&limit=150&kind=retro%2Cfeedback-report&open=1",
			[]any{map[string]any{"id": "r2", "by": "meaning", "cosine": 0.6}, map[string]any{"id": "f1", "by": "meaning", "score": "0.3"}, map[string]any{"id": "r4", "by": "meaning", "cosine": 0.9}}))},
		{By: "a1", Args: map[string]any{"search": "idle pane"}, Routes: merge(rows, routes("GET /api/itsas/search?q=idle+pane&limit=150&kind=retro%2Cfeedback-report&open=1",
			[]any{map[string]any{"id": "r2", "by": "keyword", "score": 3}}))},
		{By: "a1", Args: map[string]any{"search": "zebra quantum"}, Routes: rows},
		{By: "a1", Args: map[string]any{"search": "the is a"}, Routes: rows},
		{By: "a1", Args: map[string]any{"search": " ?! "}, Routes: rows},
		// +1: lands, the wrong kind, a count that fails after the post, no details.
		{By: "a1", Args: map[string]any{"plus_one": " S-11 ", "details": " me too "}, Routes: merge(base, rows, routes("GET /api/itsas/S-11", map[string]any{"id": "r1", "key": "S-11", "title": "Idle pane waits", "kind": "retro"},
			"POST /api/itsas/r1/post", map[string]any{"id": "m"}))},
		{By: "a1", Args: map[string]any{"plus_one": "S-7", "details": "x"}, Routes: merge(base, routes("GET /api/itsas/S-7", map[string]any{"id": "i7", "key": "S-7", "kind": "issue"}))},
		{By: "a1", Args: map[string]any{"plus_one": "S-21", "details": "x"}, Routes: merge(base, routes("GET /api/itsas/S-21", map[string]any{"id": "f1", "key": "S-21", "title": "t", "kind": "feedback-report"},
			"POST /api/itsas/f1/post", map[string]any{"id": "m"}, "GET /api/itsas/f1/plus-ones", refuse(500, "boom")))},
		{By: "a1", Args: map[string]any{"plus_one": "S-11"}, Routes: base},
		// The final round.
		{By: "a1", Args: map[string]any{"final": true, "effort": map[string]any{"reading": 40, "implementing": 50.0, "testing": 1e1}}, Routes: routes("POST /api/agents/a1/retro-final", map[string]any{})},
		{By: "a1", Args: map[string]any{"final": true, "effort": map[string]any{}}, Routes: routes("POST /api/agents/a1/retro-final", map[string]any{})},
		{By: "a1", Args: map[string]any{"final": true}, Routes: nil},
		{By: "a1", Args: map[string]any{"final": true, "effort": map[string]any{"reading": 40, "napping": 5}}, Routes: nil},
		{By: "a1", Args: map[string]any{"final": true, "effort": map[string]any{"reading": 101}}, Routes: nil},
		{By: "a1", Args: map[string]any{"final": true, "effort": map[string]any{"reading": "50"}}, Routes: nil},
		// Feedback: a repeat, a new report told to the chief of staff, with no chief of staff, a bad kind, with screens.
		{By: "a1", Args: issue(map[string]any{"summary": "reply_to ignored"}), Routes: report},
		{By: "a1", Args: issue(nil), Routes: report},
		{By: "a1", Args: issue(map[string]any{"tool": nil}), Routes: merge(report, routes("GET /api/chief-of-staff", map[string]any{"chiefOfStaff": nil}))},
		{By: "a1", Args: issue(map[string]any{"feedback_kind": "rant"}), Routes: report},
		{By: "a1", Args: issue(map[string]any{"title": nil, "details": "worker and helper showed first-prompt:screen then input:screen; nameless too"}), Routes: merge(report, screen)},
		{By: "a1", Args: issue(map[string]any{"details": "first-prompt:screen of nobody"}), Routes: merge(report, screen)},
		{By: "a1", Args: issue(map[string]any{"details": "input:screen of worker"}), Routes: merge(report, routes("GET /api/agents?state=all", refuse(403, "no list")))},
		// Feedback with no Feedback yet.
		{By: "a1", Args: issue(nil), Routes: merge(report, routes("GET /api/itsas?kind=feedback", []any{}, "GET /api/itsas?parent=fn&kind=feedback-report", []any{}))},
	}
}

// screenLines are lines that exercise redactScreen's rules, the ones written out by hand in particular.
var screenLines = []string{
	"plain text, nothing to hide",
	"Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
	"key sk-or-v1-abcdefghijklmnopqrstuvwxyz012345",
	`{"token": "hunter2value"}`,
	"run tool --token hunter2value now",
	"run --api-key   --other x",
	"run --api-key value next",
	"run -key v",
	"--token",
	"agent " + screenToken + " up",
	"git clone https://user:pa55@example.com/x",
	"tokens: 12k SECRET=x",
	"max_tokens=4096,secret=x",
	"max_tokens=1,2k3 password=y",
	"token: 4815162342",
	"tokens: 12kb",
	"dbpass=x and bypass=y",
	"compass: north, PGPASSWORD=z",
	"AWS_SECRET_ACCESS_KEY = abc",
	"monkey: banana",
	"x-api-key\"  :  \"v\"",
	"Bearer\rtoken",
	"x " + ghToken + "_tail",
	"AKIAABCDEFGHIJKLMNOP done", // gitleaks:allow
	"xoxb-1234567890-abc",
	"naïve cliché: café",
}

var screenBlocks = [][]string{
	{"key=", screenToken},
	{"token=Zk3pQ9vL2mXc7nB4hR8s", "T1yU6wE0aJ and more"}, // gitleaks:allow
	{"ready to go.", "Next: merge"},
	{"\u001b]0;title\u0007hi", "  │ token=" + screenToken + " │", "  │ continued │", "", " "},
	append(make([]string, 45), "last"),
	{strings.Repeat("é", 3500)},
	{"```", "a ```` b"},
}

func init() {
	for i := range screenBlocks[4][:45] {
		screenBlocks[4][i] = fmt.Sprintf("line %d", i)
	}
}

// TestRetroMatchesTS runs every scenario through src/retro.ts runRetro (testdata/retroref.mjs) and RunRetro, and the
// screen lines through both redactions: the replies, the errors and the daemon calls must be the same.
func TestRetroMatchesTS(t *testing.T) {
	scs := retroScenarios()
	in, err := json.Marshal(map[string]any{"scenarios": scs, "redact": screenLines, "bounded": screenBlocks})
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("node", "--no-warnings", "testdata/retroref.mjs")
	cmd.Stdin = bytes.NewReader(in)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("retroref.mjs: %v\n%s", err, stderr.String())
	}
	var ts struct {
		Scenarios []retroResult `json:"scenarios"`
		Redact    []string      `json:"redact"`
		Bounded   []struct {
			Text      string `json:"text"`
			Truncated bool   `json:"truncated"`
		} `json:"bounded"`
	}
	if err := json.Unmarshal(out, &ts); err != nil {
		t.Fatalf("retroref.mjs output: %v", err)
	}
	if len(ts.Scenarios) != len(scs) || len(ts.Redact) != len(screenLines) || len(ts.Bounded) != len(screenBlocks) {
		t.Fatalf("retroref.mjs answered %d scenarios, %d lines, %d blocks", len(ts.Scenarios), len(ts.Redact), len(ts.Bounded))
	}
	// A few replies as TS gives them, so a comparison of two empty sides can't pass.
	for i, want := range map[int]string{0: `Filed S-50 "Idle pane waits" [idea] under Retros.`, 12: "Ranked by meaning and words.", 13: "Ranked by keyword.", 21: "Recorded the final retro round for a1: implementing 50%, reading 40%, testing 10%.", 22: "Recorded the final retro round for a1: no effort."} {
		if o := ts.Scenarios[i].Out; o == nil || !strings.HasPrefix(*o, want) {
			b, _ := json.Marshal(ts.Scenarios[i])
			t.Errorf("ts scenario %d: %s, want %q", i, b, want)
		}
	}
	for i, sc := range scs {
		goRes := runGoScenario(t, sc)
		want, _ := json.Marshal(ts.Scenarios[i])
		got, _ := json.Marshal(goRes)
		var w, g any
		_ = json.Unmarshal(want, &w)
		_ = json.Unmarshal(got, &g)
		if !reflect.DeepEqual(w, g) {
			t.Errorf("scenario %d (%v):\n ts: %s\n go: %s", i, sc.Args, want, got)
		}
	}
	for i, l := range screenLines {
		if got := redactScreen(l); got != ts.Redact[i] {
			t.Errorf("redactScreen(%q) = %q, ts %q", l, got, ts.Redact[i])
		}
	}
	for i, b := range screenBlocks {
		text, trunc := boundedScreen(b)
		if text != ts.Bounded[i].Text || trunc != ts.Bounded[i].Truncated {
			t.Errorf("boundedScreen %d = %q %v, ts %q %v", i, text, trunc, ts.Bounded[i].Text, ts.Bounded[i].Truncated)
		}
	}
	// No secret reaches a filed report.
	for _, r := range ts.Scenarios {
		for _, c := range r.Calls {
			b, _ := json.Marshal(c.Body)
			for _, secret := range []string{screenToken, ghToken, "abc.def"} {
				if strings.Contains(string(b), secret) {
					t.Errorf("%s %s carries %q", c.Method, c.Path, secret)
				}
			}
		}
	}
}

// TestFeedbackToolArgs: the feedback tool is retro with kind=stam_issue, its kind the report's feedback_kind.
func TestFeedbackToolArgs(t *testing.T) {
	var got []string
	call := func(_ context.Context, method, path string, body any, _ time.Duration) (jsfmt.Value, error) {
		got = append(got, method+" "+path)
		return jsfmt.Value{}, &client.Error{Status: 500, Message: "stop"}
	}
	a, _ := jsfmt.Parse([]byte(`{"kind":"rant","summary":"s","details":"d"}`))
	if _, err := feedbackRun(context.Background(), call, "a1", a); err == nil || err.Error() != "kind must be one of bug, inconsistency, missing_param, missing_feature, other" {
		t.Errorf("a bad feedback kind: %v", err)
	}
	a, _ = jsfmt.Parse([]byte(`{"kind":"bug","summary":"s","details":"d"}`))
	if _, err := feedbackRun(context.Background(), call, "a1", a); err == nil || err.Error() != "stop" || len(got) != 1 || got[0] != "GET /api/itsas?kind=feedback" {
		t.Errorf("a bug report: %v %v", err, got)
	}
}
