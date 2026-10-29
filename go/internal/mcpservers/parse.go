// Package mcpservers reads MCP server configs as src/mcp-config.ts, src/mcp-import.ts and src/mcp-registry.ts do: a
// config pasted from any harness, the harnesses' own config files, and the public MCP registry, each into stam's stored
// form (settings.mcpServers entries); and it tests a configured server by listing its tools.
package mcpservers

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"

	"stam/internal/jsjson"
)

// SSENote is SSE_NOTE: stam reaches a server over streamable HTTP, so an SSE server is told to use its /mcp url.
const SSENote = "stam connects over streamable HTTP; use the server's /mcp URL if it has one"

// Parsed is one server as it was found, with the name it was under. Note is a caveat about that server alone, "" for
// none.
type Parsed struct {
	Name   string
	Server *jsjson.Object
	Note   string
}

// undefined is JavaScript's undefined in a parsed TOML table: what `key =` with no value holds. It never reaches a
// server: String() of it is "undefined", and no other read keeps it.
type undefined struct{}

func obj(v jsjson.Value) (*jsjson.Object, bool) {
	o, ok := v.(*jsjson.Object)
	return o, ok && o != nil
}

// prop is v[key] for a parsed value: an object's member, nil (undefined) for anything else.
func prop(v jsjson.Value, key string) jsjson.Value {
	o, _ := v.(*jsjson.Object)
	x, _ := o.Get(key)
	return x
}

// nullish is whether v is null or undefined.
func nullish(v jsjson.Value) bool {
	if _, ok := v.(undefined); ok {
		return true
	}
	return v == nil
}

func truthy(v jsjson.Value) bool {
	if _, ok := v.(undefined); ok {
		return false
	}
	return jsjson.Truthy(v)
}

// str is String(v): undefined is "undefined", and NaN and the infinities print as JavaScript prints them.
func str(v jsjson.Value) string {
	switch x := v.(type) {
	case undefined:
		return "undefined"
	case float64:
		switch {
		case math.IsNaN(x):
			return "NaN"
		case math.IsInf(x, 1):
			return "Infinity"
		case math.IsInf(x, -1):
			return "-Infinity"
		}
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			if !nullish(e) {
				parts[i] = str(e)
			}
		}
		return strings.Join(parts, ",")
	}
	return jsjson.ToString(v)
}

func strs(list []any) []any {
	out := make([]any, len(list))
	for i, v := range list {
		out[i] = str(v)
	}
	return out
}

// strMap is an object with each value as String(value).
func strMap(o *jsjson.Object) *jsjson.Object {
	out := jsjson.NewObject()
	for _, k := range o.Keys() {
		v, _ := o.Get(k)
		out.Set(k, str(v))
	}
	return out
}

// toServer is anything that looks like one server, from any harness: a local command (a string with args, or
// OpenCode's array) or a remote url, plus its env and headers; nil when it has neither a command nor a url.
func toServer(entry jsjson.Value) *jsjson.Object {
	e, ok := obj(entry)
	if !ok {
		return nil
	}
	s := jsjson.NewObject()
	switch c := prop(e, "command").(type) {
	case string:
		s.Set("command", c)
	case []any:
		if len(c) > 0 {
			s.Set("command", str(c[0]))
			if len(c) > 1 {
				s.Set("args", strs(c[1:]))
			}
		}
	}
	if _, has := s.Get("args"); !has {
		if a, ok := prop(e, "args").([]any); ok {
			s.Set("args", strs(a))
		}
	}
	env := prop(e, "env")
	if nullish(env) {
		env = prop(e, "environment")
	}
	if o, ok := obj(env); ok {
		s.Set("env", strMap(o))
	}
	if u, ok := prop(e, "url").(string); ok {
		s.Set("url", u)
	}
	headers := jsjson.NewObject()
	for _, k := range []string{"headers", "http_headers"} {
		if o, ok := obj(prop(e, k)); ok {
			for _, h := range o.Keys() {
				v, _ := o.Get(h)
				headers.Set(h, str(v))
			}
		}
	}
	if headers.Len() > 0 {
		s.Set("headers", headers)
	}
	if prop(e, "enabled") == false {
		s.Set("enabled", false)
	}
	if !truthy(prop(s, "command")) && !truthy(prop(s, "url")) {
		return nil
	}
	return s
}

