package config

import (
	"bytes"
	"os/exec"
	"strings"
	"testing"

	"stam/internal/jsjson"
)

// askCases are the settings ask's cases run through Go and TS (testdata/askref.mjs).
var askCases = []string{
	`{"diff":["a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n","a\nB\nc\nd\ne\nf\ng\nh\nI\nj\nk\n"]}`,
	`{"diff":["same\n","same\n"]}`,
	`{"diff":["","{}\n"]}`,
	`{"touched":["{\"boardViews\":{\"v1\":1,\"v2\":2},\"retro\":{\"lastDigest\":\"x\",\"digest\":{}},\"a\":1}",{"boardViews":{"v1":null,"v9":{}},"retro":{},"a":2,"missing":1}]}`,
	`{"touched":["not json",{"a":1}]}`,
	`{"restore":["{\"peers\":[{\"name\":\"p\",\"url\":\"u\",\"token\":\"[redacted]\"}],\"x\":1}","{\"peers\":[{\"name\":\"p\",\"url\":\"u\",\"token\":\"T\"}]}"]}`,
	`{"restore":["{\"peers\":[{\"name\":\"p\",\"url\":\"other\",\"token\":\"[redacted]\"}]}","{\"peers\":[{\"name\":\"p\",\"url\":\"u\",\"token\":\"T\"}]}"]}`,
	`{"restore":["{\"peers\":[{\"name\":\"p\",\"token\":\"[redacted]\"},{\"name\":\"p\",\"token\":\"[redacted]\"}]}","{\"peers\":[{\"name\":\"p\",\"token\":\"T\"}]}"]}`,
	`{"restore":["{\"mcpServers\":{\"s\":{\"command\":\"c\",\"env\":{\"K\":\"[redacted]\"}}}}","{\"mcpServers\":{\"s\":{\"command\":\"c\",\"env\":{\"K\":\"V\"}}}}"]}`,
	`{"restore":["{\"mcpServers\":{\"s\":{\"command\":\"d\",\"env\":{\"K\":\"[redacted]\"}}}}","{\"mcpServers\":{\"s\":{\"command\":\"c\",\"env\":{\"K\":\"V\"}}}}"]}`,
	`{"restore":["{\"apiKey\":\"[redacted]\"}","{}"]}`,
	`{"restore":["\"[redacted]\"","\"x\""]}`,
	`{"restore":["{\"list\":[\"[redacted]\"]}","{\"list\":[\"x\"]}"]}`,
	`{"notes":["{}","{\"providers\":{\"az\":{\"kind\":\"azure\",\"endpoint\":\"https://X.example.com:443/path\",\"apiKey\":{\"secret\":\"az-key\",\"env\":\"AZ_KEY\"}},\"br\":{\"kind\":\"bedrock\",\"region\":\"us-east-1\"},\"oc\":{\"kind\":\"openai-compatible\",\"baseUrl\":\"http://127.0.0.1:8080/v1\",\"apiKey\":{\"env\":\"lower\"}},\"openrouter\":{\"apiKey\":{\"secret\":\"x\"}},\"we ird\":{\"baseUrl\":\"nope\",\"apiKey\":{\"secret\":\"Bad Name\"}},\"un\":{\"apiKey\":{\"env\":\"E\"}}}}"]}`,
	`{"notes":["{\"providers\":{\"a\":{\"baseUrl\":\"https://a.example\",\"apiKey\":{\"env\":\"E\"}}}}","{\"providers\":{\"a\":{\"baseUrl\":\"https://b.example\",\"apiKey\":{\"env\":\"E\"}}}}"]}`,
}

