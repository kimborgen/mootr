package config

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"stam/internal/jsjson"
)

// The settings shared across machines (src/settings.ts, S-380, S-398): a non-home daemon keeps the home's shared part
// in its cache (settings.shared.json) and reads every key but its machine-local ones (LocalKeys) from there. It writes
// only its local keys; a change to a shared key is the home's.

// hasPath is src/settings.ts hasPath: every step is an object that has the next key (null counts as present).
func hasPath(v jsjson.Value, path []string) bool {
	for _, k := range path {
		x, ok := obj(v).Get(k)
		if !ok {
			return false
		}
		v = x
	}
	return true
}

// getPath is src/settings.ts getPath.
func getPath(v jsjson.Value, path []string) jsjson.Value {
	for _, k := range path {
		v, _ = obj(v).Get(k)
	}
	return v
}

// setPath is src/settings.ts setPath: a step that isn't an object becomes an empty one.
func setPath(o *jsjson.Object, path []string, v jsjson.Value) {
	for _, k := range path[:len(path)-1] {
		next, _ := o.Get(k)
		if obj(next) == nil {
			next = jsjson.NewObject()
			o.Set(k, next)
		}
		o = obj(next)
	}
	o.Set(path[len(path)-1], v)
}

// delPath is src/settings.ts delPath.
func delPath(v jsjson.Value, path []string) {
	for _, k := range path[:len(path)-1] {
		v, _ = obj(v).Get(k)
	}
	obj(v).Delete(path[len(path)-1])
}

// LocalPart is src/settings.ts localPart: only the machine-local keys of a settings value, deep paths included.
func LocalPart(v jsjson.Value) *jsjson.Object {
	out := jsjson.NewObject()
	if obj(v) == nil {
		return out
	}
	for _, key := range LocalKeys {
		path := strings.Split(key, ".")
		if hasPath(v, path) {
			setPath(out, path, jsjson.Clone(getPath(v, path)))
		}
	}
	return out
}

// SharedPart is src/settings.ts sharedPart: everything but the machine-local keys; an object left empty stays {}.
func SharedPart(v jsjson.Value) *jsjson.Object {
	if obj(v) == nil {
		return jsjson.NewObject()
	}
	out := jsjson.Clone(v).(*jsjson.Object)
	for _, key := range LocalKeys {
		delPath(out, strings.Split(key, "."))
	}
	return out
}

// SharedPatch is the part of a peer UI's patch the home applies (src/settings.ts patchSharedSettings): its shared part,
// less a mixed key (itsa) that held only local paths, which leaves an empty object and changes nothing shared.
func SharedPatch(patch *jsjson.Object) *jsjson.Object {
	mine := LocalPart(patch)
	shared := SharedPart(patch)
	for _, k := range shared.Keys() {
		v, _ := shared.Get(k)
		if _, mixed := mine.Get(k); mixed && obj(v) != nil && obj(v).Len() == 0 {
			shared.Delete(k)
		}
	}
	return shared
}

// withLocal sets the machine-local paths local holds in user, every other path as it is.
func withLocal(user, local *jsjson.Object) {
	for _, key := range LocalKeys {
		path := strings.Split(key, ".")
		if hasPath(local, path) {
			setPath(user, path, jsjson.Clone(getPath(local, path)))
		}
	}
}

// WithLocalKeys is src/settings.ts withLocalKeys: text with the machine-local paths in local set, and every other path
// as it is.
func WithLocalKeys(text string, local *jsjson.Object) string {
	user := ParseObject(text)
	withLocal(user, local)
	return Text(user)
}

// merged is the settings a non-home daemon uses: the cache's shared part with user's local keys over it.
func merged(cache *jsjson.Object, user jsjson.Value) *jsjson.Object {
	out := SharedPart(cache)
	withLocal(out, LocalPart(user))
	return out
}

