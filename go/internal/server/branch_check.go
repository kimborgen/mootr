package server

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"math"
	"net/http"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"stam/internal/auth"
	"stam/internal/config"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
	"stam/internal/requirements"
	"stam/internal/steps"
)

// The requirement checks of a branch's diff, of an external event, and the previews (src/req-check.ts branchSubject,
// checkBranches, checkEvent, candidates and preview).

// gitTimeout is the longest a git call runs (src/itsa-queue.ts GIT_TIMEOUT_MS).
const gitTimeout = 15 * time.Second

// diffLimit is the largest diff read (the maxBuffer of TS's git call).
const diffLimit = 16 << 20

type branchDiffOut struct {
	head  string
	files []requirements.FileDiff
}

var reDiffPath = regexp.MustCompile(`(?m)^diff --git a/.+? b/(.+)$`)

// splitDiff splits a diff at the start of each `diff --git ` line and keeps the pieces that have a path.
func splitDiff(out string) []requirements.FileDiff {
	var starts []int
	for i := 0; i < len(out); i++ {
		if (i == 0 || out[i-1] == '\n') && strings.HasPrefix(out[i:], "diff --git ") {
			starts = append(starts, i)
		}
	}
	files := []requirements.FileDiff{}
	for n, at := range starts {
		end := len(out)
		if n+1 < len(starts) {
			end = starts[n+1]
		}
		text := out[at:end]
		if m := reDiffPath.FindStringSubmatch(text); m != nil && m[1] != "" {
			files = append(files, requirements.FileDiff{Path: m[1], Text: text})
		}
	}
	return files
}

func gitOut(ctx context.Context, path string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "git", append([]string{"-C", path}, args...)...).Output()
	if err == nil && len(out) > diffLimit {
		err = fmt.Errorf("the output is over %d bytes", diffLimit)
	}
	return strings.ToValidUTF8(string(bytes.TrimSpace(out)), "�"), err
}

// repos is itsa.repos as TS reads it: the repo derived from the checkout this daemon runs from (src/default-repo.ts derivedRepos),
// under what settings list by the same name.
func (s *Server) repos() map[string]string {
	out := map[string]string{}
	if s.tpl != nil {
		for k, v := range config.DerivedRepos(s.tpl.Root) {
			out[k] = v
		}
	}
	for k, v := range s.settings.Get().Itsa.Repos {
		out[k] = v
	}
	return out
}

// branchDiff is the diff of a branch against the main branch, split by file, with the branch's head (src/itsa-queue.ts
// branchDiff); nil when the repo or branch can't be read.
func (s *Server) branchDiff(ctx context.Context, repo, branch string) *branchDiffOut {
	path := s.repos()[repo]
	if path == "" || !validBranch(branch) {
		return nil
	}
	main := s.settings.Get().Itsa.MainBranch
	head, err := gitOut(ctx, path, "rev-parse", "--verify", "--quiet", "refs/heads/"+branch+"^{commit}")
	if err != nil {
		return nil
	}
	cctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, "git", "-C", path, "diff", "--no-color", "refs/heads/"+main+"...refs/heads/"+branch)
	pipe, err := cmd.StdoutPipe()
	if err != nil || cmd.Start() != nil {
		return nil
	}
	// Reads at most diffLimit (the maxBuffer of TS's git call): a bigger diff is killed rather than held whole.
	raw, rerr := io.ReadAll(io.LimitReader(pipe, diffLimit+1))
	if len(raw) > diffLimit {
		cancel()
	}
	werr := cmd.Wait()
	if rerr != nil || werr != nil || len(raw) > diffLimit {
		return nil
	}
	return &branchDiffOut{head: head, files: splitDiff(strings.ToValidUTF8(string(raw), "�"))}
}

func filePaths(files []requirements.FileDiff) []string {
	paths := make([]string, len(files))
	for i, f := range files {
		paths[i] = f.Path
	}
	return paths
}