func goAskCase(t *testing.T, raw string) string {
	t.Helper()
	v, err := jsjson.Parse([]byte(raw))
	if err != nil {
		t.Fatalf("case %s: %v", raw, err)
	}
	c := v.(*jsjson.Object)
	arg := func(k string, i int) jsjson.Value {
		a, _ := c.Get(k)
		return a.([]jsjson.Value)[i]
	}
	switch {
	case has(c, "diff"):
		return jsjson.Stringify(UnifiedDiff(arg("diff", 0).(string), arg("diff", 1).(string), "settings now", "settings if approved"), "")
	case has(c, "touched"):
		return jsjson.Stringify(PatchTouchedText(arg("touched", 0).(string), obj(arg("touched", 1))), "")
	case has(c, "notes"):
		return jsjson.Stringify(KeyDestinationNotes(arg("notes", 0).(string), arg("notes", 1).(string)), "")
	}
	next, _ := jsjson.Parse([]byte(arg("restore", 0).(string)))
	cur, err := jsjson.Parse([]byte(arg("restore", 1).(string)))
	if err != nil {
		cur = jsjson.NewObject()
	}
	r, err := restoreRedacted(next, cur, true, "", false)
	if err != nil {
		return jsjson.Stringify(jsjson.NewObject("error", err.Error()), "")
	}
	return jsjson.Stringify(jsjson.NewObject("value", r), "")
}

func has(o *jsjson.Object, k string) bool {
	_, ok := o.Get(k)
	return ok
}

// TestAskMatchesTS runs every case through src/permissions.ts, src/settings.ts and src/textdiff.ts (testdata/askref.mjs)
// and the Go port, and wants the same answer from both.
func TestAskMatchesTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is not installed")
	}
	cmd := exec.Command("node", "--no-warnings", "testdata/askref.mjs", "["+strings.Join(askCases, ",")+"]")
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("askref.mjs: %v\n%s", err, stderr.String())
	}
	out, err := jsjson.Parse(stdout.Bytes())
	if err != nil {
		t.Fatalf("askref.mjs output %q: %v", stdout.String(), err)
	}
	want := out.([]jsjson.Value)
	if len(want) != len(askCases) {
		t.Fatalf("askref.mjs gave %d results for %d cases", len(want), len(askCases))
	}
	for i, c := range askCases {
		if got, w := goAskCase(t, c), jsjson.Stringify(want[i], ""); got != w {
			t.Errorf("case %d %s:\n go %s\n ts %s", i, c, got, w)
		}
	}
}

// TestRedactedForDiff: the diff side of an ask hides every secret, and says where one changed.
func TestRedactedForDiff(t *testing.T) {
	cur := `{"peers":[{"name":"p","token":"OLD"}],"mcpServers":{"s":{"command":"c","env":{"K":"SAME"}}}}`
	next := `{"peers":[{"name":"p","token":"NEW"}],"mcpServers":{"s":{"command":"d","env":{"K":"SAME"}}},"x":{"password":"P"}}`
	got := RedactedForDiff(cur, next)
	if strings.Contains(got, "NEW") || strings.Contains(got, "SAME") || strings.Contains(got, "\"P\"") {
		t.Fatalf("a secret reached the diff: %s", got)
	}
	if strings.Count(got, "[redacted: changed]") != 3 {
		t.Errorf("the changed secrets aren't all marked: %s", got)
	}
}

