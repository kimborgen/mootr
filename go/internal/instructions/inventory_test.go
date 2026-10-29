package instructions

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"stam/internal/jsjson"
	"stam/internal/process"
)

// The inventory against src/inventory.ts (testdata/inventoryref.mjs on the same home): withSummaries of each agent's
// inventory and of type inventories, in the two parts homes, with no summary model. The homes add a type whose block
// composition switches off, replaces and names unknown blocks, hits a whole-file override (in "override") and the mail
// rules its model doesn't get; a type with no harness; an instruction file holding headings in fences, CRLF and
// no-break-space headings, repeats and tiny blocks; an AGENTS.md that is a symlink to the CLAUDE.md a harness loads;
// and empty files.

var inventoryTypes = []struct {
	Name    string `json:"name"`
	Harness string `json:"harness"`
}{{"composer", ""}, {"composer", "claude"}, {"composer", "codex"}, {"skilled", ""}, {"developer", ""}, {"manager", ""}, {"nohar", ""}, {"missing", ""}}

const composerType = `,"composer":{"description":"Composes","harness":"codex","model":"gpt-x",` +
	`"brief":"Do {{task}} as {{name}} for {{parent}} in {{cwd}}{{branch}}.\n\n{{next_steps}}\n{{unknown}}",` +
	`"blocks":{"off":["shared-machine","nope",7],"replace":{"ask-permission":"blocks/retro/10-retro-record.md","waiting-and-subscribing":"/etc/hostname","nope2":"x","mail-human-restricted":"blocks/retro/10-retro-record.md","retro-record":""},"order":"bad"}},` +
	`"nohar":{"description":"No harness"}`

// markdownFile exercises splitIntoBlocks: a heading inside a fence, a longer fence a shorter one doesn't close, a CRLF
// line that isn't a heading, a no-break space after #, a level-3 heading with no level 2, repeated headings, tiny
// blocks merged forward, and a name that lowers differently in Go.
var markdownFile = "Intro line before any heading.\n\n# Top\n\nshort\n\n## Same\n\n" + strings.Repeat("body words ", 30) +
	"\n\n## Same\n\n" + strings.Repeat("again words ", 30) + "\n\n```\n# not a heading\n```\n\n~~~~\n~~~\n# still code\n~~~~\n\n" +
	"## CRLF heading\r\n" + strings.Repeat("crlf words ", 25) + "\r\n\n#\u00a0Nbsp heading\n\n" + strings.Repeat("nbsp words ", 25) +
	"\n\n### Deep without middle\n\n" + strings.Repeat("deep words ", 25) + "\n\n#### Not split\n\n#nospace\n\n## \u0130stanbul \u00c9t\u00e9!\n\n" +
	strings.Repeat("istanbul words ", 25) + "\n\n## Tiny\n\nx\n"

func TestInventoryMatchesTS(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	t.Run("full", func(t *testing.T) {
		runInventory(t, "full", `{"chiefOfStaff":"chief","humanMail":{"models":{"cheap-model":false}},"requirements":{"enabled":true},`+
			`"mcpServers":{"zeta":{"command":"z"},"2":{"command":"two"},"off":{"command":"o","enabled":false},"stam":{"command":"s"}}}`)
	})
	t.Run("override", func(t *testing.T) {
		runInventory(t, "override", `{"mcpServers":[{"command":"x"}]}`)
	})
}

type inventoryOut struct {
	Agents map[string]Inventory `json:"agents"`
	Types  []struct {
		Inventory
		Error string `json:"error"`
	} `json:"types"`
}

