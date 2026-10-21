package templates

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"stam/internal/jsjson"
)

// Block is one block file (S-883): stam's own instruction text, split into files under blocks/NAME/ with a frontmatter
// header (id, title, summary, scope, kind, applies, summary_of). A template built from blocks is the bodies
// concatenated in filename order, so the text an agent gets is the text of the files, verbatim (src/blocks.ts).
type Block struct {
	File      string
	ID        string
	Title     string
	Summary   string
	Scope     string
	Kind      string
	Applies   []string
	SummaryOf string
	Body      string
}

// ParseBlock reads one block file as src/blocks.ts parseBlock does.
func ParseBlock(file, raw string) (Block, error) {
	raw = strings.ReplaceAll(raw, "\r\n", "\n")
	// /^---\n([\s\S]*?)\n---\n/: the header runs to the first "\n---\n" after the opening line.
	rest, ok := strings.CutPrefix(raw, "---\n")
	end := strings.Index(rest, "\n---\n")
	if !ok || end < 0 {
		return Block{}, fmt.Errorf("block %s: no frontmatter", file)
	}
	f := map[string]string{}
	key := ""
	for _, line := range strings.Split(rest[:end], "\n") {
		r := []rune(line)
		if len(r) > 0 && jsjson.IsSpace(r[0]) && key != "" {
			sep := ""
			if f[key] != "" {
				sep = "\n"
			}
			f[key] += sep + jsjson.Trim(line)
			continue
		}
		k, v, ok := frontmatterLine(line)
		if !ok {
			return Block{}, fmt.Errorf("block %s: bad frontmatter line %q", file, line)
		}
		key = k
		if v == "|" || v == ">" {
			v = ""
		}
		f[key] = v
	}
	for _, k := range []string{"id", "title", "summary", "scope", "kind", "summary_of"} {
		if f[k] == "" {
			return Block{}, fmt.Errorf("block %s: no %s", file, k)
		}
	}
	b := Block{File: file, ID: f["id"], Title: f["title"], Summary: f["summary"], Scope: f["scope"], Kind: f["kind"], SummaryOf: f["summary_of"], Body: raw[4+end+5:]}
	if a := f["applies"]; a != "" {
		a = strings.TrimSuffix(strings.TrimPrefix(a, "["), "]")
		for _, s := range strings.Split(a, ",") {
			if s = jsjson.Trim(s); s != "" {
				b.Applies = append(b.Applies, s)
			}
		}
	}
	return b, nil
}

// frontmatterLine is /^(\w+):\s*(.*)$/ with JavaScript's \s, and . stopping at a line terminator.
func frontmatterLine(line string) (key, value string, ok bool) {
	i := 0
	for i < len(line) && isWord(line[i]) {
		i++
	}
	if i == 0 || i >= len(line) || line[i] != ':' {
		return "", "", false
	}
	value = strings.TrimLeftFunc(line[i+1:], jsjson.IsSpace)
	if strings.ContainsAny(value, "\r  ") {
		return "", "", false
	}
	return line[:i], value, true
}

func isWord(c byte) bool {
	return c == '_' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
}

func (s *Set) blocksDir(name string) string { return filepath.Join(s.Root, "blocks", name) }

// HasBlocks is whether name is built from block files: a folder under blocks/ not starting with `_` (one starting with
// `_` holds the files a type's `replace` points at, not a template).
func (s *Set) HasBlocks(name string) bool {
	return !strings.HasPrefix(name, "_") && exists(s.blocksDir(name))
}

// BlocksOf is the blocks of one template, in filename order; none when the template isn't built from blocks.
func (s *Set) BlocksOf(name string) ([]Block, error) {
	dir := s.blocksDir(name)
	entries, err := os.ReadDir(dir)
	if err != nil {
		if exists(dir) {
			return nil, err
		}
		return nil, nil
	}
	var out []Block
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return nil, err
		}
		b, err := ParseBlock(e.Name(), string(raw))
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, nil
}

// BlocksText is a template's blocks joined. A memory block (S-888) always starts a paragraph of its own: the block
// before it is closed with a blank line when its file ends after a single newline. Every other join is verbatim.
func (s *Set) BlocksText(name string) (string, error) {
	all, err := s.BlocksOf(name)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	for i, bl := range all {
		if i+1 < len(all) && all[i+1].Kind == "memory" && !strings.HasSuffix(bl.Body, "\n\n") {
			b.WriteString(strings.TrimSuffix(bl.Body, "\n") + "\n\n")
		} else {
			b.WriteString(bl.Body)
		}
	}
	return b.String(), nil
}

// TypeBlocks is an agent type's composition of the global templates (S-886, S-892): Off block ids are dropped, Replace
// swaps a block's body for a replacement file's, and Order puts the listed blocks first, in that order.
type TypeBlocks struct {
	Off     []string
	Replace map[string]string
	Order   []string
}

