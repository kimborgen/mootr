package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

var itsaRoutes = map[string]func(int) (int, string){
	"GET /api/itsas":     fixed(200, `[{"key":"S-1","status":"in_progress","owner":"worker","title":"Alpha é"},{"key":"S-12345","status":"waiting","owner":null,"title":"Beta"},{"key":"S-2","status":"backlog","title":"Gamma"}]`),
	"GET /api/itsas/S-1": fixed(200, `{"id":"i1","key":"S-1","title":"Alpha","owner":null,"links":[],"fields":{"n":1.5}}`),
	"POST /api/itsas": func(n int) (int, string) {
		if n == 3 {
			return 400, `{"error":"no ITSA parent nope"}`
		}
		return 200, `{"key":"S-9","title":"New one"}`
	},
	"PATCH /api/itsas/S-1":           fixed(200, `{"itsa":{"key":"S-1"},"changes":{"status":{"from":"backlog","to":"in_progress"},"owner":{"from":null,"to":"worker"},"participants":{"from":["a","b"],"to":[]}}}`),
	"PATCH /api/itsas/S-2":           fixed(200, `{"itsa":{"key":"S-2"},"changes":{}}`),
	"PATCH /api/itsas/S-3":           fixed(200, `{"itsa":{"key":"S-3"},"changes":{"status":{"from":"waiting","to":"done"}},"retro_offer":"Run the retro?"}`),
	"PATCH /api/itsas/S-4":           fixed(409, `{"error":"status changed"}`),
	"GET /api/itsas/fields":          fixed(200, `[{"id":"f1","key":"stage","type":"choice","label":"Stage","options":[{"value":"plan","label":"Plan","tone":"info"},{"value":"code"}],"description":"the step"},{"id":"f2","key":"n","type":"number","label":"Count"},{"id":"f3","key":"ok","type":"check","label":"Okay","options":[]},{"id":"f4","key":"averyverylongkey","type":"text","label":"L"}]`),
	"POST /api/itsas/fields":         fixed(200, `{"id":"f9","key":"prio","type":"choice","label":"Priority","options":[{"value":"hi"}]}`),
	"PATCH /api/itsas/fields/stage":  fixed(200, `{"id":"f1","key":"stage","type":"choice","label":"Step","options":[{"value":"plan","label":"Plan","tone":"info"}]}`),
	"DELETE /api/itsas/fields/stage": fixed(200, `{"ok":true}`),
	"POST /api/itsas/fields/order":   fixed(200, `[{"id":"f2","key":"n","type":"number","label":"Count"},{"id":"f1","key":"stage","type":"choice","label":"Stage"}]`),
	"POST /api/itsas/S-1/post":       fixed(200, `{"id":"m7","thread_id":"t7"}`),
	"GET /api/itsas/S-1/thread":      fixed(200, `{"items":[{"type":"event","ts":"2026-10-20T10:00:00.000Z","text":"status backlog -> in_progress"},{"type":"mail","ts":"2026-10-20T10:01:00.000Z","mail":{"id":"m1","from_name":"worker","kind":"comment","body":"first line\nsecond"}},{"type":"mail","ts":"2026-10-20T10:02:00.000Z","mail":{"id":"m2","thread_id":"t","from_id":"a1","from_name":"boss","kind":"update","health":"at_risk","reply_to":"m1","subject":"s","created_at":"2026-10-20T10:02:00.000Z","body":"on the way"}}]}`),
	"POST /api/itsas/S-1/links":      fixed(200, `{"link":{"n":3,"system":"branch","url":"https://x/y"}}`),
	"DELETE /api/itsas/S-1/links/2":  fixed(200, `{"ok":true}`),
}

