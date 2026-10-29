package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"stam/internal/auth"
	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/jsjson"
	"stam/internal/templates"
)

// The registry, agent type, template and instructions routes of src/daemon.ts (S-3782 6d). The registry, the
// instructions for all agents and the agent types' instructions (type-NAME templates) live on the settings home: the
// human changes them there, each write is pushed to the peers (schedulePush), and a non-home daemon reads the home's
// copy from its shared cache and refuses a change with a 409 naming the home. Other templates are per machine.

func (s *Server) registryRoutes() {
	s.handle("GET /api/registry", s.getRegistry)
	s.handle("GET /api/templates", s.getTemplates)
	s.handle("POST /api/templates/{id}", agentPath(s.postTemplate))
	s.handle("POST /api/types/{id}", agentPath(s.postType))
	s.handle("DELETE /api/types/{id}", agentPath(s.deleteType))
	for _, which := range []string{"registry", "instructions"} {
		s.handle("GET /api/config/"+which, s.getConfigFile(which))
		s.handle("POST /api/config/"+which, s.postConfigFile(which))
	}
}

// templateSet is the daemon's templates, or a 501 on a daemon built without them.
func (s *Server) templateSet() (*templates.Set, error) {
	if s.tpl == nil {
		return nil, unported("the templates aren't available on this daemon")
	}
	return s.tpl, nil
}

// humanOnly is src/daemon.ts humanOnly: a 403 unless the request carries the human's own proof.
func (s *Server) humanOnly(r *http.Request, what string) error {
	if !s.trustedHuman(r) {
		return Errorf(http.StatusForbidden, "only the human can %s, %s", what, s.humanWays("stam"))
	}
	return nil
}

// homeOnly is src/daemon.ts homeOnly: what lives on the settings home is changed there; elsewhere a 409 naming it.
func (s *Server) homeOnly(what string) error {
	if s.isSettingsHome() {
		return nil
	}
	home := s.settings.Get().Home
	return &Error{Status: http.StatusConflict, Message: what + " live on " + home + "; change them there", Extra: map[string]any{"home": home}}
}

// getRegistry is GET /api/registry: the merged registry, each harness with the version its binary reports (null when
// it can't say).
func (s *Server) getRegistry(r *http.Request, _ auth.Resolved) (any, error) {
	reg := s.registry()
	hv, _ := reg.Get("harnesses")
	if hs, ok := hv.(*jsjson.Object); ok {
		for _, name := range hs.Keys() {
			h, _ := hs.Get(name)
			o, ok := h.(*jsjson.Object)
			bin := harnessBin(name)
			if !ok || bin == "" {
				continue
			}
			var version jsjson.Value
			if v, err := binVersion(r.Context(), bin); err == nil {
				version = v
			}
			o.Set("version", version)
		}
	}
	return jsValue(reg), nil
}

// harnessBin is the binary of a harness stam has an adapter for (src/adapters/*.ts BIN); "" for any other.
func harnessBin(name string) string {
	home, _ := os.UserHomeDir()
	pick := func(env, local, plain string) string {
		if v := os.Getenv(env); v != "" {
			return v
		}
		if local != "" {
			if _, err := os.Stat(filepath.Join(home, local)); err == nil {
				return filepath.Join(home, local)
			}
		}
		return plain
	}
	switch name {
	case "claude":
		return pick("STAM_CLAUDE_BIN", "", "claude")
	case "codex":
		return pick("STAM_CODEX_BIN", ".local/bin/codex", "codex")
	case "opencode":
		return pick("STAM_OPENCODE_BIN", ".opencode/bin/opencode", "opencode")
	}
	return ""
}

// binVersion is `BIN --version`, trimmed.
func binVersion(ctx context.Context, bin string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "--version")
	cmd.WaitDelay = time.Second
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return jsjson.Trim(string(out)), nil
}

// jsValue is a value as the route sends it, in JavaScript's key order.
func jsValue(v jsjson.Value) any { return json.RawMessage(jsjson.Stringify(v, "")) }

// getTemplates is GET /api/templates: every template with its text, whether the user overrode it, and the shipped text.
func (s *Server) getTemplates(*http.Request, auth.Resolved) (any, error) {
	t, err := s.templateSet()
	if err != nil {
		return nil, err
	}
	return t.ListTemplates()
}

