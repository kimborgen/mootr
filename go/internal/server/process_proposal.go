package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
	"stam/internal/process"
)

// Process change proposals (src/process-proposal.ts, S-1084, S-1085): saving an edited process. `propose` checks the YAML, commits
// it to a new branch in a scratch worktree (never the live checkout's working tree), pushes the branch, opens a pull request, and
// files a `proposal` ITSA in needs_approval with the diff and the PR link. Nothing changes until the human approves it and the PR
// merges: Approve hands the PR to the normal review and merge path (the owner is told), and Request changes or a rejection closes
// the PR. git and gh come in as proposalDeps, so a test runs with fakes.
//
// Not ported, each answering 501 before the first git call or write:
//   - an agent's proposal (the process_propose tool): the ITSA is filed straight into needs_approval, which mails the human its ask
//     when an agent files it, and that mail is not ported. The agent's 400s and the cap of open proposals (429) are answered as in TS.
//   - the repo the pull requests go to when settings name neither itsa.prOpen.github nor a repo: TS reads the origin of the checkout.
//
// Not ported either: the per-agent FIFO queue of an agent's proposals, which only matters once an agent's can be filed.

const (
	proposalSummaryMax = 2000
	// agentOpenMax is AGENT_OPEN_MAX: how many open process proposals one agent may have at once.
	agentOpenMax = 3
	// proposalGates are the gates a process change needs: the YAML loads and its tests pass.
	proposalGates = "run process process-counts process-stage process-run"
	// proposalWriter is the system sender that writes a filed proposal's body: the proposer, who created the ITSA, may not.
	proposalWriter = "system:process-proposal"
)

var notMerged = []string{"canceled", "wont_do", "duplicate"}

// proposalDeps is git and gh, run for a proposal.
type proposalDeps interface {
	// Git runs git in cwd, else the repo, and returns its stdout.
	Git(ctx context.Context, args []string, cwd string) (string, error)
	// Gh runs gh and returns its stdout.
	Gh(ctx context.Context, args []string) (string, error)
}

// proposalState is the proposal's state of a Server: test hooks only.
type proposalState struct {
	// deps replaces the real git and gh; scratch the folder scratch worktrees are made in (the system's temp folder).
	deps    proposalDeps
	scratch string
}

type execDeps struct{ repo, gh string }

const proposalExecLimit = 120 * time.Second

func (d execDeps) run(ctx context.Context, name, dir string, args []string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, proposalExecLimit)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		msg := jsjson.Trim(errb.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", errors.New(redactURLs(msg))
	}
	return out.String(), nil
}

// reURLAuth is the credentials of a URL (https://user:token@host/...): git and gh print the URLs they were given, tokens included.
var reURLAuth = regexp.MustCompile(`([A-Za-z][A-Za-z0-9+.-]*://)[^/\s@]+@`)

// redactURLs drops the credentials of every URL in a command's error text before it reaches a client or the log.
func redactURLs(s string) string { return reURLAuth.ReplaceAllString(s, "${1}***@") }

func (d execDeps) Git(ctx context.Context, args []string, cwd string) (string, error) {
	if cwd == "" {
		cwd = d.repo
	}
	out, err := d.run(ctx, "git", cwd, args)
	if err != nil {
		return "", fmt.Errorf("git %s failed: %v", args[0], err)
	}
	return out, nil
}

func (d execDeps) Gh(ctx context.Context, args []string) (string, error) {
	out, err := d.run(ctx, d.gh, "", args)
	if err != nil {
		return "", fmt.Errorf("gh %s failed: %v", strings.Join(args[:min(2, len(args))], " "), err)
	}
	return out, nil
}

// proposalRepo is process-proposal.ts's PrOpenConfig for this daemon.
type proposalRepo struct {
	name, path, github, origin, gh, base string
}

