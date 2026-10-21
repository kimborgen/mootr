package server

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"

	"stam/internal/jsfmt"
)

// Process proposals (src/process-proposal.ts, S-1084): saving an edited process as a branch, a pull request and a needs_approval ITSA.
// git is real, over a local origin; gh is a fake that records its calls.

const ghHost = "git.acme.test/acme/app"

// propDeps runs the real git and answers gh itself.
type propDeps struct {
	execDeps
	mu       sync.Mutex
	gitCalls [][]string
	ghCalls  [][]string
	// prBody is the --body-file text at pr create.
	prBody string
	// createErr fails pr create.
	createErr error
	number    int
}

func (d *propDeps) Git(ctx context.Context, args []string, cwd string) (string, error) {
	d.mu.Lock()
	d.gitCalls = append(d.gitCalls, args)
	d.mu.Unlock()
	return d.execDeps.Git(ctx, args, cwd)
}

func (d *propDeps) Gh(_ context.Context, args []string) (string, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ghCalls = append(d.ghCalls, args)
	if len(args) >= 2 && args[0] == "pr" && args[1] == "create" {
		if d.createErr != nil {
			return "", d.createErr
		}
		for i, a := range args {
			if a == "--body-file" {
				b, err := os.ReadFile(args[i+1])
				if err != nil {
					return "", err
				}
				d.prBody = string(b)
			}
		}
		return "Creating pull request\nhttps://" + ghHost + "/pull/" + strconv.Itoa(d.number) + "\n", nil
	}
	return "", nil
}

func (d *propDeps) calls() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.gitCalls) + len(d.ghCalls)
}

func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "user.name=acme", "-c", "user.email=acme@acme.test"}, args...)...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return string(out)
}

type proposalFix struct {
	*fixture
	deps         *propDeps
	origin, repo string
}

// proposalFixture is a flow process fixture whose repo (processes/flow.yaml on main) has a local origin.
func proposalFixture(t *testing.T) *proposalFix {
	t.Helper()
	root := t.TempDir()
	origin, repo := filepath.Join(root, "origin.git"), filepath.Join(root, "app")
	must(t, os.MkdirAll(repo, 0o755))
	runGit(t, root, "init", "-q", "--bare", "-b", "main", origin)
	runGit(t, repo, "init", "-q", "-b", "main")
	must(t, os.MkdirAll(filepath.Join(repo, "processes"), 0o755))
	must(t, os.WriteFile(filepath.Join(repo, "processes", "flow.yaml"), []byte(flowYAML), 0o644))
	runGit(t, repo, "add", ".")
	runGit(t, repo, "commit", "-q", "-m", "flow")
	runGit(t, repo, "remote", "add", "origin", origin)
	runGit(t, repo, "push", "-q", "origin", "main")
	settings, _ := json.Marshal(map[string]any{"chiefOfStaff": "boss", "itsa": map[string]any{
		"repos": map[string]string{"app": repo}, "prOpen": map[string]string{"github": ghHost, "repo": "app"}}})
	f := flowFixtureOf(t, string(settings), flowYAML)
	deps := &propDeps{execDeps: execDeps{repo: repo, gh: "gh"}, number: 7}
	f.srv.proposals.deps = deps
	f.srv.proposals.scratch = t.TempDir()
	return &proposalFix{fixture: f, deps: deps, origin: origin, repo: repo}
}

func (p *proposalFix) propose(path, body string) (int, jsfmt.Value) {
	p.t.Helper()
	rec := p.post2("POST", "/api/processes/"+path+"/proposal", body)
	v, _ := jsfmt.Parse(rec.Body.Bytes())
	return rec.Code, v
}

func requestBody(m map[string]any) string {
	b, _ := json.Marshal(m)
	return string(b)
}

var changedFlow = strings.Replace(flowYAML, "title: Flow", "title: Flow, changed", 1)