// branchSubject is src/req-check.ts branchSubject: the files go in per file so each requirement reads only the files its path
// globs match. False when the diff can't be read (the check is skipped).
func (s *Server) branchSubject(ctx context.Context, x jsfmt.Value, repo, branch string, silent bool) (requirements.Subject, bool) {
	diff := s.branchDiff(ctx, repo, branch)
	if diff == nil {
		return requirements.Subject{}, false
	}
	paths := filePaths(diff.files)
	owner := x.Text("owner")
	return requirements.Subject{
		Kind: "branch", Ref: "branch:" + repo + "/" + branch + "@" + diff.head,
		Content: jsjson.NewObject("itsa", x.Text("key"), "title", x.Text("title"), "repo", repo, "branch", branch, "head", diff.head, "files", paths),
		Actor:   s.steps.ActorOf(ctx, owner), ActorID: owner, Paths: paths, Repo: repo, Itsa: s.itsaKeys(ctx, x), Files: diff.files, Silent: silent,
	}, true
}

// branchLinks are the ITSA's branch links that name a repo: the branch and its repo.
func (s *Server) branchLinks(ctx context.Context, id string) ([][2]string, error) {
	links, err := s.db.ItsaLinks(ctx, id)
	if err != nil {
		return nil, err
	}
	var out [][2]string
	for _, l := range links {
		if l.Text("system") != "branch" || l.Text("external_id") == "" {
			continue
		}
		meta, ok := l.Get("meta")
		if !ok || meta.Kind != jsfmt.Object {
			continue
		}
		if repo, ok := meta.Get("repo"); ok && repo.Kind == jsfmt.String && repo.Str != "" {
			out = append(out, [2]string{repo.Str, l.Text("external_id")})
		}
	}
	return out, nil
}

// checkBranches is src/req-check.ts checkBranches: an ITSA entered ready_to_merge, so each linked branch's diff is checked
// against main, once per head commit (the cache holds the verdict while the files a requirement reads are unchanged).
func (s *Server) checkBranches(ctx context.Context, x jsfmt.Value) {
	links, err := s.branchLinks(ctx, x.Text("id"))
	if err != nil {
		s.requirements.LogError(ctx, "subject", "itsa:"+x.Text("key"), "error", err.Error())
		return
	}
	for _, l := range links {
		if sub, ok := s.branchSubject(ctx, x, l[0], l[1], false); ok {
			s.requirements.Check(ctx, sub, requirements.CheckOptions{})
		}
	}
}

// ExtEvent is an external event as src/watch.ts stores it.
type extEvent struct {
	id       int64
	source   string
	typ      string
	subjects []string
	actor    string
	hasActor bool
	url      jsjson.Value
	summary  string
	payload  jsjson.Value
}

// checkEvent is src/req-check.ts checkEvent, for an external event after it is stored. Nobody is told: its actor is a person on
// another system, not an agent.
func (s *Server) checkEvent(ctx context.Context, ev extEvent) {
	if !s.requirements.Enabled() {
		return
	}
	name := ev.source
	var actor jsjson.Value
	if ev.hasActor {
		name, actor = ev.actor, ev.actor
	}
	s.requirements.Check(ctx, requirements.Subject{
		Kind: "event", Ref: fmt.Sprintf("event:%d", ev.id),
		Content: jsjson.NewObject("source", ev.source, "type", ev.typ, "subjects", ev.subjects, "actor", actor, "summary", ev.summary, "url", ev.url, "payload", ev.payload),
		Actor:   steps.Actor{Name: name}, Source: ev.source, Type: ev.typ,
	}, requirements.CheckOptions{})
}

// --- previews ---

const (
	previewDefault = 20
	previewMax     = 50
)

type candidate struct {
	sub     requirements.Subject
	summary string
}

