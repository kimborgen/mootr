package instructions

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"

	"stam/internal/db"
	"stam/internal/jsjson"
	"stam/internal/mcp"
	"stam/internal/process"
	"stam/internal/skills"
	"stam/internal/templates"
)

// The read-only inventory of everything one agent (or one agent type) receives, for the web UI's Instructions view
// (src/inventory.ts): the same parts as AgentInstructionParts, split into heading-level blocks with a token estimate
// and a text hash, plus the full skill text and the MCP tool schemas. Layers, in the order the agent receives them:
// system-prompt, instruction-files, first-prompt, skills, mcp-instructions, mcp-tools.

// Block is src/inventory.ts InventoryBlock, with SummarizedBlock's summary fields, which WithSummaries fills. State
// and By mark a type's composition entries (off, replaced, replaces).
type Block struct {
	ID           string   `json:"id"`
	Title        string   `json:"title"`
	HeadingPath  []string `json:"headingPath"`
	Tokens       int      `json:"tokens"`
	Hash         string   `json:"hash"`
	Format       string   `json:"format"`
	Text         string   `json:"text"`
	State        string   `json:"state,omitempty"`
	By           string   `json:"by,omitempty"`
	Summary      *string  `json:"summary,omitempty"`
	SummaryState string   `json:"summaryState,omitempty"`
}

// Layer is src/inventory.ts InventoryLayer.
type Layer struct {
	Key    string  `json:"key"`
	Label  string  `json:"label"`
	Source string  `json:"source"`
	Origin string  `json:"origin,omitempty"`
	Path   string  `json:"path,omitempty"`
	Tokens int     `json:"tokens"`
	Blocks []Block `json:"blocks"`
}

// Flag is src/inventory.ts InventoryFlag: a problem the inventory can prove from the files on disk.
type Flag struct {
	Kind    string `json:"kind"`
	Layer   string `json:"layer,omitempty"`
	Message string `json:"message"`
}

// InventoryAgent is the agent an agent inventory is of.
type InventoryAgent struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	Type    *string `json:"type"`
	Harness string  `json:"harness"`
	Model   *string `json:"model"`
}

// Inventory is src/inventory.ts Inventory: Agent for an agent's, Type for a type's.
type Inventory struct {
	Agent       *InventoryAgent `json:"agent,omitempty"`
	Type        string          `json:"type,omitempty"`
	Harness     string          `json:"harness"`
	TotalTokens int             `json:"totalTokens"`
	Layers      []Layer         `json:"layers"`
	Flags       []Flag          `json:"flags"`
}

// minBlockTokens is MIN_BLOCK_TOKENS: a thinner block is merged into the next one in the same part.
const minBlockTokens = 50

// skillHarnesses is SKILL_HARNESSES: the harnesses that load skills.
var skillHarnesses = map[string]bool{"claude": true, "opencode": true}

// composing is src/blocks.ts COMPOSING: the templates a type's composition changes.
var composing = []string{"system-prompt", "retro", "mail-to-human", "mail-to-human-restricted"}

// ErrNoType is a type inventory asked for a type the registry doesn't have.
var ErrNoType = errors.New("no agent type")

// jsSpace is JavaScript's \s, for the patterns below.
const jsSpace = `[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`

var (
	// headingRe is HEADING, /^(#{1,3})\s+(.*)$/: JavaScript's `.` stops at \r, U+2028 and U+2029, so a line holding
	// one (a CRLF file's) is no heading.
	headingRe = regexp.MustCompile(`^(#{1,3})` + jsSpace + `+([^\r\x{2028}\x{2029}]*)$`)
	fenceRe   = regexp.MustCompile(`^` + jsSpace + "*(`{3,}|~{3,})")
	// noteLineRe is /^-\s+(.+)$/ over a line of the skipped-files note.
	noteLineRe = regexp.MustCompile(`^-` + jsSpace + `+([^\r\x{2028}\x{2029}]+)$`)
	slugRe     = regexp.MustCompile(`[^a-z0-9]+`)
)

func estimateTokens(text string) int { return templates.EstimateTokens(text) }

func hashText(text string) string {
	h := sha256.Sum256([]byte(text))
	return hex.EncodeToString(h[:])
}