// postTemplate is POST /api/templates/:name: the human's save or reset of one template. An agent type's instructions
// live on the settings home (S-417), and a change to them is pushed to the peers.
func (s *Server) postTemplate(r *http.Request, c auth.Resolved) (any, error) {
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	if err := s.humanOnly(r, "change stam's templates"); err != nil {
		return nil, err
	}
	t, err := s.templateSet()
	if err != nil {
		return nil, err
	}
	name := r.PathValue("id")
	shared := config.TypeTemplateName.MatchString(name)
	if shared {
		if err := s.homeOnly("agent type instructions"); err != nil {
			return nil, err
		}
	}
	body := w.body
	if body == nil {
		body = jsjson.NewObject()
	}
	if reset, _ := body.Get("reset"); jsjson.Truthy(reset) {
		err = t.ResetTemplate(name)
	} else {
		text := ""
		if v, ok := body.Get("text"); ok && v != nil {
			text = jsjson.ToString(v)
		}
		err = t.SaveTemplate(name, text)
	}
	// TS answers 500 for a name that is no template; it is the caller's mistake, so a 404 here.
	if errors.Is(err, templates.ErrNoTemplate) {
		return nil, Errorf(http.StatusNotFound, "%s", err.Error())
	}
	if err != nil {
		return nil, err
	}
	if shared {
		s.schedulePush()
	}
	info, ok, err := t.TemplateInfo(name)
	if err != nil || !ok {
		return nil, err
	}
	return info, nil
}

// postType is POST /api/types/:name: the human adds or replaces an agent type in the user's registry.json, checked
// against the registry; an invalid one is a 400 and nothing is written.
func (s *Server) postType(r *http.Request, c auth.Resolved) (any, error) {
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	if err := s.humanOnly(r, "change stam's agent types"); err != nil {
		return nil, err
	}
	if err := s.homeOnly("agent types"); err != nil {
		return nil, err
	}
	t, err := s.templateSet()
	if err != nil {
		return nil, err
	}
	saved, err := t.SaveType(r.PathValue("id"), w.body)
	if err != nil {
		return nil, Errorf(http.StatusBadRequest, "%s", err.Error())
	}
	s.schedulePush()
	return jsValue(saved), nil
}

// deleteType is DELETE /api/types/:name: a shipped type is masked, a user one deleted with its instructions. A missing
// type is a 404; the default reviewer, or a type another names, a 409.
func (s *Server) deleteType(r *http.Request, c auth.Resolved) (any, error) {
	if _, err := s.readWrite(r, c); err != nil {
		return nil, err
	}
	if err := s.humanOnly(r, "change stam's agent types"); err != nil {
		return nil, err
	}
	if err := s.homeOnly("agent types"); err != nil {
		return nil, err
	}
	t, err := s.templateSet()
	if err != nil {
		return nil, err
	}
	name := r.PathValue("id")
	if err := t.RemoveType(name); err != nil {
		if errors.Is(err, templates.ErrNoType) {
			return nil, Errorf(http.StatusNotFound, "%s", err.Error())
		}
		return nil, Errorf(http.StatusConflict, "%s", err.Error())
	}
	s.schedulePush()
	return map[string]string{"removed": name}, nil
}

// configText is src/daemon.ts readConfigFile for the registry and the instructions: a non-home daemon with the home's
// copy cached shows that copy (S-387); else the file, or what an absent one starts from.
func (s *Server) configText(which string) string {
	if c := config.PeerShared(s.cfg.Home, s.cfg.Machine); c != nil {
		if which == "instructions" && c.Instructions != nil {
			return *c.Instructions
		}
		if which == "registry" && c.Registry != nil {
			return config.Text(c.Registry)
		}
	}
	if which == "instructions" {
		b, err := os.ReadFile(filepath.Join(s.cfg.Home, "instructions.md"))
		if err != nil {
			return ""
		}
		return string(b)
	}
	return s.registryText()
}

// registryText is src/permissions.ts currentRegistryText: STAM_HOME/registry.json, or the empty override file.
func (s *Server) registryText() string {
	b, err := os.ReadFile(filepath.Join(s.cfg.Home, "registry.json"))
	if err != nil {
		return templates.EmptyRegistry
	}
	return string(b)
}

// configFileView is the GET's answer: the text, and on a non-home daemon which daemon is the home and whether the copy
// may be behind.
type configFileView struct {
	Text  string  `json:"text"`
	Home  *string `json:"home,omitempty"`
	Stale *bool   `json:"stale,omitempty"`
}

// getConfigFile is GET /api/config/registry and /api/config/instructions.
func (s *Server) getConfigFile(which string) handler {
	return func(*http.Request, auth.Resolved) (any, error) {
		text := s.configText(which)
		if s.isSettingsHome() {
			return configFileView{Text: text}, nil
		}
		st := s.syncState()
		return configFileView{Text: text, Home: &st.Home, Stale: &st.Stale}, nil
	}
}

