// Package instructions builds the parts of an agent's system prompt that come from outside the templates (S-3776):
// the org paragraph and the type's instructions (src/org.ts), and later the cost, ITSA, workspace, lessons and
// requirements slots, the Instructions view's parts (src/agent-instructions.ts) and the inventory (src/inventory.ts).
// Each function renders what its TS original renders, byte for byte; testdata/orgref.mjs runs the TS side.
package instructions

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"

	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/jsjson"
	"stam/internal/skills"
	"stam/internal/templates"
)

// Prompts renders the prompt parts for one home.
type Prompts struct {
	Templates *templates.Set
	DB        *db.DB
	Settings  func() config.Settings
	Skills    skills.Paths
	// IsHome is whether this daemon is the ITSA home; nil means it is. Off the home, the ITSA slot comes from Home.
	IsHome func() bool
	// Home is the ITSA slot's cache on a daemon that isn't the home (Load fills it); nil on the home.
	Home *HomeItsas
	// Index embeds the task text and finds the retro items nearest it, for lessons; nil gives none.
	Index Embedder
	// LessonsTimeout is the longest LessonsPrompt waits; 0 means LessonsTimeout.
	LessonsTimeout time.Duration
	// NextSteps renders a type brief's {{next_steps}} from the loaded processes; nil gives the fallback prose.
	NextSteps func(typ string) string
	// Summarize is a block's summary for WithSummaries (tiny.Steps.BlockSummary); nil leaves every block off.
	Summarize BlockSummarizer

	lessons lessonCache
}

func (p *Prompts) home() bool { return p.IsHome == nil || p.IsHome() }

// ChiefOfStaff is src/org.ts chiefOfStaff: the agent settings.chiefOfStaff names, while it is active or paused.
func (p *Prompts) ChiefOfStaff(ctx context.Context) (db.Agent, bool) {
	name := p.Settings().ChiefOfStaff
	if name == "" {
		return db.Agent{}, false
	}
	a, err := p.DB.GetAgent(ctx, name)
	if err != nil || (a.Lifecycle != "active" && a.Lifecycle != "paused") {
		return db.Agent{}, false
	}
	return a, true
}

func (p *Prompts) isChief(ctx context.Context, a db.Agent) bool {
	cos, ok := p.ChiefOfStaff(ctx)
	return ok && cos.ID == a.ID
}

// CostPrompt is src/org.ts costPrompt: the Cost section with the user's cost instructions, "" when they set none.
func (p *Prompts) CostPrompt() string {
	text := jsjson.Trim(p.Settings().CostInstructions)
	if text == "" {
		return ""
	}
	return "## Cost\n\nWatch the 5-hour and weekly windows with `usage_info`, pace your work to them, and follow these instructions:\n\n" + text
}

// childrenOf is src/tree.ts childrenOf: the direct children, local and on peers, each once.
func (p *Prompts) childrenOf(ctx context.Context, id string) ([]string, error) {
	local, err := p.DB.ChildrenOf(ctx, id)
	if err != nil {
		return nil, err
	}
	peer, err := p.DB.PeerChildrenOf(ctx, id)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var out []string
	for _, c := range append(local, peer...) {
		if !seen[c] {
			seen[c] = true
			out = append(out, c)
		}
	}
	return out, nil
}

// ManagerCostPrompt is src/org.ts managerCostPrompt: the Cost section for an agent with children; the chief of staff
// gets it in its own paragraph instead.
func (p *Prompts) ManagerCostPrompt(ctx context.Context, a db.Agent) (string, error) {
	if p.isChief(ctx, a) {
		return "", nil
	}
	kids, err := p.childrenOf(ctx, a.ID)
	if err != nil || len(kids) == 0 {
		return "", err
	}
	return p.CostPrompt(), nil
}

// MergeLine is src/org.ts mergeLine: who merges an approved PR (S-1357).
func (p *Prompts) MergeLine() string {
	if p.Settings().Process.Run == "on" {
		return "Wait for the reviewer's `stam/review` status on the PR's current head; the process runner then merges it, and if the merge is refused moves the stage back to code and mails you. Don't call the `pr_merge` tool yourself unless the runner's refusal mail says the fault is fixed and asks you to."
	}
	return "Wait for the reviewer's `stam/review` status, and check it is on the PR's current head; then merge with the `pr_merge` tool (it mails you the result). Retarget a stacked PR to `main` first."
}

// Segment is one piece of the type's slot: "type" (its template), "skills" (the Skills available block) or "memory".
type Segment struct {
	Key  string `json:"key"`
	Text string `json:"text"`
}