// The human's save: a branch pushed, a PR opened, and a needs_approval ITSA owned by the chief of staff with the diff, the PR and the
// commit on lines the hooks read.
func TestProposeHuman(t *testing.T) {
	p := proposalFixture(t)
	code, out := p.propose("flow", requestBody(map[string]any{"yaml": changedFlow, "summary": "Retitle the flow.\nMore on why.", "base": flowYAML}))
	if code != 200 {
		t.Fatalf("propose: %d %s", code, out.Text("error"))
	}
	pr, _ := out.Get("pr")
	branch := out.Text("branch")
	if out.Text("key") == "" || pr.Text("url") != "https://"+ghHost+"/pull/7" || !strings.HasPrefix(branch, "process/flow-") {
		t.Fatalf("the answer: %v", out)
	}
	if n, _ := pr.Get("number"); n.Num != "7" {
		t.Errorf("the PR number: %v", n)
	}
	id := out.Text("id")
	if got := p.text("SELECT kind || '|' || status || '|' || owner || '|' || title || '|' || summary FROM itsas WHERE id = ?", id); got != "proposal|needs_approval|aboss|flow process change|Retitle the flow." {
		t.Errorf("the ITSA: %q", got)
	}
	sha := strings.TrimSpace(runGit(t, p.origin, "rev-parse", branch))
	body := p.text("SELECT body FROM itsas WHERE id = ?", id)
	for _, want := range []string{"Process proposal: flow\nPR: #7 https://" + ghHost + "/pull/7\nCommit: " + sha + "\n\nRetitle the flow.\nMore on why.\n\n```diff\n", "+title: Flow, changed", "-title: Flow\n"} {
		if !strings.Contains(body, want) {
			t.Errorf("the body lacks %q:\n%s", want, body)
		}
	}
	if processProposalOf("proposal", body) != "flow" {
		t.Errorf("the body is not read as a process proposal")
	}
	if got := p.texts("SELECT system || '|' || COALESCE(external_id, '') || '|' || url FROM itsa_links WHERE itsa_id = ? ORDER BY n", id); len(got) != 2 ||
		got[0] != "github|7|https://"+ghHost+"/pull/7" || got[1] != "branch|"+branch+"|" {
		t.Errorf("the links: %q", got)
	}
	// The pushed file is the new text; the PR was asked for in the right place with the ITSA line the merge reads.
	if got := runGit(t, p.origin, "show", branch+":processes/flow.yaml"); got != changedFlow {
		t.Errorf("the pushed file: %q", got)
	}
	for _, want := range []string{"ITSA: " + out.Text("key") + "\nGates: run process process-counts process-stage process-run\nDeploy: normal\n", "Process change proposed from the editor", "+title: Flow, changed"} {
		if !strings.Contains(p.deps.prBody, want) {
			t.Errorf("the PR body lacks %q:\n%s", want, p.deps.prBody)
		}
	}
	create := p.deps.ghCalls[0]
	if strings.Join(create[:4], " ") != "pr create --repo "+ghHost || !strings.Contains(strings.Join(create, " "), "--base main --head "+branch+" --title Change the flow process") {
		t.Errorf("gh: %q", create)
	}
	// The scratch worktree and local branch are gone; the live checkout is as it was.
	if got := runGit(t, p.repo, "worktree", "list"); strings.Count(got, "\n") != 1 {
		t.Errorf("a worktree is left: %s", got)
	}
	if got := runGit(t, p.repo, "branch", "--list", "process/*"); got != "" {
		t.Errorf("a local branch is left: %s", got)
	}
	if b, _ := os.ReadFile(filepath.Join(p.repo, "processes", "flow.yaml")); string(b) != flowYAML {
		t.Errorf("the live checkout changed")
	}
	if entries, _ := os.ReadDir(p.srv.proposals.scratch); len(entries) != 0 {
		t.Errorf("a scratch folder is left: %v", entries)
	}
	// The body is the system's: the proposer, who created the ITSA, may not edit it.
	if rec := p.post2("PATCH", "/api/itsas/"+out.Text("key"), `{"body":"x","by":"achild"}`); rec.Code == 200 {
		t.Errorf("an agent edited a process proposal's body")
	}
}

