package process

import (
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
)

// The process runner's core (src/process-run.ts, S-946): what entering a node does. An agent node is computed from the AgentContext
// the daemon fills (S-1037); without one the runner acts on no agent node, as in TS.

// EntryAction is what entering a node does.
type EntryAction struct {
	// Do is run, ask, close, spawn, mail or skip.
	Do string
	// Script and Args are the script a `run` runs.
	Script string
	Args   []string
	// Ask and Status are the ask a human node opens and the ITSA status it opens; Status is also the status a `close` sets.
	Ask, Status string
	// Type, Itsa (the key), Node, Prompt, Parent ("" for none) and Machine ("" for the type's default) are a spawn's; To, Itsa and
	// Node a mail's; Why a skip's.
	Type, Itsa, Node, Prompt, Parent, Machine, To, Why string
}

// Lane types whose agent takes over the ITSA (owner), and the lane type held by a standing agent.
var (
	ownerTakingTypes = []string{"developer", "manager"}
	standingTypes    = []string{"cos"}
)

// AgentContext is what an agent node needs to know about the ITSA (src/process-run.ts AgentContext).
type AgentContext struct {
	ID, Key string
	// OwnerLive is whether the ITSA's owner agent is alive.
	OwnerLive bool
	// ParentOwner is the owner of the ITSA's parent ITSA and Cos the chief of staff ("" for none).
	ParentOwner, Cos string
	// ReviewerLive is whether a live reviewer takes part in the ITSA.
	ReviewerLive bool
	// TypeKnown is whether an agent type exists here (the lane's fallback is used for one that doesn't); nil means all do.
	TypeKnown func(string) bool
	// IsReviewerType is whether an agent type is a reviewer type; nil means the type named `reviewer`.
	IsReviewerType func(string) bool
}

// AskStatus is the ITSA status each human-node `ask` opens.
var AskStatus = map[string]string{
	"approve": "needs_approval",
	"decide":  "needs_input",
	"answer":  "needs_input",
	"review":  "needs_review",
	"test":    "needs_test",
}

// RunnerActor is the actor the runner itself moves a stage as. A script node runs live only for an entry this actor made.
const RunnerActor = "system:process"

// Link is one ITSA link as the runner reads it.
type Link struct {
	System string
	URL    string
}

var rePullURL = regexp.MustCompile(`^https://github\.com/([^/]+/[^/]+)/pull/(\d+)(?:[/?#]|$)`)

// PRNumber is the PR number of the ITSA's latest github link whose url is a pull request of repo (OWNER/NAME), or "".
func PRNumber(links []Link, repo string) string {
	for i := len(links) - 1; i >= 0; i-- {
		if links[i].System != "github" {
			continue
		}
		if m := rePullURL.FindStringSubmatch(links[i].URL); m != nil && strings.EqualFold(m[1], repo) {
			return m[2]
		}
	}
	return ""
}

// AppliesTo is whether the process's `applies_to.kind` names the kind (an ITSA with no kind is the empty string).
func (p *Def) AppliesTo(kind string) bool { return contains(p.AppliesToKind, kind) }

// ProcessOf is the first process that applies to the kind, or nil.
func ProcessOf(processes []*Def, kind string) *Def {
	for _, p := range processes {
		if p.AppliesTo(kind) {
			return p
		}
	}
	return nil
}

// EntryActions is src/process-run.ts entryActions: what entering nodeID does; empty for a node kind the runner doesn't act on, an
// agent node of an ITSA with no agent context, or an unknown node.
func EntryActions(p *Def, nodeID string, links []Link, repo string, agent *AgentContext) []EntryAction {
	n := p.Nodes[nodeID]
	if n == nil {
		return nil
	}
	switch {
	case n.Kind == "script" && n.Run != "":
		var args []string
		if pr := PRNumber(links, repo); pr != "" {
			args = []string{pr}
		}
		return []EntryAction{{Do: "run", Script: n.Run, Args: args}}
	case n.Kind == "human" && n.Ask != "" && AskStatus[n.Ask] != "":
		return []EntryAction{{Do: "ask", Ask: n.Ask, Status: AskStatus[n.Ask]}}
	case n.Kind == "end" && n.Status != "":
		return []EntryAction{{Do: "close", Status: n.Status}}
	case n.Kind == "agent" && agent != nil:
		return agentActions(p, n, agent)
	}
	return nil
}