var sseURL = regexp.MustCompile(`/sse/?$`)

// isSSE is whether a server is announced as SSE, by its type or its url.
func isSSE(entry jsjson.Value, s *jsjson.Object) bool {
	u, _ := prop(s, "url").(string)
	return prop(entry, "type") == "sse" || sseURL.MatchString(u)
}

// serversFromMap is one JSON-style server map, in any harness's shape, in stam's form.
func serversFromMap(m *jsjson.Object) []Parsed {
	var out []Parsed
	for _, name := range m.Keys() {
		entry, _ := m.Get(name)
		if s := toServer(entry); s != nil {
			p := Parsed{Name: name, Server: s}
			if isSSE(entry, s) {
				p.Note = name + ": " + SSENote
			}
			out = append(out, p)
		}
	}
	return out
}

func looksLikeServer(v jsjson.Value) bool {
	o, ok := obj(v)
	if !ok {
		return false
	}
	for _, k := range []string{"command", "url", "type", "args", "env", "environment", "headers"} {
		if _, has := o.Get(k); has {
			return true
		}
	}
	return false
}

// ServersFromJSON is the server map in a JSON config: Claude's mcpServers, OpenCode's mcp (or mcp.servers), Codex's
// mcp_servers written as JSON, or a bare {name: server} map.
func ServersFromJSON(json jsjson.Value) []Parsed {
	if o, ok := obj(prop(json, "mcpServers")); ok {
		return serversFromMap(o)
	}
	mcp := prop(json, "mcp")
	if o, ok := obj(prop(mcp, "servers")); ok {
		return serversFromMap(o)
	}
	if o, ok := obj(mcp); ok {
		return serversFromMap(o)
	}
	if o, ok := obj(prop(json, "mcp_servers")); ok {
		return serversFromMap(o)
	}
	if o, ok := obj(json); ok && o.Len() > 0 {
		for _, k := range o.Keys() {
			if v, _ := o.Get(k); !looksLikeServer(v) {
				return nil
			}
		}
		return serversFromMap(o)
	}
	return nil
}

// ServersFromTOML is each Codex [mcp_servers.NAME] table, minus what only an environment variable could carry, which
// becomes the server's note. An error is a table the text can't hold (TS's TypeError).
func ServersFromTOML(text string) ([]Parsed, error) {
	root, err := parseTOML(text)
	if err != nil {
		return nil, err
	}
	servers, ok := obj(prop(root, "mcp_servers"))
	if !ok {
		return nil, nil
	}
	var out []Parsed
	for _, name := range servers.Keys() {
		v, _ := servers.Get(name)
		if _, ok := obj(v); !ok {
			continue
		}
		s := toServer(v)
		if s == nil {
			continue
		}
		var notes []string
		if env, ok := prop(v, "bearer_token_env_var").(string); ok {
			notes = append(notes, "authorizes with the "+env+" environment variable; stam stores header values, so set it by hand or choose OAuth")
		}
		if o, ok := obj(prop(v, "env_http_headers")); ok && o.Len() > 0 {
			notes = append(notes, strings.Join(o.Keys(), ", ")+" read a value from the environment at run time; set them by hand or choose OAuth")
		}
		if isSSE(v, s) {
			notes = append(notes, SSENote)
		}
		p := Parsed{Name: name, Server: s}
		if len(notes) > 0 {
			p.Note = name + ": " + strings.Join(notes, "; ")
		}
		out = append(out, p)
	}
	return out, nil
}