// TestRedactedPayload (S-3869): a decided ask's payload keeps its change's shape and a secret's store name, but no secret
// value and no hash, for a patch, a whole file and a registry text; a payload that isn't an object is only the mark, and a
// redacted payload redacts to itself.
func TestRedactedPayload(t *testing.T) {
	patch := Payload(Change{Kind: "patch", Patch: ParseObject(`{"mcpServers":{"t":{"url":"https://y","auth":{"client_secret":"PLAIN-1"},"env":{"K":"ENV-2"}},` +
		`"r":{"auth":{"client_secret":{"secret":"mcp-r-client-secret"}}}},"peers":[{"name":"p","token":"TOK-3"}]}`)}, `{"a":1}`)
	post := Payload(Change{Kind: "post", Text: `{"providers":{"x":{"apiKey":"KEY-4"}}}`}, `{}`)
	registry := `{"change":{"kind":"registry","text":"{\"token\":\"REG-5\"}"},"baseHash":"abc"}`
	for name, tc := range map[string]struct{ in, keep string }{
		"patch":    {jsjson.Stringify(patch, ""), `"secret":"mcp-r-client-secret"`},
		"post":     {jsjson.Stringify(post, ""), `"kind":"post"`},
		"registry": {registry, `"kind":"registry"`},
		"no json":  {`not json PLAIN-1`, `{"redacted":true}`},
	} {
		got := RedactedPayload(tc.in)
		for _, secret := range []string{"PLAIN-1", "ENV-2", "TOK-3", "KEY-4", "REG-5", "Hash"} {
			if strings.Contains(got, secret) {
				t.Errorf("%s: %s is left in %s", name, secret, got)
			}
		}
		if !strings.Contains(got, tc.keep) || !strings.HasSuffix(got, `"redacted":true}`) {
			t.Errorf("%s: %s", name, got)
		}
		if again := RedactedPayload(got); again != got {
			t.Errorf("%s: redacted again it changed: %s", name, again)
		}
	}
}

// TestResultOf: a whole file keeps the secrets its redacted markers stand for, and an invalid change is refused.
func TestResultOf(t *testing.T) {
	cur := "{\n  \"peers\": [\n    {\n      \"name\": \"p\",\n      \"token\": \"T\"\n    }\n  ]\n}\n"
	text, p, err := ResultOf(Change{Kind: "post", Text: `{"peers":[{"name":"p","token":"[redacted]"}],"a":1}`}, cur, jsjson.NewObject())
	if err != nil || p != nil || !strings.Contains(text, `"token": "T"`) {
		t.Errorf("post: %q %v %v", text, p, err)
	}
	if _, _, err := ResultOf(Change{Kind: "post", Text: `{"token":"[redacted]"}`}, cur, jsjson.NewObject()); err == nil {
		t.Errorf("a marker with no value was accepted")
	}
	if _, p, _ := ResultOf(Change{Kind: "patch", Patch: jsjson.NewObject("cost", jsjson.NewObject("fallbackMinutes", 0.0))}, cur, jsjson.NewObject()); p == nil || p.Field != "cost" {
		t.Errorf("an invalid patch: %v", p)
	}
}

// TestMarkChangedSecrets: a secret that changed, sits under a changed url, or is new is marked changed; one that kept its
// value stays plain redacted, in an array element matched by name too (a provider's baseUrl is no url key).
func TestMarkChangedSecrets(t *testing.T) {
	parse := func(s string) jsjson.Value {
		v, err := jsjson.Parse([]byte(s))
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	cur := parse(`{"peers":[{"name":"a","token":"A"},{"name":"b","token":"B"}],"providers":{"p":{"baseUrl":"https://x","apiKey":"K"}},"mcpServers":{"m":{"url":"https://a","headers":{"H":"V"}}}}`)
	next := parse(`{"peers":[{"name":"b","token":"B"},{"name":"a","token":"A2"},{"name":"c","token":"C"}],"providers":{"p":{"baseUrl":"https://y","apiKey":"K"}},"mcpServers":{"m":{"url":"https://b","headers":{"H":"V"}}}}`)
	got := jsjson.Stringify(markChangedSecrets(RedactValue(next), next, true, cur, true, false), "")
	want := `{"peers":[{"name":"b","token":"[redacted]"},{"name":"a","token":"[redacted: changed]"},{"name":"c","token":"[redacted: changed]"}],"providers":{"p":{"baseUrl":"https://y","apiKey":"[redacted]"}},"mcpServers":{"m":{"url":"https://b","headers":{"H":"[redacted: changed]"}}}}`
	if got != want {
		t.Errorf("marked:\n got %s\nwant %s", got, want)
	}
}
