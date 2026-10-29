package instructions

import (
	"bufio"
	"context"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"stam/internal/db"
	"stam/internal/jsjson"
)

// Part is src/agent-instructions.ts InstructionPart: one piece of what an agent receives, for the web UI's
// Instructions view. Source is stam, stam-generated, repo or user-global; Origin is the template or settings item the
// part comes from; Format is markdown or text.
type Part struct {
	Label  string `json:"label"`
	Source string `json:"source"`
	Path   string `json:"path,omitempty"`
	Origin string `json:"origin,omitempty"`
	Format string `json:"format"`
	Text   string `json:"text"`
}

// partFileLimit is FILE_LIMIT: a native instruction file is cut at this many UTF-16 units.
const partFileLimit = 50_000

// mark is a placeholder's unique marker, so a template renders with its literal text and substituted values in the
// template's own order.
func mark(key string) string { return "\x00stam:" + key + "\x00" }

var markRe = regexp.MustCompile(`\x00stam:(\w+)\x00`)

type markedSeg struct{ key, text string }

// splitMarked is text split at its markers: literal runs (key "") and one empty segment per marker.
func splitMarked(text string) []markedSeg {
	var out []markedSeg
	last := 0
	for _, m := range markRe.FindAllStringSubmatchIndex(text, -1) {
		if m[0] > last {
			out = append(out, markedSeg{text: text[last:m[0]]})
		}
		out = append(out, markedSeg{key: text[m[2]:m[3]]})
		last = m[1]
	}
	if last < len(text) {
		out = append(out, markedSeg{text: text[last:]})
	}
	return out
}

// literal is a stam-generated markdown part of the trimmed text; ok is false when it is empty.
func literal(text, label, origin string) (Part, bool) {
	t := jsjson.Trim(text)
	return Part{Label: label, Source: "stam-generated", Origin: origin, Format: "markdown", Text: t}, t != ""
}

// orgTemplate is the org paragraph's template when it is one: the agent's own role paragraph.
func (p *Prompts) orgTemplate(ctx context.Context, a db.Agent) string {
	switch {
	case deref(a.Kind) == "assistant":
		return "assistant"
	case p.isChief(ctx, a):
		return "chief-of-staff"
	}
	return ""
}

// AgentInstructionParts is src/agent-instructions.ts agentInstructionParts: everything one agent receives, in the order
// it arrives. The parts are rendered now, so they show what the agent gets at its next start.
func (p *Prompts) AgentInstructionParts(ctx context.Context, a db.Agent) ([]Part, error) {
	parts, err := p.systemPromptParts(ctx, a)
	if err != nil {
		return nil, err
	}
	for _, f := range p.Templates.NativeFiles(ctx, a.Harness, a.Cwd) {
		parts = append(parts, Part{Label: filepath.Base(f.Path), Source: f.Source, Path: f.Path, Format: "markdown", Text: readText(f.Path)})
	}
	first := "Not recorded for this agent."
	if a.FirstPrompt != nil {
		first = *a.FirstPrompt
	}
	parts = append(parts, Part{Label: "First prompt", Source: "stam", Format: "markdown", Text: first})
	skills := p.Templates.SkillFolders()
	slices.SortFunc(skills, compareUTF16)
	text := "None."
	if len(skills) > 0 {
		text = bulletList(skills)
	}
	parts = append(parts, Part{Label: "Skills", Source: "stam", Format: "text", Text: text})
	servers := p.extraMcpServers()
	if !slices.Contains(servers, "stam") {
		servers = append(servers, "stam")
	}
	parts = append(parts, Part{Label: "MCP servers", Source: "stam", Format: "text", Text: bulletList(servers)})
	parts = append(parts, Part{
		Label: "Harness built-in prompt", Source: "stam-generated", Format: "text",
		Text: "This is everything stam gives " + a.Name + ". The harness's own built-in system prompt is not shown here.",
	})
	return parts, nil
}

