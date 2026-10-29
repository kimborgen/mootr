package server

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"sort"

	"stam/internal/auth"
	"stam/internal/config"
	"stam/internal/jsjson"
)

// The secret store's routes (src/daemon.ts, S-2114): only the human lists, sets, tests or deletes a secret, behind the
// same check as a settings change; agents, the OpenCode server and peers get 403. No route returns a value, and the log
// names secrets only.
func (s *Server) secretsRoutes() {
	s.handle("GET /api/secrets", s.listSecrets)
	s.handle("PUT /api/secrets/{name}", s.putSecret)
	s.handle("POST /api/secrets/{name}/test", s.testSecret)
	s.handle("DELETE /api/secrets/{name}", s.deleteSecret)
}

// StartSecrets is src/daemon.ts's start: the store read into memory, opencode.env imported once, and the MCP client
// secrets moved into it (S-2736). The settings asks decided before their payloads were redacted are redacted now (S-3869;
// TS keeps them). The log gives a count only.
func (s *Server) StartSecrets() {
	s.secrets.Init()
	s.migrateClientSecrets()
	if n, err := s.db.RedactDecidedPayloads(context.Background()); err != nil {
		slog.Warn("permissions: couldn't redact the decided settings asks' payloads")
	} else if n > 0 {
		slog.Info("permissions: redacted the payloads of decided settings asks", "count", n)
	}
}

// secretsErr is src/daemon.ts secretsCall: a broken secrets.json is a 409 that says so, a bad request a 400.
func secretsErr(err error) error {
	var se *config.SecretError
	if errors.As(err, &se) {
		if se.File {
			return Errorf(http.StatusConflict, "%s; fix or remove it", se.Message)
		}
		return Errorf(http.StatusBadRequest, "%s", se.Message)
	}
	return err
}

func (s *Server) listSecrets(r *http.Request, _ auth.Resolved) (any, error) {
	if err := s.humanOnly(r, "see stam's secrets"); err != nil {
		return nil, err
	}
	list, err := s.secrets.List()
	if err != nil {
		return nil, secretsErr(err)
	}
	return map[string]any{"secrets": list}, nil
}

func (s *Server) putSecret(r *http.Request, c auth.Resolved) (any, error) {
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	if err := s.humanOnly(r, "change stam's secrets"); err != nil {
		return nil, err
	}
	info, err := s.secrets.Set(r.PathValue("name"), jsjson.Value(w.body))
	if err != nil {
		return nil, secretsErr(err)
	}
	slog.Info("secret set: " + info.Name)
	return info, nil
}

// testSecret is src/llm/index.ts testSecret's checks: the secret and the provider it is tested against. The test
// itself, one authenticated read at the provider, needs the LLM layer, which is not ported.
func (s *Server) testSecret(r *http.Request, c auth.Resolved) (any, error) {
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	if err := s.humanOnly(r, "test stam's secrets"); err != nil {
		return nil, err
	}
	name := r.PathValue("name")
	named := ""
	if p, ok := getValue(w.body, "provider").(string); ok {
		named = p
	}
	_, env, ok, err := s.secrets.Stored(name)
	if err != nil {
		return nil, secretsErr(err)
	}
	if !ok {
		return nil, Errorf(http.StatusNotFound, "no secret %s", name)
	}
	targets := keyTestTargets(s.settings.Get().ProviderKeySecrets, name, env)
	if named != "" && !slices.Contains(targets, named) {
		return nil, Errorf(http.StatusBadRequest, "%s doesn't use %s, so it isn't tested there", named, name)
	}
	id := named
	if id == "" && len(targets) > 0 {
		id = targets[0]
	}
	if id == "" {
		return nil, Errorf(http.StatusBadRequest, "no provider uses %s", name)
	}
	return nil, unported("testing a key against %s", id)
}

// keyTestTargets is src/llm/index.ts testTargets: the providers whose apiKey names the secret, by id, and openrouter
// (the default provider) last for the secret that stands for OPENROUTER_API_KEY.
func keyTestTargets(keys map[string]string, name, env string) []string {
	var ids []string
	for id, secret := range keys {
		if id != "openrouter" && secret == name {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	if env == "OPENROUTER_API_KEY" {
		ids = append(ids, "openrouter")
	}
	return ids
}

func (s *Server) deleteSecret(r *http.Request, c auth.Resolved) (any, error) {
	if _, err := s.readWrite(r, c); err != nil {
		return nil, err
	}
	if err := s.humanOnly(r, "change stam's secrets"); err != nil {
		return nil, err
	}
	name := r.PathValue("name")
	removed, err := s.secrets.Remove(name)
	if err != nil {
		return nil, secretsErr(err)
	}
	if !removed {
		return nil, Errorf(http.StatusNotFound, "no secret %s", name)
	}
	slog.Info("secret deleted: " + name)
	return map[string]any{"removed": name}, nil
}