// agentActions is src/process-run.ts agentActions: what entering an agent node does: a mail to the standing agent that holds the
// lane, else a spawn of the lane's type (its `fallback` when the type is unknown here) for the ITSA, unless the ITSA already has
// the agent that spawn would add.
func agentActions(p *Def, n *Node, x *AgentContext) []EntryAction {
	lane, ok := p.Lanes[n.Lane]
	if n.Lane == "" || !ok {
		return nil
	}
	if contains(standingTypes, lane.Type) {
		if x.Cos != "" {
			return []EntryAction{{Do: "mail", To: x.Cos, Itsa: x.Key, Node: n.ID}}
		}
		return []EntryAction{{Do: "skip", Why: "no " + lane.Type + " to mail"}}
	}
	typ := lane.Type
	if lane.Fallback != "" && x.TypeKnown != nil && !x.TypeKnown(lane.Type) {
		typ = lane.Fallback
	}
	if contains(ownerTakingTypes, typ) && x.OwnerLive {
		return []EntryAction{{Do: "skip", Why: x.Key + " already has a live owner"}}
	}
	reviewer := typ == "reviewer"
	if x.IsReviewerType != nil {
		reviewer = x.IsReviewerType(typ)
	}
	if reviewer && x.ReviewerLive {
		return []EntryAction{{Do: "skip", Why: "a live reviewer already takes part in " + x.Key}}
	}
	parts := []string{n.Brief}
	for _, id := range p.NodeIDs {
		if o := p.Nodes[id]; o.ID != n.ID && o.Tell != nil && contains(o.Tell.Lanes, n.Lane) {
			parts = append(parts, o.Tell.Text)
		}
	}
	var kept []string
	for _, part := range parts {
		if part != "" {
			kept = append(kept, part)
		}
	}
	parent := x.ParentOwner
	if parent == "" {
		parent = x.Cos
	}
	return []EntryAction{{Do: "spawn", Type: typ, Itsa: x.Key, Node: n.ID, Prompt: strings.Join(kept, "\n\n"), Parent: parent, Machine: lane.Machine}}
}

// jsLen is a string's length in JS: UTF-16 code units.
func jsLen(s string) int { return len(utf16.Encode([]rune(s))) }

// Describe is src/process-run.ts describeAction.
func (a EntryAction) Describe() string {
	switch a.Do {
	case "run":
		return "run `" + strings.Join(append([]string{a.Script}, a.Args...), " ") + "`"
	case "ask":
		return "open the ask (" + a.Ask + ") as `" + a.Status + "`"
	case "spawn":
		on := ""
		if a.Machine != "" {
			on = " on " + a.Machine
		}
		parent := a.Parent
		if parent == "" {
			parent = "nobody"
		}
		return "spawn a `" + a.Type + "` for " + a.Itsa + on + " under " + parent + " (prompt: " + strconv.Itoa(jsLen(a.Prompt)) + " chars)"
	case "mail":
		return "mail " + a.To + " about " + a.Itsa + " at `" + a.Node + "`"
	case "skip":
		return "skip: " + a.Why
	}
	return "close the ITSA as `" + a.Status + "`"
}

// jsSpace is JS's \s: [\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff].
const jsSpace = "[\\t\\n\\v\\f\\r \\x{a0}\\x{1680}\\x{2000}-\\x{200a}\\x{2028}\\x{2029}\\x{202f}\\x{205f}\\x{3000}\\x{feff}]"

var (
	// JS \s also matches the Unicode spaces, the BOM and the line separators; Go's is ASCII only.
	reFlag = regexp.MustCompile(`^` + jsSpace + `*([a-z_][a-z0-9_]*)` + jsSpace + `*$`)
	reEq   = regexp.MustCompile(`^` + jsSpace + `*([a-z_][a-z0-9_]*)` + jsSpace + `*(==|!=)` + jsSpace + `*"?([A-Za-z0-9_.-]+)"?` + jsSpace + `*$`)
)