// types is src/agent-types.ts agentTypes(): the merged registry's types.
func (p *Prompts) types() *jsjson.Object {
	v, _ := p.Templates.Registry().Get("types")
	if o, ok := v.(*jsjson.Object); ok {
		return o
	}
	return jsjson.NewObject()
}

func field(v jsjson.Value, key string) (jsjson.Value, bool) {
	if o, ok := v.(*jsjson.Object); ok {
		return o.Get(key)
	}
	return nil, false
}

// memoryFile is src/blocks.ts MEMORY_FILE: a type's memory block (S-888).
const memoryFile = "99-memory.md"

var braceVar = regexp.MustCompile(`\{\{(\w+)\}\}`)

// TypeSegments is src/org.ts typeSegments: the type's template text, then the Skills available block when the type
// names skills (S-891), then its memory block, so notes stay last. Without skills, one segment with exactly the
// rendered template; none without a type, or when the template can't render.
func (p *Prompts) TypeSegments(a db.Agent) ([]Segment, error) {
	if a.Type == nil || *a.Type == "" {
		return nil, nil
	}
	typ := *a.Type
	text, err := p.Templates.Render("type-"+typ, map[string]string{"name": a.Name, "type": typ, "merge": p.MergeLine()}, "")
	if err != nil {
		return nil, nil
	}
	t, _ := p.types().Get(typ)
	names, _ := field(t, "skills")
	skillsText, _ := p.TypeSkillsBlock(names)
	if skillsText == "" {
		if text == "" {
			return nil, nil
		}
		return []Segment{{"type", text}}, nil
	}
	blocks, err := p.Templates.BlocksOf("type-" + typ)
	if err != nil {
		return nil, err
	}
	mem := ""
	for _, b := range blocks {
		if b.File == memoryFile {
			vars := map[string]string{"name": a.Name, "type": typ}
			mem = jsjson.Trim(braceVar.ReplaceAllStringFunc(b.Body, func(m string) string { return vars[m[2:len(m)-2]] }))
			break
		}
	}
	var out []Segment
	if mem != "" && strings.HasSuffix(text, mem) {
		if head := jsjson.Trim(strings.TrimSuffix(text, mem)); head != "" {
			out = append(out, Segment{"type", head})
		}
		return append(out, Segment{"skills", skillsText}, Segment{"memory", mem}), nil
	}
	if text != "" {
		out = append(out, Segment{"type", text})
	}
	return append(out, Segment{"skills", skillsText}), nil
}

// TypePrompt is src/org.ts typePrompt: the type's segments joined.
func (p *Prompts) TypePrompt(a db.Agent) (string, error) {
	segs, err := p.TypeSegments(a)
	if err != nil {
		return "", err
	}
	texts := make([]string, len(segs))
	for i, s := range segs {
		texts[i] = s.Text
	}
	return strings.Join(texts, "\n\n"), nil
}

// OrgPrompt is src/org.ts orgPrompt: the type's instructions, then the rest of the org paragraph.
func (p *Prompts) OrgPrompt(ctx context.Context, a db.Agent) (string, error) {
	typ, err := p.TypePrompt(a)
	if err != nil {
		return "", err
	}
	rest, err := p.OrgRest(ctx, a)
	if err != nil {
		return "", err
	}
	return joinNonEmpty([]string{typ, rest}, "\n\n"), nil
}

// skillLineMax is src/instructions.ts SKILL_LINE_MAX, in UTF-16 code units.
const skillLineMax = 240

// squeeze is s.replace(/\s+/g, ' ').trim() with JavaScript's \s, which holds Unicode whitespace that Go's \s doesn't.
func squeeze(s string) string { return strings.Join(strings.FieldsFunc(s, jsjson.IsSpace), " ") }

// TypeSkillsBlock is src/instructions.ts typeSkillsBlock: one line per named skill with its description and the path to
// its SKILL.md, under the Skills available heading; a name with no skill folder is returned in missing and left out.
func (p *Prompts) TypeSkillsBlock(names jsjson.Value) (text string, missing []string) {
	list, _ := names.([]jsjson.Value)
	folders := map[string]skills.Folder{}
	for _, f := range p.Skills.Folders() {
		folders[f.Name] = f
	}
	seen := map[string]bool{}
	var lines []string
	for _, v := range list {
		n, ok := v.(string)
		if !ok || seen[n] {
			continue
		}
		seen[n] = true
		f, ok := folders[n]
		if !ok {
			missing = append(missing, n)
			continue
		}
		file := filepath.Join(f.Path, "SKILL.md")
		desc, _ := skills.Parse(readFile(file))
		d := squeeze(desc)
		if units := utf16.Encode([]rune(d)); len(units) > skillLineMax {
			d = string(utf16.Decode(units[:skillLineMax-1])) + "…"
		} else if d == "" {
			d = "no description"
		}
		lines = append(lines, fmt.Sprintf("- %s: %s (%s)", n, d, file))
	}
	if len(lines) == 0 {
		return "", missing
	}
	return "## Skills available\n\nBefore you do work that matches a skill below, read its SKILL.md and follow it.\n\n" + strings.Join(lines, "\n"), missing
}

