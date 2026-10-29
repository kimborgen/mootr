package server

import (
	"context"
	"strings"
	"testing"

	"stam/internal/db"
)

// TestWorkspaceShare: an agent shares its personal workspace, self only: a grant is upserted and the grantee told when
// its access changes; a revoke ('none') removes it from the grantee's whole switch chain and says when access ends.
// Each refusal of share is a 400 with TS's text.
func TestWorkspaceShare(t *testing.T) {
	f := newFixture(t, nil)
	var notices []string
	f.srv.noticeHook = func(id, text string) { notices = append(notices, id+": "+text) }
	share := func(tok, owner, body string) (int, string) {
		t.Helper()
		return f.postAs(tok, "/api/agents/"+owner+"/workspace-share", body, nil)
	}
	if code, body := share(bossTokOr(f), "aboss", `{"by":"aboss","agent":"child","access":"read"}`); code != 400 || !strings.Contains(body, "boss has no personal workspace to share; spawn it with a workspace first") {
		t.Errorf("no workspace: %d %s", code, body)
	}
	const path = "/h/workspaces/child"
	f.sql("UPDATE agents SET personal_workspace = ? WHERE id = 'achild'", path)
	if code, body := share(bossTokOr(f), "achild", `{"by":"aboss","agent":"coder","access":"read"}`); code != 403 {
		t.Errorf("its parent on its behalf: %d %s", code, body)
	}
	if code, body := share(agentTok, "achild", `{"agent":"coder","access":"read"}`); code != 200 || body != `{"message":"Shared `+path+` with coder (read)."}` {
		t.Errorf("a read grant: %d %s", code, body)
	}
	share(agentTok, "achild", `{"agent":"coder","access":"read"}`)
	share(agentTok, "achild", `{"agent":"coder","access":"write"}`)
	want := []string{
		"acodex: child shared its workspace `" + path + "` with you (read). You may read there; please don't write (stam can't enforce it). Use it now.",
		"acodex: child shared its workspace `" + path + "` with you (write). You may read and write there. It becomes writable at your next launch; you can read it now.",
	}
	if strings.Join(notices, "\n") != strings.Join(want, "\n") {
		t.Errorf("notices:\n%s\nwant:\n%s", strings.Join(notices, "\n"), strings.Join(want, "\n"))
	}
	if g, _ := f.db.GrantsTo(context.Background(), "acodex"); len(g) != 1 || g[0].Workspace != path || g[0].Access != "write" || g[0].GrantedBy != "achild" {
		t.Errorf("grants: %+v", g)
	}
	f.sql("UPDATE agents SET machine = 'other' WHERE id = 'aboss'")
	f.sql("UPDATE agents SET lifecycle = 'archived' WHERE id = 'agone'")
	for _, tc := range []struct{ body, want string }{
		{`{"agent":"coder","access":"admin"}`, "access must be read, write or none, not admin"},
		{`{"agent":"coder"}`, "access must be read, write or none, not "},
		{`{"agent":"nobody","access":"read"}`, "no agent nobody on this machine: a workspace folder is local, so it can only be shared with an agent on test-machine"},
		{`{"agent":"boss","access":"read"}`, "boss runs on other, and the workspace folder is on test-machine"},
		{`{"agent":"child","access":"read"}`, "an agent already has access to its own workspace"},
		{`{"agent":"gone","access":"read"}`, "gone is archived"},
	} {
		if code, body := share(agentTok, "achild", tc.body); code != 400 || !strings.Contains(body, tc.want) {
			t.Errorf("%s: %d %s, want 400 %q", tc.body, code, body, tc.want)
		}
	}
	// coder was cost-switched to gone: sharing with coder reaches gone, and a revoke clears the whole chain.
	f.sql("UPDATE agents SET lifecycle = 'active' WHERE id = 'agone'")
	f.sql("UPDATE agents SET forwarded_to = 'agone', lifecycle = 'shut_down' WHERE id = 'acodex'")
	notices = nil
	if code, body := share(agentTok, "achild", `{"agent":"coder","access":"none"}`); code != 200 || body != `{"message":"Stopped sharing `+path+` with gone. Access ends at gone's next launch, not now."}` {
		t.Errorf("a revoke over the chain: %d %s", code, body)
	}
	if len(notices) != 1 || notices[0] != "agone: child stopped sharing its workspace `"+path+"` with you. Stop using it. The folder stays reachable until your next launch, so don't use it before then either." {
		t.Errorf("revoke notices: %v", notices)
	}
	if g, _ := f.db.GrantsTo(context.Background(), "acodex"); len(g) != 0 {
		t.Errorf("the predecessor keeps %+v", g)
	}
	if code, body := share(agentTok, "achild", `{"agent":"gone","access":"none"}`); code != 200 || body != `{"message":"`+path+` wasn't shared with gone."}` {
		t.Errorf("a revoke of nothing: %d %s", code, body)
	}
}

// TestWorkspaceShareRacesSwitch: a cost switch that lands between reading the grantee and the share's write (it copies
// the grantee's grants to its successor and forwards to it) can't leave the successor with access the share removed:
// a downgrade lands on the successor, and a revoke clears it.
func TestWorkspaceShareRacesSwitch(t *testing.T) {
	f := newFixture(t, nil)
	f.srv.noticeHook = func(id, text string) {}
	const path = "/h/workspaces/child"
	f.sql("UPDATE agents SET personal_workspace = ? WHERE id = 'achild'", path)
	ctx := context.Background()
	switchOnce := func(pred, succ string) {
		f.srv.beforeShare = func() {
			f.srv.beforeShare = nil
			a, err := f.db.GetAgent(ctx, pred)
			must(t, err)
			_, _, err = f.db.MoveToSuccessor(ctx, a, db.SuccessorSpec{Agent: db.NewAgent{ID: succ, Machine: a.Machine, Harness: "claude", Cwd: a.Cwd}}, nil, "fast")
			must(t, err)
			f.sql("UPDATE agents SET lifecycle = 'shut_down' WHERE id = ?", pred)
		}
	}
	share := func(body string) string {
		t.Helper()
		code, out := f.postAs(agentTok, "/api/agents/achild/workspace-share", body, nil)
		if code != 200 {
			t.Fatalf("%s: %d %s", body, code, out)
		}
		return out
	}
	share(`{"agent":"coder","access":"write"}`)
	switchOnce("acodex", "asucc1")
	share(`{"agent":"coder","access":"read"}`)
	if g, _ := f.db.GrantsTo(ctx, "asucc1"); len(g) != 1 || g[0].Access != "read" {
		t.Errorf("the successor after a downgrade: %+v", g)
	}
	share(`{"agent":"boss","access":"read"}`)
	switchOnce("aboss", "asucc2")
	if out := share(`{"agent":"boss","access":"none"}`); !strings.Contains(out, "Stopped sharing") {
		t.Errorf("the revoke: %s", out)
	}
	for _, id := range []string{"aboss", "asucc2"} {
		if g, _ := f.db.GrantsTo(ctx, id); len(g) != 0 {
			t.Errorf("%s keeps %+v after the revoke", id, g)
		}
	}
}