// Every refusal that can be told before git runs is answered without a git call, an ITSA or a PR.
func TestProposeRefusals(t *testing.T) {
	p := proposalFixture(t)
	long := strings.Repeat("é", 2001)
	for _, tc := range []struct {
		name, path, body string
		status           int
		msg              string
	}{
		{"a bad process id", "Flow", requestBody(map[string]any{"yaml": changedFlow, "summary": "x"}), 400, "not a process id: Flow"},
		{"no summary", "flow", requestBody(map[string]any{"yaml": changedFlow, "summary": "  "}), 400, "a proposal needs a summary: say what the change does and why"},
		{"a long summary", "flow", requestBody(map[string]any{"yaml": changedFlow, "summary": long}), 400, "the summary is over 2000 characters"},
		{"not a process", "flow", requestBody(map[string]any{"yaml": "process: flow\nnodes: 3", "summary": "x"}), 400, "flow.yaml doesn't validate:\n- "},
		{"a missing yaml", "flow", requestBody(map[string]any{"summary": "x"}), 400, "flow.yaml doesn't validate:\n- "},
	} {
		t.Run(tc.name, func(t *testing.T) {
			code, out := p.propose(tc.path, tc.body)
			if code != tc.status || !strings.HasPrefix(out.Text("error"), tc.msg) {
				t.Errorf("%d %q", code, out.Text("error"))
			}
		})
	}
	if n := p.count("SELECT COUNT(*) FROM itsas"); n != 0 || p.deps.calls() != 0 {
		t.Errorf("%d ITSAs, %d git or gh calls", n, p.deps.calls())
	}
}

// A call to a process that isn't loaded is refused, as is a lane type the registry doesn't know; the process may call itself.
func TestProposeChecksTheRegistryAndCalls(t *testing.T) {
	p := proposalFixture(t)
	call := strings.Replace(flowYAML, "nodes:\n", "nodes:\n  sub: { kind: agent, lane: dev, call: ghost }\n", 1)
	if !strings.Contains(call, "call: ghost") {
		t.Fatal("the fixture has no nodes: line")
	}
	problems := p.srv.checkYaml("flow", call, []string{"flow"})
	if !strings.Contains(strings.Join(problems, "\n"), `node "sub": call "ghost" is not a loaded process`) {
		t.Errorf("a missing call: %q", problems)
	}
	if got := p.srv.checkYaml("flow", flowYAML, []string{"flow"}); len(got) != 0 {
		t.Errorf("the flow itself: %q", got)
	}
}

// The base the edit started from must still be main's, else it is a 409; a save that changes nothing is refused. Neither leaves
// anything: no ITSA, no pushed branch, no worktree.
func TestProposeStaleAndUnchanged(t *testing.T) {
	p := proposalFixture(t)
	code, out := p.propose("flow", requestBody(map[string]any{"yaml": changedFlow, "summary": "x", "base": flowYAML + "# newer\n"}))
	if code != 409 || !strings.Contains(out.Text("error"), "processes/flow.yaml on main changed after you opened the editor") {
		t.Errorf("stale: %d %q", code, out.Text("error"))
	}
	code, out = p.propose("flow", requestBody(map[string]any{"yaml": flowYAML, "summary": "x"}))
	if code != 400 || out.Text("error") != "processes/flow.yaml is already this on main: nothing to propose" {
		t.Errorf("unchanged: %d %q", code, out.Text("error"))
	}
	if n := p.count("SELECT COUNT(*) FROM itsas"); n != 0 {
		t.Errorf("%d ITSAs", n)
	}
	if len(p.deps.ghCalls) != 0 {
		t.Errorf("gh ran: %q", p.deps.ghCalls)
	}
	if got := runGit(t, p.origin, "branch", "--list", "process/*"); got != "" {
		t.Errorf("a branch was pushed: %s", got)
	}
	if got := runGit(t, p.repo, "worktree", "list"); strings.Count(got, "\n") != 1 {
		t.Errorf("a worktree is left: %s", got)
	}
}

