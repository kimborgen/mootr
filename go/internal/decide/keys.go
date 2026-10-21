package decide

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

// stam's own OpenRouter key (src/secrets.ts keyFor with the `stam` slot): the environment, then the secret store's value for
// that variable (the first by name when several name it), then opencode.env's line until the store has imported it. The store
// is read here and never written: the one-time import of opencode.env is the TS daemon's, and a store that has imported it
// already holds the keys.

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

// keyFor is src/secrets.ts keyFor(env, 'stam').
func keyFor(home, env string, getenv func(string) string) string {
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

// checkCredential is src/llm/http.ts checkCredential: a credential fit for a header, printable ASCII with no spaces. The
// error names only what it is, never the value.
func checkCredential(v string) bool {
	return v != "" && !bytes.ContainsFunc([]byte(v), func(r rune) bool { return r < 0x21 || r > 0x7e })
}