// errMalformed stands for the TypeError a malformed registry entry throws in TS's reviewerProcessPrompt.
var errMalformed = errors.New("malformed registry entry")

// jsString is a value in a JS template literal: String(v), and "undefined" for a missing one.
func jsString(v jsjson.Value, present bool) string {
	if !present {
		return "undefined"
	}
	return jsjson.ToString(v)
}

// FallbackChain is src/agent-types.ts fallbackChain: a reviewer type's fallback, that one's fallback, and so on,
// stopping before a type already in the chain.
func FallbackChain(types *jsjson.Object, name string) []string {
	seen := map[string]bool{name: true}
	var out []string
	next := func(n string) string {
		t, _ := types.Get(n)
		r, _ := field(t, "review")
		f, ok := field(r, "fallback")
		if !ok || !jsjson.Truthy(f) {
			return ""
		}
		return jsjson.ToString(f)
	}
	for n := next(name); n != "" && !seen[n]; n = next(n) {
		if t, ok := types.Get(n); !ok || !jsjson.Truthy(t) {
			break
		}
		seen[n] = true
		out = append(out, n)
	}
	return out
}

// reviewerTypes is src/agent-types.ts reviewerTypes: the types with a truthy review, in registry order.
func reviewerTypes(types *jsjson.Object) []string {
	var out []string
	for _, n := range types.Keys() {
		t, _ := types.Get(n)
		if r, _ := field(t, "review"); jsjson.Truthy(r) {
			out = append(out, n)
		}
	}
	return out
}

// ReviewerProcessPrompt is src/org.ts reviewerProcessPrompt: the default reviewer and its fallback chain, then each
// other reviewer type, for a manager spawning reviewers (S-360, S-412). A malformed registry gives "", never an error.
func (p *Prompts) ReviewerProcessPrompt() string {
	out, err := p.reviewerProcess()
	if err != nil {
		return ""
	}
	return out
}

var blankRuns = regexp.MustCompile(`\n{3,}`)

func (p *Prompts) reviewerProcess() (string, error) {
	types := p.types()
	name := templates.DefaultReviewer(p.Templates.Registry())
	def, _ := types.Get(name)
	if r, _ := field(def, "review"); !jsjson.Truthy(r) {
		return "No default reviewer is set; spawn a reviewer type from registry_info.", nil
	}
	chain := FallbackChain(types, name)
	q := func(n string) string { return "`" + n + "`" }
	quoteAll := func(ns []string, sep string) string {
		qs := make([]string, len(ns))
		for i, n := range ns {
			qs[i] = q(n)
		}
		return strings.Join(qs, sep)
	}
	ringOf := func(t string) jsjson.Value {
		tv, _ := types.Get(t)
		r, _ := field(tv, "review")
		ring, _ := field(r, "ring")
		return ring
	}
	target := func(t string) (string, error) {
		if ring := ringOf(t); jsjson.Truthy(ring) {
			format, hasFormat := field(ring, "format")
			members, _ := field(ring, "members")
			var ms []string
			switch m := members.(type) {
			case nil:
			case []jsjson.Value:
				for _, x := range m {
					ms = append(ms, jsjson.ToString(x))
				}
			default:
				return "", errMalformed
			}
			rounds, hasRounds := field(ring, "maxRounds")
			return fmt.Sprintf("ring, %s, %s, at most %s rounds", jsString(format, hasFormat), quoteAll(ms, " + "), jsString(rounds, hasRounds)), nil
		}
		tv, _ := types.Get(t)
		harness, _ := field(tv, "harness")
		if !jsjson.Truthy(harness) {
			return "no harness", nil
		}
		model, hasModel := field(tv, "model")
		effort, hasEffort := field(tv, "effort")
		var hm []string
		for _, v := range []struct {
			v  jsjson.Value
			ok bool
		}{{harness, true}, {model, hasModel}} {
			if v.ok && jsjson.Truthy(v.v) {
				hm = append(hm, jsjson.ToString(v.v))
			}
		}
		return joinNonEmpty([]string{strings.Join(hm, " "), truthyString(effort, hasEffort)}, ", "), nil
	}
	inChain := map[string]bool{name: true}
	for _, n := range chain {
		inChain[n] = true
	}
	var otherLines []string
	ringed := false
	for _, t := range reviewerTypes(types) {
		if jsjson.Truthy(ringOf(t)) {
			ringed = true
		}
		if inChain[t] {
			continue
		}
		fb := FallbackChain(types, t)
		falls := ""
		if len(fb) > 0 {
			falls = " Falls back to " + quoteAll(fb, " → ") + "."
		}
		tv, _ := types.Get(t)
		dv, _ := field(tv, "description")
		desc := ""
		switch d := dv.(type) {
		case nil:
		case string:
			desc = strings.TrimSuffix(d, ".")
		default:
			return "", errMalformed
		}
		if desc != "" {
			desc = ": " + desc
		}
		tt, err := target(t)
		if err != nil {
			return "", err
		}
		otherLines = append(otherLines, fmt.Sprintf("- %s%s (%s).%s", q(t), desc, tt, falls))
	}
	spawn := "Spawn a reviewer with `spawn_agent` `type` alone, with no harness, model, or preset"
	first := spawn + "."
	if len(chain) > 0 {
		first = spawn + ": stam then uses its fallback reviewer (" + quoteAll(append([]string{name}, chain...), " → ") + ") when its account is held, and the brief says so."
	}
	second := ""
	if ringed {
		second = "A ring reviewer is spawned with `spawn_agent` `type` like any other, and starts several reviewers and mails you their result."
	}
	defTarget, err := target(name)
	if err != nil {
		return "", err
	}
	scenario, others := "", ""
	if len(otherLines) > 0 {
		scenario = ", unless a scenario below fits"
		others = "Other reviewers:\n" + strings.Join(otherLines, "\n")
	}
	text, err := p.Templates.Render("reviewer-process", map[string]string{
		"default": name, "target": defTarget, "scenario": scenario, "others": others,
		"fallback": joinNonEmpty([]string{first, second}, " "),
	}, "")
	if err != nil {
		return "", err
	}
	return blankRuns.ReplaceAllString(text, "\n\n"), nil
}