// A failure after the ITSA is made and the branch pushed leaves nothing: the proposal is cancelled and the branch deleted.
func TestProposeCleansUpAfterAFailure(t *testing.T) {
	p := proposalFixture(t)
	p.deps.createErr = errors.New("gh pr create failed: no network")
	code, out := p.propose("flow", requestBody(map[string]any{"yaml": changedFlow, "summary": "x", "base": flowYAML}))
	if code == 200 || !strings.Contains(out.Text("error"), "no network") {
		t.Fatalf("%d %q", code, out.Text("error"))
	}
	if got := p.texts("SELECT status FROM itsas"); len(got) != 1 || got[0] != "canceled" {
		t.Errorf("the ITSA: %q", got)
	}
	if got := runGit(t, p.origin, "branch", "--list", "process/*"); got != "" {
		t.Errorf("the pushed branch is left: %s", got)
	}
	if got := runGit(t, p.repo, "branch", "--list", "process/*"); got != "" {
		t.Errorf("the local branch is left: %s", got)
	}
	if got := runGit(t, p.repo, "worktree", "list"); strings.Count(got, "\n") != 1 {
		t.Errorf("a worktree is left: %s", got)
	}
	// Cancelled with no PR to close: no gh pr close.
	for _, c := range p.deps.ghCalls {
		if c[1] == "close" {
			t.Errorf("a PR close with no PR: %q", c)
		}
	}
}

// What this daemon cannot do answers 501 before the first git call: a repo it cannot tell, and the PR link while GitHub watches are
// not ported (a repo on github.com).
func TestProposeUnportedBeforeGit(t *testing.T) {
	p := proposalFixture(t)
	body := requestBody(map[string]any{"yaml": changedFlow, "summary": "x", "base": flowYAML})
	set := func(itsa map[string]any) {
		b, _ := json.Marshal(map[string]any{"chiefOfStaff": "boss", "itsa": itsa})
		p.setProcessSettings(string(b))
	}
	for _, tc := range []struct {
		name string
		itsa map[string]any
		msg  string
	}{
		{"no github repo set", map[string]any{"repos": map[string]string{"app": p.repo}}, "itsa.prOpen.github"},
		{"two repos and none named", map[string]any{"repos": map[string]string{"app": p.repo, "other": p.repo}, "prOpen": map[string]string{"github": ghHost}}, "needs itsa.prOpen.repo"},
		{"a repo that isn't listed", map[string]any{"repos": map[string]string{"app": p.repo}, "prOpen": map[string]string{"github": ghHost, "repo": "ghost"}}, "repo ghost is not in settings.itsa.repos"},
		{"a github.com repo", map[string]any{"repos": map[string]string{"app": p.repo}, "prOpen": map[string]string{"github": "acme/app"}}, "starts a watch on it"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			set(tc.itsa)
			code, out := p.propose("flow", body)
			if code != 501 || !strings.Contains(out.Text("error"), tc.msg) {
				t.Errorf("%d %q", code, out.Text("error"))
			}
		})
	}
	if n := p.count("SELECT COUNT(*) FROM itsas"); n != 0 || p.deps.calls() != 0 {
		t.Errorf("%d ITSAs, %d calls before the 501", n, p.deps.calls())
	}
}