func runInventory(t *testing.T, name, settings string) {
	h := partsHome(t, name, settings, composerType)
	root := repoRoot(t)
	loaded, err := process.Load(filepath.Join(root, "processes"), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	h.p.NextSteps = func(typ string) string { return process.NextSteps(loaded.Processes, typ) }
	proj := filepath.Join(h.userHome, "proj")
	sub := filepath.Join(proj, "sub")
	if name == "full" {
		write(t, filepath.Join(sub, "CLAUDE.md"), markdownFile)
		// AGENTS.md beside the CLAUDE.md Claude Code loads is a symlink to it, so the note names the same file again.
		if err := os.Remove(filepath.Join(sub, "AGENTS.md")); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink("CLAUDE.md", filepath.Join(sub, "AGENTS.md")); err != nil {
			t.Fatal(err)
		}
		write(t, filepath.Join(h.home, "skills", "empty-skill", "SKILL.md"), "")
	} else {
		write(t, filepath.Join(h.home, "instructions.md"), "")
		write(t, filepath.Join(sub, "CLAUDE.local.md"), "")
	}
	h.agent("comp", map[string]any{"lifecycle": "active", "type": "composer", "harness": "codex", "cwd": sub})
	agents := append(append([]string{}, partsAgents...), "comp")

	var want inventoryOut
	h.ts("testdata/inventoryref.mjs", map[string]any{"agents": agents, "types": inventoryTypes, "warm": []string{"dev"}}, &want)
	for _, id := range agents {
		a, err := h.db.GetAgent(h.ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		inv, err := h.p.AgentInventory(h.ctx, a)
		if err != nil {
			t.Fatalf("%s: %v", id, err)
		}
		got, err := h.p.WithSummaries(h.ctx, inv)
		if err != nil {
			t.Fatal(err)
		}
		compareInventory(t, id, *got, want.Agents[id])
	}
	for i, ty := range inventoryTypes {
		w := want.Types[i]
		inv, err := h.p.TypeInventory(h.ctx, ty.Name, ty.Harness)
		label := "type " + ty.Name + "/" + ty.Harness
		if w.Error != "" {
			if err == nil || err.Error() != w.Error {
				t.Errorf("%s: error %v, TS %q", label, err, w.Error)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%s: %v", label, err)
		}
		got, err := h.p.WithSummaries(h.ctx, inv)
		if err != nil {
			t.Fatal(err)
		}
		compareInventory(t, label, *got, w.Inventory)
	}

	// The cases reach what they are meant to.
	kinds := map[string]bool{}
	for _, inv := range want.Agents {
		for _, f := range inv.Flags {
			kinds[f.Kind] = true
		}
	}
	for _, k := range []string{"composition-ignored", "empty-file", "skills-unsupported"} {
		if !kinds[k] {
			t.Errorf("no agent has a %s flag", k)
		}
	}
	// The override home has no skills, so its skills layer is empty wherever the test runs. An empty instruction-files
	// layer isn't asserted: the walk up from a temp cwd finds a CLAUDE.md when TMPDIR is inside a checkout (test-slot.sh).
	if name == "override" {
		layers := map[string]bool{}
		for _, inv := range want.Agents {
			for _, f := range inv.Flags {
				if f.Kind == "empty-layer" {
					layers[f.Layer] = true
				}
			}
		}
		if !layers["skills"] {
			t.Errorf("no agent has an empty-layer flag on its skills: %v", layers)
		}
	}
	if name == "full" {
		if !kinds["duplicate-file"] || !kinds["type-skill-missing"] {
			t.Errorf("flags: %v", kinds)
		}
		states := map[string]bool{}
		for _, b := range want.Agents["comp"].Layers[0].Blocks {
			states[b.State] = true
		}
		if !states["off"] || !states["replaced"] || !states["replaces"] {
			t.Errorf("comp's composition states: %v", states)
		}
	}
}

// compareInventory reports where got differs from TS's inventory, layer by layer and block by block.
func compareInventory(t *testing.T, label string, got, want Inventory) {
	t.Helper()
	if reflect.DeepEqual(got, want) {
		return
	}
	t.Errorf("%s: inventory differs from TS", label)
	if !reflect.DeepEqual(got.Agent, want.Agent) || got.Type != want.Type || got.Harness != want.Harness || got.TotalTokens != want.TotalTokens {
		t.Errorf("  head: go %+v %q %q %d, ts %+v %q %q %d", got.Agent, got.Type, got.Harness, got.TotalTokens, want.Agent, want.Type, want.Harness, want.TotalTokens)
	}
	if !reflect.DeepEqual(got.Flags, want.Flags) {
		t.Errorf("  flags:\n    go: %+v\n    ts: %+v", got.Flags, want.Flags)
	}
	for i := 0; i < max(len(got.Layers), len(want.Layers)); i++ {
		var g, w Layer
		if i < len(got.Layers) {
			g = got.Layers[i]
		}
		if i < len(want.Layers) {
			w = want.Layers[i]
		}
		if reflect.DeepEqual(g, w) {
			continue
		}
		gb, wb := g.Blocks, w.Blocks
		g.Blocks, w.Blocks = nil, nil
		if !reflect.DeepEqual(g, w) {
			t.Errorf("  layer %d: go %+v, ts %+v", i, g, w)
		}
		shown := 0
		for j := 0; j < max(len(gb), len(wb)) && shown < 3; j++ {
			var x, y Block
			if j < len(gb) {
				x = gb[j]
			}
			if j < len(wb) {
				y = wb[j]
			}
			if !reflect.DeepEqual(x, y) {
				shown++
				xs, _ := json.Marshal(x)
				ys, _ := json.Marshal(y)
				t.Errorf("  layer %s block %d:\n    go: %.600s\n    ts: %.600s", w.Key, j, xs, ys)
			}
		}
	}
}

// localeCompare sorts skill-like names as Node's String#localeCompare does: punctuation, fullwidth forms, symbols,
// digits, case, accents precomposed or not, expansions such as ß and Æ, and compatibility forms such as ﬁ and ½.
func TestLocaleCompareMatchesNode(t *testing.T) {
	names := []string{"z", "Zed", "zed", "s-one", "s_one", "sone", "s1", "S-one", "été", "ete", "Ete", "Été", "empty-skill",
		"～", "~", "\U0001F600", "1x", "10", "9", "a", "A", "á", "Á", "b", "ça", "ca", "da", "ño", "no", "oz",
		"öa", "øb", "ü", "u", "ÿ", "y", "α", "_x", "-x", ".x", "@x", "$x",
		// Accents and their decomposed forms, expansions and contractions, compatibility forms, spaces.
		"è", "é", "e", "E", "é", "è", "É", "ä", "ä", "ſ", "ß", "ss", "Æ", "ae", "ﬁ", "fi", "Ⅳ", "iv",
		"½", "1/2", "x y", "x-y", "xy", "", " "}
	cmd := exec.Command("node", "-e", `const a = JSON.parse(require('fs').readFileSync(0, 'utf8')); a.sort((x, y) => x.localeCompare(y)); process.stdout.write(JSON.stringify(a));`)
	in, _ := json.Marshal(names)
	cmd.Stdin = strings.NewReader(string(in))
	out, err := cmd.Output()
	if err != nil {
		t.Skipf("node: %v", err)
	}
	var want []string
	if err := json.Unmarshal(out, &want); err != nil {
		t.Fatal(err)
	}
	got := append([]string{}, names...)
	slices.SortStableFunc(got, localeCompare())
	if !reflect.DeepEqual(got, want) {
		t.Errorf("sorted:\n  go:   %q\n  node: %q", got, want)
	}
}

// WithSummaries asks once per text hash, takes a tool's description as its summary, and passes a summarizer's error
// on.
func TestWithSummaries(t *testing.T) {
	text := "same text"
	inv := &Inventory{Layers: []Layer{
		{Key: "a", Blocks: []Block{{Hash: hashText(text), Text: text, Title: "first", Format: "markdown"}, {Hash: hashText(text), Text: text, Title: "second", Format: "markdown"}}},
		{Key: "mcp-tools", Blocks: []Block{{Hash: "h2", Text: `{"name":"t","description":"  Does t.  "}`, Format: "json"}, {Hash: "h3", Text: `{"name":"u","description":" "}`, Format: "json"}}},
	}}
	var asked []string
	p := &Prompts{Summarize: func(ctx context.Context, hash, text, title string) (*jsjson.Object, error) {
		asked = append(asked, title)
		if hash == "h3" {
			return jsjson.NewObject("state", "pending"), nil
		}
		return jsjson.NewObject("summary", "Says the same.", "state", "auto"), nil
	}}
	got, err := p.WithSummaries(context.Background(), inv)
	if err != nil {
		t.Fatal(err)
	}
	// The repeated text is asked once, with its first block's title; the blank description goes to the summarizer.
	if !reflect.DeepEqual(asked, []string{"first", ""}) {
		t.Errorf("asked for %q", asked)
	}
	b := got.Layers[0].Blocks
	if b[0].SummaryState != "auto" || *b[0].Summary != "Says the same." || b[1].SummaryState != "auto" {
		t.Errorf("text blocks: %+v", b)
	}
	tools := got.Layers[1].Blocks
	if tools[0].SummaryState != "source" || *tools[0].Summary != "Does t." || tools[1].SummaryState != "pending" || tools[1].Summary != nil {
		t.Errorf("tool blocks: %+v", tools)
	}
	if inv.Layers[0].Blocks[0].SummaryState != "" {
		t.Error("WithSummaries changed the inventory it was given")
	}
	if got, _ := (&Prompts{}).WithSummaries(context.Background(), inv); got.Layers[0].Blocks[0].SummaryState != "off" {
		t.Errorf("with no summarizer: %q", got.Layers[0].Blocks[0].SummaryState)
	}
	boom := errors.New("db gone")
	p.Summarize = func(context.Context, string, string, string) (*jsjson.Object, error) { return nil, boom }
	if _, err := p.WithSummaries(context.Background(), inv); !errors.Is(err, boom) {
		t.Errorf("the summarizer's error: %v", err)
	}
}
