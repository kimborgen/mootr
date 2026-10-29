package mcpservers

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"

	"stam/internal/jsjson"
)

// The import scan is src/mcp-import.ts (S-52): read-only, it reads the servers the harnesses already have and marks
// each against settings.mcpServers. Only the user-level and project configs are read, and stam's own `stam` server is
// skipped.
//
//	Claude Code  ~/.claude.json (top-level mcpServers and each projects[path].mcpServers), and .mcp.json in each
//	             distinct agent folder and its git root.
//	Codex        ~/.codex/config.toml.
//	OpenCode     ~/.config/opencode/opencode.json and .jsonc.

// StripJSONC is JSON with // and /* */ comments and trailing commas removed (OpenCode writes .jsonc).
func StripJSONC(text string) string {
	var out strings.Builder
	q := false
	for i := 0; i < len(text); i++ {
		c := text[i]
		if q {
			out.WriteByte(c)
			if c == '\\' {
				if i++; i < len(text) {
					out.WriteByte(text[i])
				}
				continue
			}
			if c == '"' {
				q = false
			}
			continue
		}
		if c == '"' {
			q = true
			out.WriteByte(c)
			continue
		}
		if c == '/' && i+1 < len(text) && text[i+1] == '/' {
			for i < len(text) && text[i] != '\n' {
				i++
			}
			out.WriteByte('\n')
			continue
		}
		if c == '/' && i+1 < len(text) && text[i+1] == '*' {
			i += 2
			for i < len(text) && !(text[i] == '*' && i+1 < len(text) && text[i+1] == '/') {
				i++
			}
			i++
			continue
		}
		if c == ',' {
			j := i + 1
			for j < len(text) {
				r, n := utf8.DecodeRuneInString(text[j:])
				if !jsjson.IsSpace(r) {
					break
				}
				j += n
			}
			if j < len(text) && (text[j] == '}' || text[j] == ']') {
				continue
			}
		}
		out.WriteByte(c)
	}
	return out.String()
}

// entries is Object.entries(v) for a parsed value as an object: an array by index, anything else empty.
func entries(v jsjson.Value) *jsjson.Object {
	switch x := v.(type) {
	case *jsjson.Object:
		if x != nil {
			return x
		}
	case []any:
		o := jsjson.NewObject()
		for i, e := range x {
			o.Set(jsjson.Number(float64(i)), e)
		}
		return o
	}
	return jsjson.NewObject()
}

// sorted is a map with its keys sorted, null when there is none: only equality is read from it, so any one order does.
func sorted(v jsjson.Value) jsjson.Value {
	if !truthy(v) {
		return nil
	}
	o := entries(v)
	keys := o.Keys()
	sort.Strings(keys)
	out := jsjson.NewObject()
	for _, k := range keys {
		x, _ := o.Get(k)
		out.Set(k, x)
	}
	return out
}

func orNull(v jsjson.Value) jsjson.Value {
	if nullish(v) {
		return nil
	}
	return v
}

// norm is a server in a form where its maps' key order doesn't count.
func norm(s jsjson.Value) string {
	args := prop(s, "args")
	if nullish(args) {
		args = []any{}
	}
	return jsjson.Stringify(jsjson.NewObject(
		"command", orNull(prop(s, "command")),
		"args", args,
		"env", sorted(prop(s, "env")),
		"url", orNull(prop(s, "url")),
		"headers", sorted(prop(s, "headers")),
		"auth", orNull(prop(s, "auth")),
		"enabled", prop(s, "enabled") != false,
	), "")
}

// SameServer is whether two servers are the same, comparing maps by key so order never matters.
func SameServer(a, b jsjson.Value) bool { return norm(a) == norm(b) }

func show(v jsjson.Value) string {
	if nullish(v) {
		return "—"
	}
	if s, ok := v.(string); ok {
		return s
	}
	return jsjson.Stringify(v, "")
}

// strictEqual is ===: primitives by value, objects and arrays never (each read is its own).
func strictEqual(a, b jsjson.Value) bool {
	switch x := a.(type) {
	case nil, string, bool:
		return a == b
	case float64:
		y, ok := b.(float64)
		return ok && x == y
	}
	return false
}

// describeDifferences is the fields that differ, with env and header values masked (names only).
func describeDifferences(existing, found jsjson.Value) []any {
	out := []any{}
	for _, k := range []string{"command", "args", "url", "auth", "enabled"} {
		var a, b jsjson.Value
		if k == "enabled" {
			a, b = prop(existing, k) != false, prop(found, k) != false
		} else {
			a, b = prop(existing, k), prop(found, k)
		}
		if jsjson.Stringify(orNull(a), "") != jsjson.Stringify(orNull(b), "") {
			out = append(out, k+": "+show(a)+" → "+show(b))
		}
	}
	for _, k := range []string{"env", "headers"} {
		a, b := entries(prop(existing, k)), entries(prop(found, k))
		var onlyA, onlyB, changed []string
		for _, x := range a.Keys() {
			av, _ := a.Get(x)
			if bv, ok := b.Get(x); !ok {
				onlyA = append(onlyA, x)
			} else if !strictEqual(av, bv) {
				changed = append(changed, x)
			}
		}
		for _, x := range b.Keys() {
			if _, ok := a.Get(x); !ok {
				onlyB = append(onlyB, x)
			}
		}
		if len(onlyA) > 0 {
			out = append(out, k+": only in stam: "+strings.Join(onlyA, ", "))
		}
		if len(onlyB) > 0 {
			out = append(out, k+": only found: "+strings.Join(onlyB, ", "))
		}
		if len(changed) > 0 {
			out = append(out, k+": value differs: "+strings.Join(changed, ", "))
		}
	}
	return out
}

