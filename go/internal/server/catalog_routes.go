package server

import (
	"net/http"
	"os"
	"runtime"
	"sync"

	"stam/internal/auth"
	"stam/internal/catalog"
	"stam/internal/config"
	"stam/internal/jsjson"
	"stam/internal/mcp"
)

// The catalog routes are the read-only lists the Settings pages pick from (src/daemon.ts): the MCP tools, the tiny-step
// models, the models a model field offers, what a fresh install lacks, and the blocks a type's composer lists.
func (s *Server) catalogRoutes() {
	s.handle("GET /api/tools", s.getTools)
	s.handle("GET /api/blocks/composing", s.getComposing)
	s.handle("GET /api/tiny-models", s.getTinyModels)
	s.handle("GET /api/models", s.getModels)
	s.handle("GET /api/onboarding", s.getOnboarding)
}

// getTools is GET /api/tools: the MCP tools every agent talks to, grouped, for Settings › Tools and the decision-steps
// UI (S-60); the requirement tools only while requirements are on.
func (s *Server) getTools(*http.Request, auth.Resolved) (any, error) {
	return raw(mcp.Catalog(s.requirements.Enabled())), nil
}

// getComposing is GET /api/blocks/composing?type=&harness= (S-892): the blocks a type's composer lists and the
// replacement files it can pick; an unknown type is a 404.
func (s *Server) getComposing(r *http.Request, _ auth.Resolved) (any, error) {
	t, err := s.templateSet()
	if err != nil {
		return nil, err
	}
	q := r.URL.Query()
	var typ *jsjson.Object
	if name := q.Get("type"); name != "" {
		types, _ := s.registry().Get("types")
		v, _ := at(types, name)
		if !jsjson.Truthy(v) {
			return nil, Errorf(http.StatusNotFound, "no agent type %s", name)
		}
		typ, _ = v.(*jsjson.Object)
	}
	models := s.settings.Get().HumanMail.Models
	// src/settings.ts mayMailHuman: a null or unknown model may; only an explicit false keeps it from.
	mayMail := func(model jsjson.Value) bool {
		if !jsjson.Truthy(model) {
			return true
		}
		allowed, ok := models[jsjson.ToString(model)]
		return !ok || allowed
	}
	out, err := t.ComposerCatalog(typ, q.Get("harness"), mayMail)
	if err != nil {
		return nil, err
	}
	return raw(out), nil
}

// getTinyModels is GET /api/tiny-models: every cheap model call stam makes for itself (S-1480).
func (s *Server) getTinyModels(*http.Request, auth.Resolved) (any, error) {
	return raw(jsjson.NewObject("models", catalog.TinyModels(s.settings.Get()))), nil
}

// getModels is GET /api/models?kind=openrouter|harness[&harness=]: the models a Settings model field can pick (S-379).
func (s *Server) getModels(r *http.Request, _ auth.Resolved) (any, error) {
	q := r.URL.Query()
	switch q.Get("kind") {
	case "openrouter":
		models, err := s.openRouter.Models(r.Context())
		if err != nil {
			return nil, err
		}
		return raw(jsjson.NewObject("models", models)), nil
	case "harness":
		return raw(jsjson.NewObject("models", catalog.HarnessModels(s.registry(), q.Get("harness")))), nil
	}
	return nil, Errorf(http.StatusBadRequest, "kind is openrouter or harness")
}

// orderedRepos is settings().itsa.repos in its order: the file's repos first, then the one derived from this checkout
// unless the file names it.
func (s *Server) orderedRepos() []catalog.Repo {
	all := s.repos()
	text, _ := s.settings.EffectiveText()
	itsa, _ := config.ParseObject(text).Get("itsa")
	var names []string
	seen := map[string]bool{}
	if o, ok := itsa.(*jsjson.Object); ok {
		user, _ := o.Get("repos")
		if u, ok := user.(*jsjson.Object); ok {
			names = u.Keys()
		}
	}
	if s.tpl != nil {
		for k := range config.DerivedRepos(s.tpl.Root) {
			names = append(names, k)
		}
	}
	var out []catalog.Repo
	for _, n := range names {
		if p, ok := all[n]; ok && !seen[n] {
			seen[n] = true
			out = append(out, catalog.Repo{Name: n, Path: p})
		}
	}
	return out
}

// getOnboarding is GET /api/onboarding: what a fresh install still lacks (S-2145). Providers stay 'unknown', as in TS,
// until the onboarding reads GET /api/secrets (S-2114).
func (s *Server) getOnboarding(r *http.Request, _ auth.Resolved) (any, error) {
	versions := map[string]*string{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, name := range catalog.Harnesses {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var version *string
			if v, err := binVersion(r.Context(), harnessBin(name)); err == nil {
				version = &v
			}
			mu.Lock()
			versions[name] = version
			mu.Unlock()
		}()
	}
	wg.Wait()
	var cos *string
	if id := s.chiefOfStaffID(r.Context()); id != "" {
		if a, err := s.db.GetAgent(r.Context(), id); err == nil {
			cos = &a.Name
		}
	}
	home, _ := os.UserHomeDir()
	var derived map[string]string
	if s.tpl != nil {
		derived = config.DerivedRepos(s.tpl.Root)
	}
	return raw(catalog.Onboarding(catalog.OnboardingInput{
		Versions: versions, Providers: "unknown", LocalHuman: s.settings.Get().Auth.LocalHuman, Repos: s.orderedRepos(), DerivedRepos: derived,
		Cos: cos, Home: home, Getenv: os.Getenv, Platform: runtime.GOOS,
	})), nil
}