// postConfigFile is POST /api/config/registry and /api/config/instructions: the human's whole-file save on the settings
// home, pushed to the peers. The chief of staff and the assistant may ask for a registry change instead (S-496).
func (s *Server) postConfigFile(which string) handler {
	return func(r *http.Request, c auth.Resolved) (any, error) {
		w, err := s.readWrite(r, c)
		if err != nil {
			return nil, err
		}
		text := ""
		if v := getValue(w.body, "text"); v != nil {
			text = jsjson.ToString(v)
		}
		if which == "registry" && !s.trustedHuman(r) {
			me, err := s.mayAskSettings(r.Context(), c)
			if err != nil {
				return nil, err
			}
			if err := s.homeOnly("registry entries"); err != nil {
				return nil, err
			}
			return s.askRegistry(r.Context(), me, text)
		}
		if err := s.humanOnly(r, "change stam's settings, registry and instructions"); err != nil {
			return nil, err
		}
		what := "registry entries"
		if which == "instructions" {
			what = "the instructions for all agents"
		}
		if err := s.homeOnly(what); err != nil {
			return nil, err
		}
		t, err := s.templateSet()
		if err != nil {
			return nil, err
		}
		if which == "instructions" {
			if err := t.WriteInstructions(text); err != nil {
				return nil, err
			}
		} else {
			if err := registryProblem(text); err != nil {
				return nil, err
			}
			if err := t.UpdateUserRegistry(func(string) (string, error) { return text, nil }); err != nil {
				return nil, err
			}
		}
		s.schedulePush()
		return map[string]string{"text": text}, nil
	}
}

// registryProblem is the check a registry text passes before it is saved or asked for: valid JSON. The ask also wants a
// JSON object (src/permissions.ts resultOf); the human's save takes any JSON, as TS's does.
func registryProblem(text string) error {
	if _, err := jsjson.Parse([]byte(text)); err != nil {
		return Errorf(http.StatusBadRequest, "not valid JSON: the text does not parse")
	}
	return nil
}

// askRegistry is src/permissions.ts requestSettingsChange for the registry: the human gets an approval with the diff of
// registry.json, and nothing is written until they approve (answerRegistry).
func (s *Server) askRegistry(ctx context.Context, me db.Agent, text string) (any, error) {
	if utf16Len(text) > 256*1024 {
		return nil, Errorf(http.StatusBadRequest, "the settings text is over 256 KB")
	}
	if err := registryProblem(text); err != nil {
		return nil, err
	}
	if v, _ := jsjson.Parse([]byte(text)); func() bool { _, ok := v.(*jsjson.Object); return !ok }() {
		return nil, Errorf(http.StatusBadRequest, "the registry must be a JSON object")
	}
	current := s.registryText()
	diff := config.UnifiedDiff(current, text, "registry now", "registry if approved")
	if diff == "" {
		diff = "No visible change."
	}
	payload := jsjson.Stringify(jsjson.NewObject("change", jsjson.NewObject("kind", "registry", "text", text), "baseHash", config.Hash(current)), "")
	req, err := s.requestPermissionWith(ctx, me, "Change stam registry", me.Name+" wants to change stam's registry (STAM_HOME/registry.json)", diff, false, "human", permExtra{payload: &payload, fence: "diff"})
	if err != nil {
		return nil, err
	}
	return withStatus{http.StatusAccepted, map[string]string{"requested": req.Text("id")}}, nil
}

// answerRegistry applies an approved registry change on the settings home, unless registry.json changed since the ask.
// It returns the result the asker is told and whether it was applied.
func (s *Server) answerRegistry(payload *jsjson.Object, text string) (string, bool, error) {
	if !s.isSettingsHome() {
		return "approved, but not applied: the registry lives on " + s.settings.Get().Home + "; change it there", false, nil
	}
	t, err := s.templateSet()
	if err != nil {
		return "", false, err
	}
	base, _ := payload.Get("baseHash")
	result := "approved and applied"
	err = t.UpdateUserRegistry(func(current string) (string, error) {
		if config.Hash(current) != base {
			result = "approved, but not applied: the registry changed after you asked, so read it again and ask again"
			return "", errNotApplied
		}
		return text, nil
	})
	if errors.Is(err, errNotApplied) {
		return result, false, nil
	}
	if err != nil {
		return "", false, err
	}
	s.schedulePush()
	return result, true, nil
}