// An agent's proposal needs a base (400), is held to the cap of open ones (429) and is then refused (501): filing into needs_approval
// mails the human its ask, which is not ported. None of it touches git.
func TestProposeAgent(t *testing.T) {
	p := proposalFixture(t)
	agent := func(body map[string]any) (int, string) {
		rec := p.sendH("POST", "/api/processes/flow/proposal", agentTok, nil, requestBody(body))
		v, _ := jsfmt.Parse(rec.Body.Bytes())
		return rec.Code, v.Text("error")
	}
	if code, msg := agent(map[string]any{"yaml": changedFlow, "summary": "x"}); code != 400 || !strings.HasPrefix(msg, "an agent's proposal needs base") {
		t.Errorf("no base: %d %q", code, msg)
	}
	if code, msg := agent(map[string]any{"yaml": changedFlow, "summary": "x", "base": 5}); code != 400 || !strings.HasPrefix(msg, "an agent's proposal needs base") {
		t.Errorf("a base that is no text: %d %q", code, msg)
	}
	if code, msg := agent(map[string]any{"yaml": changedFlow, "summary": "x", "base": flowYAML}); code != 501 || !strings.Contains(msg, "mails your user its ask") {
		t.Errorf("an agent's: %d %q", code, msg)
	}
	// Three open ones of the agent's own: the cap answers first.
	for i := range 3 {
		p.sql("INSERT INTO itsas (id, key, title, status, kind, body, created_by, created_at, updated_at) VALUES (?, ?, 't', 'needs_approval', 'proposal', 'Process proposal: flow\nPR: x', 'achild', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')", "ip"+strconv.Itoa(i), "S-90"+strconv.Itoa(i))
	}
	if code, msg := agent(map[string]any{"yaml": changedFlow, "summary": "x", "base": flowYAML}); code != 429 || !strings.HasPrefix(msg, "you already have 3 open process proposals (S-900, S-901, S-902)") {
		t.Errorf("the cap: %d %q", code, msg)
	}
	// A closed one, and one that isn't a process change, don't count.
	p.sql("UPDATE itsas SET status = 'canceled' WHERE id = 'ip0'")
	p.sql("UPDATE itsas SET body = 'plain' WHERE id = 'ip1'")
	if code, _ := agent(map[string]any{"yaml": changedFlow, "summary": "x", "base": flowYAML}); code != 501 {
		t.Errorf("under the cap: %d", code)
	}
	if p.deps.calls() != 0 {
		t.Errorf("git or gh ran: %d calls", p.deps.calls())
	}
}

// The gate on anyone but the human, over the ITSA routes: a process proposal is allowed through where another proposal is still 501,
// and an agent can't apply one the human has not approved.
func TestProposalGateOnTheRoutes(t *testing.T) {
	p := proposalFixture(t)
	withLife(p.fixture)
	// A proposal that isn't a process change stays refused.
	if rec := p.post2("POST", "/api/itsas", `{"title":"retro","kind":"proposal","body":"plain"}`); rec.Code != 501 {
		t.Errorf("a plain proposal: %d %s", rec.Code, rec.Body.String())
	}
	// A human may create a process proposal in any status; an agent may not create one into a status that applies it.
	if rec := p.post2("POST", "/api/itsas", `{"title":"c","kind":"proposal","body":"Process proposal: flow\n","status":"ready_to_merge"}`); rec.Code != 200 {
		t.Errorf("the human's create: %d %s", rec.Code, rec.Body.String())
	}
	if rec := p.sendH("POST", "/api/itsas", agentTok, nil, `{"title":"c","kind":"proposal","body":"Process proposal: flow\n","status":"ready_to_merge","by":"achild"}`); rec.Code != 400 || !strings.Contains(rec.Body.String(), "is a proposal your user hasn't approved") {
		t.Errorf("an agent's create into an applying status: %d %s", rec.Code, rec.Body.String())
	}
	code, out := p.propose("flow", requestBody(map[string]any{"yaml": changedFlow, "summary": "x", "base": flowYAML}))
	if code != 200 {
		t.Fatalf("propose: %d %q", code, out.Text("error"))
	}
	key := out.Text("key")
	for _, tc := range []struct{ name, body, msg string }{
		{"apply before the human approved", `{"status":"ready_to_merge","by":"aboss"}`, "is a proposal your user hasn't approved"},
		{"drop the kind", `{"kind":"issue","by":"aboss"}`, "is a proposal: only your user can change its kind"},
		{"edit the body", `{"body":"Process proposal: flow\nPR: elsewhere","by":"aboss"}`, "is a process proposal: its body is written by the system"},
	} {
		rec := p.sendH("PATCH", "/api/itsas/"+key, bossTok, nil, tc.body)
		if rec.Code != 400 || !strings.Contains(rec.Body.String(), tc.msg) {
			t.Errorf("%s: %d %s", tc.name, rec.Code, rec.Body.String())
		}
	}
}