// slug is slug: lower case, every run of anything but a-z and 0-9 a dash, trimmed of dashes, at most 60 characters,
// "block" when nothing is left. JavaScript lowers U+0130 to "i" and a combining dot, which Go's ToLower drops.
func slug(text string) string {
	lower := strings.ToLower(strings.ReplaceAll(text, "İ", "i̇"))
	out := strings.Trim(slugRe.ReplaceAllString(lower, "-"), "-")
	if len(out) > 60 {
		out = out[:60]
	}
	if out == "" {
		return "block"
	}
	return out
}

type rawBlock struct {
	headingPath []string
	text        string
}

// splitIntoBlocks is splitIntoBlocks: one part's text split at its headings (# to ###), each block keeping its
// heading path. A heading inside a fenced code block is text, and text before the first heading is its own block.
func splitIntoBlocks(text string) []rawBlock {
	current := &rawBlock{headingPath: []string{}}
	blocks := []*rawBlock{current}
	var path []string
	fence := ""
	for _, line := range strings.Split(text, "\n") {
		f := fenceRe.FindStringSubmatch(line)
		if fence != "" {
			// Only a fence at least as long as the opener closes it.
			if f != nil && strings.HasPrefix(jsjson.Trim(line), fence) {
				fence = ""
			}
			current.text += line + "\n"
			continue
		}
		if f != nil {
			fence = f[1]
			current.text += line + "\n"
			continue
		}
		if h := headingRe.FindStringSubmatch(line); h != nil {
			level := len(h[1])
			// path.length = level - 1; path[level - 1] = title: a shorter path grows with holes, which the filter drops.
			for len(path) < level {
				path = append(path, "")
			}
			path = path[:level]
			path[level-1] = jsjson.Trim(h[2])
			hp := []string{}
			for _, s := range path {
				if s != "" {
					hp = append(hp, s)
				}
			}
			current = &rawBlock{headingPath: hp, text: line + "\n"}
			blocks = append(blocks, current)
			continue
		}
		current.text += line + "\n"
	}
	var out []rawBlock
	for _, b := range blocks {
		if jsjson.Trim(b.text) != "" {
			out = append(out, *b)
		}
	}
	return out
}

// mergeTiny is mergeTiny: a block thinner than minBlockTokens prepends the block after it in the same part.
func mergeTiny(blocks []rawBlock) []rawBlock {
	var out []rawBlock
	for _, b := range blocks {
		if n := len(out); n > 0 && estimateTokens(out[n-1].text) < minBlockTokens {
			out[n-1] = rawBlock{headingPath: b.headingPath, text: out[n-1].text + b.text}
			continue
		}
		out = append(out, b)
	}
	return out
}

// layerBuilder is a layer and the block ids it has given out.
type layerBuilder struct {
	layer Layer
	ids   map[string]int
}

func newLayer(key, label, source, origin, path string) *layerBuilder {
	return &layerBuilder{layer: Layer{Key: key, Label: label, Source: source, Origin: origin, Path: path, Blocks: []Block{}}, ids: map[string]int{}}
}

// makeBlock is makeBlock: one block, its id deduped against ids (the first keeps layerKey:slug, the next gets -2).
func makeBlock(layerKey, title string, headingPath []string, raw, format string, ids map[string]int) Block {
	text := jsjson.TrimEnd(raw)
	base := title
	if len(headingPath) > 0 {
		base = strings.Join(headingPath, " ")
	}
	stem := layerKey + ":" + slug(base)
	n := ids[stem]
	ids[stem] = n + 1
	id := stem
	if n > 0 {
		id = stem + "-" + itoa(n+1)
	}
	return Block{ID: id, Title: title, HeadingPath: headingPath, Tokens: estimateTokens(text), Hash: hashText(text), Format: format, Text: text}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for ; n > 0; n /= 10 {
		b = append([]byte{byte('0' + n%10)}, b...)
	}
	return string(b)
}

// addPart is addPart: one part's text split into its blocks; root prefixes every heading path (a file's basename).
func (l *layerBuilder) addPart(text, format, fallbackTitle string, root []string) {
	for _, raw := range mergeTiny(splitIntoBlocks(text)) {
		title := fallbackTitle
		if n := len(raw.headingPath); n > 0 {
			title = raw.headingPath[n-1]
		}
		hp := append(append([]string{}, root...), raw.headingPath...)
		l.add(makeBlock(l.layer.Key, title, hp, raw.text, format, l.ids))
	}
}