// proposalRepoOf is prOpenConfig: the repo the pull requests are opened from. Settings name it (itsa.prOpen.repo), or it is the only
// one configured (TS takes the first: the settings map has no order here). 501 when it can't be told.
func (s *Server) proposalRepoOf() (proposalRepo, error) {
	st := s.settings.Get().Itsa
	if st.PrOpenGithub == "" {
		return proposalRepo{}, unported("a process proposal opens its pull request on the repo named by itsa.prOpen.github; TS reads the origin of the checkout when it is unset, which is not ported to the Go daemon yet")
	}
	name := st.PrOpenRepo
	if name == "" {
		if len(st.Repos) != 1 {
			return proposalRepo{}, unported("a process proposal needs itsa.prOpen.repo to name the repo when settings.itsa.repos lists %d (TS takes the first, which this daemon cannot tell)", len(st.Repos))
		}
		for n := range st.Repos {
			name = n
		}
	}
	path, ok := st.Repos[name]
	if !ok {
		return proposalRepo{}, unported("repo %s is not in settings.itsa.repos; the checkout this stam runs from is a repo in TS, and the Go daemon does not derive it yet", name)
	}
	return proposalRepo{name: name, path: path, github: st.PrOpenGithub, origin: st.PrOpenOrigin, gh: st.PrOpenGh, base: st.MainBranch}, nil
}

func (s *Server) proposalDeps(repo proposalRepo) proposalDeps {
	if s.proposals.deps != nil {
		return s.proposals.deps
	}
	return execDeps{repo: repo.path, gh: repo.gh}
}

// proposalError is a refusal with its status: ProposalError.
func proposalError(status int, format string, args ...any) *Error {
	return Errorf(status, format, args...)
}

type proposalInput struct {
	process, yaml, summary string
	// base is the file text the edit started from; nil skips the stale check (an agent that edits blind).
	base *string
	// by is an agent id, or humanBox.
	by string
}

// checkYaml is process-proposal.ts checkYaml: why the YAML can't be a process file, against the registry's types and the ITSA statuses (parseProcess).
func (s *Server) checkYaml(id, yaml string, loadedIDs []string) []string {
	types := map[string]bool{}
	for _, t := range s.registryTypes() {
		types[t] = true
	}
	statuses := map[string]bool{}
	for _, st := range s.itsaStatuses() {
		statuses[st.Name] = true
	}
	def, errs := process.Parse(yaml, id+".yaml", types, statuses)
	var out []string
	for _, e := range errs {
		out = append(out, strings.Replace(e, id+".yaml: ", "", 1))
	}
	if def != nil && len(loadedIDs) > 0 {
		for _, nid := range def.NodeIDs {
			if n := def.Nodes[nid]; n.HasCall && n.Call != "" && n.Call != id && !contains(loadedIDs, n.Call) {
				out = append(out, fmt.Sprintf("node %q: call %q is not a loaded process", n.ID, n.Call))
			}
		}
	}
	return out
}

// proposalBody is the body of the proposal ITSA: the process and PR on lines the hooks read, the summary, the diff.
func proposalBody(id, summary, pr, diff, sha string) string {
	lines := []string{"Process proposal: " + id, "PR: " + pr}
	if sha != "" {
		lines = append(lines, "Commit: "+sha)
	}
	lines = append(lines, "", jsjson.Trim(summary), "", "```diff", strings.TrimRight(diff, " \t\r\n"), "```", "")
	return strings.Join(lines, "\n")
}

func firstLine(s string) string {
	s = jsjson.Trim(s)
	if i := strings.Index(s, "\n"); i >= 0 {
		s = s[:i]
	}
	return sliceUnits(s, 72)
}

// processProposalRoute is POST /api/processes/{id}/proposal: the human saves from the editor; an agent calls the process_propose
// tool, which lands here with `by` the calling agent.
func (s *Server) processProposalRoute(r *http.Request, c auth.Resolved) (any, error) {
	if err := s.notHome(c); err != nil {
		return nil, err
	}
	ctx := context.WithoutCancel(r.Context())
	body, err := jsonBody(r)
	if err != nil {
		return nil, err
	}
	human := s.isHuman(r, c)
	by := humanBox
	if !human {
		actor, err := itsaActor(body, human, false)
		if err != nil {
			return nil, err
		}
		if by, err = s.actorOf(ctx, actor); err != nil {
			return nil, err
		}
	}
	in := proposalInput{process: r.PathValue("id"), by: by}
	for _, k := range []struct {
		key string
		to  *string
	}{{"yaml", &in.yaml}, {"summary", &in.summary}} {
		if v, ok := body.Get(k.key); ok && v.Kind != jsfmt.Null {
			*k.to = anyString(v)
		}
	}
	if v, ok := body.Get("base"); ok && v.Kind != jsfmt.Null {
		base := anyString(v)
		if v.Kind == jsfmt.String {
			in.base = &base
		} else if !human {
			return nil, Errorf(http.StatusBadRequest, "an agent's proposal needs base: the exact text of the process file it edited from (an empty string for a new process)")
		} else {
			in.base = &base
		}
	} else if !human {
		return nil, Errorf(http.StatusBadRequest, "an agent's proposal needs base: the exact text of the process file it edited from (an empty string for a new process)")
	}
	loaded, err := s.processesHere()
	if err != nil {
		return nil, err
	}
	ids := make([]string, len(loaded.Processes))
	for i, p := range loaded.Processes {
		ids[i] = p.ID
	}
	return s.propose(ctx, in, ids)
}