// systemPromptParts is system-prompt.md as the agent gets it: its literal text and each substituted block, in template
// order, so overrides, reordering and omitted placeholders all show where the agent sees them.
func (p *Prompts) systemPromptParts(ctx context.Context, a db.Agent) ([]Part, error) {
	typ := deref(a.Type)
	vars := map[string]string{"id": a.ID, "name": a.Name, "machine": a.Machine}
	for _, k := range []string{"role", "org", "instructions", "cost", "retro", "lessons", "workspace", "itsa", "requirements", "human_mail"} {
		vars[k] = mark(k)
	}
	text, err := p.Templates.Render("system-prompt", vars, typ)
	if err != nil {
		return nil, err
	}
	var parts []Part
	add := func(part Part, ok bool) {
		if ok {
			parts = append(parts, part)
		}
	}
	for _, seg := range splitMarked(text) {
		switch seg.key {
		case "":
			add(literal(seg.text, "System prompt", "system-prompt"))
		case "role":
			role := a.Role
			if role == "" {
				role = "not set"
			}
			parts = append(parts, Part{Label: "Role", Source: "stam", Format: "markdown", Text: role})
		case "org":
			segs, err := p.TypeSegments(a)
			if err != nil {
				return nil, err
			}
			for _, s := range segs {
				if s.Key == "skills" {
					parts = append(parts, Part{Label: "Skills available", Source: "stam-generated", Origin: "type-skills", Format: "markdown", Text: s.Text})
				} else {
					parts = append(parts, Part{Label: "Type: " + typ, Source: "stam", Origin: "type-" + typ, Format: "markdown", Text: s.Text})
				}
			}
			org, err := p.OrgRest(ctx, a)
			if err != nil {
				return nil, err
			}
			if org != "" {
				parts = append(parts, Part{Label: "Org", Source: "stam-generated", Origin: p.orgTemplate(ctx, a), Format: "markdown", Text: org})
			}
		case "instructions":
			files, err := p.instructionFileParts(ctx, a.Harness, a.Cwd)
			if err != nil {
				return nil, err
			}
			parts = append(parts, files...)
		case "cost":
			cost, err := p.ManagerCostPrompt(ctx, a)
			if err != nil {
				return nil, err
			}
			if cost != "" {
				parts = append(parts, Part{Label: "Cost", Source: "stam-generated", Format: "markdown", Text: cost})
			}
		case "retro":
			retro, err := p.Templates.Render("retro", nil, typ)
			if err != nil {
				return nil, err
			}
			add(literal(retro, "Retros", "retro"))
		case "lessons":
			lessons, _ := p.CachedLessons(a.ID)
			add(literal(lessons, "Lessons from similar work", "lessons"))
		case "workspace":
			ws, err := p.WorkspacePrompt(ctx, a)
			if err != nil {
				return nil, err
			}
			add(literal(ws, "Your workspace", "workspace"))
		case "itsa":
			itsa, err := p.ItsaPrompt(ctx, a.ID)
			if err != nil {
				return nil, err
			}
			if t := jsjson.Trim(itsa); t != "" {
				parts = append(parts, Part{Label: "ITSAs", Source: "stam-generated", Origin: "itsa", Format: "markdown", Text: t})
			}
		case "requirements":
			req, err := p.RequirementsPrompt()
			if err != nil {
				return nil, err
			}
			if req != "" {
				parts = append(parts, Part{Label: "Requirements", Source: "stam-generated", Origin: "requirements", Format: "markdown", Text: req})
			}
		case "human_mail":
			mail, err := p.Templates.HumanMailPrompt(a.Model, typ)
			if err != nil {
				return nil, err
			}
			if mail != "" {
				origin := "mail-to-human-restricted"
				// src/settings.ts mayMailHuman: a nil or empty model may.
				if a.Model == nil || p.Settings().HumanMail.MayMail(*a.Model) {
					origin = "mail-to-human"
				}
				parts = append(parts, Part{Label: "Mail to your user", Source: "stam-generated", Origin: origin, Format: "markdown", Text: mail})
			}
		}
	}
	return parts, nil
}

// instructionFileParts is instruction-files.md as the agent gets it: its literal heading, then the all-agents text and
// the skipped-files note, in the template's order.
func (p *Prompts) instructionFileParts(ctx context.Context, harness, cwd string) ([]Part, error) {
	global, note := p.Templates.InstructionsDetail(ctx, harness, cwd)
	if global == "" && note == "" {
		return nil, nil
	}
	text, err := p.Templates.Render("instruction-files", map[string]string{"global": mark("global"), "files": mark("files")}, "")
	if err != nil {
		return nil, err
	}
	var parts []Part
	for _, seg := range splitMarked(text) {
		switch {
		case seg.key == "":
			if part, ok := literal(seg.text, "Instructions", "instruction-files"); ok {
				parts = append(parts, part)
			}
		case seg.key == "global" && global != "":
			parts = append(parts, Part{Label: "Instructions for all agents", Source: "stam", Path: filepath.Join(p.Templates.Home, "instructions.md"), Origin: "instructions", Format: "markdown", Text: global})
		case seg.key == "files" && note != "":
			parts = append(parts, Part{Label: "Instruction files your harness skips", Source: "stam-generated", Origin: "instruction-files", Format: "markdown", Text: note})
		}
	}
	return parts, nil
}

