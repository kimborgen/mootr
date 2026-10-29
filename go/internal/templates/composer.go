package templates

import (
	"os"
	"path/filepath"
	"strings"
	"unicode/utf16"

	"stam/internal/jsjson"
)

// Composing is src/blocks.ts COMPOSING: the templates a type's composition (its `blocks`) applies to.
var Composing = []string{"system-prompt", "retro", "mail-to-human", "mail-to-human-restricted"}

// replaceDir is src/blocks.ts REPLACE_DIR: the block files a type's `replace` may point at.
const replaceDir = "blocks/_replace"

// RendersFromBlocks is src/templates.ts rendersFromBlocks: the template is its blocks, with no whole file over them.
func (s *Set) RendersFromBlocks(name string) bool {
	if !s.HasBlocks(name) {
		return false
	}
	if _, ok := s.UserTemplate(name); ok {
		return false
	}
	return !exists(filepath.Join(s.Root, "templates", name+".md"))
}

// ReplacementFiles is src/blocks.ts replacementFiles: the usable block files under blocks/_replace, by name, each with
// its path from the root as File.
func (s *Set) ReplacementFiles() []Block {
	entries, err := os.ReadDir(filepath.Join(s.Root, replaceDir))
	if err != nil {
		return nil
	}
	var out []Block
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		path := replaceDir + "/" + e.Name()
		if b, ok := s.UsableReplacement(path); ok {
			b.File = path
			out = append(out, b)
		}
	}
	return out
}

// EstimateTokens is src/inventory.ts estimateTokens: a quarter of the text's UTF-16 length, rounded up.
func EstimateTokens(text string) int {
	n := len(utf16.Encode([]rune(text)))
	return (n + 3) / 4
}

// oneLine is `s.replace(/\s+/g, ' ').trim()`.
func oneLine(s string) string {
	return strings.Join(strings.FieldsFunc(s, jsjson.IsSpace), " ")
}

// ComposerCatalog is src/inventory.ts composerCatalog (S-892): the blocks a type's composer lists, by composing
// template, and the replacement files it can pick. `rendered` is false for a template a whole file overrides, whose
// blocks a composition can't change; `applies` is false for the mail rules an agent of the type doesn't get, by
// mayMail of its model (the type's own, unless harness names another harness than the type's).
func (s *Set) ComposerCatalog(typ *jsjson.Object, harness string, mayMail func(model jsjson.Value) bool) (*jsjson.Object, error) {
	var model jsjson.Value
	if typ != nil {
		th, _ := typ.Get("harness")
		if harness == "" || harness == th {
			model, _ = typ.Get("model")
		}
	}
	gets := func(template string) bool {
		switch template {
		case "mail-to-human":
			return mayMail(model)
		case "mail-to-human-restricted":
			return !mayMail(model)
		}
		return true
	}
	blocks := []jsjson.Value{}
	for _, template := range Composing {
		if !s.HasBlocks(template) {
			continue
		}
		rendered := s.RendersFromBlocks(template)
		list, err := s.BlocksOf(template)
		if err != nil {
			return nil, err
		}
		for _, b := range list {
			blocks = append(blocks, jsjson.NewObject("id", b.ID, "title", b.Title, "summary", oneLine(b.Summary), "tokens", EstimateTokens(jsjson.TrimEnd(b.Body)),
				"template", template, "rendered", rendered, "applies", gets(template)))
		}
	}
	replacements := []jsjson.Value{}
	for _, b := range s.ReplacementFiles() {
		replacements = append(replacements, jsjson.NewObject("path", b.File, "id", b.ID, "title", b.Title, "summary", oneLine(b.Summary), "tokens", EstimateTokens(jsjson.TrimEnd(b.Body))))
	}
	return jsjson.NewObject("blocks", blocks, "replacements", replacements), nil
}
