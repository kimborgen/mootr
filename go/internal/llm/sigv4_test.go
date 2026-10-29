package llm

import (
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"stam/internal/jsjson"
)

// The AWS documentation's example credentials (the SigV4 test suite's), not a real key.
var docCreds = awsCredentials{"AKIDEXAMPLE", "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", ""}

// TestSignMatchesTS: src/llm/sigv4.ts sign and Go's sign give the same headers for the same request: the Bedrock
// Converse shape with a session token and an escaped model id, header values with runs of whitespace, a query with
// repeats, +, empty values and a malformed escape, an upper-case host with its default port, raw non-ASCII and
// sub-delimiters in the path, and no path at all. The first case is AWS's get-vanilla test vector.
func TestSignMatchesTS(t *testing.T) {
	now := time.Date(2015, 8, 30, 12, 36, 0, 0, time.UTC)
	session := awsCredentials{"AKIDEXAMPLE", "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "tok/session+token=="}
	type sc struct {
		method, url string
		headers     map[string]string
		body        string
		service     string
		region      string
		c           awsCredentials
	}
	json := map[string]string{"content-type": "application/json", "accept": "application/json"}
	cases := []sc{
		{"GET", "https://example.amazonaws.com/", nil, "", "service", "us-east-1", docCreds},
		{"POST", "http://127.0.0.1:8080/model/anthropic.claude-3%3A0%2Fv1/converse", json, `{"messages":[]}`, "bedrock", "eu-west-1", session},
		{"post", "https://bedrock-runtime.us-east-1.amazonaws.com/model/a(b)!'*~/converse", map[string]string{"X-Custom": "  a   b\tc  ", "Content-Type": "application/json"}, "ü", "bedrock", "us-east-1", session},
		{"GET", "https://Bedrock-Runtime.US-east-1.amazonaws.com:443/a/b?z=1&a=2&a=1&b=x+y&e=&c=%2F&bad=%zz&semi=1;2#frag", nil, "", "bedrock", "us-east-1", docCreds},
		{"GET", "http://example.com:80/ü/x y/%41", nil, "", "s3x", "ap-south-1", docCreds},
		{"GET", "https://example.com", nil, "", "service", "us-east-1", docCreds},
		{"GET", "https://example.com:8443?only=query", map[string]string{"accept": " x　 y "}, "", "service", "us-east-1", docCreds},
	}
	in := make([]jsjson.Value, len(cases))
	want := make([]jsjson.Value, len(cases))
	for i, c := range cases {
		h := jsjson.NewObject()
		for k, v := range c.headers {
			h.Set(k, v)
		}
		cred := jsjson.NewObject("accessKeyId", c.c.accessKeyID, "secretAccessKey", c.c.secretAccessKey)
		if c.c.sessionToken != "" {
			cred.Set("sessionToken", c.c.sessionToken)
		}
		in[i] = jsjson.NewObject("method", c.method, "url", c.url, "headers", h, "body", c.body, "service", c.service, "region", c.region, "credentials", cred, "now", now.Format(time.RFC3339))
		got, err := sign(c.method, c.url, c.headers, c.body, c.service, c.region, c.c, now)
		must(t, err)
		o := jsjson.NewObject("x-amz-date", got["x-amz-date"])
		if tok, ok := got["x-amz-security-token"]; ok {
			o.Set("x-amz-security-token", tok)
		}
		o.Set("authorization", got["authorization"])
		want[i] = o
	}
	cmd := exec.Command("node", "--no-warnings", "testdata/llmref.mjs")
	cmd.Stdin = strings.NewReader(jsjson.Stringify(jsjson.NewObject("home", t.TempDir(), "env", jsjson.NewObject(), "signs", in), ""))
	cmd.Stderr = os.Stderr
	ts, err := cmd.Output()
	if err != nil {
		t.Fatalf("llmref.mjs: %v", err)
	}
	tsList, err := jsjson.Parse(ts)
	must(t, err)
	for i := range cases {
		if g, w := jsjson.Stringify(tsList.([]jsjson.Value)[i], ""), jsjson.Stringify(want[i], ""); g != w {
			t.Errorf("case %d (%s) differs\n  ts %s\n  go %s", i, cases[i].url, g, w)
		}
	}
	if a, _ := want[0].(*jsjson.Object).Get("authorization"); !strings.HasSuffix(a.(string), "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31") {
		t.Errorf("get-vanilla: %s", a)
	}
}
