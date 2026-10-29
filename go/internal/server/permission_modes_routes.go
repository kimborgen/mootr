package server

import (
	"context"
	"net/http"

	"stam/internal/auth"
	"stam/internal/catalog"
	"stam/internal/jsjson"
)

// permissionModesRoutes are Settings › permission modes (S-1967): the modes and the agents still on an older one, and
// apply, which switches them.
func (s *Server) permissionModesRoutes() {
	s.handle("GET /api/permission-modes", s.getPermissionModes)
	s.handle("POST /api/permission-modes/apply", s.applyPermissionModes)
}

// staleJSON is the stale list as GET /api/permission-modes sends it.
func (s *Server) staleJSON(ctx context.Context) ([]jsjson.Value, error) {
	stale, err := s.life.StaleAgents(ctx)
	if err != nil {
		return nil, err
	}
	out := []jsjson.Value{}
	for _, a := range stale {
		out = append(out, a.JSON())
	}
	return out, nil
}

// getPermissionModes is GET /api/permission-modes (S-1967): the settings, each harness's modes in its own words, the
// agent types, and the running agents still on another mode than the settings give them.
func (s *Server) getPermissionModes(r *http.Request, _ auth.Resolved) (any, error) {
	if s.life == nil {
		return nil, Errorf(http.StatusNotImplemented, "agent control isn't available on this daemon")
	}
	stale, err := s.staleJSON(r.Context())
	if err != nil {
		return nil, err
	}
	typesV, _ := s.registry().Get("types")
	types := []jsjson.Value{}
	if t, ok := typesV.(*jsjson.Object); ok {
		for _, k := range t.Keys() {
			types = append(types, k)
		}
	}
	return raw(jsjson.NewObject("settings", s.settings.Get().PermissionModes.JSON(), "harnesses", catalog.HarnessModes(), "types", types, "stale", stale)), nil
}

type applyEvent struct {
	By      string   `json:"by"`
	Applied []string `json:"applied"`
	Skipped any      `json:"skipped"`
}

// applyPermissionModes is POST /api/permission-modes/apply: the human switches the agents that follow the settings
// to the mode the settings now give them, each at the end of its step, keeping its session.
func (s *Server) applyPermissionModes(r *http.Request, _ auth.Resolved) (any, error) {
	if err := s.humanOnly(r, "apply permission modes, from the web UI"); err != nil {
		return nil, err
	}
	if s.life == nil {
		return nil, Errorf(http.StatusNotImplemented, "agent control isn't available on this daemon")
	}
	// A relaunch, and the restore after a failed one, outlive the request: a closed tab mustn't leave an agent on neither
	// mode.
	ctx := context.WithoutCancel(r.Context())
	applied, skipped, err := s.life.ApplyPermissionModes(ctx, humanName)
	if err != nil {
		return nil, err
	}
	appliedJSON, skippedJSON := []jsjson.Value{}, []jsjson.Value{}
	names := []string{}
	for _, a := range applied {
		appliedJSON = append(appliedJSON, jsjson.NewObject("name", a.Name, "mode", a.Mode, "result", a.Result))
		names = append(names, a.Name)
	}
	for _, k := range skipped {
		skippedJSON = append(skippedJSON, jsjson.NewObject("name", k.Name, "reason", k.Reason))
	}
	if err := s.db.AddEvent(ctx, humanName, "permission-modes:apply", applyEvent{By: humanName, Applied: names, Skipped: raw(skippedJSON)}); err != nil {
		return nil, err
	}
	stale, err := s.staleJSON(ctx)
	if err != nil {
		return nil, err
	}
	return raw(jsjson.NewObject("applied", appliedJSON, "skipped", skippedJSON, "stale", stale)), nil
}
