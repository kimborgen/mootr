package config

import (
	"errors"

	"stam/internal/jsjson"
)

// errUnchanged ends an Ensure's Update without a write.
var errUnchanged = errors.New("settings: nothing to add")

// Ensure is src/settings.ts ensureSettings, run once at daemon start: a home with no settings.json gets the defaults
// (auth.localHuman true among them, S-2121), and every top-level key added since is written, so each setting shows in
// the file. A file from before local login became the default has no auth.localHuman: it gets false, once, so it keeps
// working as it did. A file that isn't a JSON object is left alone. A non-home daemon with a shared cache gets only the
// machine-local part of a missing key: the cache holds the rest. Go's defaults carry no itsa.repos (TS derives them
// from its checkout).
func (f *SettingsFile) Ensure() error {
	err := f.Update(func(current string) (string, error) {
		user := jsjson.NewObject()
		added := false
		if current != "" {
			v, err := jsjson.Parse([]byte(current))
			if err != nil || obj(v) == nil {
				return "", errUnchanged
			}
			user = obj(v)
			if !hasPath(user, []string{"auth", "localHuman"}) {
				auth := jsjson.NewObject()
				if o := obj(getPathOr(user, "auth")); o != nil {
					auth = spread(o)
				}
				auth.Set("localHuman", false)
				user.Set("auth", auth)
				added = true
			}
		}
		localOnly := homeOf(user, f.machine) != f.machine && f.SharedCache() != nil
		defaults := Defaults()
		for _, k := range defaults.Keys() {
			if _, ok := user.Get(k); ok {
				continue
			}
			v, _ := defaults.Get(k)
			if !localOnly {
				user.Set(k, v)
				added = true
				continue
			}
			if part, ok := LocalPart(jsjson.NewObject(k, v)).Get(k); ok {
				user.Set(k, part)
				added = true
			}
		}
		if !added {
			return "", errUnchanged
		}
		return Text(user), nil
	})
	if errors.Is(err, errUnchanged) {
		return nil
	}
	return err
}