func TestProposalGateUnit(t *testing.T) {
	ev := func(typ, actor, data string) jsfmt.Value {
		v := jsfmt.Value{Kind: jsfmt.Object}
		v.Set("type", jsfmt.StringValue(typ))
		v.Set("actor", jsfmt.StringValue(actor))
		v.Set("data", jsfmt.StringValue(data))
		return v
	}
	asked := ev("status", "aboss", `{"from":"backlog","to":"needs_approval"}`)
	approve := ev("action", "human", `{"id":"approve"}`)
	changes := ev("action", "human", `{"id":"changes"}`)
	for _, tc := range []struct {
		name   string
		events []jsfmt.Value
		want   bool
	}{
		{"never asked", nil, false},
		{"asked, no answer", []jsfmt.Value{asked}, false},
		{"approved", []jsfmt.Value{asked, approve}, true},
		{"the latest answer decides", []jsfmt.Value{asked, approve, changes}, false},
		{"an answer before the last ask", []jsfmt.Value{asked, approve, ev("status", "human", `{"to":"in_progress"}`), asked}, false},
		{"created in needs_approval", []jsfmt.Value{ev("created", "human", `{"status":"needs_approval"}`), approve}, true},
		{"an agent's act is no approval", []jsfmt.Value{asked, ev("action", "aboss", `{"id":"approve"}`)}, false},
		{"a kind change since asks again", []jsfmt.Value{asked, approve, ev("kind", "human", `{}`)}, false},
	} {
		if got := proposalApproved(tc.events); got != tc.want {
			t.Errorf("%s: %v", tc.name, got)
		}
	}
	cur := &gateCur{key: "S-1", kind: "proposal", body: "Process proposal: flow\n"}
	if err := proposalGate([]jsfmt.Value{asked, approve}, cur, "proposal", "ready_to_merge", cur.body, "aboss"); err != nil {
		t.Errorf("approved: %v", err)
	}
	if err := proposalGate(nil, cur, "proposal", "ready_to_merge", cur.body, humanBox); err != nil {
		t.Errorf("the human: %v", err)
	}
	if err := proposalGate(nil, cur, "proposal", "ready_to_merge", cur.body, "aboss"); err == nil {
		t.Errorf("unapproved")
	}
	if err := proposalGate(nil, cur, "proposal", "needs_approval", "other", proposalWriter); err != nil {
		t.Errorf("the system writer: %v", err)
	}
	if err := proposalGate(nil, nil, "proposal", "ready_to_merge", "x", "aboss"); err == nil || !strings.Contains(err.Error(), "A new proposal is a proposal your user hasn't approved") {
		t.Errorf("a create: %v", err)
	}
	// The body line, the way processProposalOf reads it.
	for body, want := range map[string]string{"Process proposal: flow\n": "flow", "x\r\nProcess proposal: a-b_1  \r\n": "a-b_1", "Process proposal: Flow": "", "see Process proposal: flow": "", "": ""} {
		if got := processProposalOf("proposal", body); got != want {
			t.Errorf("%q: %q", body, got)
		}
	}
	if processProposalOf("issue", "Process proposal: flow") != "" {
		t.Errorf("a body line of another kind")
	}
}