// --- A tiny TOML reader, enough for the [mcp_servers.*] tables Codex writes, as src/mcp-config.ts reads them --------
// Values: strings (basic and literal), arrays, inline tables, booleans and numbers. Tables are nested objects; other
// top-level tables are parsed and ignored. It walks bytes: every character it looks for is ASCII.

// findTop is the first ch outside quotes, or -1.
func findTop(s string, ch byte) int {
	var q byte
	for i := 0; i < len(s); i++ {
		c := s[i]
		if q != 0 {
			if c == '\\' && q == '"' {
				i++
			} else if c == q {
				q = 0
			}
			continue
		}
		if c == '"' || c == '\'' {
			q = c
			continue
		}
		if c == ch {
			return i
		}
	}
	return -1
}

// endQuote is the index of the quote closing the string opened at start, or len(s).
func endQuote(s string, start int) int {
	q := s[start]
	for i := start + 1; i < len(s); i++ {
		if q == '"' && s[i] == '\\' {
			i++
			continue
		}
		if s[i] == q {
			return i
		}
	}
	return len(s)
}

// matching is the index of the close matching the open at start, or len(s).
func matching(s string, start int, open, close byte) int {
	depth := 0
	var q byte
	for i := start; i < len(s); i++ {
		c := s[i]
		if q != 0 {
			if c == '\\' && q == '"' {
				i++
			} else if c == q {
				q = 0
			}
			continue
		}
		if c == '"' || c == '\'' {
			q = c
			continue
		}
		if c == open {
			depth++
		} else if c == close {
			if depth--; depth == 0 {
				return i
			}
		}
	}
	return len(s)
}

// splitTop splits on sep outside quotes and brackets. A backslash ending the text inside a basic string takes
// "undefined" with it, as `c + s[++i]` does in TS.
func splitTop(s string, sep byte) []string {
	var out []string
	var buf strings.Builder
	depth := 0
	var q byte
	for i := 0; i < len(s); i++ {
		c := s[i]
		if q != 0 {
			if c == '\\' && q == '"' {
				buf.WriteByte(c)
				if i++; i < len(s) {
					buf.WriteByte(s[i])
				} else {
					buf.WriteString("undefined")
				}
				continue
			}
			if c == q {
				q = 0
			}
			buf.WriteByte(c)
			continue
		}
		if c == '"' || c == '\'' {
			q = c
			buf.WriteByte(c)
			continue
		}
		if c == '[' || c == '{' {
			depth++
		} else if c == ']' || c == '}' {
			depth--
		}
		if c == sep && depth == 0 {
			out = append(out, buf.String())
			buf.Reset()
			continue
		}
		buf.WriteByte(c)
	}
	if jsjson.Trim(buf.String()) != "" {
		out = append(out, buf.String())
	}
	return out
}

// splitKey is a key path (mcp_servers.name, "my server", a."b.c") with its quotes stripped and escapes ignored.
func splitKey(s string) []string {
	var out []string
	var buf strings.Builder
	var q byte
	for i := 0; i < len(s); i++ {
		c := s[i]
		if q != 0 {
			if c == q {
				q = 0
			} else {
				buf.WriteByte(c)
			}
			continue
		}
		if c == '"' || c == '\'' {
			q = c
			continue
		}
		if c == '.' {
			out = append(out, jsjson.Trim(buf.String()))
			buf.Reset()
			continue
		}
		buf.WriteByte(c)
	}
	out = append(out, jsjson.Trim(buf.String()))
	kept := out[:0]
	for _, k := range out {
		if k != "" {
			kept = append(kept, k)
		}
	}
	return kept
}

func stripComment(line string) string {
	if i := findTop(line, '#'); i >= 0 {
		return line[:i]
	}
	return line
}

