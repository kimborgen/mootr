package server

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"net/http"
	"regexp"

	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/jsfmt"
)

// POST /api/register (src/daemon.ts registerAgent): an agent stam didn't spawn joins the registry. With `token: true`
// (as `stam mcp` and Go's MCP register ask) it gets its own launch token, as a launch gives one, since the shared token
// can't name an agent that has one (S-545). Only the token's hash is stored; the token goes once, in this reply.

var registerName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,40}$`)

// registered is the reply: the agent row as TS returns it (every column but token_hash, which db.Agent never
// marshals, and none of the list's extras), and the token when one was asked for.
type registered struct {
	db.Agent
	Token string `json:"token,omitempty"`
}

func (s *Server) register(r *http.Request, _ auth.Resolved) (any, error) {
	ctx := r.Context()
	body, err := jsonBody(r)
	if err != nil {
		return nil, err
	}
	name := db.JSTrim(orString(body, "name", ""))
	if !registerName.MatchString(name) {
		return nil, Errorf(http.StatusBadRequest, "name must be lowercase letters, digits, and dashes")
	}
	if _, err := s.db.GetAgent(ctx, name); err == nil {
		return nil, Errorf(http.StatusConflict, "name %s is taken", name)
	} else if !errors.Is(err, db.ErrNotFound) {
		return nil, err
	}
	id, err := s.db.NewAgentID(ctx)
	if err != nil {
		return nil, err
	}
	var model *string
	if v, ok := body.Get("model"); ok && v.Truthy() {
		m := db.JSStr(v)
		model = &m
	}
	if _, err := s.db.CreateAgent(ctx, db.NewAgent{ID: id, Name: name, Role: orString(body, "role", ""), Machine: s.cfg.Machine,
		Harness: orString(body, "harness", "external"), Cwd: orString(body, "cwd", ""), Model: model}); err != nil {
		return nil, err
	}
	if err := s.db.UpdateAgent(ctx, id, db.Field{Col: "activity", Val: "unknown"}, db.Field{Col: "child_notices", Val: s.settings.Get().ChildNotices}); err != nil {
		return nil, err
	}
	if err := s.db.AddEvent(ctx, id, "register", nil); err != nil {
		return nil, err
	}
	a, err := s.db.GetAgent(ctx, id)
	if err != nil {
		return nil, err
	}
	out := registered{Agent: a}
	if v, ok := body.Get("token"); ok && v.Kind == jsfmt.Bool && v.Bool {
		if out.Token, err = s.mintToken(r, id); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// mintToken is src/agent-token.ts mintAgentToken (lifecycle.mintToken's twin): a new random token, of which only the
// hash is stored.
func (s *Server) mintToken(r *http.Request, id string) (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(b)
	if err := s.db.SetTokenHash(r.Context(), id, auth.Hash(token)); err != nil {
		return "", err
	}
	return token, nil
}

// orString is JS String(body[key] ?? def).
func orString(body jsfmt.Value, key, def string) string {
	v, ok := body.Get(key)
	if !ok || v.Kind == jsfmt.Null {
		return def
	}
	return db.JSStr(v)
}
