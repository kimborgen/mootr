package catalog

import (
	"os"
	"path/filepath"

	"stam/internal/jsjson"
)

// Harnesses is src/adapters/index.ts adapters' order: the harnesses onboarding reports on.
var Harnesses = []string{"claude", "opencode", "codex"}

// Repo is one of itsa.repos, in the settings' order.
type Repo struct{ Name, Path string }

// OnboardingInput is src/onboarding.ts OnboardingInput. Versions holds a version, or nil for a harness that isn't
// installed, by Harnesses' names; Getenv reads the environment (CLAUDE_CONFIG_DIR, API key variables).
type OnboardingInput struct {
	Versions     map[string]*string
	Providers    jsjson.Value
	LocalHuman   bool
	Repos        []Repo
	DerivedRepos map[string]string
	Cos          *string
	Home         string
	Getenv       func(string) string
	Platform     string
}

// loginFiles is src/onboarding.ts loginFiles: where each harness keeps its login, and a variable that also counts.
func loginFiles(home string, getenv func(string) string) map[string]struct {
	files []string
	env   string
} {
	or := func(v, d string) string {
		if v != "" {
			return v
		}
		return d
	}
	return map[string]struct {
		files []string
		env   string
	}{
		"claude":   {[]string{filepath.Join(or(getenv("CLAUDE_CONFIG_DIR"), filepath.Join(home, ".claude")), ".credentials.json")}, "ANTHROPIC_API_KEY"},
		"codex":    {[]string{filepath.Join(or(getenv("CODEX_HOME"), filepath.Join(home, ".codex")), "auth.json")}, "OPENAI_API_KEY"},
		"opencode": {[]string{filepath.Join(or(getenv("XDG_DATA_HOME"), filepath.Join(home, ".local", "share")), "opencode", "auth.json")}, ""},
	}
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// real is realpathSync, or the path as it is when that fails.
func real(p string) string {
	if r, err := filepath.EvalSymlinks(p); err == nil {
		if a, err := filepath.Abs(r); err == nil {
			return a
		}
	}
	return p
}

// harnessStatus is src/onboarding.ts harnessStatus: each harness installed or not, its version, and whether a login
// file (or API key variable) is there, which says nothing about whether it still works.
func harnessStatus(in OnboardingInput) (*jsjson.Object, bool) {
	out := jsjson.NewObject()
	logins := loginFiles(in.Home, in.Getenv)
	usable := false
	for _, name := range Harnesses {
		version, ok := in.Versions[name]
		if !ok {
			continue
		}
		l, known := logins[name]
		file := ""
		for _, f := range l.files {
			if exists(f) {
				file = f
				break
			}
		}
		viaEnv := ""
		if l.env != "" && in.Getenv(l.env) != "" {
			viaEnv = l.env
		}
		var loggedIn jsjson.Value = file != "" || viaEnv != ""
		if loggedIn == false && name == "claude" && in.Platform == "darwin" {
			loggedIn = "unknown"
		}
		via := file
		switch {
		case via != "":
		case viaEnv != "":
			via = viaEnv
		case known && len(l.files) > 0:
			via = l.files[0]
		default:
			via = "unknown harness"
		}
		var v jsjson.Value
		if version != nil {
			v = *version
		}
		installed := version != nil && *version != ""
		out.Set(name, jsjson.NewObject("installed", installed, "version", v, "loggedIn", loggedIn, "via", via))
		if installed && loggedIn != false {
			usable = true
		}
	}
	return out, usable
}

// Onboarding is src/onboarding.ts onboardingStatus: what a fresh install still lacks, from cheap file and settings
// reads only, with the gaps in the order to walk them.
func Onboarding(in OnboardingInput) *jsjson.Object {
	harnesses, usable := harnessStatus(in)
	derived := map[string]bool{}
	for _, p := range in.DerivedRepos {
		derived[real(p)] = true
	}
	gaps := []jsjson.Value{}
	if !usable {
		gaps = append(gaps, "no harness is installed and logged in")
	}
	repos := []jsjson.Value{}
	mine := 0
	for _, r := range in.Repos {
		ok := exists(r.Path)
		o := jsjson.NewObject("name", r.Name, "path", r.Path, "exists", ok)
		if derived[real(r.Path)] {
			o.Set("derived", true)
		} else {
			mine++
			if !ok {
				gaps = append(gaps, "repo "+r.Name+" is missing at "+r.Path)
			}
		}
		repos = append(repos, o)
	}
	if mine == 0 {
		gaps = append(gaps, "no repo is configured")
	}
	var cos jsjson.Value
	if in.Cos != nil {
		cos = *in.Cos
	}
	if in.Cos == nil || *in.Cos == "" {
		gaps = append(gaps, "no chief of staff is running")
	}
	return jsjson.NewObject("harnesses", harnesses, "providers", in.Providers, "network", jsjson.NewObject("localHuman", in.LocalHuman),
		"repos", repos, "cos", jsjson.NewObject("exists", in.Cos != nil && *in.Cos != "", "name", cos), "gaps", gaps)
}