var (
	tomlNumber  = regexp.MustCompile(`^[-+]?[\d_]+(\.[\d_]+)?([eE][-+]?\d+)?$`)
	tomlEscape  = regexp.MustCompile(`\\(["\\nrtbf/])`)
	tomlUnicode = regexp.MustCompile(`(?:\\u[\da-fA-F]{4})+`)
	escapes     = map[string]string{`"`: `"`, `\`: `\`, "n": "\n", "r": "\r", "t": "\t", "b": "\b", "f": "\f", "/": "/"}
)

// unescape is TS's two passes over a basic string: the named escapes, then \uXXXX (so `\\u0041` is A, as there). A
// lone surrogate becomes U+FFFD, which a Go string can hold instead.
func unescape(s string) string {
	s = tomlEscape.ReplaceAllStringFunc(s, func(m string) string { return escapes[m[1:]] })
	return tomlUnicode.ReplaceAllStringFunc(s, func(m string) string {
		units := make([]uint16, 0, len(m)/6)
		for i := 0; i+6 <= len(m); i += 6 {
			n, _ := strconv.ParseUint(m[i+2:i+6], 16, 16)
			units = append(units, uint16(n))
		}
		return string(utf16.Decode(units))
	})
}

// tomlNum is Number(s) for a TOML number with its underscores dropped: "" is 0, a lone sign NaN.
func tomlNum(s string) float64 {
	s = strings.ReplaceAll(s, "_", "")
	if s == "" {
		return 0
	}
	f, err := strconv.ParseFloat(s, 64)
	var ne *strconv.NumError
	if err != nil && !(errors.As(err, &ne) && ne.Err == strconv.ErrRange) {
		return math.NaN()
	}
	return f
}

// maxDepth bounds how deep arrays and inline tables nest. Each level scans the rest of the text again, so without it
// a pasted text of deeply nested arrays (on the open parse route) costs quadratic time; TS has no bound.
const maxDepth = 32

func parseValue(s string) jsjson.Value { return parseValueAt(s, 0) }

// parseValueAt is parseValue at a nesting depth; an array or inline table past maxDepth is dropped.
func parseValueAt(s string, depth int) jsjson.Value {
	s = jsjson.Trim(s)
	if s == "" {
		return undefined{}
	}
	if (s[0] == '[' || s[0] == '{') && depth >= maxDepth {
		return undefined{}
	}
	switch s[0] {
	case '[':
		out := []any{}
		for _, p := range splitTop(s[1:max(1, matching(s, 0, '[', ']'))], ',') {
			if v := parseValueAt(p, depth+1); v != (undefined{}) {
				out = append(out, v)
			}
		}
		return out
	case '{':
		out := jsjson.NewObject()
		for _, part := range splitTop(s[1:max(1, matching(s, 0, '{', '}'))], ',') {
			if eq := findTop(part, '='); eq >= 0 {
				key := "undefined"
				if k := splitKey(part[:eq]); len(k) > 0 {
					key = k[0]
				}
				out.Set(key, parseValueAt(part[eq+1:], depth+1))
			}
		}
		return out
	case '"':
		return unescape(s[1:max(1, endQuote(s, 0))])
	case '\'':
		return s[1:max(1, endQuote(s, 0))]
	}
	switch {
	case s == "true":
		return true
	case s == "false":
		return false
	case tomlNumber.MatchString(s):
		return tomlNum(s)
	}
	return s
}

// typeError is V8's TypeError for setting a property on a primitive, which a table over a plain value throws in TS.
func typeError(target jsjson.Value, key string) error {
	kind := "string"
	switch target.(type) {
	case float64:
		kind = "number"
	case bool:
		kind = "boolean"
	}
	return fmt.Errorf("Cannot create property '%s' on %s '%s'", key, kind, str(target))
}

// arrayIndex is key as an index into list, when it is one.
func arrayIndex(list []any, key string) (int, bool) {
	n, err := strconv.Atoi(key)
	return n, err == nil && n >= 0 && n < len(list) && strconv.Itoa(n) == key
}

// descend is `o[k] ??= {}`: an object's member, made an empty table when missing. An array's element is kept; any
// other key on an array is a table nothing reads.
func descend(o jsjson.Value, k string) (jsjson.Value, error) {
	switch x := o.(type) {
	case *jsjson.Object:
		if v, _ := x.Get(k); !nullish(v) {
			return v, nil
		}
		t := jsjson.NewObject()
		x.Set(k, t)
		return t, nil
	case []any:
		if i, ok := arrayIndex(x, k); ok {
			return x[i], nil
		}
		return jsjson.NewObject(), nil
	}
	return nil, typeError(o, k)
}

// assign is `o[k] = v`.
func assign(o jsjson.Value, k string, v jsjson.Value) error {
	switch x := o.(type) {
	case *jsjson.Object:
		x.Set(k, v)
	case []any:
		if i, ok := arrayIndex(x, k); ok {
			x[i] = v
		}
	default:
		return typeError(o, k)
	}
	return nil
}

var lineBreak = regexp.MustCompile(`\r?\n`)

// parseTOML reads the tables and keys of a TOML text. A key named __proto__ is an ordinary key here: TS's reader sets
// Object.prototype's members with it, which isn't carried over.
func parseTOML(text string) (*jsjson.Object, error) {
	root := jsjson.NewObject()
	var table jsjson.Value = root
	for _, raw := range lineBreak.Split(text, -1) {
		line := jsjson.Trim(stripComment(raw))
		if line == "" {
			continue
		}
		if line[0] == '[' {
			var t jsjson.Value = root
			for _, k := range splitKey(strings.TrimRight(strings.TrimLeft(line, "["), "]")) {
				var err error
				if t, err = descend(t, k); err != nil {
					return nil, err
				}
			}
			table = t
			continue
		}
		eq := findTop(line, '=')
		if eq < 0 {
			continue
		}
		key := splitKey(line[:eq])
		value := parseValue(line[eq+1:])
		target := table
		last := "undefined"
		if len(key) > 0 {
			for _, k := range key[:len(key)-1] {
				var err error
				if target, err = descend(target, k); err != nil {
					return nil, err
				}
			}
			last = key[len(key)-1]
		}
		if err := assign(target, last, value); err != nil {
			return nil, err
		}
	}
	return root, nil
}

const jsSpace = `[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`

var (
	tomlKeyLine = regexp.MustCompile(`^[A-Za-z0-9_.'"-]+` + jsSpace + `*=`)
	tomlTable   = regexp.MustCompile(`\n` + jsSpace + `*\[`)
)

// isTOML is whether pasted text is TOML: a table header, a top-level key = value, or a [table] on a later line.
func isTOML(t string) bool {
	if t[0] == '{' {
		return false
	}
	return t[0] == '[' || tomlKeyLine.MatchString(t) || tomlTable.MatchString(t)
}

// ParseConfig is parseMcpConfig: pasted text from any harness as {servers, notes} in stam's stored form. The error is
// the plain reason there is no config to read, for a 400.
func ParseConfig(text string) (*jsjson.Object, error) {
	t := jsjson.Trim(text)
	if t == "" {
		return nil, errors.New("Paste an MCP server config.")
	}
	var found []Parsed
	toml := isTOML(t)
	if toml {
		var err error
		if found, err = ServersFromTOML(t); err != nil {
			return nil, err
		}
	} else {
		json, err := jsjson.Parse([]byte(t))
		if err != nil {
			return nil, errors.New("That is neither JSON nor a Codex TOML config.")
		}
		found = ServersFromJSON(json)
	}
	if len(found) == 0 {
		if toml {
			return nil, errors.New("No mcp_servers tables found.")
		}
		return nil, errors.New("No MCP servers found in that config.")
	}
	servers := jsjson.NewObject()
	notes := []any{}
	for _, f := range found {
		servers.Set(f.Name, f.Server)
		if f.Note != "" {
			notes = append(notes, f.Note)
		}
	}
	return jsjson.NewObject("servers", servers, "notes", notes), nil
}