// propose is process-proposal.ts propose. Every refusal that can be told in advance comes before the first git call.
func (s *Server) propose(ctx context.Context, in proposalInput, loadedIDs []string) (any, error) {
	id := in.process
	if !process.ValidID(id) {
		return nil, proposalError(http.StatusBadRequest, "not a process id: %s", id)
	}
	summary := jsjson.Trim(in.summary)
	if summary == "" {
		return nil, proposalError(http.StatusBadRequest, "a proposal needs a summary: say what the change does and why")
	}
	if utf16Len(summary) > proposalSummaryMax {
		return nil, proposalError(http.StatusBadRequest, "the summary is over %d characters", proposalSummaryMax)
	}
	if problems := s.checkYaml(id, in.yaml, loadedIDs); len(problems) > 0 {
		return nil, proposalError(http.StatusBadRequest, "%s.yaml doesn't validate:\n- %s", id, strings.Join(problems, "\n- "))
	}
	if in.by != humanBox {
		open, err := s.openProposals(ctx, in.by)
		if err != nil {
			return nil, err
		}
		if len(open) >= agentOpenMax {
			return nil, proposalError(http.StatusTooManyRequests, "you already have %d open process proposals (%s): wait for your user to decide on them before proposing more", len(open), strings.Join(open, ", "))
		}
		return nil, unported("an agent's process proposal is filed into needs_approval, which mails your user its ask, which is not ported to the Go daemon yet")
	}
	repo, err := s.proposalRepoOf()
	if err != nil {
		return nil, err
	}
	return s.proposeNow(ctx, in, id, summary, repo)
}

// openProposals are the keys of the agent's open process proposals.
func (s *Server) openProposals(ctx context.Context, by string) ([]string, error) {
	kind := proposalKind
	list, err := s.db.ListItsas(ctx, db.ItsaFilter{Kind: &kind})
	if err != nil {
		return nil, err
	}
	var open []string
	for _, x := range list {
		if x.Text("created_by") == by && !s.isClosedStatus(x.Text("status")) && processProposalOf(x.Text("kind"), x.Text("body")) != "" {
			open = append(open, x.Text("key"))
		}
	}
	return open, nil
}

