package server

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"strings"
	"testing"
)

// The routes mayActAs gates and the OpenCode server's exemption are the ones src/agent-routes.ts lists.
func TestAgentRoutesMatchTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to run src/agent-routes.ts")
	}
	var inputs []string
	for _, m := range []string{"GET", "POST", "PUT", "DELETE"} {
		for _, p := range []string{
			"", "/files", "/instructions", "/inventory", "/inbox", "/threads", "/thread-index", "/threads/t1/archive", "/threads/t1/unarchive", "/threads/t1/defer",
			"/threads/t1/undefer", "/threads/t1/unread", "/threads/t1/nope", "/read", "/view", "/view/history", "/view/tools", "/view/prompt",
			"/view/interrupt", "/view/permission", "/stream", "/permission-mode", "/prompt", "/pause", "/kill", "/forget", "/default-view",
			"/events", "/usage", "/waits", "/waits/clear", "/waits/declared", "/waits/wake", "/waits/done", "/waits/nope", "/notice",
			"/retro-final", "/workspace-share", "/tty", "/nope", "/files/x", "x/files",
		} {
			inputs = append(inputs, m+" /api/agents/a-1"+p)
		}
	}
	inputs = append(inputs, "GET /api/agents", "GET /api/agents/", "GET /api/other/a/files", "GET /api/agents/a b/files")
	in, _ := json.Marshal(inputs)
	cmd := exec.Command("node", "--no-warnings", "testdata/agentroutes.mjs")
	cmd.Stdin = bytes.NewReader(in)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("agentroutes.mjs: %v", err)
	}
	var want []struct {
		In     string
		Acting *string
		Named  bool
	}
	if err := json.Unmarshal(out, &want); err != nil {
		t.Fatal(err)
	}
	acting, named := 0, 0
	for _, w := range want {
		method, path, _ := strings.Cut(w.In, " ")
		id, ok := matchActing(method, path)
		if ok != (w.Acting != nil) || (ok && id != *w.Acting) {
			t.Errorf("matchActing(%s) = %q, %v; TS %v", w.In, id, ok, w.Acting)
		}
		if got := opencodeNamesAgent(method, path); got != w.Named {
			t.Errorf("opencodeNamesAgent(%s) = %v; TS %v", w.In, got, w.Named)
		}
		if ok {
			acting++
		}
		if w.Named {
			named++
		}
	}
	if acting < 15 || named < 15 {
		t.Errorf("the sample reaches %d acting and %d named routes", acting, named)
	}
}
