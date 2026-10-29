// Package secrets reads stam's own keys as src/secrets.ts does: the environment, the secret store (secrets.json), and
// opencode.env until the store has imported it. The store is read here and never written: the one-time import of
// opencode.env is the TS daemon's, and a store that has imported it already holds the keys.
package secrets

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"syscall"
)

var (
	secretName = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
	envName    = regexp.MustCompile(`^[A-Z_][A-Z0-9_]*$`)
	keyVar     = regexp.MustCompile(`(_API_KEY|_KEY|_TOKEN|_SECRET)$`)
)

var warned sync.Map

// warnOnce logs why the store was not used, once per reason, with no value in it.
func warnOnce(why string) {
	if _, dup := warned.LoadOrStore(why, true); !dup {
		slog.Warn("secrets: " + why + "; using the environment and opencode.env only")
	}
}

type storeFile struct {
	Secrets  map[string]json.RawMessage `json:"secrets"`
	Imported []any                      `json:"imported"`
}

type storeEntry struct {
	Value string `json:"value"`
	Slot  string `json:"slot"`
	Env   string `json:"env"`
}

// readStore is the secrets.json of home as src/secrets.ts readable() reads it: a missing file is empty; one that can't be
// read, is a symlink or not a regular file, or is not JSON reads as empty, with the reason logged once.
func readStore(home string) (entries map[string]storeEntry, importedLegacy bool) {
	path := filepath.Join(home, "secrets.json")
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		if !os.IsNotExist(err) {
			warnOnce("secrets.json can't be read")
		}
		return nil, false
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		warnOnce("secrets.json is not a regular file")
		return nil, false
	}
	raw, err := io.ReadAll(f)
	var parsed storeFile
	if err != nil || json.Unmarshal(raw, &parsed) != nil {
		warnOnce("secrets.json is not valid JSON")
		return nil, false
	}
	for _, v := range parsed.Imported {
		if s, ok := v.(string); ok && s == "opencode.env" {
			importedLegacy = true
		}
	}
	entries = map[string]storeEntry{}
	for name, rawEntry := range parsed.Secrets {
		var e storeEntry
		if !secretName.MatchString(name) || json.Unmarshal(rawEntry, &e) != nil || e.Value == "" {
			continue
		}
		if !envName.MatchString(e.Env) {
			e.Env = ""
		}
		if e.Slot != "agent" {
			e.Slot = "stam"
		}
		entries[name] = e
	}
	return entries, importedLegacy
}

// legacyLines is opencode.env's KEY=VALUE lines (src/secrets.ts legacyLines). Once imported, its key lines are the store's.
func legacyLines(home string, imported bool) map[string]string {
	text, err := os.ReadFile(filepath.Join(home, "opencode.env"))
	if err != nil {
		return nil
	}
	out := map[string]string{}
	for _, line := range strings.Split(string(text), "\n") {
		i := strings.IndexByte(line, '=')
		if i <= 0 || !envName.MatchString(line[:i]) {
			continue
		}
		v := strings.TrimSpace(line[i+1:])
		// replace(/^['"]|['"]$/g, ''): one quote off each end.
		if v != "" && (v[0] == '\'' || v[0] == '"') {
			v = v[1:]
		}
		if v != "" && (v[len(v)-1] == '\'' || v[len(v)-1] == '"') {
			v = v[:len(v)-1]
		}
		if v != "" && !(imported && keyVar.MatchString(line[:i])) {
			out[line[:i]] = v
		}
	}
	return out
}

// KeyFor is src/secrets.ts keyFor(env, 'stam'): the environment, then the secret store's value for that variable (the
// first by name when several name it), then opencode.env's line until the store has imported it.
func KeyFor(home, env string, getenv func(string) string) string {
	if v := getenv(env); v != "" {
		return v
	}
	entries, imported := readStore(home)
	names := make([]string, 0, len(entries))
	for n := range entries {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		if e := entries[n]; e.Env == env && e.Slot == "stam" {
			return e.Value
		}
	}
	return legacyLines(home, imported)[env]
}

// Get is src/secrets.ts getSecret: the named secret, its variable's value from the environment when that is set.
func Get(home, name string, getenv func(string) string) string {
	entries, _ := readStore(home)
	e, ok := entries[name]
	if !ok {
		return ""
	}
	if e.Env != "" {
		if v := getenv(e.Env); v != "" {
			return v
		}
	}
	return e.Value
}

// CheckCredential is src/llm/http.ts checkCredential: a credential fit for a header, printable ASCII with no spaces. A
// caller's error names only what it is, never the value.
func CheckCredential(v string) bool {
	return v != "" && !bytes.ContainsFunc([]byte(v), func(r rune) bool { return r < 0x21 || r > 0x7e })
}

// AgentEnv is src/secrets.ts agentEnv: the provider keys for stam's OpenCode server (S-2114), such as OPENROUTER_API_KEY.
// opencode.env's lines (its key lines only until the store imported them), then the store's `agent` slot by variable,
// where the first name in order wins when several name one, then the environment over any variable either sets. It is
// only ever the server's environment: no value goes in a log or an error.
func AgentEnv(home string, getenv func(string) string) map[string]string {
	entries, imported := readStore(home)
	out := legacyLines(home, imported)
	if out == nil {
		out = map[string]string{}
	}
	names := make([]string, 0, len(entries))
	for n := range entries {
		names = append(names, n)
	}
	// TS writes them in descending order, so the last write, the first name, wins.
	sort.Sort(sort.Reverse(sort.StringSlice(names)))
	for _, n := range names {
		if e := entries[n]; e.Slot == "agent" && e.Env != "" {
			out[e.Env] = e.Value
		}
	}
	for k := range out {
		if v := getenv(k); v != "" {
			out[k] = v
		}
	}
	return out
}