// proposeNow is process-proposal.ts proposeNow from the git fetch on. Nothing half-made stays: on a failure the proposal is
// cancelled and the pushed branch deleted, and the scratch worktree is always removed.
func (s *Server) proposeNow(ctx context.Context, in proposalInput, id, summary string, repo proposalRepo) (_ any, err error) {
	deps := s.proposalDeps(repo)
	rnd := make([]byte, 3)
	if _, err := rand.Read(rnd); err != nil {
		return nil, err
	}
	branch := fmt.Sprintf("process/%s-%s-%s", id, strconv.FormatInt(time.Now().UnixMilli(), 36), hex.EncodeToString(rnd))
	file := "processes/" + id + ".yaml"
	base := repo.origin + "/" + repo.base

	scratch := s.proposals.scratch
	if scratch == "" {
		scratch = os.TempDir()
	}
	tmp, err := os.MkdirTemp(scratch, "stam-process-proposal-")
	if err != nil {
		return nil, err
	}
	wt := filepath.Join(tmp, "wt")
	var added, pushed bool
	var createdID string
	cleanup := context.WithoutCancel(ctx)
	defer func() {
		// A panic cleans up like any failure, then goes on.
		r := recover()
		if r != nil {
			err = fmt.Errorf("process proposal: %v", r)
		}
		if err != nil {
			if createdID != "" {
				if _, cerr := s.setItsa(cleanup, createdID, statusBody("canceled"), in.by); cerr != nil {
					slog.Error("process proposal: cancel", "itsa", createdID, "err", cerr)
				}
			}
			if pushed {
				if _, derr := deps.Git(cleanup, []string{"push", repo.origin, "--delete", branch}, ""); derr != nil {
					slog.Error("process proposal: delete the pushed branch", "branch", branch, "err", derr)
				}
			}
		}
		if added {
			deps.Git(cleanup, []string{"worktree", "remove", "--force", wt}, "")
		}
		// Delete the directory, then prune: prune frees only worktrees whose directory is gone, and a worktree that failed to
		// remove still holds its branch, which `branch -D` would refuse.
		os.RemoveAll(tmp)
		deps.Git(cleanup, []string{"worktree", "prune"}, "")
		deps.Git(cleanup, []string{"branch", "-D", branch}, "")
		if r != nil {
			panic(r)
		}
	}()

	if _, err = deps.Git(ctx, []string{"fetch", "--no-tags", repo.origin, "+refs/heads/" + repo.base + ":refs/remotes/" + repo.origin + "/" + repo.base}, ""); err != nil {
		return nil, err
	}
	if _, err = deps.Git(ctx, []string{"worktree", "add", "-b", branch, wt, base}, ""); err != nil {
		return nil, err
	}
	added = true
	path := filepath.Join(wt, file)
	before, haveBefore := "", false
	if b, rerr := os.ReadFile(path); rerr == nil {
		before, haveBefore = string(b), true
	}
	if in.base != nil && *in.base != before {
		return nil, proposalError(http.StatusConflict, "%s on %s changed after you opened the editor, so saving would overwrite that change. Discard this edit, reload the process and edit it again.", file, repo.base)
	}
	if haveBefore && before == in.yaml {
		return nil, proposalError(http.StatusBadRequest, "%s is already this on %s: nothing to propose", file, repo.base)
	}
	if err = os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	if err = os.WriteFile(path, []byte(in.yaml), 0o644); err != nil {
		return nil, err
	}
	if _, err = deps.Git(ctx, []string{"add", "--", file}, wt); err != nil {
		return nil, err
	}
	diff, err := deps.Git(ctx, []string{"diff", "--cached", "--no-color", "--", file}, wt)
	if err != nil {
		return nil, err
	}

	created, err := s.fileProposal(ctx, in, id, summary, diff)
	if err != nil {
		return nil, err
	}
	createdID, key := created.Text("id"), created.Text("key")

	msg := fmt.Sprintf("Change the %s process\n\n%s\n\nProposal %s", id, summary, key)
	if _, err = deps.Git(ctx, []string{"-c", "user.name=stam", "-c", "user.email=stam@localhost", "commit", "-q", "-m", msg}, wt); err != nil {
		return nil, err
	}
	if _, err = deps.Git(ctx, []string{"push", repo.origin, branch + ":refs/heads/" + branch}, wt); err != nil {
		return nil, err
	}
	pushed = true
	sha, err := deps.Git(ctx, []string{"rev-parse", "HEAD"}, wt)
	if err != nil {
		return nil, err
	}
	sha = jsjson.Trim(sha)

	from := "the editor"
	if in.by != humanBox {
		from = "agent " + in.by
	}
	prBody := strings.Join([]string{"ITSA: " + key, "Gates: " + proposalGates, "Deploy: normal", "",
		fmt.Sprintf("Process change proposed from %s (%s): %s", from, key, summary), "",
		"Nothing changes until the proposal is approved and this PR merges.", "", "```diff", strings.TrimRight(diff, " \t\r\n"), "```", ""}, "\n")
	bodyFile := filepath.Join(tmp, "body.md")
	if err = os.WriteFile(bodyFile, []byte(prBody), 0o644); err != nil {
		return nil, err
	}
	out, err := deps.Gh(ctx, []string{"pr", "create", "--repo", repo.github, "--base", repo.base, "--head", branch, "--title", "Change the " + id + " process", "--body-file", bodyFile})
	if err != nil {
		return nil, err
	}
	out = jsjson.Trim(out)
	url := out
	if i := strings.LastIndex(out, "\n"); i >= 0 {
		url = out[i+1:]
	}
	m := rePullURL.FindStringSubmatch(url)
	if m == nil {
		return nil, fmt.Errorf("gh pr create printed no PR url: %s", out)
	}
	number, _ := strconv.Atoi(m[1])

	actor, err := s.actorOf(ctx, in.by)
	if err != nil {
		return nil, err
	}
	for _, l := range []map[string]string{
		{"system": "github", "url": url, "external_id": m[1]},
		{"system": "branch", "external_id": branch, "repo": repo.name, "url": ""},
	} {
		lv := jsfmt.Value{Kind: jsfmt.Object}
		for _, k := range []string{"system", "url", "external_id", "repo"} {
			if v, ok := l[k]; ok {
				lv.Set(k, jsfmt.StringValue(v))
			}
		}
		nl, verr := s.validateLink(lv)
		if verr != nil {
			return nil, verr
		}
		if _, _, err = s.db.AddItsaLink(ctx, createdID, actor, nl); err != nil {
			return nil, asItsaErr(err)
		}
		s.syncItsaSubscriptions(ctx, createdID)
	}
	bodyBox := jsfmt.Value{Kind: jsfmt.Object}
	bodyBox.Set("body", jsfmt.StringValue(proposalBody(id, summary, fmt.Sprintf("#%d %s", number, url), diff, sha)))
	set, err := s.setItsa(ctx, createdID, bodyBox, proposalWriter)
	if err != nil {
		return nil, err
	}
	// An agent's proposal was asked about with its opening body: the human is shown the final one, whose revision a thread's
	// Approve then carries (S-2998).
	if in.by != "" && in.by != humanBox {
		if err = s.postShownAs(ctx, createdID, proposalWriter, "The proposal now links its PR. This is what you approve:\n\n", set.(jsfmt.Value), humanBox); err != nil {
			return nil, err
		}
	}

	pr := jsfmt.Value{Kind: jsfmt.Object}
	pr.Set("number", jsfmt.IntValue(int64(number)))
	pr.Set("url", jsfmt.StringValue(url))
	res := jsfmt.Value{Kind: jsfmt.Object}
	res.Set("key", jsfmt.StringValue(key))
	res.Set("id", jsfmt.StringValue(createdID))
	res.Set("pr", pr)
	res.Set("branch", jsfmt.StringValue(branch))
	return res, nil
}