// SplitPatch is src/settings.ts splitSettingsPatch: a change on a non-home daemon in two (S-398). local holds the
// machine-local paths it sets, shared the top-level shared keys it would change, which a non-home daemon refuses. A
// top-level key mixing both (itsa, retro) goes to each side with only its own sub-keys, and isn't shared at all when
// it held only local ones. A shared key equal to the cached copy is dropped (unless fill), so saving the merged text
// back with only local edits is a local change. A fill patch changes only view records, by adding ids: it is a shared
// change only when it adds an id the cache lacks. cached is the cache's settings, nil when there is none yet.
func SplitPatch(patch *jsjson.Object, fill bool, cached *jsjson.Object) (local, shared *jsjson.Object) {
	shared = jsjson.NewObject()
	if cached == nil {
		cached = jsjson.NewObject()
	}
	if fill {
		for _, k := range []string{"boardViews", "workViews", "sidebarCols", "sidebarPanes", "motion", "cardLayouts", "agentsTableCols"} {
			v, _ := patch.Get(k)
			have, _ := cached.Get(k)
			for _, id := range obj(v).Keys() {
				if _, ok := obj(have).Get(id); !ok {
					shared.Set(k, v)
					break
				}
			}
		}
		return jsjson.NewObject(), shared
	}
	local = LocalPart(patch)
	sp := SharedPart(patch)
	for _, k := range sp.Keys() {
		v, _ := sp.Get(k)
		if _, mixed := local.Get(k); mixed && obj(v) != nil && obj(v).Len() == 0 {
			continue
		}
		if c, ok := cached.Get(k); ok && jsjson.Equal(v, c) {
			continue
		}
		shared.Set(k, v)
	}
	return local, shared
}

// SharedCache is src/settings.ts SharedCache: the home's shared settings as a non-home daemon keeps them.
type SharedCache struct {
	Rev      jsjson.Value
	Settings *jsjson.Object
	// Registry, Instructions and Templates are the home's user registry, instructions for all agents and type
	// templates (S-387, S-417); absent from a cache an older home wrote.
	Registry     *jsjson.Object
	Instructions *string
	Templates    *jsjson.Object
	// Web is the home's web UI origin (S-414); "" when none.
	Web string
}

// SharedPath is the cache's file.
func (f *SettingsFile) SharedPath() string {
	return filepath.Join(filepath.Dir(f.path), "settings.shared.json")
}

// SharedCache is src/settings.ts readSharedCache: nil when there is none, or it isn't a JSON object with settings.
func (f *SettingsFile) SharedCache() *SharedCache {
	data, err := os.ReadFile(f.SharedPath())
	if err != nil {
		return nil
	}
	return parseSharedCache(data)
}

func parseSharedCache(data []byte) *SharedCache {
	v, err := jsjson.Parse(data)
	c := obj(v)
	if err != nil || c == nil {
		return nil
	}
	s, _ := c.Get("settings")
	if obj(s) == nil {
		return nil
	}
	out := &SharedCache{Settings: obj(s)}
	out.Rev, _ = c.Get("rev")
	if r, _ := c.Get("registry"); obj(r) != nil {
		out.Registry = obj(r)
	}
	if i, ok := c.Get("instructions"); ok {
		if str, isStr := i.(string); isStr {
			out.Instructions = &str
		}
	}
	if t, _ := c.Get("templates"); obj(t) != nil {
		out.Templates = jsjson.NewObject()
		for _, k := range obj(t).Keys() {
			if x, _ := obj(t).Get(k); x != nil {
				if str, isStr := x.(string); isStr {
					out.Templates.Set(k, str)
				}
			}
		}
	}
	if w, _ := c.Get("web"); w != nil {
		out.Web, _ = w.(string)
	}
	return out
}

// WriteSharedCache is src/settings.ts writeSharedCache: the cache replaced atomically, mode 0600, then the listeners.
func (f *SettingsFile) WriteSharedCache(text string) error {
	if err := writeAtomic(f.SharedPath(), text); err != nil {
		return err
	}
	f.changed()
	return nil
}

