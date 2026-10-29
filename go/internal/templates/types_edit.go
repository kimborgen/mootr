package templates

import (
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"stam/internal/config"
	"stam/internal/jsjson"
)

// Agent types as the human edits them (src/agent-types.ts saveType and removeType, S-3782 6d): each is an entry under
// `types` in the user's registry.json, checked against the merged registry. A shipped type that is removed is masked
// with null; a user type is deleted, with its instructions (templates/type-NAME.md).

// TypeNameRe is src/agent-types.ts NAME_RE.
var TypeNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,40}$`)

// ErrNoType is wrapped by RemoveType for a name that is no agent type.
var ErrNoType = errors.New("no agent type")

// composing is src/blocks.ts COMPOSING: the templates whose blocks a type may switch off, replace or reorder.
var composing = []string{"system-prompt", "retro", "mail-to-human", "mail-to-human-restricted"}

// at is `v?.[k]`: the member, and whether it is there (undefined when not).
func at(v jsjson.Value, k string) (jsjson.Value, bool) {
	if o, ok := v.(*jsjson.Object); ok {
		return o.Get(k)
	}
	return nil, false
}

// isObject is `typeof v === 'object' && v !== null`, arrays included.
func isObject(v jsjson.Value) bool {
	switch v.(type) {
	case *jsjson.Object, []jsjson.Value:
		return true
	}
	return false
}

// str is String(v) with undefined as "undefined".
func str(v jsjson.Value, present bool) string {
	if !present {
		return "undefined"
	}
	return jsjson.ToString(v)
}

// stringList is v as a list of strings, and whether it is one.
func stringList(v jsjson.Value) ([]string, bool) {
	list, ok := v.([]jsjson.Value)
	if !ok {
		return nil, false
	}
	out := make([]string, 0, len(list))
	for _, e := range list {
		s, isStr := e.(string)
		if !isStr {
			return nil, false
		}
		out = append(out, s)
	}
	return out, true
}

func unique(list []string) []string {
	var out []string
	for _, s := range list {
		if !slices.Contains(out, s) {
			out = append(out, s)
		}
	}
	return out
}

// DefaultReviewer is src/agent-types.ts defaultReviewer: the registry's defaultReviewer, else "reviewer".
func DefaultReviewer(registry *jsjson.Object) string {
	if d, ok := at(registry, "defaultReviewer"); ok {
		if s, isStr := d.(string); isStr && s != "" {
			return s
		}
	}
	return "reviewer"
}

// SaveType is src/agent-types.ts saveType: the type, checked against the registry, added to or replacing its entry in
// the user's registry.json; `default: true` also makes it the default reviewer. Any error refuses the whole save and
// writes nothing. It returns the saved entry.
func (s *Set) SaveType(name string, input *jsjson.Object) (*jsjson.Object, error) {
	if input == nil {
		input = jsjson.NewObject()
	}
	if !TypeNameRe.MatchString(name) {
		return nil, errors.New("a type name must be lowercase letters, digits, and dashes")
	}
	s.editMu.Lock()
	defer s.editMu.Unlock()
	r := s.Registry()
	typesV, _ := r.Get("types")
	types, _ := typesV.(*jsjson.Object)
	if types == nil {
		types = jsjson.NewObject()
	}
	harnesses, _ := r.Get("harnesses")
	get := func(k string) (jsjson.Value, bool) { return input.Get(k) }
	reviewIn, _ := get("review")
	review, err := parseReview(name, reviewIn, types)
	if err != nil {
		return nil, err
	}
	harness := ""
	if v, ok := get("harness"); ok && v != nil {
		harness = jsjson.ToString(v)
	}
	isRing := false
	if review != nil {
		ring, _ := review.Get("ring")
		isRing = ring != nil
	}
	h, hasHarness := at(harnesses, harness)
	if isRing {
		if harness != "" {
			return nil, errors.New("a ring type has no harness")
		}
	} else if !hasHarness || !jsjson.Truthy(h) {
		return nil, fmt.Errorf("unknown harness %s", harness)
	}
	def, _ := get("default")
	if def == true && review == nil {
		return nil, errors.New("only a reviewer type can be the default reviewer")
	}
	if review == nil {
		if def != true && DefaultReviewer(r) == name {
			return nil, fmt.Errorf("%s is the default reviewer, so it must keep its review config", name)
		}
		var fb []string
		for _, n := range types.Keys() {
			o, _ := types.Get(n)
			rv, _ := at(o, "review")
			if f, _ := at(rv, "fallback"); n != name && f == name {
				fb = append(fb, n)
			}
		}
		if len(fb) > 0 {
			return nil, fmt.Errorf("%s is the fallback of %s, so it must keep its review config", name, strings.Join(fb, ", "))
		}
	}
	var effort jsjson.Value
	if v, _ := get("effort"); jsjson.Truthy(v) {
		e := jsjson.ToString(v)
		efforts, _ := at(h, "efforts")
		list, _ := efforts.([]jsjson.Value)
		if !slices.ContainsFunc(list, func(x jsjson.Value) bool { return x == e }) {
			return nil, fmt.Errorf("%s has no effort %s", harness, e)
		}
		effort = e
	}
	description := ""
	if v, ok := get("description"); ok && v != nil {
		description = jsjson.Trim(jsjson.ToString(v))
	}
	var model jsjson.Value
	if v, _ := get("model"); jsjson.Truthy(v) {
		model = jsjson.ToString(v)
	}
	t := jsjson.NewObject("description", description, "harness", harness, "model", model, "effort", effort)
	if review != nil {
		t.Set("review", review)
	}
	if v, _ := get("child_notices"); jsjson.Truthy(v) {
		if v != "turn" && v != "tree-idle" && v != "none" {
			return nil, errors.New("child notices must be turn, tree-idle, or none")
		}
		t.Set("child_notices", v)
	}
	if v, ok := get("worktree"); ok && v != nil {
		t.Set("worktree", jsjson.Truthy(v))
	}
	if v, _ := get("visibility"); jsjson.Truthy(v) && isObject(v) {
		if reach, _ := at(v, "reach"); jsjson.Truthy(reach) && reach != "all" && reach != "tree" && reach != "parent" {
			return nil, errors.New("reach must be all, tree, or parent")
		}
		t.Set("visibility", v)
	}
	if v, _ := get("brief"); jsjson.Truthy(v) && jsjson.Trim(jsjson.ToString(v)) != "" {
		t.Set("brief", jsjson.ToString(v))
	}
	blocksIn, _ := get("blocks")
	blocks, err := s.parseBlocks(blocksIn)
	if err != nil {
		return nil, err
	}
	if blocks != nil {
		t.Set("blocks", blocks)
	}
	own, _ := types.Get(name)
	hadV, _ := at(own, "skills")
	had, _ := stringList(hadV)
	skillsIn, _ := get("skills")
	skills, err := s.parseSkills(skillsIn, had)
	if err != nil {
		return nil, err
	}
	if skills != nil {
		t.Set("skills", skills)
	}
	user, err := s.readUserRegistry()
	if err != nil {
		return nil, err
	}
	userTypes := jsjson.NewObject()
	ut, _ := user.Get("types")
	spread(userTypes, ut)
	userTypes.Set(name, t)
	user.Set("types", userTypes)
	if def == true {
		user.Set("defaultReviewer", name)
	}
	if err := s.writeUserRegistry(user); err != nil {
		return nil, err
	}
	return t, nil
}

// parseReview is src/agent-types.ts parseReview: a review config checked against the registry's types; self, the type
// being saved, can't be its own fallback, ring member or moderator. Nil when the type isn't a reviewer.
func parseReview(self string, raw jsjson.Value, types *jsjson.Object) (*jsjson.Object, error) {
	if raw == nil {
		return nil, nil
	}
	if _, ok := raw.(*jsjson.Object); !ok {
		return nil, errors.New("review must be an object")
	}
	isType := func(n jsjson.Value) bool {
		s, ok := n.(string)
		if !ok {
			return false
		}
		t, _ := types.Get(s)
		return jsjson.Truthy(t)
	}
	fb, _ := at(raw, "fallback")
	if fb != nil {
		t, _ := at(types, jsjson.ToString(fb))
		rv, _ := at(t, "review")
		if _, isStr := fb.(string); !isStr || !jsjson.Truthy(rv) {
			return nil, fmt.Errorf("fallback %s is not a reviewer type", jsjson.ToString(fb))
		}
		if fb == self {
			return nil, errors.New("a type cannot be its own fallback")
		}
	}
	var ring jsjson.Value
	if g, _ := at(raw, "ring"); g != nil {
		if _, ok := g.(*jsjson.Object); !ok {
			return nil, errors.New("ring must be an object")
		}
		format, _ := at(g, "format")
		if format != "rounds" && format != "fire" && format != "debate" {
			return nil, errors.New("ring format must be rounds, fire, or debate")
		}
		mv, _ := at(g, "members")
		members, ok := mv.([]jsjson.Value)
		if !ok || len(members) < 2 {
			return nil, errors.New("a ring needs at least 2 members")
		}
		for _, m := range members {
			if !isType(m) {
				return nil, fmt.Errorf("ring member %s is not an agent type", jsjson.ToString(m))
			}
			if m == self {
				return nil, errors.New("a ring cannot have itself as a member")
			}
		}
		var moderator jsjson.Value
		if mod, _ := at(g, "moderator"); mod != nil {
			mt, present := at(mod, "type")
			if !isType(mt) {
				return nil, fmt.Errorf("ring moderator %s is not an agent type", str(mt, present))
			}
			if mt == self {
				return nil, errors.New("a ring cannot be its own moderator")
			}
			decides, _ := at(mod, "decides")
			moderator = jsjson.NewObject("type", mt, "decides", decides == true)
		}
		maxRounds, _ := at(g, "maxRounds")
		n, isNum := maxRounds.(float64)
		if !isNum || n != math.Trunc(n) || math.IsInf(n, 0) || n < 1 {
			return nil, errors.New("maxRounds must be a whole number, 1 or more")
		}
		ring = jsjson.NewObject("format", format, "members", slices.Clone(members), "moderator", moderator, "maxRounds", n)
	}
	return jsjson.NewObject("fallback", fb, "ring", ring), nil
}

// parseBlocks is src/agent-types.ts parseBlocks: `off` ids and `replace` keys must be shipped block ids of the
// composing templates, a replacement file must be a block file inside blocks/, and a block can't be both off and
// replaced. Nil when the type composes nothing.
func (s *Set) parseBlocks(raw jsjson.Value) (*jsjson.Object, error) {
	if raw == nil {
		return nil, nil
	}
	if _, ok := raw.(*jsjson.Object); !ok {
		return nil, errors.New("blocks must be an object")
	}
	known, err := s.blockIDs()
	if err != nil {
		return nil, err
	}
	var off []string
	if v, _ := at(raw, "off"); v != nil {
		list, ok := stringList(v)
		if !ok {
			return nil, errors.New("blocks.off must be a list of block ids")
		}
		off = list
	}
	rep := jsjson.NewObject()
	if v, _ := at(raw, "replace"); v != nil {
		o, ok := v.(*jsjson.Object)
		if !ok {
			return nil, errors.New("blocks.replace must map block ids to files")
		}
		rep = o
	}
	for _, id := range append(slices.Clone(off), rep.Keys()...) {
		if !known[id] {
			return nil, fmt.Errorf("unknown block id %s", id)
		}
	}
	for _, id := range rep.Keys() {
		if slices.Contains(off, id) {
			return nil, fmt.Errorf("block %s is both off and replaced", id)
		}
		p, _ := rep.Get(id)
		path, ok := p.(string)
		if !ok || path == "" {
			return nil, fmt.Errorf("blocks.replace.%s must be a file path", id)
		}
		if _, err := s.ReplacementBlock(path); err != nil {
			return nil, fmt.Errorf("replacement for %s: %s", id, err.Error())
		}
	}
	var order []string
	if v, _ := at(raw, "order"); v != nil {
		list, ok := stringList(v)
		if !ok {
			return nil, errors.New("blocks.order must be a list of block ids")
		}
		order = list
	}
	for _, id := range order {
		if !known[id] {
			return nil, fmt.Errorf("unknown block id %s", id)
		}
	}
	if len(unique(order)) != len(order) {
		return nil, errors.New("blocks.order lists a block id twice")
	}
	out := jsjson.NewObject()
	if len(off) > 0 {
		out.Set("off", toValues(unique(off)))
	}
	if rep.Len() > 0 {
		out.Set("replace", jsjson.Clone(rep))
	}
	if len(order) > 0 {
		out.Set("order", toValues(order))
	}
	if out.Len() == 0 {
		return nil, nil
	}
	return out, nil
}

func toValues(list []string) []jsjson.Value {
	out := make([]jsjson.Value, len(list))
	for i, s := range list {
		out[i] = s
	}
	return out
}

// blockIDs is src/blocks.ts allBlocks's keys: the block ids of the composing templates.
func (s *Set) blockIDs() (map[string]bool, error) {
	out := map[string]bool{}
	for _, t := range composing {
		if !s.HasBlocks(t) {
			continue
		}
		blocks, err := s.BlocksOf(t)
		if err != nil {
			return nil, err
		}
		for _, b := range blocks {
			out[b.ID] = true
		}
	}
	return out, nil
}

// ReplacementBlock is src/blocks.ts replacementBlock: a replacement file, which must be a block file inside blocks/
// once symlinks are resolved (the registry is editable by agents, so a path is never trusted).
func (s *Set) ReplacementBlock(path string) (Block, error) {
	base, err := filepath.EvalSymlinks(filepath.Join(s.Root, "blocks"))
	if err != nil {
		return Block{}, err
	}
	p := path
	if !strings.HasPrefix(p, "/") {
		p = filepath.Join(s.Root, p)
	}
	file, err := filepath.EvalSymlinks(p)
	if err != nil {
		return Block{}, fmt.Errorf("%s does not exist", path)
	}
	if !strings.HasPrefix(file, base+string(filepath.Separator)) {
		return Block{}, fmt.Errorf("%s is not inside blocks/", path)
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		return Block{}, fmt.Errorf("%s can't be read", path)
	}
	return ParseBlock(path, string(raw))
}

// parseSkills is src/agent-types.ts parseSkills: names of skill folders that exist. A name the type already had stays
// even when its folder is gone, so a save of other fields isn't refused. Nil when empty.
func (s *Set) parseSkills(raw jsjson.Value, had []string) ([]jsjson.Value, error) {
	if raw == nil {
		return nil, nil
	}
	list, ok := stringList(raw)
	if !ok {
		return nil, errors.New("skills must be a list of skill names")
	}
	known := map[string]bool{}
	for _, n := range s.SkillFolders() {
		known[n] = true
	}
	for _, n := range list {
		if !known[n] && !slices.Contains(had, n) {
			return nil, fmt.Errorf("unknown skill %s", n)
		}
	}
	out := unique(list)
	if len(out) == 0 {
		return nil, nil
	}
	return toValues(out), nil
}

// SkillFolders is the names of src/instructions.ts skillFolders: the folders holding a SKILL.md in ~/.claude/skills,
// then in STAM_HOME/skills.
func (s *Set) SkillFolders() []string {
	var out []string
	for _, dir := range []string{filepath.Join(s.UserHome, ".claude", "skills"), filepath.Join(s.Home, "skills")} {
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			if exists(filepath.Join(dir, e.Name(), "SKILL.md")) && !slices.Contains(out, e.Name()) {
				out = append(out, e.Name())
			}
		}
	}
	return out
}

// RemoveType is src/agent-types.ts removeType: a shipped type is masked with null in the user's registry.json, a user
// one deleted, and its edited instructions go too. The default reviewer and a type another names (fallback, ring member
// or moderator) can't be removed.
func (s *Set) RemoveType(name string) error {
	s.editMu.Lock()
	defer s.editMu.Unlock()
	r := s.Registry()
	typesV, _ := r.Get("types")
	types, _ := typesV.(*jsjson.Object)
	if t, _ := at(types, name); !jsjson.Truthy(t) {
		return fmt.Errorf("%w %s", ErrNoType, name)
	}
	if DefaultReviewer(r) == name {
		return fmt.Errorf("%s is the default reviewer; make another type the default first", name)
	}
	var used []string
	for _, n := range types.Keys() {
		if n == name {
			continue
		}
		t, _ := types.Get(n)
		rv, _ := at(t, "review")
		fb, _ := at(rv, "fallback")
		ring, _ := at(rv, "ring")
		mv, _ := at(ring, "members")
		members, _ := mv.([]jsjson.Value)
		mod, _ := at(ring, "moderator")
		mt, _ := at(mod, "type")
		if fb == name || slices.ContainsFunc(members, func(m jsjson.Value) bool { return m == name }) || mt == name {
			used = append(used, n)
		}
	}
	if len(used) > 0 {
		return fmt.Errorf("%s is used by %s (fallback, ring member, or moderator); change that first", name, strings.Join(used, ", "))
	}
	user, err := s.readUserRegistry()
	if err != nil {
		return err
	}
	userTypes := jsjson.NewObject()
	ut, _ := user.Get("types")
	spread(userTypes, ut)
	if s.isShipped(name) {
		userTypes.Set(name, nil)
	} else {
		userTypes.Delete(name)
	}
	user.Set("types", userTypes)
	if err := s.writeUserRegistry(user); err != nil {
		return err
	}
	err = os.Remove(filepath.Join(s.Home, "templates", "type-"+name+".md"))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

// isShipped is src/agent-types.ts isShipped: registry/defaults.json has the type.
func (s *Set) isShipped(name string) bool {
	b, err := os.ReadFile(filepath.Join(s.Root, "registry", "defaults.json"))
	if err != nil {
		return false
	}
	v, _ := jsjson.Parse(b)
	types, _ := at(v, "types")
	t, _ := at(types, name)
	return jsjson.Truthy(t)
}

// readUserRegistry is src/agent-types.ts readUser: STAM_HOME/registry.json, {} when there is none, and an error when it
// isn't valid JSON (or, unlike TS, isn't an object), so a save never replaces a file it couldn't read.
func (s *Set) readUserRegistry() (*jsjson.Object, error) {
	path := filepath.Join(s.Home, "registry.json")
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return jsjson.NewObject(), nil
	}
	if err != nil {
		return nil, err
	}
	v, err := jsjson.Parse(b)
	if err != nil {
		return nil, errors.New("registry.json is not valid JSON")
	}
	o, ok := v.(*jsjson.Object)
	if !ok {
		return nil, errors.New("registry.json is not a JSON object")
	}
	return o, nil
}

// writeUserRegistry replaces STAM_HOME/registry.json atomically, as JSON.stringify(r, null, 2) and a newline.
func (s *Set) writeUserRegistry(r *jsjson.Object) error {
	return writeFileAtomic(filepath.Join(s.Home, "registry.json"), config.Text(r), 0o644)
}

// EmptyRegistry is src/permissions.ts EMPTY_REGISTRY: the override file a user registry starts from.
const EmptyRegistry = "{\n  \"presets\": {},\n  \"models\": {},\n  \"harnesses\": {}\n}\n"

// UpdateUserRegistry replaces STAM_HOME/registry.json with what fn makes of its text (EmptyRegistry when there is none),
// under the same lock as the type edits, so no write loses another's. An error from fn writes nothing.
func (s *Set) UpdateUserRegistry(fn func(current string) (string, error)) error {
	s.editMu.Lock()
	defer s.editMu.Unlock()
	path := filepath.Join(s.Home, "registry.json")
	current := EmptyRegistry
	if b, err := os.ReadFile(path); err == nil {
		current = string(b)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	next, err := fn(current)
	if err != nil {
		return err
	}
	return writeFileAtomic(path, next, 0o644)
}

// WriteInstructions replaces STAM_HOME/instructions.md, the instructions for all agents.
func (s *Set) WriteInstructions(text string) error {
	if err := os.MkdirAll(s.Home, 0o700); err != nil {
		return err
	}
	return writeFileAtomic(filepath.Join(s.Home, "instructions.md"), text, 0o644)
}
