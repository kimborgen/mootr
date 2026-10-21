package process

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// What src/process-run.ts says for a matrix of entries over testdata/flow.yaml (testdata/runref.mjs): the text the listener
// records, how many scripts it would run and asks it would open, the conditions, answer edges, PR numbers and actions.
func TestRunMatchesTS(t *testing.T) {
	for _, name := range []string{"flow", "crew"} {
		t.Run(name, func(t *testing.T) { runMatchesTS(t, name) })
	}
}

type refCtx struct {
	ID, Key                 string
	OwnerLive, ReviewerLive bool
	Cos, ParentOwner        *string
	Known                   string
}

func (c *refCtx) agent() *AgentContext {
	if c == nil {
		return nil
	}
	a := &AgentContext{ID: c.ID, Key: c.Key, OwnerLive: c.OwnerLive, ReviewerLive: c.ReviewerLive}
	if c.Cos != nil {
		a.Cos = *c.Cos
	}
	if c.ParentOwner != nil {
		a.ParentOwner = *c.ParentOwner
	}
	if c.Known != "unset" {
		a.TypeKnown = func(t string) bool { return c.Known == "all" || t != "ghost" }
		a.IsReviewerType = func(t string) bool { return t == "reviewer" || t == "reviewer-lite" }
	}
	return a
}

func runMatchesTS(t *testing.T, name string) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to run src/process-run.ts")
	}
	out := filepath.Join(t.TempDir(), "expect.json")
	if b, err := exec.Command("node", "--no-warnings", "testdata/runref.mjs", "testdata/"+name+".yaml", out, name).CombinedOutput(); err != nil {
		t.Fatalf("runref.mjs: %v\n%s", err, b)
	}
	raw, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	var want struct {
		Ctxs    []*refCtx
		Entries []struct {
			Mode, Repo, Actor, To string
			Links, Ctx            int
			Record                *string
			Run, Ask, Mail, Spawn int
		}
		Other []string
		Evals []struct {
			When  *string
			Facts map[string]string
			Ok    bool
		}
		Answers [][]string
		Prs     []struct {
			Repo  string
			Links []struct{ System, URL *string }
			Pr    *string
		}
		Described []struct {
			Node       string
			Links, Ctx int
			Actions    []struct {
				Do, Script, Ask, Status, Text, Type, Itsa, Node, Prompt, Machine, To, Why string
				Args                                                                      []string
				Parent                                                                    *string
			}
		}
	}
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	text, err := os.ReadFile("testdata/" + name + ".yaml")
	if err != nil {
		t.Fatal(err)
	}
	def, errs := ParseText(string(text), ParseOptions{File: "processes/" + name + ".yaml", KnownStatuses: map[string]bool{"todo": true, "in_progress": true, "done": true, "canceled": true, "wont_do": true, "blocked": true}})
	if def == nil {
		t.Fatalf("%s.yaml: %v", name, errs)
	}
	linkSets := [][]Link{nil, {{"github", "https://github.com/acme/app/pull/7"}, {"github", "https://github.com/other/app/pull/9"}}}

	recorded, live, agentLive := 0, 0, 0
	for _, e := range want.Entries {
		text, acts := RunText(def, e.To, e.Actor, e.Mode, linkSets[e.Links], e.Repo, want.Ctxs[e.Ctx].agent())
		wantText := ""
		if e.Record != nil {
			wantText = *e.Record
			recorded++
		}
		if text != wantText {
			t.Errorf("mode %s repo %q links %d actor %q node %q:\n go: %q\n ts: %q", e.Mode, e.Repo, e.Links, e.Actor, e.To, text, wantText)
		}
		runs, asks, mails, spawns := 0, 0, 0, 0
		for _, a := range acts {
			switch a.Do {
			case "run":
				runs++
			case "ask":
				asks++
			case "mail":
				mails++
			case "spawn":
				spawns++
			}
		}
		if runs != e.Run || asks != e.Ask || mails != e.Mail || spawns != e.Spawn {
			t.Errorf("mode %s actor %q node %q ctx %d: live run %d ask %d mail %d spawn %d, ts %d %d %d %d", e.Mode, e.Actor, e.To, e.Ctx, runs, asks, mails, spawns, e.Run, e.Ask, e.Mail, e.Spawn)
		}
		live += runs + asks + mails + spawns
		agentLive += mails + spawns
	}
	if recorded < 100 || live == 0 {
		t.Errorf("the matrix proves little: %d records, %d live actions", recorded, live)
	}
	if name == "crew" && agentLive < 100 {
		t.Errorf("the matrix proves little about agent nodes: %d live mails and spawns", agentLive)
	}
	if len(want.Other) != 0 {
		t.Errorf("an ITSA of another kind was recorded by TS: %q", want.Other)
	}

	for _, c := range want.Evals {
		when := ""
		if c.When != nil {
			when = *c.When
		}
		if got := EvalCondition(when, c.Facts); got != c.Ok {
			t.Errorf("condition %q over %v: go %v, ts %v", when, c.Facts, got, c.Ok)
		}
	}
	for _, a := range want.Answers {
		if got := AnswerEdge(def, a[0]); got != a[1] {
			t.Errorf("answer edge of %s: go %q, ts %q", a[0], got, a[1])
		}
	}
	for _, c := range want.Prs {
		links := make([]Link, len(c.Links))
		for i, l := range c.Links {
			if l.System != nil {
				links[i].System = *l.System
			}
			if l.URL != nil {
				links[i].URL = *l.URL
			}
		}
		wantPR := ""
		if c.Pr != nil {
			wantPR = *c.Pr
		}
		if got := PRNumber(links, c.Repo); got != wantPR {
			t.Errorf("PR of %v in %q: go %q, ts %q", links, c.Repo, got, wantPR)
		}
	}
	for _, d := range want.Described {
		got := EntryActions(def, d.Node, linkSets[d.Links], "acme/app", want.Ctxs[d.Ctx].agent())
		if len(got) != len(d.Actions) {
			t.Errorf("actions of %s: go %d, ts %d", d.Node, len(got), len(d.Actions))
			continue
		}
		for i, a := range d.Actions {
			g := got[i]
			parent := ""
			if a.Parent != nil {
				parent = *a.Parent
			}
			if g.Do != a.Do || g.Script != a.Script || g.Ask != a.Ask || g.Status != a.Status || g.Describe() != a.Text || len(g.Args) != len(a.Args) ||
				g.Type != a.Type || g.Itsa != a.Itsa || g.Node != a.Node || g.Prompt != a.Prompt || g.Machine != a.Machine || g.To != a.To || g.Why != a.Why || g.Parent != parent {
				t.Errorf("action %d of %s: go %+v (%s), ts %+v", i, d.Node, g, g.Describe(), a)
			}
		}
	}
}