// candidates is the last `want` real subjects of each kind the requirement's scope names (mail and ITSAs when it names none),
// newest first within a kind, built the way the live hooks build them, and interleaved.
func (s *Server) candidates(ctx context.Context, r requirements.Req, want int) ([]candidate, error) {
	kinds := map[string]bool{}
	if v, ok := r.Get("scope"); ok && v.Kind == jsfmt.Object {
		if subj, ok := v.Get("subjects"); ok && subj.Kind == jsfmt.Array && len(subj.Items) > 0 {
			for _, k := range subj.Items {
				kinds[jsjson.ToString(jv(k, true))] = true
			}
		}
	}
	if len(kinds) == 0 {
		kinds["mail"], kinds["itsa"] = true, true
	}
	var perKind [][]candidate
	if kinds["mail"] {
		rows, err := s.db.PreviewMail(ctx, want)
		if err != nil {
			return nil, err
		}
		var out []candidate
		for _, m := range rows {
			out = append(out, candidate{s.mailSubject(ctx, m.Text("id"), m.Text("from_id"), m.Text("subject"), m.Text("body"), m.Text("thread_id"), false), m.Text("subject")})
		}
		perKind = append(perKind, out)
	}
	if kinds["mail-to-human"] {
		rows, err := s.db.PreviewMailToHuman(ctx, want)
		if err != nil {
			return nil, err
		}
		var out []candidate
		for _, m := range rows {
			// The state of a step's example: the mail's payload, without an actor id to tell.
			sub := s.mailSubject(ctx, m.Text("id"), m.Text("from_id"), m.Text("subject"), m.Text("body"), m.Text("thread_id"), true)
			sub.ActorID = ""
			out = append(out, candidate{sub, m.Text("subject")})
		}
		perKind = append(perKind, out)
	}
	if kinds["itsa"] {
		made, err := s.db.PreviewItsaCreated(ctx, want)
		if err != nil {
			return nil, err
		}
		moved, err := s.db.PreviewItsaStatus(ctx, want)
		if err != nil {
			return nil, err
		}
		var out []candidate
		for i := 0; i < max(len(made), len(moved)); i++ {
			if i < len(made) {
				x := made[i]
				out = append(out, candidate{s.previewItsa(ctx, x, "created", x.Text("created_by"), "", ""), x.Text("key") + " " + x.Text("title")})
			}
			if i < len(moved) {
				x := moved[i]
				ch, _ := jsjson.Parse([]byte(x.Text("data")))
				from, to := "", ""
				var fromV, toV jsjson.Value
				if o, ok := ch.(*jsjson.Object); ok {
					fromV, _ = o.Get("from")
					toV, _ = o.Get("to")
				}
				from, to = jsjson.ToString(fromV), jsjson.ToString(toV)
				sub := s.previewItsa(ctx, x, "status", x.Text("actor"), "", "")
				content := sub.Content.(*jsjson.Object)
				content.Set("from", fromV)
				content.Set("to", toV)
				out = append(out, candidate{sub, x.Text("key") + " " + from + " -> " + to})
			}
		}
		if len(out) > want {
			out = out[:want]
		}
		perKind = append(perKind, out)
	}
	if kinds["branch"] {
		rows, err := s.db.PreviewBranchLinks(ctx, want)
		if err != nil {
			return nil, err
		}
		var out []candidate
		for _, row := range rows {
			meta, _ := jsjson.Parse([]byte(row.Text("meta")))
			o, _ := meta.(*jsjson.Object)
			repo := ""
			if o != nil {
				if v, ok := o.Get("repo"); ok {
					repo, _ = v.(string)
				}
			}
			x, ok, err := s.db.FindItsa(ctx, row.Text("id"))
			if err != nil {
				return nil, err
			}
			if !ok || repo == "" {
				continue
			}
			if sub, ok := s.branchSubject(ctx, x, repo, row.Text("branch"), true); ok {
				out = append(out, candidate{sub, x.Text("key") + " " + row.Text("branch")})
			}
		}
		perKind = append(perKind, out)
	}
	var merged []candidate
	for i := 0; ; i++ {
		more := false
		for _, k := range perKind {
			if i < len(k) {
				merged = append(merged, k[i])
				more = true
			}
		}
		if !more {
			return merged, nil
		}
	}
}

// previewItsa is the subject of an ITSA example: the content the live hook builds, with the actor the event names.
func (s *Server) previewItsa(ctx context.Context, x jsfmt.Value, event, actor, _, _ string) requirements.Subject {
	content := jsjson.NewObject("event", event)
	payload := s.itsaPayload(ctx, x)
	for _, k := range payload.Keys() {
		v, _ := payload.Get(k)
		content.Set(k, v)
	}
	keys := s.itsaKeys(ctx, x)
	return requirements.Subject{Kind: "itsa", Ref: "itsa:" + x.Text("key"), Content: content, Actor: s.steps.ActorOf(ctx, actor), Itsa: keys}
}