// NormalizeTypeBlocks cleans a type's `blocks` as the registry holds it (an agent can hand-edit it) to the valid shape,
// naming what it drops in problems (src/blocks.ts normalizeTypeBlocks).
func NormalizeTypeBlocks(raw jsjson.Value) (TypeBlocks, []string) {
	var tb TypeBlocks
	var problems []string
	r, ok := raw.(*jsjson.Object)
	if !ok {
		if raw == nil {
			return tb, nil
		}
		return tb, []string{"blocks is not an object"}
	}
	strs := func(v jsjson.Value) ([]string, bool) {
		var out []string
		all := true
		for _, x := range v.([]jsjson.Value) {
			if s, ok := x.(string); ok {
				out = append(out, s)
			} else {
				all = false
			}
		}
		return out, all
	}
	if v, ok := r.Get("off"); ok && v != nil {
		if _, isList := v.([]jsjson.Value); isList {
			ok, all := strs(v)
			tb.Off = ok
			if !all {
				problems = append(problems, "blocks.off has entries that are not block ids")
			}
		} else {
			problems = append(problems, "blocks.off is not a list")
		}
	}
	if v, ok := r.Get("replace"); ok && v != nil {
		if o, isObj := v.(*jsjson.Object); isObj {
			for _, k := range o.Keys() {
				x, _ := o.Get(k)
				if p, ok := x.(string); ok && p != "" {
					if tb.Replace == nil {
						tb.Replace = map[string]string{}
					}
					tb.Replace[k] = p
				}
			}
			if len(tb.Replace) != o.Len() {
				problems = append(problems, "blocks.replace has entries that are not file paths")
			}
		} else {
			problems = append(problems, "blocks.replace is not an object")
		}
	}
	if v, ok := r.Get("order"); ok && v != nil {
		if _, isList := v.([]jsjson.Value); isList {
			ok, all := strs(v)
			seen := map[string]bool{}
			for _, id := range ok {
				if !seen[id] {
					seen[id] = true
					tb.Order = append(tb.Order, id)
				}
			}
			if !all {
				problems = append(problems, "blocks.order has entries that are not block ids")
			}
		} else {
			problems = append(problems, "blocks.order is not a list")
		}
	}
	return tb, problems
}

func (tb TypeBlocks) composes() bool {
	return len(tb.Off) > 0 || len(tb.Replace) > 0 || len(tb.Order) > 0
}

// usableReplacement is the replacement block at path, which must be a block file inside blocks/ once symlinks are
// resolved (the registry is editable by agents, so a path is never trusted); false when it can't be used.
func (s *Set) usableReplacement(path string) (Block, bool) {
	base, err := filepath.EvalSymlinks(filepath.Join(s.Root, "blocks"))
	if err != nil {
		return Block{}, false
	}
	p := path
	if !strings.HasPrefix(p, "/") {
		p = filepath.Join(s.Root, p)
	}
	file, err := filepath.EvalSymlinks(p)
	if err != nil || !strings.HasPrefix(file, base+string(filepath.Separator)) {
		return Block{}, false
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		return Block{}, false
	}
	b, err := ParseBlock(path, string(raw))
	return b, err == nil
}

// ComposedBlocks is the blocks of one template for an agent of a type: its Off blocks dropped, its Replace blocks
// swapped for the replacement's body, its Order blocks first. Without composition, exactly BlocksOf(name).
func (s *Set) ComposedBlocks(name string, raw jsjson.Value) ([]Block, error) {
	blocks, err := s.BlocksOf(name)
	if err != nil {
		return nil, err
	}
	tb, _ := NormalizeTypeBlocks(raw)
	if !tb.composes() {
		return blocks, nil
	}
	off := map[string]bool{}
	for _, id := range tb.Off {
		off[id] = true
	}
	rank := map[string]float64{}
	for i, id := range tb.Order {
		rank[id] = float64(i)
	}
	rankOf := func(id string) float64 {
		if r, ok := rank[id]; ok {
			return r
		}
		return math.Inf(1)
	}
	var out []Block
	for _, b := range blocks {
		if off[b.ID] {
			continue
		}
		if p := tb.Replace[b.ID]; p != "" {
			if r, ok := s.usableReplacement(p); ok {
				b.Body = r.Body
			}
		}
		out = append(out, b)
	}
	sort.SliceStable(out, func(i, j int) bool { return rankOf(out[i].ID) < rankOf(out[j].ID) })
	return out, nil
}

// ComposedText is the composed blocks' bodies joined verbatim.
func (s *Set) ComposedText(name string, raw jsjson.Value) (string, error) {
	blocks, err := s.ComposedBlocks(name, raw)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	for _, bl := range blocks {
		b.WriteString(bl.Body)
	}
	return b.String(), nil
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