// dirsToCheck is each agent folder and its git root, so a .mcp.json at the repo root is found too.
func dirsToCheck(ctx context.Context, cwds []string) []string {
	var dirs []string
	seen := map[string]bool{}
	add := func(d string) {
		if !seen[d] {
			seen[d] = true
			dirs = append(dirs, d)
		}
	}
	for _, cwd := range cwds {
		if cwd == "" {
			continue
		}
		add(cwd)
		out, err := exec.CommandContext(ctx, "git", "-C", cwd, "rev-parse", "--show-toplevel").Output()
		if root := jsjson.Trim(string(out)); err == nil && root != "" {
			add(root)
		}
	}
	return dirs
}

func exists(file string) bool {
	_, err := os.Stat(file)
	return err == nil
}

// readJSON is a JSON or JSONC file's object, nil when it is missing, unreadable, not JSON or not an object.
func readJSON(file string) *jsjson.Object {
	b, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	v, err := jsjson.Parse([]byte(StripJSONC(string(b))))
	if err != nil {
		return nil
	}
	o, _ := obj(v)
	return o
}

// member is existing[name] for settings.mcpServers: an object's member or an array's element.
func member(existing jsjson.Value, name string) jsjson.Value {
	switch x := existing.(type) {
	case *jsjson.Object:
		v, _ := x.Get(name)
		return v
	case []any:
		if i, ok := arrayIndex(x, name); ok {
			return x[i]
		}
	}
	return nil
}

// ScanHarnesses is scanHarnesses: every harness config under home and the agent folders, each server marked new, same
// or differs against existing (settings.mcpServers). Each row is {name, server, group, file, path?, note?, status,
// differences?}.
func ScanHarnesses(ctx context.Context, home string, cwds []string, existing jsjson.Value) []any {
	out := []any{}
	tilde := func(p string) string {
		if p == home {
			return "~"
		}
		if rest, ok := strings.CutPrefix(p, home+"/"); ok {
			return "~/" + rest
		}
		return p
	}
	add := func(f Parsed, group, file string, path ...string) {
		if f.Name == "stam" {
			return
		}
		e := jsjson.NewObject("name", f.Name, "server", f.Server, "group", group, "file", file)
		if len(path) > 0 {
			e.Set("path", path[0])
		}
		if f.Note != "" {
			e.Set("note", f.Note)
		}
		e.Set("status", "new")
		if cur := member(existing, f.Name); truthy(cur) {
			if SameServer(cur, f.Server) {
				e.Set("status", "same")
			} else {
				e.Set("status", "differs")
				e.Set("differences", describeDifferences(cur, f.Server))
			}
		}
		out = append(out, e)
	}
	claudeFile := filepath.Join(home, ".claude.json")
	if claude := readJSON(claudeFile); claude != nil {
		for _, f := range claudeServers(prop(claude, "mcpServers")) {
			add(f, "~/.claude.json", claudeFile)
		}
		if projects, ok := obj(prop(claude, "projects")); ok {
			for _, path := range projects.Keys() {
				proj, _ := projects.Get(path)
				if _, ok := obj(proj); !ok {
					continue
				}
				for _, f := range claudeServers(prop(proj, "mcpServers")) {
					add(f, "~/.claude.json · "+tilde(path), claudeFile, path)
				}
			}
		}
	}
	for _, dir := range dirsToCheck(ctx, cwds) {
		file := filepath.Join(dir, ".mcp.json")
		if !exists(file) {
			continue
		}
		b, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		json, err := jsjson.Parse(b)
		if err != nil {
			continue
		}
		for _, f := range ServersFromJSON(json) {
			add(f, tilde(file), file)
		}
	}
	codexFile := filepath.Join(home, ".codex", "config.toml")
	if exists(codexFile) {
		if b, err := os.ReadFile(codexFile); err == nil {
			found, _ := ServersFromTOML(string(b))
			for _, f := range found {
				add(f, "~/.codex/config.toml", codexFile)
			}
		}
	}
	for _, name := range []string{"opencode.json", "opencode.jsonc"} {
		file := filepath.Join(home, ".config", "opencode", name)
		if json := readJSON(file); json != nil {
			for _, f := range ServersFromJSON(json) {
				add(f, tilde(file), file)
			}
		}
	}
	return out
}

// claudeServers is serversFromJson({mcpServers: v}): the map when v is one, otherwise none.
func claudeServers(v jsjson.Value) []Parsed {
	if o, ok := obj(v); ok {
		return serversFromMap(o)
	}
	return nil
}