// extraMcpServers is the names of src/instructions.ts extraMcpServers, in Object.entries order: settings.mcpServers'
// entries that are truthy and not `enabled: false`.
func (p *Prompts) extraMcpServers() []string {
	var out []string
	switch v := p.Settings().McpServers.(type) {
	case *jsjson.Object:
		for _, k := range v.Keys() {
			s, _ := v.Get(k)
			if enabledServer(s) {
				out = append(out, k)
			}
		}
	case []jsjson.Value:
		for i, s := range v {
			if enabledServer(s) {
				out = append(out, strconv.Itoa(i))
			}
		}
	}
	return out
}

// enabledServer is `s && s.enabled !== false`.
func enabledServer(s jsjson.Value) bool {
	if !jsjson.Truthy(s) {
		return false
	}
	if o, ok := s.(*jsjson.Object); ok {
		if en, ok := o.Get("enabled"); ok && en == false {
			return false
		}
	}
	return true
}

func bulletList(items []string) string {
	text := ""
	for i, s := range items {
		if i > 0 {
			text += "\n"
		}
		text += "- " + s
	}
	return text
}

// compareUTF16 is JavaScript's default sort order: by UTF-16 code units.
func compareUTF16(a, b string) int {
	return slices.Compare(utf16.Encode([]rune(a)), utf16.Encode([]rune(b)))
}

// openText opens a native instruction file for readText; a test swaps it to count the bytes read.
var openText = func(path string) (io.ReadCloser, error) { return os.Open(path) }

// readText is readText in src/agent-instructions.ts, `readFileSync(path, 'utf8').slice(0, FILE_LIMIT)`: the file
// decoded as Node's utf8 decoder does (decodeUTF8), cut at partFileLimit UTF-16 units; "" when it can't be read. It
// decodes as it reads and stops at the cap, so a huge file costs no more than its first partFileLimit characters. A
// cut inside a surrogate pair leaves U+FFFD, which differs from TS in route JSON as jsPrefix says.
func readText(path string) string {
	f, err := openText(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	text, err := decodePrefix(f, partFileLimit)
	if err != nil {
		return ""
	}
	return text
}

// decodePrefix is the first limit UTF-16 units of what r holds, decoded as the WHATWG UTF-8 decoder Node's
// readFileSync(path, 'utf8') uses, then sliced as String.slice does: each maximal subpart of an ill-formed sequence
// becomes one U+FFFD (Go's own conversion gives one per byte), a BOM is kept, and a cut between the halves of a
// surrogate pair leaves U+FFFD. It reads no further than the limit needs.
func decodePrefix(r io.Reader, limit int) (string, error) {
	br := bufio.NewReader(r)
	var b strings.Builder
	for units := 0; units < limit; {
		p, err := br.Peek(utf8.UTFMax)
		if err != nil && err != io.EOF {
			return "", err
		}
		if len(p) == 0 {
			break
		}
		c, n := utf8.DecodeRune(p)
		if c == utf8.RuneError && n <= 1 {
			n = maximalSubpart(p)
		}
		w := utf16.RuneLen(c)
		if units+w > limit {
			b.WriteRune(utf8.RuneError)
			break
		}
		units += w
		b.WriteRune(c)
		br.Discard(n)
	}
	return b.String(), nil
}

// maximalSubpart is how many bytes at the start of b, which doesn't start a well-formed sequence, the decoder replaces
// with one U+FFFD: the lead byte and the continuation bytes that could still have completed it (Unicode 3.9, D93b).
func maximalSubpart(b []byte) int {
	c := b[0]
	var need int
	lo, hi := byte(0x80), byte(0xBF)
	switch {
	case c >= 0xC2 && c <= 0xDF:
		need = 1
	case c == 0xE0:
		need, lo = 2, 0xA0
	case c >= 0xE1 && c <= 0xEC, c == 0xEE, c == 0xEF:
		need = 2
	case c == 0xED:
		need, hi = 2, 0x9F
	case c == 0xF0:
		need, lo = 3, 0x90
	case c >= 0xF1 && c <= 0xF3:
		need = 3
	case c == 0xF4:
		need, hi = 3, 0x8F
	default:
		return 1
	}
	n := 1
	for ; n <= need && n < len(b); n++ {
		if b[n] < lo || b[n] > hi {
			break
		}
		lo, hi = 0x80, 0xBF
	}
	return n
}
