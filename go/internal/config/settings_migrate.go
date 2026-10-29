package config

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"stam/internal/jsjson"
)

// Migrate is src/settings-migrate.ts runMigrate, `stam settings migrate` (S-404, S-380 change 4): it compares a peer's
// settings.json with the shared cache from the home, and with apply rewrites the file with only its local keys, after a
// backup that is never overwritten. Local only: no network, no daemon. It returns the exit code, the text report and the
// result object --json prints. Shown values are redacted, with MCP args scrubbed; comparing uses the raw values.
func Migrate(home, machine string, apply bool, now time.Time) (int, string, *jsjson.Object) {
	file := filepath.Join(home, "settings.json")
	fail := func(text, homeName string) (int, string, *jsjson.Object) {
		r := jsjson.NewObject()
		if homeName != "" {
			r.Set("home", homeName)
		}
		r.Set("error", text)
		return 1, text, r
	}
	// The raw file decides everything: the home from its own keys, never from the effective settings.
	raw, err := os.ReadFile(file)
	exists := err == nil
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fail("settings.json can't be read: "+err.Error(), "")
	}
	var disk jsjson.Value = jsjson.NewObject()
	if exists {
		if disk, err = jsjson.Parse(raw); err != nil {
			// A fixed message: the parser's may quote the file, which holds secrets (TS prints the SyntaxError).
			return fail("settings.json is not valid JSON: the text does not parse", "")
		}
	}
	homeName := homeOf(disk, machine)
	if homeName == machine {
		text := "this is the settings home (" + machine + "); nothing to migrate"
		return 0, text, jsjson.NewObject("home", machine)
	}
	cache := NewSettingsFile(home, machine).SharedCache()
	if cache == nil {
		return fail("no shared settings cached yet from "+homeName+"; is the daemon running and the home reachable?", homeName)
	}
	mineRaw := leavesOf(SharedPart(disk))
	theirsRaw := leavesOf(SharedPart(cache.Settings))
	mineShown := leavesOf(redactForDisplay(SharedPart(disk)))
	theirsShown := leavesOf(redactForDisplay(SharedPart(cache.Settings)))
	var same, onlyHome []jsjson.Value
	var differs, onlyHere []jsjson.Value
	var lDiffers, lOnlyHere, lOnlyHome []string
	for _, path := range mineRaw.order {
		v := mineRaw.vals[path]
		theirs, ok := theirsRaw.vals[path]
		switch {
		case !ok:
			here, hasHere := mineShown.vals[path]
			e := jsjson.NewObject("path", path)
			if hasHere {
				e.Set("here", here)
			}
			onlyHere = append(onlyHere, e)
			lOnlyHere = append(lOnlyHere, "    "+path+": "+stringifyOr(here, hasHere))
		case jsjson.Equal(v, theirs):
			same = append(same, path)
		default:
			here, hasHere := mineShown.vals[path]
			there, hasThere := theirsShown.vals[path]
			e := jsjson.NewObject("path", path)
			// An absent shown value is undefined, which JSON.stringify drops.
			if hasHere {
				e.Set("here", here)
			}
			if hasThere {
				e.Set("home", there)
			}
			differs = append(differs, e)
			lDiffers = append(lDiffers, "    "+path+": here "+stringifyOr(here, hasHere)+", home "+stringifyOr(there, hasThere))
		}
	}
	for _, path := range theirsRaw.order {
		if _, ok := mineRaw.vals[path]; !ok {
			onlyHome = append(onlyHome, path)
			lOnlyHome = append(lOnlyHome, "    "+path)
		}
	}
	r := jsjson.NewObject("home", homeName, "same", list(same), "differs", list(differs), "onlyHere", list(onlyHere), "onlyHome", list(onlyHome))
	lines := []string{
		homeName + " is the settings home. Compared with " + file + ":",
		"  same as the home: " + strconv.Itoa(len(same)),
		"  differs: " + strconv.Itoa(len(differs)),
	}
	lines = append(lines, lDiffers...)
	lines = append(lines, "  only here: "+strconv.Itoa(len(onlyHere)))
	lines = append(lines, lOnlyHere...)
	lines = append(lines, "  only on the home (you now get these): "+strconv.Itoa(len(onlyHome)))
	lines = append(lines, lOnlyHome...)
	removed := mineRaw.order
	if !apply {
		if len(removed) > 0 {
			lines = append(lines, "dry run: --apply would remove "+strconv.Itoa(len(removed))+" shared key(s) from settings.json", "nothing written")
		} else {
			lines = append(lines, "nothing to remove", "nothing written")
		}
		return 0, strings.Join(lines, "\n"), r
	}
	if len(removed) == 0 {
		lines = append(lines, "nothing to remove")
		return 0, strings.Join(lines, "\n"), r
	}
	// The backup comes first and is never overwritten: a differing earlier backup stays and this one gets a timestamp,
	// so a strip never runs without a copy of what it removes.
	backup := file + ".pre-S380"
	reused := false
	if err := copyExcl(raw, backup); err != nil {
		if !errors.Is(err, fs.ErrExist) {
			return fail("backup failed: "+err.Error(), homeName)
		}
		if prev, err := os.ReadFile(backup); err == nil && string(prev) == string(raw) {
			reused = true
		} else {
			backup += "." + strings.NewReplacer(":", "-", ".", "-").Replace(now.UTC().Format("2006-01-02T15:04:05.000Z"))
			if err := copyExcl(raw, backup); err != nil {
				return fail("backup failed: "+err.Error(), homeName)
			}
		}
	}
	// A daemon may have written the file since the report: abort rather than drop that write.
	if cur, err := os.ReadFile(file); err != nil || string(cur) != string(raw) {
		return fail("settings.json changed while migrating; nothing was rewritten (the backup is kept). Stop the daemon and run again.", homeName)
	}
	tmp := file + "." + strconv.Itoa(os.Getpid()) + ".tmp"
	if err := os.WriteFile(tmp, []byte(jsjson.Stringify(LocalPart(disk), "  ")+"\n"), 0o600); err != nil {
		return fail("settings.json can't be written: "+err.Error(), homeName)
	}
	if err := os.Rename(tmp, file); err != nil {
		os.Remove(tmp)
		return fail("settings.json can't be written: "+err.Error(), homeName)
	}
	removedList := make([]jsjson.Value, len(removed))
	for i, p := range removed {
		removedList[i] = p
	}
	r.Set("applied", jsjson.NewObject("backup", backup, "removed", removedList))
	how := "written to"
	if reused {
		how = "already at"
	}
	lines = append(lines, "backup "+how+" "+backup, "removed "+strconv.Itoa(len(removed))+" shared key(s) from settings.json:")
	for _, p := range removed {
		lines = append(lines, "    "+p)
	}
	return 0, strings.Join(lines, "\n"), r
}