// The human's answer on a filed proposal: Approve tells the owner the PR and commit; Request changes closes the PR and cancels it (the
// PR link here is not on github.com, so the close is not refused); a rejection closes the PR. The observers run off the write path.
func TestProposalStatusObservers(t *testing.T) {
	p := proposalFixture(t)
	withLife(p.fixture)
	file := func(name string) (key, id, sha string) {
		code, out := p.propose("flow", requestBody(map[string]any{"yaml": strings.Replace(flowYAML, "title: Flow", "title: "+name, 1), "summary": name, "base": flowYAML}))
		if code != 200 {
			t.Fatalf("propose: %d %q", code, out.Text("error"))
		}
		return out.Text("key"), out.Text("id"), strings.TrimSpace(runGit(t, p.origin, "rev-parse", out.Text("branch")))
	}
	// WaitBackground would end the daemon's background work for good, so the closes are waited for, not the observers.
	closed := func() [][]string {
		var out [][]string
		p.deps.mu.Lock()
		defer p.deps.mu.Unlock()
		for _, c := range p.deps.ghCalls {
			if c[1] == "close" {
				out = append(out, c)
			}
		}
		return out
	}

	key, _, sha := file("Approved")
	if rec := p.post2("POST", "/api/itsas/"+key+"/act", `{"action":"approve"}`); rec.Code != 200 {
		t.Fatalf("approve: %d %s", rec.Code, rec.Body.String())
	}
	waitFor(t, func() bool { return len(p.srv.life.Notices("aboss")) == 1 }, "the owner's notice")
	want := key + " (the flow process change) is approved at commit " + sha + ". Its PR #7 goes through the normal path: a reviewer reads it (the `pr_review` tool), then you merge it with the `pr_merge` tool (PR 7); merge only if the PR head is still " + sha + ", so a commit pushed after the approval isn't merged unseen. The deploy watcher closes " + key + " after the deploy."
	if got := p.srv.life.Notices("aboss"); got[0] != want {
		t.Errorf("the notice:\n%s\nwant\n%s", got[0], want)
	}
	if got := p.text("SELECT status FROM itsas WHERE key = ?", key); got != "in_progress" {
		t.Errorf("approved: %q", got)
	}
	p.srv.WaitProcessRuns()
	if n := len(closed()); n != 0 {
		t.Errorf("an approval closed the PR: %d", n)
	}

	// Request changes: the PR and branch go, with the reason, and the proposal is cancelled as the human.
	key2, id2, _ := file("Changes")
	p.deps.number = 8
	if rec := p.post2("POST", "/api/itsas/"+key2+"/act", `{"action":"changes","text":"no"}`); rec.Code != 200 {
		t.Fatalf("changes: %d %s", rec.Code, rec.Body.String())
	}
	waitFor(t, func() bool { return p.text("SELECT status FROM itsas WHERE id = ?", id2) == "canceled" }, "the cancel")
	got := closed()
	if len(got) != 1 || strings.Join(got[0], " ") != "pr close 7 --repo "+ghHost+" --delete-branch --comment Closed: changes were requested on "+key2+". Edit the process again and save a new proposal." {
		t.Errorf("the close: %q", got)
	}
	if actor := p.text("SELECT actor FROM itsa_events WHERE itsa_id = ? AND type = 'status' ORDER BY id DESC", id2); actor != "human" {
		t.Errorf("the cancel was by %q", actor)
	}

	// A rejection (not merged) closes the PR; a done one does not.
	key3, id3, _ := file("Rejected")
	if rec := p.post2("PATCH", "/api/itsas/"+key3, `{"status":"wont_do"}`); rec.Code != 200 {
		t.Fatalf("reject: %d %s", rec.Code, rec.Body.String())
	}
	waitFor(t, func() bool { return len(closed()) == 2 }, "the rejection's close")
	if got := closed(); !strings.HasSuffix(strings.Join(got[1], " "), "--comment Closed: "+key3+" was wont do.") {
		t.Errorf("the rejection: %q", got[1])
	}
	if got := p.text("SELECT status FROM itsas WHERE id = ?", id3); got != "wont_do" {
		t.Errorf("rejected: %q", got)
	}
	key4, _, _ := file("Merged")
	if rec := p.post2("PATCH", "/api/itsas/"+key4, `{"status":"done"}`); rec.Code != 200 {
		t.Fatalf("done: %d %s", rec.Code, rec.Body.String())
	}
	p.srv.WaitProcessRuns()
	if n := len(closed()); n != 2 {
		t.Errorf("done closed the PR: %d closes", n)
	}
}