// addWhole is addWhole: exactly one block, not split by heading.
func (l *layerBuilder) addWhole(title string, headingPath []string, text, format string) {
	l.add(makeBlock(l.layer.Key, title, headingPath, text, format, l.ids))
}

func (l *layerBuilder) add(b Block) {
	l.layer.Blocks = append(l.layer.Blocks, b)
	l.layer.Tokens += b.Tokens
}

// allBlocks is src/blocks.ts allBlocks: every block of the composing templates by id, with its template.
func (p *Prompts) allBlocks() (map[string]struct {
	template string
	block    templates.Block
}, error) {
	out := map[string]struct {
		template string
		block    templates.Block
	}{}
	for _, t := range composing {
		if !p.Templates.HasBlocks(t) {
			continue
		}
		bs, err := p.Templates.BlocksOf(t)
		if err != nil {
			return nil, err
		}
		for _, b := range bs {
			out[b.ID] = struct {
				template string
				block    templates.Block
			}{t, b}
		}
	}
	return out, nil
}

// mayMailHuman is src/settings.ts mayMailHuman: a nil or empty model may.
func (p *Prompts) mayMailHuman(model *string) bool {
	return model == nil || *model == "" || p.Settings().HumanMail.MayMail(*model)
}

// addComposition is addComposition: what the agent's type switched off or replaced, as state entries after the
// layer's blocks, and a flag for each change that is ignored.
func (p *Prompts) addComposition(l *layerBuilder, a db.Agent, flags *[]Flag) error {
	by := deref(a.Type)
	if by == "" {
		return nil
	}
	t, _ := p.types().Get(by)
	raw, _ := field(t, "blocks")
	tb, problems := templates.NormalizeTypeBlocks(raw)
	known, err := p.allBlocks()
	if err != nil {
		return err
	}
	entry := func(id, state, title, text, kind string) {
		t := jsjson.TrimEnd(text)
		l.layer.Blocks = append(l.layer.Blocks, Block{ID: l.layer.Key + ":" + kind + "-" + id, Title: title, HeadingPath: []string{}, Tokens: estimateTokens(t), Hash: hashText(t), Format: "markdown", Text: t, State: state, By: by})
	}
	flag := func(message string) {
		*flags = append(*flags, Flag{Kind: "composition-ignored", Layer: l.layer.Key, Message: message})
	}
	for _, pr := range problems {
		flag(by + ": " + pr + ", so it is ignored.")
	}
	// The block's template must be the text this agent gets: not overridden by a whole file, and for the mail rules,
	// the one its model is given.
	applies := func(id string) bool {
		k, ok := known[id]
		if !ok {
			return false
		}
		if !p.Templates.RendersFromBlocks(k.template) {
			flag(by + " changes block " + id + ", but the " + k.template + " template is overridden by a whole file, so it is ignored.")
			return false
		}
		if (k.template == "mail-to-human" && !p.mayMailHuman(a.Model)) || (k.template == "mail-to-human-restricted" && p.mayMailHuman(a.Model)) {
			flag(by + " changes block " + id + ", but this agent's model gets the other mail rules, so it is ignored.")
			return false
		}
		return true
	}
	for _, id := range tb.Off {
		if k, ok := known[id]; ok {
			if applies(id) {
				entry(id, "off", k.block.Title, k.block.Body, "off")
			}
		} else {
			flag(by + " switches off block " + id + ", which isn't a block of a template a type composes, so it is ignored.")
		}
	}
	for _, id := range tb.ReplaceOrder {
		path := tb.Replace[id]
		k, ok := known[id]
		if !ok {
			flag(by + " replaces block " + id + ", which isn't a block of a template a type composes, so it is ignored.")
			continue
		}
		if !applies(id) {
			continue
		}
		r, ok := p.Templates.UsableReplacement(path)
		if !ok {
			flag(by + " replaces block " + id + " with " + path + ", which is missing, outside blocks/, or not a block, so the agent gets the global block.")
			continue
		}
		entry(id, "replaced", k.block.Title, k.block.Body, "replaced")
		entry(id, "replaces", r.Title, r.Body, "replaces")
	}
	return nil
}

// replacedLabels is REPLACED_LABELS: the parts the inventory replaces with its own full-text layers.
var replacedLabels = map[string]bool{"First prompt": true, "Skills": true, "MCP servers": true, "Harness built-in prompt": true}