var rePullURL = regexp.MustCompile(`/pull/(\d+)$`)

func statusBody(status string) jsfmt.Value {
	v := jsfmt.Value{Kind: jsfmt.Object}
	v.Set("status", jsfmt.StringValue(status))
	return v
}

// fileProposal creates the proposal ITSA, in needs_approval, owned by the chief of staff (who drives the PR through review and
// merge once the human approves), under the proposals' parent ITSA when there is one.
func (s *Server) fileProposal(ctx context.Context, in proposalInput, id, summary, diff string) (jsfmt.Value, error) {
	body := jsfmt.Value{Kind: jsfmt.Object}
	body.Set("kind", jsfmt.StringValue(proposalKind))
	body.Set("title", jsfmt.StringValue(id+" process change"))
	body.Set("summary", jsfmt.StringValue(firstLine(summary)))
	body.Set("body", jsfmt.StringValue(proposalBody(id, summary, "opening", diff, "")))
	body.Set("status", jsfmt.StringValue(proposalApproval))
	ref := os.Getenv("PROCESS_PROPOSAL_PARENT")
	if ref == "" {
		ref = "S-866"
	}
	if parent, found, err := s.db.FindItsa(ctx, ref); err != nil {
		return jsfmt.Value{}, err
	} else if found {
		body.Set("parent", jsfmt.StringValue(parent.Text("id")))
	}
	if cos := s.chiefOfStaffID(ctx); cos != "" {
		body.Set("owner", jsfmt.StringValue(cos))
	}
	out, err := s.createItsa(ctx, body, in.by)
	if err != nil {
		return jsfmt.Value{}, err
	}
	created, ok := out.(jsfmt.Value)
	if !ok {
		return jsfmt.Value{}, errors.New("process proposal: no ITSA made")
	}
	return created, nil
}