// OrgRest is src/org.ts orgRest: the org paragraph after the type's instructions — the assistant's role, the reviewer
// process for managers and the chief of staff, the chief of staff's own paragraph or its name, the parents, the child
// notices choice, and whom the agent may mail.
func (p *Prompts) OrgRest(ctx context.Context, a db.Agent) (string, error) {
	var lines []string
	cos, hasCos := p.ChiefOfStaff(ctx)
	isCos := hasCos && cos.ID == a.ID
	if a.Kind != nil && *a.Kind == "assistant" {
		t, err := p.Templates.Render("assistant", nil, "")
		if err != nil {
			return "", err
		}
		lines = append(lines, t)
	}
	if typ := deref(a.Type); typ == "manager" || typ == "coordinator" || isCos {
		lines = append(lines, p.ReviewerProcessPrompt())
	}
	if isCos {
		t, err := p.Templates.Render("chief-of-staff", map[string]string{"cost": p.CostPrompt()}, "")
		if err != nil {
			return "", err
		}
		lines = append(lines, t)
	} else if hasCos {
		lines = append(lines, fmt.Sprintf("Your user's chief of staff is %s (%s). You may escalate anything to it by mail.", cos.Name, cos.ID))
	}
	parents, err := p.DB.ParentsOf(ctx, a)
	if err != nil {
		return "", err
	}
	if len(parents) > 0 {
		names := make([]string, len(parents))
		for i, id := range parents {
			names[i] = id
			if pa, err := p.DB.GetAgent(ctx, id); err == nil {
				names[i] = pa.Name
			}
		}
		are, them := " is", "it"
		if len(parents) > 1 {
			are, them = "s are", "them"
		}
		lines = append(lines, fmt.Sprintf("Your parent agent%s %s: report to %s by mail when you finish or get stuck.", are, strings.Join(names, ", "), them))
	}
	lines = append(lines, `You choose how much you hear about your children's finished turns with agent_control "set-child-notices": "turn" (every turn), "tree-idle" (once a child and its whole subtree are idle; the default), or "none". Blocked and errored children always reach you.`)
	if v := a.VisibilityOf(); v.Reach != "all" {
		who := "agents in your tree"
		if v.Reach == "parent" {
			who = "your parents"
		}
		lines = append(lines, "You may mail only "+who+", the chief of staff, and the human.")
	}
	return strings.Join(lines, "\n\n"), nil
}

func truthyString(v jsjson.Value, present bool) string {
	if present && jsjson.Truthy(v) {
		return jsjson.ToString(v)
	}
	return ""
}

func joinNonEmpty(parts []string, sep string) string {
	var out []string
	for _, s := range parts {
		if s != "" {
			out = append(out, s)
		}
	}
	return strings.Join(out, sep)
}

// readFile is a file's text, "" when it can't be read (TS's readFileSync in a try).
func readFile(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(b)
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