// With the PR link on github.com a Request changes would cancel a watched ITSA, which is not ported: refused before it is written.
func TestProposalChangesRefusedWithAWatchedLink(t *testing.T) {
	p := proposalFixture(t)
	key := p.createItsa(`{"title":"w","kind":"proposal","body":"Process proposal: flow\n","status":"needs_approval"}`)
	p.sql("INSERT INTO itsa_links (itsa_id, n, system, external_id, url) SELECT id, 1, 'github', '9', 'https://github.com/acme/app/pull/9' FROM itsas WHERE key = ?", key)
	rec := p.post2("POST", "/api/itsas/"+key+"/act", `{"action":"changes","text":"no"}`)
	if rec.Code != 501 || !strings.Contains(rec.Body.String(), "Request changes on process proposal") {
		t.Errorf("%d %s", rec.Code, rec.Body.String())
	}
	if got := p.text("SELECT status FROM itsas WHERE key = ?", key); got != "needs_approval" {
		t.Errorf("the refusal wrote: %q", got)
	}
}

// A panic in the middle of a proposal cleans up like any failure, then goes on: the ITSA is cancelled, the pushed branch deleted.
type panicDeps struct{ *propDeps }

func (d panicDeps) Gh(ctx context.Context, args []string) (string, error) {
	if args[0] == "pr" && args[1] == "create" {
		panic("boom")
	}
	return d.propDeps.Gh(ctx, args)
}

func TestProposePanicCleansUp(t *testing.T) {
	p := proposalFixture(t)
	p.srv.proposals.deps = panicDeps{p.deps}
	func() {
		defer func() {
			if r := recover(); r == nil {
				t.Errorf("the panic was swallowed")
			}
		}()
		p.srv.propose(context.Background(), proposalInput{process: "flow", yaml: changedFlow, summary: "x", by: humanBox}, []string{"flow"})
	}()
	if got := p.texts("SELECT status FROM itsas"); len(got) != 1 || got[0] != "canceled" {
		t.Errorf("the ITSA: %q", got)
	}
	if got := runGit(t, p.origin, "branch", "--list", "process/*"); got != "" {
		t.Errorf("the pushed branch is left: %s", got)
	}
	if got := runGit(t, p.repo, "worktree", "list"); strings.Count(got, "\n") != 1 {
		t.Errorf("a worktree is left: %s", got)
	}
}

// Credentials in a URL git or gh prints don't reach the client or the log; a U+FEFF summary is empty, as JS trim() has it.
func TestProposeRedactsAndTrims(t *testing.T) {
	if got := redactURLs("fatal: unable to access 'https://alex:ghp_secret@github.com/acme/app.git/': 403; also ssh://git:pw@host:22/x"); got != "fatal: unable to access 'https://***@github.com/acme/app.git/': 403; also ssh://***@host:22/x" {
		t.Errorf("redacted: %q", got)
	}
	d := execDeps{repo: t.TempDir(), gh: "gh"}
	_, err := d.Git(context.Background(), []string{"ls-remote", "https://alex:ghp_secret@127.0.0.1:1/acme/app.git"}, "")
	if err == nil || strings.Contains(err.Error(), "ghp_secret") {
		t.Errorf("git's error: %v", err)
	}
	p := proposalFixture(t)
	code, out := p.propose("flow", requestBody(map[string]any{"yaml": changedFlow, "summary": "\ufeff \u00a0"}))
	if code != 400 || !strings.HasPrefix(out.Text("error"), "a proposal needs a summary") {
		t.Errorf("%d %q", code, out.Text("error"))
	}
}