// build is build: every layer and the provable flags, for a real agent or the synthetic one a type inventory makes.
func (p *Prompts) build(ctx context.Context, a db.Agent) ([]Layer, []Flag, error) {
	var layers []Layer
	flags := []Flag{}
	parts, err := p.AgentInstructionParts(ctx, a)
	if err != nil {
		return nil, nil, err
	}
	_, note := p.Templates.InstructionsDetail(ctx, a.Harness, a.Cwd)
	native := p.Templates.NativeFiles(ctx, a.Harness, a.Cwd)

	sp := newLayer("system-prompt", "System prompt", "stam-generated", "system-prompt", "")
	for _, part := range parts {
		if part.Source != "repo" && part.Source != "user-global" && !replacedLabels[part.Label] {
			sp.addPart(part.Text, part.Format, part.Label, nil)
		}
	}
	if err := p.addComposition(sp, a, &flags); err != nil {
		return nil, nil, err
	}
	if a.Type != nil && *a.Type != "" {
		t, _ := p.types().Get(*a.Type)
		names, _ := field(t, "skills")
		_, missing := p.TypeSkillsBlock(names)
		for _, n := range missing {
			flags = append(flags, Flag{Kind: "type-skill-missing", Layer: "system-prompt", Message: *a.Type + " names skill " + n + ", which isn't installed, so it is left out of the Skills available block."})
		}
	}
	layers = append(layers, sp.layer)

	fileSource := "stam"
	for _, f := range native {
		if f.Source == "repo" {
			fileSource = "repo"
			break
		}
		if f.Source == "user-global" {
			fileSource = "user-global"
		}
	}
	onlyPath := ""
	if len(native) == 1 {
		onlyPath = native[0].Path
	}
	files := newLayer("instruction-files", "Instruction files", fileSource, "instruction-files", onlyPath)
	for _, f := range native {
		files.addPart(readText(f.Path), "markdown", filepath.Base(f.Path), []string{filepath.Base(f.Path)})
	}
	layers = append(layers, files.layer)

	fp := newLayer("first-prompt", "First prompt", "stam", "", "")
	first := "Not recorded for this agent."
	if a.FirstPrompt != nil {
		first = *a.FirstPrompt
	}
	fp.addPart(first, "markdown", "First prompt", nil)
	layers = append(layers, fp.layer)

	folders := p.Skills.Folders()
	sk := newLayer("skills", "Skills", "skill", "", "")
	sorted := slices.Clone(folders)
	cmp := localeCompare()
	slices.SortStableFunc(sorted, func(x, y skills.Folder) int { return cmp(x.Name, y.Name) })
	for _, s := range sorted {
		sk.addWhole(s.Name, []string{s.Name}, readText(filepath.Join(s.Path, "SKILL.md")), "markdown")
	}
	layers = append(layers, sk.layer)

	mi := newLayer("mcp-instructions", "MCP instructions", "stam", "", "")
	text, err := p.Templates.Template("mcp-instructions", "")
	if err != nil {
		return nil, nil, err
	}
	mi.addPart(text, "markdown", "MCP instructions", nil)
	layers = append(layers, mi.layer)

	mt := newLayer("mcp-tools", "MCP tools", "mcp", "", "")
	groups, _ := mcp.Catalog(p.Settings().RequirementsEnabled).Get("groups")
	for _, g := range groups.([]jsjson.Value) {
		tools, _ := g.(*jsjson.Object).Get("tools")
		for _, tv := range tools.([]jsjson.Value) {
			t := tv.(*jsjson.Object)
			name, _ := t.Get("name")
			desc, _ := t.Get("description")
			schema, _ := t.Get("inputSchema")
			mt.addWhole(jsjson.ToString(name), []string{}, jsjson.Stringify(jsjson.NewObject("name", name, "description", desc, "inputSchema", schema), "  "), "json")
		}
	}
	extra := p.extraMcpServers()
	slices.SortFunc(extra, compareUTF16)
	if len(extra) > 0 {
		mt.addWhole("Other MCP servers", []string{}, bulletList(extra), "text")
	}
	layers = append(layers, mt.layer)

	// The same file reached twice: a harness loads CLAUDE.md while the note tells it to read AGENTS.md, which is a
	// symlink to it. Compare the realpath of every file in the layer.
	var paths []string
	addPath := func(path string) {
		if !slices.Contains(paths, path) {
			paths = append(paths, path)
		}
	}
	for _, f := range native {
		addPath(f.Path)
	}
	for _, line := range strings.Split(note, "\n") {
		if m := noteLineRe.FindStringSubmatch(line); m != nil {
			if strings.HasPrefix(m[1], "/") {
				addPath(m[1])
			} else {
				addPath(filepath.Join(a.Cwd, m[1]))
			}
		}
	}
	var reals []string
	byReal := map[string][]string{}
	for _, path := range paths {
		r := realOrSelf(path)
		if _, ok := byReal[r]; !ok {
			reals = append(reals, r)
		}
		byReal[r] = append(byReal[r], path)
	}
	for _, r := range reals {
		if list := byReal[r]; len(list) > 1 {
			flags = append(flags, Flag{Kind: "duplicate-file", Layer: "instruction-files", Message: strings.Join(list, " and ") + " are the same file (" + r + "), so the agent is given it twice."})
		}
	}

	// A file that exists but holds nothing (a 0-byte instructions.md, say).
	emptyFile := func(path, layer string) {
		if info, err := os.Stat(path); err == nil && info.Size() == 0 {
			flags = append(flags, Flag{Kind: "empty-file", Layer: layer, Message: path + " is empty (0 bytes)."})
		}
	}
	for _, f := range native {
		emptyFile(f.Path, "instruction-files")
	}
	emptyFile(filepath.Join(p.Templates.Home, "instructions.md"), "instruction-files")
	for _, s := range folders {
		emptyFile(filepath.Join(s.Path, "SKILL.md"), "skills")
	}

	for _, l := range layers {
		if len(l.Blocks) == 0 {
			flags = append(flags, Flag{Kind: "empty-layer", Layer: l.Key, Message: l.Label + " is empty."})
		}
	}

	if !skillHarnesses[a.Harness] {
		harness := a.Harness
		if harness == "" {
			// `${a.harness}` of a type with no harness.
			harness = "undefined"
		}
		flags = append(flags, Flag{Kind: "skills-unsupported", Layer: "skills", Message: harness + " can't load skills, so the skills layer (" + itoa(len(folders)) + ") is only informational here."})
	}
	return layers, flags, nil
}