// --- after the proposal is filed ---

// prNumber is the number of the proposal's GitHub PR link, "" for none.
func (s *Server) prNumber(ctx context.Context, id string) string {
	links, err := s.db.ItsaLinks(ctx, id)
	if err != nil {
		return ""
	}
	for _, l := range links {
		if l.Text("system") == "github" {
			return l.Text("external_id")
		}
	}
	return ""
}

// closeProposalPr closes the proposal's PR, and its branch, with a comment saying why. It never fails: a PR that is already closed
// or gone is not a failure of the status change that asked.
func (s *Server) closeProposalPr(ctx context.Context, x jsfmt.Value, why string) bool {
	n := s.prNumber(ctx, x.Text("id"))
	if n == "" {
		return false
	}
	repo, err := s.proposalRepoOf()
	if err != nil {
		slog.Error("process proposal: closing PR #"+n, "itsa", x.Text("key"), "err", err)
		return false
	}
	if _, err := s.proposalDeps(repo).Gh(ctx, []string{"pr", "close", n, "--repo", repo.github, "--delete-branch", "--comment", why}); err != nil {
		slog.Error("process proposal: closing PR #"+n, "itsa", x.Text("key"), "err", err)
		return false
	}
	return true
}

var reCommit = regexp.MustCompile(`(?m)^Commit: ([0-9a-f]{7,40})$`)

// onProposalStatus is process-proposal.ts onProposalStatus, an observer of a status change that runs off the write path: Approve
// tells the owner to take the PR through review and merge; Request changes, or a close that isn't done, closes the PR.
func (s *Server) onProposalStatus(ctx context.Context, x jsfmt.Value, actor, from string) {
	id := processProposalOf(x.Text("kind"), x.Text("body"))
	if id == "" {
		return
	}
	ctx = context.WithoutCancel(ctx)
	s.goBg(func() { s.proposalStatusNow(ctx, x, id, actor, from) })
}

func (s *Server) proposalStatusNow(ctx context.Context, x jsfmt.Value, id, actor, from string) {
	events, err := s.db.ItsaEvents(ctx, x.Text("id"), 1000)
	if err != nil {
		slog.Error("process proposal: events", "itsa", x.Text("key"), "err", err)
		return
	}
	act := humanAction(events)
	key := x.Text("key")
	n := s.prNumber(ctx, x.Text("id"))
	if from == proposalApproval && actor == humanBox {
		if owner := x.Text("owner"); act == "approve" && owner != "" && n != "" && s.life != nil {
			first, _, _ := strings.Cut(jsjson.Trim(x.Text("body")), "\n\n")
			sha := ""
			if m := reCommit.FindStringSubmatch(first); m != nil {
				sha = m[1]
			}
			text := key + " (the " + id + " process change) is approved"
			if sha != "" {
				text += " at commit " + sha
			}
			text += ". Its PR #" + n + " goes through the normal path: a reviewer reads it (the `pr_review` tool), then you merge it with the `pr_merge` tool (PR " + n + ")"
			if sha != "" {
				text += "; merge only if the PR head is still " + sha + ", so a commit pushed after the approval isn't merged unseen"
			}
			text += ". The deploy watcher closes " + key + " after the deploy."
			s.life.QueueNotice(ctx, owner, text, false)
			return
		}
		if act == "changes" {
			// The PR and branch go, so the proposal ends with them: a new edit is a new proposal.
			s.closeProposalPr(ctx, x, "Closed: changes were requested on "+key+". Edit the process again and save a new proposal.")
			if _, err := s.setItsa(ctx, x.Text("id"), statusBody("canceled"), humanBox); err != nil {
				slog.Error("process proposal: cancel "+key, "err", err)
			}
			return
		}
	}
	// Already closed by the Request changes above (its own cancel lands here).
	if status := x.Text("status"); contains(notMerged, status) && act != "changes" {
		s.closeProposalPr(ctx, x, "Closed: "+key+" was "+strings.Replace(status, "_", " ", 1)+".")
	}
}
