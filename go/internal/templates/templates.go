// Package templates renders the text stam sends to agents, as src/templates.ts, src/blocks.ts and src/instructions.ts
// do (S-2804): every text comes from a template, a file in STAM_HOME/templates overrides the shipped one (the
// checkout's templates/ folder, or for a template built from block files, blocks/NAME/, their bodies in order), and an
// agent type's `blocks` composition (off, replace, order) applies to a template built from blocks.
//
// Not yet ported: the shared cache a non-home daemon reads registry.json and instructions.md from (peerShared), and
// the template list, save and reset the settings UI uses.
package templates

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"unicode/utf16"

	"stam/internal/config"
	"stam/internal/jsjson"
)

// Set is the templates of one home.
type Set struct {
	// Root is the checkout or release the daemon runs from: templates/, blocks/ and registry/defaults.json (src/config.ts
	// ROOT).
	Root string
	// Home is STAM_HOME: templates/ overrides, registry.json, instructions.md.
	Home string
	// UserHome is the user's home folder ($HOME): the harnesses' global instruction files, and where the walk up from a
	// working folder outside a git repo stops.
	UserHome string
	// Settings returns the current settings (humanMail).
	Settings func() config.Settings

	mu    sync.Mutex
	types typesMemo
}

// ErrNoTemplate is wrapped by Template for a name that is no template.
var ErrNoTemplate = errors.New("no template")

// Template is a template's text for an agent of type typ ("" for none). A whole file in STAM_HOME/templates wins, then
// one in the checkout's templates/, then the template's blocks, composed by the type's `blocks` when the registry gives
// it one. A type the user added has no shipped instructions: its type-NAME template is empty until they write one.
func (s *Set) Template(name, typ string) (string, error) {
	var blocks jsjson.Value
	var hasType bool
	if typ != "" {
		types, err := s.Types()
		if err != nil {
			return "", err
		}
		if t, ok := types[typ]; ok {
			blocks, hasType = t.Blocks, t.HasBlocks
		}
	}
	userDir := filepath.Join(s.Home, "templates")
	for _, dir := range []string{userDir, filepath.Join(s.Root, "templates")} {
		if b, err := os.ReadFile(filepath.Join(dir, name+".md")); err == nil {
			return string(b), nil
		}
		if dir != userDir && s.HasBlocks(name) {
			if hasType && jsjson.Truthy(blocks) {
				return s.ComposedText(name, blocks)
			}
			return s.BlocksText(name)
		}
	}
	isType, err := s.isTypeTemplate(name)
	if err != nil {
		return "", err
	}
	if isType {
		return "", nil
	}
	return "", fmt.Errorf("%w %s", ErrNoTemplate, name)
}

var varRe = regexp.MustCompile(`\{\{(\w+)\}\}`)

// Render is the template with each {{var}} replaced by its value (an unknown one by ""), in one pass, trimmed as
// JavaScript's trim does.
func (s *Set) Render(name string, vars map[string]string, typ string) (string, error) {
	t, err := s.Template(name, typ)
	if err != nil {
		return "", err
	}
	return jsjson.Trim(varRe.ReplaceAllStringFunc(t, func(m string) string { return vars[m[2:len(m)-2]] })), nil
}

// HumanMailPrompt is the rules for mailing the human, with the user's choice of when to mail them. An agent whose model
// may not mail the human (settings.humanMail.models) gets the short rules instead; model nil (an agent with no model)
// may.
func (s *Set) HumanMailPrompt(model *string, typ string) (string, error) {
	hm := s.Settings().HumanMail
	if model != nil && *model != "" && !hm.MayMail(*model) {
		return s.Render("mail-to-human-restricted", nil, typ)
	}
	when, err := s.Render("human-mail-when-"+hm.When, nil, "")
	if err != nil {
		return "", err
	}
	return s.Render("mail-to-human", map[string]string{"when": when}, typ)
}

// AgentType is the part of a registry type the templates read.
type AgentType struct {
	// Blocks is the type's `blocks` as the registry holds it, and HasBlocks whether the key is there.
	Blocks    jsjson.Value
	HasBlocks bool
	// Review is whether the type has a truthy `review` (src/agent-types.ts isReviewerType): it is a reviewer type.
	Review bool
}

type typesMemo struct {
	key   string
	value map[string]AgentType
}

// Types is the registry's agent types: registry/defaults.json's, then STAM_HOME/registry.json's over them by name, a
// null one dropped (src/registry.ts registry().types). A registry.json that is missing or not JSON counts as empty.
func (s *Set) Types() (map[string]AgentType, error) {
	defaultsFile := filepath.Join(s.Root, "registry", "defaults.json")
	userFile := filepath.Join(s.Home, "registry.json")
	key := statKey(defaultsFile) + "|" + statKey(userFile)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.types.value != nil && s.types.key == key {
		return s.types.value, nil
	}
	raw, err := os.ReadFile(defaultsFile)
	if err != nil {
		return nil, err
	}
	defaults, err := jsjson.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", defaultsFile, err)
	}
	var user jsjson.Value
	if b, err := os.ReadFile(userFile); err == nil {
		user, _ = jsjson.Parse(b)
	}
	merged := jsjson.NewObject()
	for _, doc := range []jsjson.Value{defaults, user} {
		if o, ok := doc.(*jsjson.Object); ok {
			if types, ok := o.Get("types"); ok {
				spread(merged, types)
			}
		}
	}
	out := map[string]AgentType{}
	for _, name := range merged.Keys() {
		v, _ := merged.Get(name)
		if v == nil {
			continue
		}
		var t AgentType
		if o, ok := v.(*jsjson.Object); ok {
			t.Blocks, t.HasBlocks = o.Get("blocks")
			rv, _ := o.Get("review")
			t.Review = jsjson.Truthy(rv)
		}
		out[name] = t
	}
	s.types = typesMemo{key: key, value: out}
	return out, nil
}

// spread copies v's own enumerable keys into o, as `{...o, ...v}` does: an object's keys, an array's indices, a
// string's character indices; nothing for null, booleans and numbers.
func spread(o *jsjson.Object, v jsjson.Value) {
	switch x := v.(type) {
	case *jsjson.Object:
		for _, k := range x.Keys() {
			val, _ := x.Get(k)
			o.Set(k, val)
		}
	case []jsjson.Value:
		for i, e := range x {
			o.Set(fmt.Sprint(i), e)
		}
	case string:
		// One key per UTF-16 code unit; the values (single characters there) only need to be non-null here.
		for i := range len(utf16.Encode([]rune(x))) {
			o.Set(fmt.Sprint(i), "")
		}
	}
}

func statKey(path string) string {
	info, err := os.Stat(path)
	if errors.Is(err, fs.ErrNotExist) || err != nil {
		return "none"
	}
	return fmt.Sprintf("%d:%d", info.ModTime().UnixNano(), info.Size())
}

// isTypeTemplate is whether name is an agent type's instructions, type-NAME.
func (s *Set) isTypeTemplate(name string) (bool, error) {
	t, ok := strings.CutPrefix(name, "type-")
	if !ok {
		return false, nil
	}
	types, err := s.Types()
	if err != nil {
		return false, err
	}
	_, ok = types[t]
	return ok, nil
}
