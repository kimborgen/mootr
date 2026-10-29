// Package templates renders the text stam sends to agents, as src/templates.ts, src/blocks.ts and src/instructions.ts
// do (S-2804): every text comes from a template, a file in STAM_HOME/templates overrides the shipped one (the
// checkout's templates/ folder, or for a template built from block files, blocks/NAME/, their bodies in order), and an
// agent type's `blocks` composition (off, replace, order) applies to a template built from blocks.
//
// A non-home daemon reads the home's registry, instructions for all agents and type templates from its shared cache
// (config.PeerShared, S-387, S-417).
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
	// Machine is this daemon's machine name: a settings.json that names another home makes it a peer, which reads the
	// home's registry, instructions and type templates from its shared cache.
	Machine string

	mu    sync.Mutex
	types typesMemo
	// editMu serialises the read-modify-writes of STAM_HOME/registry.json.
	editMu sync.Mutex
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
	if user, ok := s.UserTemplate(name); ok {
		return user, nil
	}
	if b, err := os.ReadFile(filepath.Join(s.Root, "templates", name+".md")); err == nil {
		return string(b), nil
	}
	if s.HasBlocks(name) {
		if hasType && jsjson.Truthy(blocks) {
			return s.ComposedText(name, blocks)
		}
		return s.BlocksText(name)
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

// sharedTemplate is src/templates.ts SHARED_TEMPLATE: an agent type's instructions, which live on the settings home.
var sharedTemplate = regexp.MustCompile(`^type-[\w-]+$`)

// UserTemplate is src/templates.ts userTemplate: the user's override of a template. A type's template (type-NAME) lives
// on the settings home (S-417): a non-home daemon with the home's cached copy reads that and ignores its own file, so
// the home's removal or edit reaches it; else the file in STAM_HOME/templates.
func (s *Set) UserTemplate(name string) (string, bool) {
	if sharedTemplate.MatchString(name) {
		if c := config.PeerShared(s.Home, s.Machine); c != nil && c.Templates != nil {
			v, _ := c.Templates.Get(name)
			text, ok := v.(string)
			return text, ok
		}
	}
	b, err := os.ReadFile(filepath.Join(s.Home, "templates", name+".md"))
	if err != nil {
		return "", false
	}
	return string(b), true
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
	order []string
}

// Types is the registry's agent types: registry/defaults.json's, then the user registry's over them by name, a null one
// dropped (src/registry.ts registry().types). The user registry is config.UserRegistry: the home's cached copy on a
// peer, else STAM_HOME/registry.json, which counts as empty when it is missing or not JSON.
func (s *Set) Types() (map[string]AgentType, error) {
	types, _, err := s.TypesInOrder()
	return types, err
}

// TypesInOrder is Types with the type names in Object.keys(agentTypes()) order, from the same read.
func (s *Set) TypesInOrder() (map[string]AgentType, []string, error) {
	defaultsFile := filepath.Join(s.Root, "registry", "defaults.json")
	key := statKey(defaultsFile)
	for _, f := range []string{"registry.json", "settings.json", "settings.shared.json"} {
		key += "|" + statKey(filepath.Join(s.Home, f))
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.types.value != nil && s.types.key == key {
		return s.types.value, append([]string(nil), s.types.order...), nil
	}
	raw, err := os.ReadFile(defaultsFile)
	if err != nil {
		return nil, nil, err
	}
	defaults, err := jsjson.Parse(raw)
	if err != nil {
		return nil, nil, fmt.Errorf("%s: %w", defaultsFile, err)
	}
	user := s.UserRegistry()
	merged := jsjson.NewObject()
	for _, doc := range []jsjson.Value{defaults, jsjson.Value(user)} {
		if o, ok := doc.(*jsjson.Object); ok {
			if types, ok := o.Get("types"); ok {
				spread(merged, types)
			}
		}
	}
	out, order := map[string]AgentType{}, []string{}
	for _, name := range merged.Keys() {
		v, _ := merged.Get(name)
		if v == nil {
			continue
		}
		order = append(order, name)
		var t AgentType
		if o, ok := v.(*jsjson.Object); ok {
			t.Blocks, t.HasBlocks = o.Get("blocks")
			rv, _ := o.Get("review")
			t.Review = jsjson.Truthy(rv)
		}
		out[name] = t
	}
	s.types = typesMemo{key: key, value: out, order: order}
	return out, append([]string(nil), order...), nil
}

// UserRegistry is config.UserRegistry for this home and machine.
func (s *Set) UserRegistry() *jsjson.Object { return config.UserRegistry(s.Home, s.Machine) }

// Registry is config.Registry for this checkout, home and machine.
func (s *Set) Registry() *jsjson.Object { return config.Registry(s.Root, s.Home, s.Machine) }

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