// homeOf is src/settings.ts homeOf: home, else itsa.home, else this machine, from the local file alone.
func homeOf(user jsjson.Value, machine string) string {
	if h, _ := member(user, "home"); h != nil {
		if s, ok := h.(string); ok && s != "" {
			return s
		}
	}
	itsa, _ := member(user, "itsa")
	if h, _ := member(itsa, "home"); h != nil {
		if s, ok := h.(string); ok && s != "" {
			return s
		}
	}
	return machine
}

// IsHome is src/settings.ts isSettingsHome: this daemon holds the settings.
func (f *SettingsFile) IsHome() bool { return f.Get().Home == f.machine }

// EffectiveText is src/settings.ts effectiveSettingsText: the settings as this daemon uses them, as text. On the home
// (or a peer with no cache yet) the file; on a peer the cached shared part with its own local keys over it.
func (f *SettingsFile) EffectiveText() (string, error) {
	text, err := f.Text()
	if err != nil {
		return "", err
	}
	return f.EffectiveFrom(text), nil
}

// EffectiveFrom is EffectiveText for the file's text as given, such as the one an Update holds.
func (f *SettingsFile) EffectiveFrom(text string) string {
	if f.IsHome() {
		return text
	}
	cache := f.SharedCache()
	if cache == nil {
		return text
	}
	user, err := jsjson.Parse([]byte(text))
	if err != nil {
		user = jsjson.NewObject()
	}
	return Text(merged(cache.Settings, user))
}

// CachedSettings is the shared cache's settings, nil when there is none.
func (f *SettingsFile) CachedSettings() *jsjson.Object {
	if c := f.SharedCache(); c != nil {
		return c.Settings
	}
	return nil
}

// PatchLocal is src/settings.ts patchLocalKeys: the machine-local paths in local set in this daemon's file, every other
// path as it is. A local key the change doesn't name is kept, never removed (so a peer can't lose its home).
func (f *SettingsFile) PatchLocal(local *jsjson.Object) error {
	if local.Len() == 0 {
		return nil
	}
	return f.Update(func(current string) (string, error) { return WithLocalKeys(current, local), nil })
}

// SetSetting is src/settings.ts setSetting: one top-level key set in the file, everything else kept as written. A
// non-home daemon never writes shared settings (S-398): it writes the local part only, and a changed shared part is
// dropped with the warning returned (a caller that spreads the current value sends the shared part unchanged, which
// warns nothing).
func (f *SettingsFile) SetSetting(key string, value jsjson.Value) (warning string, err error) {
	if !f.IsHome() {
		local, shared := SplitPatch(jsjson.NewObject(key, value), false, f.CachedSettings())
		if err := f.PatchLocal(local); err != nil {
			return "", err
		}
		v, ok := shared.Get(key)
		cur, _ := f.View().Get(key)
		same := ok && jsjson.Equal(v, getPathOr(SharedPart(jsjson.NewObject(key, jsjson.Clone(cur))), key))
		if shared.Len() > 0 && !same {
			return "settings: " + key + " is shared and lives on " + f.Get().Home + "; not changed here", nil
		}
		return "", nil
	}
	return "", f.Update(func(current string) (string, error) {
		user := ParseObject(current)
		user.Set(key, value)
		return Text(user), nil
	})
}

func getPathOr(o *jsjson.Object, key string) jsjson.Value {
	v, _ := o.Get(key)
	return v
}

// OnChange adds a listener told after stam writes the settings file or the shared cache (src/settings.ts
// onSettingsChange), such as the home's push to its peers.
func (f *SettingsFile) OnChange(fn func()) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.listeners = append(f.listeners, fn)
}

// changed drops the read cache and tells the listeners; the read after it tells the OnReload ones, so they see each
// write here at once.
func (f *SettingsFile) changed() {
	f.mu.Lock()
	f.key = fileKey{size: -1}
	listeners := append([]func(){}, f.listeners...)
	f.mu.Unlock()
	f.Get()
	for _, fn := range listeners {
		fn()
	}
}