// EvalCondition is src/process-run.ts evalCondition: `FACT == VALUE`, `FACT != VALUE` or a bare flag `FACT` (true when the fact
// is `true`). An unknown fact or a form it doesn't read never matches.
func EvalCondition(when string, facts map[string]string) bool {
	if m := reFlag.FindStringSubmatch(when); m != nil {
		return facts[m[1]] == "true"
	}
	m := reEq.FindStringSubmatch(when)
	if m == nil {
		return false
	}
	v, ok := facts[m[1]]
	if !ok {
		return false
	}
	if m[2] == "==" {
		return v == m[3]
	}
	return v != m[3]
}

// AnswerEdge is the node a human node's answer leads to: the target of its out-edge with the flag condition `answered`, or ""
// when the node has none (a `hold` leaves on `hold_cleared`, which the deploy watcher owns, so it is never opened here).
func AnswerEdge(p *Def, nodeID string) string {
	if n := p.Nodes[nodeID]; n == nil || n.Kind != "human" {
		return ""
	}
	for _, e := range p.Edges {
		if e.From == nodeID && EvalCondition(e.When, map[string]string{"answered": "true"}) {
			return e.To
		}
	}
	return ""
}

const askNotOpened = "not opened: its way out belongs to something else (the deploy watcher), so it stays dry-run"

// RunText is what src/process-run.ts stageEntryListener records when an ITSA enters `to`: the line for the ITSA's history and
// the log, and the actions it carries out for real (under `on`: a script entered by the runner, and a human node whose answer
// leaves it). The text is "" when entering the node does nothing or the mode is off. An agent node has no actions here. actor is
// "" when unknown.
func RunText(p *Def, to, actor, mode string, links []Link, repo string, agent *AgentContext) (text string, live []EntryAction) {
	if mode == "off" || to == "" {
		return "", nil
	}
	actions := EntryActions(p, to, links, repo, agent)
	if len(actions) == 0 {
		return "", nil
	}
	who := actor
	if who == "" {
		who = "unknown"
	}
	byRunner := actor == RunnerActor
	askable := AnswerEdge(p, to) != ""
	liveRun := mode == "on" && byRunner
	liveAsk := mode == "on" && askable
	liveAgent := mode == "on" && byRunner
	var hasRun, hasAsk, hasAgent bool
	var notes []string
	described := make([]string, len(actions))
	for i, a := range actions {
		hasRun = hasRun || a.Do == "run"
		hasAsk = hasAsk || a.Do == "ask"
		hasAgent = hasAgent || a.Do == "spawn" || a.Do == "mail"
		isLive := (a.Do == "run" && liveRun) || (a.Do == "ask" && liveAsk) || ((a.Do == "spawn" || a.Do == "mail") && liveAgent)
		if isLive {
			live = append(live, a)
			described[i] = a.Describe()
		} else {
			described[i] = "would " + a.Describe()
		}
	}
	if mode == "on" {
		if hasRun && !liveRun {
			notes = append(notes, "not run: entered by "+who+", not the runner")
		}
		if hasAgent && !liveAgent {
			notes = append(notes, "not done: entered by "+who+", not the runner")
		}
		if hasAsk && !liveAsk {
			notes = append(notes, askNotOpened)
		}
	} else {
		if hasRun && !byRunner {
			notes = append(notes, "under on: not run, entered by "+who+", not the runner")
		}
		if hasAgent && !byRunner {
			notes = append(notes, "under on: not done, entered by "+who+", not the runner")
		}
		if hasAsk && !askable {
			notes = append(notes, "under on: "+askNotOpened)
		}
	}
	text = "process " + p.ID + ": entering `" + to + "` (by " + who + ") " + strings.Join(described, ", then ")
	if len(notes) > 0 {
		text += " (" + strings.Join(notes, "; ") + ")"
	}
	return text, live
}

// RefusedExit is the status merge-pr.mjs exits with for a verdict on the PR (review missing, conflict, gates failed). Any other
// failure (the lock wait ran out, a gh or network error), a timeout or a signal is not a verdict on the PR.
const RefusedExit = 3

// ScriptResult is how a script run ended.
type ScriptResult struct {
	// Code is the exit status, -1 when the process was killed by a signal or never ran.
	Code int
	// Signal names the signal that ended it, "" for none.
	Signal string
	// Output is the last 4 KB of the script's output.
	Output string
}

// IsRefusal is whether the run ended with a verdict on the PR.
func (r ScriptResult) IsRefusal() bool { return r.Code == RefusedExit && r.Signal == "" }
