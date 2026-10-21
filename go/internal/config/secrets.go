package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var (
	secretName = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
	envName    = regexp.MustCompile(`^[A-Z_][A-Z0-9_]*$`)
	keyVar     = regexp.MustCompile(`(_API_KEY|_KEY|_TOKEN|_SECRET)$`)
)

// KeyFor is src/secrets.ts keyFor for the `stam` slot: the environment first, then the secret store's value for that
// variable (the first by name when several name it), then opencode.env's line until the store has imported it. A
// broken or missing secrets.json reads as empty, as TS's readable() does. The empty string is no key.
func KeyFor(home, env string, getenv func(string) string) string {
	if v := getenv(env); v != "" {
		return v
	}
	var store struct {
		Secrets  map[string]json.RawMessage `json:"secrets"`
		Imported []any                      `json:"imported"`
	}
	imported := false
	if b, err := readRegular(filepath.Join(home, "secrets.json")); err == nil && json.Unmarshal(b, &store) == nil {
		for _, x := range store.Imported {
			if s, ok := x.(string); ok && s == "opencode.env" {
				imported = true
			}
		}
		names := make([]string, 0, len(store.Secrets))
		for n := range store.Secrets {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			var e struct {
				Value string `json:"value"`
				Slot  string `json:"slot"`
				Env   string `json:"env"`
			}
			if !secretName.MatchString(n) || json.Unmarshal(store.Secrets[n], &e) != nil || e.Value == "" {
				continue
			}
			if e.Slot != "agent" && e.Env == env && envName.MatchString(e.Env) {
				return e.Value
			}
		}
	}
	return legacyLines(filepath.Join(home, "opencode.env"), imported)[env]
}

// readRegular reads a file that is not a symlink (TS opens secrets.json with O_NOFOLLOW).
func readRegular(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, os.ErrInvalid
	}
	return os.ReadFile(path)
}

// legacyLines is src/secrets.ts legacyLines: KEY=VALUE lines of opencode.env with surrounding quotes stripped; once the
// file is imported, its key lines belong to the store and are skipped.
func legacyLines(path string, imported bool) map[string]string {
	out := map[string]string{}
	b, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	for _, l := range strings.Split(string(b), "\n") {
		i := strings.Index(l, "=")
		if i <= 0 || !envName.MatchString(l[:i]) {
			continue
		}
		v := strings.TrimSpace(l[i+1:])
		// One quote of either kind off each end, as /^['"]|['"]$/g does.
		if v != "" && (v[0] == '"' || v[0] == '\'') {
			v = v[1:]
		}
		if v != "" && (v[len(v)-1] == '"' || v[len(v)-1] == '\'') {
			v = v[:len(v)-1]
		}
		if v != "" && !(imported && keyVar.MatchString(l[:i])) {
			out[l[:i]] = v
		}
	}
	return out
}
