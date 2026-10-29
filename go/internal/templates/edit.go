package templates

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"stam/internal/jsjson"
)

// The template list, save and reset of the settings UI (src/templates.ts listTemplates, saveTemplate, resetTemplate,
// S-3782 6d).

// TemplateInfo is one template as the settings UI lists it: its current text, whether the user overrode it, and the
// shipped text.
type TemplateInfo struct {
	Name       string `json:"name"`
	Text       string `json:"text"`
	Overridden bool   `json:"overridden"`
	Default    string `json:"default"`
}

var templateName = regexp.MustCompile(`^[\w-]+$`)

// ListTemplates is src/templates.ts listTemplates: every shipped template (the checkout's templates/*.md, then the
// templates built from blocks/), a type-NAME one only while its type exists, then each agent type's instructions,
// shipped or not.
func (s *Set) ListTemplates() ([]TemplateInfo, error) {
	var names []string
	seen := map[string]bool{}
	add := func(n string) {
		if !seen[n] {
			seen[n] = true
			names = append(names, n)
		}
	}
	files, err := os.ReadDir(filepath.Join(s.Root, "templates"))
	if err != nil {
		return nil, err
	}
	var shipped []string
	for _, f := range files {
		if n, ok := strings.CutSuffix(f.Name(), ".md"); ok {
			shipped = append(shipped, n)
		}
	}
	dirs, err := os.ReadDir(filepath.Join(s.Root, "blocks"))
	if err != nil {
		return nil, err
	}
	for _, d := range dirs {
		if s.HasBlocks(d.Name()) {
			shipped = append(shipped, d.Name())
		}
	}
	typeNames := s.TypeNames()
	isType := map[string]bool{}
	for _, t := range typeNames {
		isType["type-"+t] = true
	}
	for _, n := range shipped {
		if !strings.HasPrefix(n, "type-") || isType[n] {
			add(n)
		}
	}
	for _, t := range typeNames {
		add("type-" + t)
	}
	out := make([]TemplateInfo, 0, len(names))
	for _, n := range names {
		text, err := s.Template(n, "")
		if err != nil {
			return nil, err
		}
		_, overridden := s.UserTemplate(n)
		def := ""
		if b, err := os.ReadFile(filepath.Join(s.Root, "templates", n+".md")); err == nil {
			def = string(b)
		} else if s.HasBlocks(n) {
			if def, err = s.BlocksText(n); err != nil {
				return nil, err
			}
		}
		out = append(out, TemplateInfo{Name: n, Text: text, Overridden: overridden, Default: def})
	}
	return out, nil
}

// TemplateInfo is the listed entry of one template; false when it isn't listed.
func (s *Set) TemplateInfo(name string) (TemplateInfo, bool, error) {
	list, err := s.ListTemplates()
	if err != nil {
		return TemplateInfo{}, false, err
	}
	for _, t := range list {
		if t.Name == name {
			return t, true, nil
		}
	}
	return TemplateInfo{}, false, nil
}

// SaveTemplate is src/templates.ts saveTemplate: the user's override, STAM_HOME/templates/NAME.md, of a shipped
// template, one built from blocks, or an agent type's instructions; ErrNoTemplate for any other name.
func (s *Set) SaveTemplate(name, text string) error {
	ok := templateName.MatchString(name)
	if ok {
		ok = exists(filepath.Join(s.Root, "templates", name+".md")) || s.HasBlocks(name)
		if !ok {
			isType, err := s.isTypeTemplate(name)
			if err != nil {
				return err
			}
			ok = isType
		}
	}
	if !ok {
		return fmt.Errorf("%w %s", ErrNoTemplate, name)
	}
	if err := os.MkdirAll(filepath.Join(s.Home, "templates"), 0o777); err != nil {
		return err
	}
	return writeFileAtomic(filepath.Join(s.Home, "templates", name+".md"), text, 0o644)
}

// ResetTemplate is src/templates.ts resetTemplate: the user's override removed, so the shipped text applies again.
func (s *Set) ResetTemplate(name string) error {
	if !templateName.MatchString(name) {
		return fmt.Errorf("%w %s", ErrNoTemplate, name)
	}
	err := os.Remove(filepath.Join(s.Home, "templates", name+".md"))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

// TypeNames is the registry's agent type names in its order (Object.keys(agentTypes())).
func (s *Set) TypeNames() []string {
	types, _ := s.Registry().Get("types")
	if o, ok := types.(*jsjson.Object); ok {
		return o.Keys()
	}
	return nil
}

// writeFileAtomic writes text to a temporary file beside path and renames it over path, so a reader never sees half a
// file.
func writeFileAtomic(path, text string, mode fs.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+"-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.WriteString(text); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