// copyExcl writes data to a new file, mode 600; an existing file is fs.ErrExist (COPYFILE_EXCL).
func copyExcl(data []byte, path string) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Chmod(path, 0o600)
	}
	return err
}

func list(v []jsjson.Value) []jsjson.Value {
	if v == nil {
		return []jsjson.Value{}
	}
	return v
}

// stringifyOr is JSON.stringify(v) in a template literal: "undefined" for an absent value.
func stringifyOr(v jsjson.Value, ok bool) string {
	if !ok {
		return "undefined"
	}
	return jsjson.Stringify(v, "")
}

// leafMap is an object's leaf paths in order: arrays and scalars are leaves; empty objects are skipped.
type leafMap struct {
	order []string
	vals  map[string]jsjson.Value
}

func leavesOf(v jsjson.Value) leafMap {
	m := leafMap{vals: map[string]jsjson.Value{}}
	var walk func(v jsjson.Value, prefix []string)
	walk = func(v jsjson.Value, prefix []string) {
		if o := obj(v); o != nil {
			for _, k := range o.Keys() {
				x, _ := o.Get(k)
				walk(x, append(append([]string(nil), prefix...), k))
			}
			return
		}
		if len(prefix) > 0 {
			p := strings.Join(prefix, ".")
			if _, ok := m.vals[p]; !ok {
				m.order = append(m.order, p)
			}
			m.vals[p] = v
		}
	}
	walk(v, nil)
	return m
}

var (
	secretFlag = regexp.MustCompile(`(?i)^--?([\w-]*(token|secret|password|apikey|api-key|api_key|authorization))$`)
	headerFlag = regexp.MustCompile(`^(--header|-H)$`)
	secretPair = regexp.MustCompile(`(?i)^((authorization|[\w-]*(token|key|secret))\s*[:=]\s*)`)
	flagEq     = regexp.MustCompile(`^(--?[\w-]+)=`)
)

// scrubArgs hides the credentials in an MCP server's args: `--token=VALUE`, the value after `--token` or a header flag,
// and an `Authorization: Bearer X` or `API_KEY=X` string wherever it sits.
func scrubArgs(args []jsjson.Value) []jsjson.Value {
	after := false
	out := make([]jsjson.Value, len(args))
	for i, a := range args {
		s, ok := a.(string)
		if !ok {
			out[i] = a
			continue
		}
		if m := secretPair.FindStringSubmatch(s); m != nil && !after {
			out[i] = m[1] + Redacted
			continue
		}
		if m := flagEq.FindStringSubmatch(s); m != nil && secretFlag.MatchString(m[1]) {
			out[i] = m[1] + "=" + Redacted
			continue
		}
		if after {
			after = false
			out[i] = Redacted
			continue
		}
		after = secretFlag.MatchString(s) || headerFlag.MatchString(s)
		out[i] = s
	}
	return out
}

// redactForDisplay is RedactValue plus the MCP args scrub, for display only.
func redactForDisplay(v jsjson.Value) jsjson.Value {
	out := RedactValue(v)
	servers, _ := member(out, "mcpServers")
	var each []jsjson.Value
	switch x := servers.(type) {
	case *jsjson.Object:
		for _, k := range x.Keys() {
			srv, _ := x.Get(k)
			each = append(each, srv)
		}
	case []jsjson.Value:
		each = x
	}
	for _, srv := range each {
		if s := obj(srv); s != nil {
			if args, ok := getPathOr(s, "args").([]jsjson.Value); ok {
				s.Set("args", scrubArgs(args))
			}
		}
	}
	return out
}