// stam itsa prints and sends what the TS CLI does: the same lines, and the same requests to the daemon, query and body
// byte for byte.
func TestItsaCLIMatchesTS(t *testing.T) {
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "src", "cli.ts")); err != nil {
		t.Skip("no src/cli.ts to compare with")
	}
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node")
	}
	for _, c := range []struct {
		agent string
		args  []string
	}{
		{"", []string{"itsa", "ls"}},
		{"", []string{"itsa", "ls", "--status", "waiting", "--owner", "a b", "--parent", "root", "--participant", "x", "--participant", "y", "some", "text*~é&"}},
		{"", []string{"itsa", "ls", "--category", "active", "--kind", "issue", "--subtree", "S-1", "--status", ""}},
		{"", []string{"itsa", "show", "S-1"}},
		{"", []string{"itsa", "show"}},
		{"", []string{"itsa", "show", ""}},
		{"", []string{"itsa", "thread", ""}},
		{"", []string{"itsa", "mails", ""}},
		{"", []string{"itsa", "post", "", "text"}},
		{"", []string{"itsa", "link", "", "https://a"}},
		{"", []string{"itsa", "new", "Hello", "world", "--parent", "S-1", "--kind", "issue", "--status", "todo", "--owner", "worker", "--participant", "a", "--participant", "b", "--summary", "s", "--body", "b", "--link", "https://a", "--link", "https://b"}},
		{"a1", []string{"itsa", "new", "By agent"}},
		{"", []string{"itsa", "new", "Bad", "--parent", "nope"}},
		{"", []string{"itsa", "new"}},
		{"", []string{"itsa", "set", "S-1", "--status", "in_progress", "--owner", "worker", "--participant", "a"}},
		{"a1", []string{"itsa", "set", "S-1", "--title", "T", "--system", "deploy-watch"}},
		{"", []string{"itsa", "set", "S-1", "--field", "n=12", "--field", "ok=true", "--field", "stage=code", "--field", "gone=", "--field", "unknown=x"}},
		{"", []string{"itsa", "set", "S-1", "--field", "n=0x10", "--field", "stage= padded "}},
		{"", []string{"itsa", "set", "S-1", "--field", "n= 7 "}},
		{"", []string{"itsa", "set", "S-1", "--field", "n=abc"}},
		{"", []string{"itsa", "set", "S-1", "--field", "n=Infinity"}},
		{"", []string{"itsa", "set", "S-1", "--field", "n=1e21"}},
		{"", []string{"itsa", "set", "S-1", "--field", "n=1e-7"}},
		{"", []string{"itsa", "set", "S-1", "--field", "ok=yes"}},
		{"", []string{"itsa", "set", "S-1", "--field", "bare"}},
		{"", []string{"itsa", "set", "S-1", "--field", "=x"}},
		{"", []string{"itsa", "set", "S-2", "--title", "same"}},
		{"", []string{"itsa", "set", "S-3", "--status", "done"}},
		{"", []string{"itsa", "set", "S-4", "--status", "done"}},
		{"", []string{"itsa", "set", "S-1"}},
		{"", []string{"itsa", "set", "--status", "done"}},
		{"", []string{"itsa", "set", "S-1", "--status", "done", "--summary", ""}},
		{"", []string{"itsa", "field"}},
		{"", []string{"itsa", "field", "ls"}},
		{"", []string{"itsa", "field", "new", "prio", "Priority", "level", "--type", "choice", "--option", "hi", "--option", "lo", "--description", "d", "--hint", "h", "--width", "w", "--align", "right", "--card", "c"}},
		{"a1", []string{"itsa", "field", "new", "prio", "--label", "Pri", "--type", "choice"}},
		{"", []string{"itsa", "field", "new", "prio"}},
		{"", []string{"itsa", "field", "new", "prio", "--type", "text"}},
		{"", []string{"itsa", "field", "new", "--type", "text"}},
		{"", []string{"itsa", "field", "set", "stage", "--label", "Step", "--option", "plan", "--option", "new"}},
		{"", []string{"itsa", "field", "set", "stage", "--label", "Step"}},
		{"", []string{"itsa", "field", "set"}},
		{"", []string{"itsa", "field", "rm", "stage"}},
		{"a1", []string{"itsa", "field", "rm", "stage"}},
		{"", []string{"itsa", "field", "rm"}},
		{"", []string{"itsa", "field", "order", "n", "stage"}},
		{"", []string{"itsa", "field", "order"}},
		{"", []string{"itsa", "field", "nope"}},
		{"", []string{"itsa", "post", "S-1", "a", "comment"}},
		{"a1", []string{"itsa", "post", "S-1", "status", "--update", "at_risk", "--to", "x", "--to", "y", "--override", "why", "--system", "deploy-watch"}},
		{"", []string{"itsa", "post", "S-1"}},
		{"", []string{"itsa", "post"}},
		{"", []string{"itsa", "post", "S-1", "x", "--update", ""}},
		{"", []string{"itsa", "thread", "S-1"}},
		{"", []string{"itsa", "thread"}},
		{"", []string{"itsa", "mails", "S-1"}},
		{"", []string{"itsa", "mails"}},
		{"", []string{"itsa", "link", "S-1", "https://x/y"}},
		{"a1", []string{"itsa", "link", "S-1", "--system", "branch", "--external-id", "stam/x", "--repo", "stam2"}},
		{"", []string{"itsa", "link", "S-1", "--remove", "2"}},
		{"", []string{"itsa", "link", "S-1"}},
		{"", []string{"itsa", "link"}},
		{"", []string{"itsa", "link", "S-1", "--system", "branch"}},
		{"", []string{"itsa"}},
		{"", []string{"itsa", "nope"}},
	} {
		t.Run(c.agent+" "+strings.Join(c.args, " "), func(t *testing.T) {
			ts := newStub(t, itsaRoutes)
			g := newStub(t, itsaRoutes)
			home := t.TempDir()
			cmd := exec.Command("node", "--no-warnings", filepath.Join(root, "src", "cli.ts"))
			cmd.Args = append(cmd.Args, c.args...)
			cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME"), "STAM_HOME=" + home, "STAM_URL=" + ts.URL, "STAM_TOKEN=" + token, "STAM_ROOT=" + root, "STAM_EMBEDDER=stub"}
			vars := map[string]string{"STAM_URL": g.URL}
			if c.agent != "" {
				cmd.Env = append(cmd.Env, "STAM_AGENT_ID="+c.agent)
				vars["STAM_AGENT_ID"] = c.agent
			}
			var tsOut, tsErr strings.Builder
			cmd.Stdout, cmd.Stderr = &tsOut, &tsErr
			code := 0
			if err := cmd.Run(); err != nil {
				code = err.(*exec.ExitError).ExitCode()
			}
			o := runCLI(t, vars, "", c.args...)
			if o.code != code || o.stdout != tsOut.String() {
				t.Errorf("go: %d %q\n ts: %d %q", o.code, o.stdout, code, tsOut.String())
			}
			// The TS CLI names itself mootr here; the Go one is stam.
			if want := strings.ReplaceAll(tsErr.String(), "mootr", "stam"); o.stderr != want {
				t.Errorf("go stderr %q\n ts stderr %q", o.stderr, want)
			}
			if len(ts.calls) != len(g.calls) {
				t.Fatalf("the daemon got %d calls from ts, %d from go", len(ts.calls), len(g.calls))
			}
			for i := range ts.calls {
				if ts.calls[i] != g.calls[i] {
					t.Errorf("call %d\n ts: %+v\n go: %+v", i, ts.calls[i], g.calls[i])
				}
			}
		})
	}
}