// previewRoute is POST /api/requirements/:id/preview: one requirement on the last n real subjects of its scope, the verdict
// per subject. It records nothing and tells nobody; the model's cost is `decide:req:preview` and the daily cap applies.
func (s *Server) previewRoute(r *http.Request, c auth.Resolved) (any, error) {
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	var n jsjson.Value
	if w.body != nil {
		n, _ = w.body.Get("n")
	}
	out, err := s.previewRequirement(context.WithoutCancel(r.Context()), r.PathValue("id"), n)
	return out, reqErr(err)
}

func (s *Server) previewRequirement(ctx context.Context, ref string, nv jsjson.Value) (any, error) {
	if !s.requirements.Enabled() {
		return nil, requirements.Off{}
	}
	req, err := s.requirements.Find(ctx, ref)
	if err != nil {
		return nil, err
	}
	if req == nil {
		return nil, fmt.Errorf("no requirement %s", ref)
	}
	r := *req
	// Math.max(1, Math.min(PREVIEW_MAX, Math.floor(Number(n)) || PREVIEW_DEFAULT)): a NaN or 0 is the default.
	floor := math.Floor(jsonNumber(nv))
	if math.IsNaN(floor) || floor == 0 {
		floor = previewDefault
	}
	count := int(math.Max(1, math.Min(previewMax, floor)))
	result := func(rows []jsfmt.Value, note string) jsfmt.Value {
		o := jsfmt.Value{Kind: jsfmt.Object}
		o.Set("key", jsfmt.StringValue(r.Key()))
		o.Set("n", numberValue(float64(count)))
		if rows == nil {
			rows = []jsfmt.Value{}
		}
		o.Set("rows", jsfmt.ArrayValue(rows))
		if note != "" {
			o.Set("note", jsfmt.StringValue(note))
		}
		return o
	}
	if !requirements.UsesDecision(r) {
		return result(nil, fmt.Sprintf("%s has no decision method, so there is nothing a model would check", r.Key())), nil
	}
	// The scope filter drops some subjects, so look at more than n before it.
	all, err := s.candidates(ctx, r, min(previewMax*3, count*3))
	if err != nil {
		return nil, err
	}
	var pool []candidate
	for _, c := range all {
		if requirements.InScope(r, c.sub) {
			pool = append(pool, c)
		}
	}
	rows := []jsfmt.Value{}
	for i, c := range pool {
		if i >= count {
			break
		}
		row := jsfmt.Value{Kind: jsfmt.Object}
		row.Set("subject", jsfmt.StringValue(c.sub.Ref))
		row.Set("summary", jsfmt.StringValue(c.summary))
		res := s.requirements.Check(ctx, c.sub, requirements.CheckOptions{Preview: true, Only: []requirements.Req{r}, Keys: []string{r.Key()}})
		if len(res) == 0 {
			row.Set("error", jsfmt.StringValue("the model gave no answer"))
		} else {
			x := res[0]
			f := func(p *float64) jsfmt.Value {
				if p == nil {
					return jsfmt.NullValue()
				}
				return numberValue(*p)
			}
			row.Set("verdict", jsfmt.StringValue(x.Verdict))
			row.Set("p_conforms", f(x.PConforms))
			row.Set("p_violates", f(x.PViolates))
			row.Set("p_na", f(x.PNa))
			row.Set("would_act", jsfmt.Value{Kind: jsfmt.Bool, Bool: x.Verdict == "violates" && r.Text("mode") != "observe"})
		}
		rows = append(rows, row)
	}
	note := ""
	if len(pool) == 0 {
		note = "no recent subject in the scope of " + r.Key()
	} else if spent, err := s.requirements.SpentToday(ctx); err == nil && spent >= s.settings.Get().Requirements.DailyCapUsd {
		note = "the daily cap was reached; the rest got no answer"
	}
	return result(rows, note), nil
}

// jsonNumber is JS Number(v) for a request's value.
func jsonNumber(v jsjson.Value) float64 { return jsjson.ToNumber(v) }