// statKey is a file's size and mtime, or the zero key when it is missing.
func statKey(path string) fileKey {
	info, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return fileKey{}
		}
		return fileKey{size: -2}
	}
	return fileKey{size: info.Size(), mtime: info.ModTime()}
}

//go:embed settings_defaults.json
var defaultsJSON []byte

// Defaults is src/settings.ts DEFAULTS (testdata/gendefaults.mjs), without the repos TS derives from its checkout.
func Defaults() *jsjson.Object {
	v, err := jsjson.Parse(defaultsJSON)
	if err != nil {
		panic(err)
	}
	return v.(*jsjson.Object)
}

// View is src/settings.ts settings() as JSON, approximately: DEFAULTS with the effective settings over them, objects
// merged key by key, and home resolved. TS normalises each key its own way (some spread one level, some drop values
// they don't accept); only the test route (GET /api/test/settings) and SetSetting's comparison read this.
func (f *SettingsFile) View() *jsjson.Object {
	text, _ := f.EffectiveText()
	out := deepMerge(Defaults(), ParseObject(text)).(*jsjson.Object)
	out.Set("home", f.Get().Home)
	return out
}

// deepMerge is over on base: two objects merge key by key, anything else is over's.
func deepMerge(base, over jsjson.Value) jsjson.Value {
	b, o := obj(base), obj(over)
	if b == nil || o == nil {
		return over
	}
	for _, k := range o.Keys() {
		v, _ := o.Get(k)
		cur, ok := b.Get(k)
		if ok {
			v = deepMerge(cur, v)
		}
		b.Set(k, v)
	}
	return b
}

var (
	// TypeTemplateFile is src/settings-sync.ts TYPE_TEMPLATE_FILE: a type template's file, its name in group 1.
	TypeTemplateFile = regexp.MustCompile(`^(type-[\w-]+)\.md$`)
	// TypeTemplateName is a template name a peer's cache keeps (type-NAME).
	TypeTemplateName = regexp.MustCompile(`^type-[\w-]+$`)
)

func readText(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(b)
}

// SharedPayload is src/settings-sync.ts sharedPayload for the home's settings text: { rev, settings, registry,
// instructions, templates }, where settings is the raw shared part (the peer normalises it), registry home's
// registry.json, instructions its instructions.md, templates its type templates (templates/type-NAME.md as
// {type-NAME: text}, no other file of the folder), and rev the sha256 of the other four. Nil when the text isn't valid
// JSON, so a peer keeps its cache rather than take the defaults. A registry that isn't a JSON object goes as {}.
func SharedPayload(home, text string) *jsjson.Object {
	var user jsjson.Value = jsjson.NewObject()
	if text != "" {
		var err error
		if user, err = jsjson.Parse([]byte(text)); err != nil {
			return nil
		}
	}
	shared := SharedPart(user)
	registry, err := jsjson.Parse([]byte(readText(filepath.Join(home, "registry.json"))))
	if _, ok := registry.(*jsjson.Object); err != nil || !ok {
		registry = jsjson.NewObject()
	}
	instructions := readText(filepath.Join(home, "instructions.md"))
	templates := jsjson.NewObject()
	if entries, err := os.ReadDir(filepath.Join(home, "templates")); err == nil {
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		sort.Strings(names)
		for _, n := range names {
			if m := TypeTemplateFile.FindStringSubmatch(n); m != nil {
				templates.Set(m[1], readText(filepath.Join(home, "templates", n)))
			}
		}
	}
	sum := sha256.Sum256([]byte(jsjson.Stringify(jsjson.NewObject("settings", shared, "registry", registry, "instructions", instructions, "templates", templates), "")))
	return jsjson.NewObject("rev", hex.EncodeToString(sum[:]), "settings", shared, "registry", registry, "instructions", instructions, "templates", templates)
}