func total(layers []Layer) int {
	n := 0
	for _, l := range layers {
		n += l.Tokens
	}
	return n
}

// AgentInventory is agentInventory: everything one real agent receives.
func (p *Prompts) AgentInventory(ctx context.Context, a db.Agent) (*Inventory, error) {
	layers, flags, err := p.build(ctx, a)
	if err != nil {
		return nil, err
	}
	return &Inventory{Agent: &InventoryAgent{ID: a.ID, Name: a.Name, Type: a.Type, Harness: a.Harness, Model: a.Model}, Harness: a.Harness, TotalTokens: total(layers), Layers: layers, Flags: flags}, nil
}

// TypeInventory is typeInventory: everything an agent of type name would receive, as a synthetic agent of that type.
// It has the type's harness and model unless harness overrides (then no model, which belongs to the type's own
// harness), starts in the checkout, owns no ITSAs, and its first prompt is the type's brief with {{task}} left as is.
func (p *Prompts) TypeInventory(ctx context.Context, name, harness string) (*Inventory, error) {
	tv, _ := p.types().Get(name)
	t, ok := tv.(*jsjson.Object)
	if !ok || !jsjson.Truthy(tv) {
		return nil, fmt.Errorf("%w %s", ErrNoType, name)
	}
	str := func(key string) (string, bool) {
		v, _ := t.Get(key)
		s, ok := v.(string)
		return s, ok
	}
	own, _ := str("harness")
	h := own
	if harness != "" {
		h = harness
	}
	a := db.Agent{ID: "type:" + name, Name: name, Type: &name, Harness: h, Cwd: p.Templates.Root}
	a.Role, _ = str("description")
	if m, ok := str("model"); ok && (harness == "" || harness == own) {
		a.Model = &m
	}
	if b, _ := t.Get("brief"); jsjson.Truthy(b) {
		next := func() string { return p.nextSteps(name) }
		if brief, ok := renderBrief(t, map[string]string{"task": "{{task}}", "name": name, "type": name, "parent": "human", "cwd": p.Templates.Root, "branch": ""}, next); ok {
			a.FirstPrompt = &brief
		}
	}
	layers, flags, err := p.build(ctx, a)
	if err != nil {
		return nil, err
	}
	return &Inventory{Type: name, Harness: h, TotalTokens: total(layers), Layers: layers, Flags: flags}, nil
}

