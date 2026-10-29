package config

import (
	"os"
	"path/filepath"
	"testing"

	"stam/internal/jsjson"
)

// ensured runs Ensure on a home whose settings.json is text ("" for none), and returns the file after it.
func ensured(t *testing.T, text string, cache string) (string, *jsjson.Object) {
	t.Helper()
	home := t.TempDir()
	p := filepath.Join(home, "settings.json")
	if text != "" {
		if err := os.WriteFile(p, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if cache != "" {
		if err := os.WriteFile(filepath.Join(home, "settings.shared.json"), []byte(cache), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := NewSettingsFile(home, "m").Ensure(); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if info, _ := os.Stat(p); info.Mode().Perm() != 0o600 {
		t.Errorf("mode %v", info.Mode().Perm())
	}
	return string(b), ParseObject(string(b))
}

func at(o *jsjson.Object, path ...string) jsjson.Value { return getPath(o, path) }

// TestEnsure is src/settings.ts ensureSettings: a fresh install gets the defaults with local login on; a file from
// before is pinned off and given the keys it lacks; one that isn't a JSON object is left alone; a non-home daemon with a
// cache writes only the machine-local part.
func TestEnsure(t *testing.T) {
	t.Run("fresh", func(t *testing.T) {
		text, o := ensured(t, "", "")
		if text != Text(Defaults()) || at(o, "auth", "localHuman") != true {
			t.Errorf("a fresh home's file:\n%s", text)
		}
	})
	t.Run("from before local login", func(t *testing.T) {
		_, o := ensured(t, `{"chiefOfStaff":"cos","auth":{"humanStrict":true}}`, "")
		if at(o, "auth", "localHuman") != false || at(o, "auth", "humanStrict") != true || at(o, "chiefOfStaff") != "cos" {
			t.Errorf("pinned: %s", Text(o))
		}
		if keys := o.Keys(); keys[0] != "chiefOfStaff" || len(keys) != Defaults().Len() {
			t.Errorf("keys %v", keys)
		}
	})
	t.Run("an auth that isn't an object", func(t *testing.T) {
		_, o := ensured(t, `{"auth":5}`, "")
		if a := at(o, "auth"); obj(a) == nil || obj(a).Len() != 1 || at(o, "auth", "localHuman") != false {
			t.Errorf("auth %v", Text(o))
		}
	})
	t.Run("already set", func(t *testing.T) {
		full := Defaults()
		setPath(full, []string{"auth", "localHuman"}, true)
		before := Text(full)
		if text, _ := ensured(t, before, ""); text != before {
			t.Error("a complete file was rewritten")
		}
	})
	for _, bad := range []string{"{not json", "[1,2]", `"s"`} {
		t.Run("left alone: "+bad, func(t *testing.T) {
			if text, _ := ensured(t, bad, ""); text != bad {
				t.Errorf("rewritten: %s", text)
			}
		})
	}
	t.Run("a non-home daemon with a cache", func(t *testing.T) {
		_, o := ensured(t, `{"home":"other"}`, `{"rev":1,"settings":{}}`)
		if at(o, "auth", "localHuman") != false || at(o, "search", "embedder") != "local" || at(o, "debug", "stallMs") != 100.0 {
			t.Errorf("local parts: %s", Text(o))
		}
		for _, k := range []string{"chiefOfStaff", "cost", "harness"} {
			if _, ok := o.Get(k); ok {
				t.Errorf("a shared key %s was written", k)
			}
		}
		if _, ok := obj(at(o, "search")).Get("turnDays"); ok {
			t.Error("search's shared part was written")
		}
	})
	t.Run("a non-home daemon with no cache", func(t *testing.T) {
		_, o := ensured(t, `{"home":"other"}`, "")
		if _, ok := o.Get("chiefOfStaff"); !ok {
			t.Error("with no cache yet the defaults are written")
		}
	})
}
