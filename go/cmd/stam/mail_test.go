package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

var mailRoutes = map[string]func(int) (int, string){
	"POST /api/mail": func(n int) (int, string) {
		if n == 3 {
			return 200, `{"id":"m3","queued":true,"thread_id":"m3","to":["z"]}`
		}
		if n == 4 {
			return 400, `{"error":"no agent nobody"}`
		}
		return 200, `{"id":"m` + string(rune('0'+n)) + `","thread_id":"t"}`
	},
	"GET /api/agents/worker/inbox": fixed(200, `[{"id":"m1","from_id":"boss","subject":"Plan","read_at":null},{"id":"m2","from_id":"human","subject":"Q é <&>","read_at":"2026-10-01T00:00:00.000Z"}]`),
	"POST /api/agents/human/read":  fixed(200, `[{"id":"m5","subject":"S","from_id":"u","created_at":"2026-10-02T00:00:00.000Z","body":"line one\nline two","note":"n"},{"id":"m6","subject":"T","from_id":"u","created_at":"2026-10-03T00:00:00.000Z","body":"b","note":null}]`),
	"POST /api/agents/worker/read": fixed(200, `[]`),
}

// stam mail prints and sends what the TS CLI does: the same lines, and the same requests to the daemon.
func TestMailMatchesTS(t *testing.T) {
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
	for _, args := range [][]string{
		{"mail", "send", "--to", "boss", "--to", "worker", "--subject", "Hi é", "hello", "there"},
		{"mail", "send", "--from", "worker", "--to", "boss", "--subject", "Hi", "body"},
		{"mail", "send", "--system", "deploy-watch", "--to", "boss", "--subject", "Deployed", "--itsa", "S-1", "notice"},
		{"mail", "send", "--to", "nobody", "--subject", "Lost", "x"},
		{"mail", "send", "--to", "boss", "--subject", "Over", "--override", "why", "x"},
		{"mail", "send", "--subject", "No to"},
		{"mail", "send", "--from", "", "--to", "boss", "--subject", "Empty from", "x"},
		{"mail", "send", "--system", "", "--to", "boss", "--subject", "Empty system", "x"},
		{"mail", "inbox", "worker"},
		{"mail", "read"},
		{"mail", "read", "worker", "m1"},
		{"mail", "read", "human", "m5", "m6"},
		{"mail"},
		{"mail", "nope"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			ts := newStub(t, mailRoutes)
			g := newStub(t, mailRoutes)
			home := t.TempDir()
			cmd := exec.Command("node", "--no-warnings", filepath.Join(root, "src", "cli.ts"))
			cmd.Args = append(cmd.Args, args...)
			cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME"), "STAM_HOME=" + home, "STAM_URL=" + ts.URL, "STAM_TOKEN=" + token, "STAM_ROOT=" + root, "STAM_EMBEDDER=stub"}
			var tsOut, tsErr strings.Builder
			cmd.Stdout, cmd.Stderr = &tsOut, &tsErr
			code := 0
			if err := cmd.Run(); err != nil {
				code = err.(*exec.ExitError).ExitCode()
			}
			o := runCLI(t, map[string]string{"STAM_URL": g.URL}, "", args...)
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