// nextSteps is src/process-brief-fallback.ts nextSteps: NextSteps when set, else the fallback prose.
func (p *Prompts) nextSteps(typ string) string {
	if p.NextSteps != nil {
		return p.NextSteps(typ)
	}
	return process.FallbackNextSteps(typ)
}

var briefVar = regexp.MustCompile(`\{\{(\w+)\}\}`)

// renderBrief is src/agent-types.ts renderBrief: the type's brief with its {{vars}} filled in (an unknown one empty),
// trimmed, or the task alone when the type has none; false without a task.
func renderBrief(t *jsjson.Object, vars map[string]string, nextSteps func() string) (string, bool) {
	if vars["task"] == "" {
		return "", false
	}
	b, _ := t.Get("brief")
	if !jsjson.Truthy(b) {
		return vars["task"], true
	}
	brief := jsjson.ToString(b)
	if strings.Contains(brief, "{{next_steps}}") {
		ns, ok := vars["next_steps"]
		if !ok {
			ns = nextSteps()
		}
		brief = strings.Replace(brief, "{{next_steps}}", ns, 1)
	}
	return jsjson.Trim(briefVar.ReplaceAllStringFunc(brief, func(m string) string { return vars[m[2:len(m)-2]] })), true
}

// BlockSummarizer is tiny.Steps.BlockSummary: a block's summary as {summary?, state}.
type BlockSummarizer func(ctx context.Context, hash, text, title string) (*jsjson.Object, error)

// toolDescription is toolDescription: an mcp-tools JSON block's own description, trimmed; false when the block isn't
// that JSON or the description is blank.
func toolDescription(b Block) (string, bool) {
	if b.Format != "json" {
		return "", false
	}
	v, err := jsjson.Parse([]byte(b.Text))
	if err != nil {
		return "", false
	}
	o, _ := v.(*jsjson.Object)
	d, _ := field(o, "description")
	s, ok := d.(string)
	if !ok || jsjson.Trim(s) == "" {
		return "", false
	}
	return jsjson.Trim(s), true
}

// WithSummaries is withSummaries (S-879): every block with its summary and state. A tool schema is never sent to a
// model: its description is the summary (state source). The rest go through Summarize once per text hash, which never
// blocks (a miss is queued and shows as pending); with no Summarize every block is off.
func (p *Prompts) WithSummaries(ctx context.Context, inv *Inventory) (*Inventory, error) {
	out := *inv
	out.Layers = make([]Layer, len(inv.Layers))
	sums := map[string]*jsjson.Object{}
	for i, l := range inv.Layers {
		l.Blocks = slices.Clone(l.Blocks)
		for j, b := range l.Blocks {
			if d, ok := toolDescription(b); ok {
				b.Summary, b.SummaryState = &d, "source"
				l.Blocks[j] = b
				continue
			}
			s, ok := sums[b.Hash]
			if !ok {
				if p.Summarize == nil {
					s = jsjson.NewObject("state", "off")
				} else {
					var err error
					if s, err = p.Summarize(ctx, b.Hash, b.Text, b.Title); err != nil {
						return nil, err
					}
				}
				sums[b.Hash] = s
			}
			if v, ok := s.Get("summary"); ok {
				if str, ok := v.(string); ok {
					b.Summary = &str
				}
			}
			state, _ := s.Get("state")
			b.SummaryState = jsjson.ToString(state)
			l.Blocks[j] = b
		}
		out.Layers[i] = l
	}
	return &out, nil
}

func realOrSelf(path string) string {
	if r, err := filepath.EvalSymlinks(path); err == nil {
		if abs, err := filepath.Abs(r); err == nil {
			return abs
		}
		return r
	}
	return path
}

// localeCompare is String#localeCompare in Node's default collation: ICU's root order, which x/text's root collator
// gives for every name TestLocaleCompareMatchesNode sorts (accents, decomposed forms, ß, compatibility forms and case
// included). A Collator keeps buffers between calls, so each sort takes its own.
func localeCompare() func(a, b string) int {
	return collate.New(language.Und).CompareString
}
