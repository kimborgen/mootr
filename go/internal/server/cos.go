package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync"

	"stam/internal/adapters/claude"
	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/jsjson"
)

// The chief of staff (src/daemon.ts): its name is settings.chiefOfStaff, so it survives a restart, and it counts while
// that agent is active or paused (src/org.ts chiefOfStaff). The cos agent type makes the agent it spawns the chief of
// staff; the human starts and stops one through /api/cos.

// cosState keeps the chief of staff to one: start runs one start at a time, and spawning is a cos spawn in flight, held
// from the check to the end of the spawn, so two at once can't both pass it.
type cosState struct {
	mu       sync.Mutex
	spawning bool
	start    sync.Mutex
	// held runs in a cos spawn once it holds the spawn, before the agent's row: a test blocks the spawn there, or fails it.
	held func() error
}

// claim is the cos spawn's check: a 409 when a chief of staff is active or another is starting; otherwise it holds the
// spawn until release.
func (st *cosState) claim(ctx context.Context, s *Server) (func(), error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if cur, ok := s.chiefOfStaff(ctx); ok {
		return nil, Errorf(http.StatusConflict, "%s is already the chief of staff", cur.Name)
	}
	if st.spawning {
		return nil, Errorf(http.StatusConflict, "a chief of staff is already starting")
	}
	st.spawning = true
	return func() {
		st.mu.Lock()
		st.spawning = false
		st.mu.Unlock()
	}, nil
}

// chiefOfStaff is the active chief of staff's row (src/org.ts chiefOfStaff).
func (s *Server) chiefOfStaff(ctx context.Context) (db.Agent, bool) {
	return s.liveAgent(ctx, s.settings.Get().ChiefOfStaff)
}

func (s *Server) cosRoutes() {
	s.handle("GET /api/chief-of-staff", s.cosGet)
	s.handle("POST /api/chief-of-staff", s.cosName)
	s.handle("POST /api/cos/{action}", s.cosAction)
}

// cosGet is GET /api/chief-of-staff: the chief of staff's name (null when none is active), for agents that mail it, and
// the setting as stored.
func (s *Server) cosGet(r *http.Request, _ auth.Resolved) (any, error) {
	var name, setting *string
	if a, ok := s.chiefOfStaff(r.Context()); ok {
		name = &a.Name
	}
	if v := s.settings.Get().ChiefOfStaff; v != "" {
		setting = &v
	}
	return struct {
		ChiefOfStaff *string `json:"chiefOfStaff"`
		Setting      *string `json:"setting"`
	}{name, setting}, nil
}

// cosName is POST /api/chief-of-staff (`stam cos`): the human or the assistant names the chief of staff (agent), or
// clears it with none. It takes the role in its prompt at its next restart.
func (s *Server) cosName(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	if !w.human {
		by, _ := w.body.Get("by")
		if !jsjson.Truthy(by) || !s.isAssistant(ctx, claude.JSString(by)) {
			return nil, Errorf(http.StatusForbidden, "only the human and the assistant name the chief of staff")
		}
	}
	var name *string
	var value jsjson.Value
	if v, _ := w.body.Get("agent"); jsjson.Truthy(v) {
		a, err := s.mustAgent(ctx, claude.JSString(v))
		if err != nil {
			return nil, err
		}
		name, value = &a.Name, a.Name
	}
	if err := s.settings.SetShared("chiefOfStaff", value); err != nil {
		return nil, err
	}
	return struct {
		ChiefOfStaff *string `json:"chiefOfStaff"`
	}{name}, nil
}

// cosAction is POST /api/cos/start and /stop, the human's alone: start runs one from the cos type if none is active,
// and returns the active one; stop shuts the active one down now.
func (s *Server) cosAction(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	action := r.PathValue("action")
	if action != "start" && action != "stop" {
		return nil, Errorf(http.StatusNotFound, "no route %s %s", r.Method, r.URL.Path)
	}
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	if !w.human {
		return nil, Errorf(http.StatusForbidden, "only the human starts or stops the chief of staff this way")
	}
	if action == "start" {
		return s.startCos(ctx, c, w.local)
	}
	cos, ok := s.chiefOfStaff(ctx)
	if !ok {
		return nil, Errorf(http.StatusNotFound, "no chief of staff is active")
	}
	if s.life == nil {
		return nil, Errorf(http.StatusNotImplemented, "shutdown isn't available on this daemon")
	}
	if err := s.life.Shutdown(ctx, cos); err != nil {
		return nil, err
	}
	return s.db.GetAgent(ctx, cos.ID)
}

// startCos is src/daemon.ts startCos: the active chief of staff, or a new one from the cos type, named cos (cos-2, ...
// when taken), in its own folder under the home like the assistant's, since it manages stam rather than a project.
// Concurrent starts run one after another, so the later ones find the first's.
func (s *Server) startCos(ctx context.Context, c auth.Resolved, local bool) (db.Agent, error) {
	s.cos.start.Lock()
	defer s.cos.start.Unlock()
	if cur, ok := s.chiefOfStaff(ctx); ok {
		return cur, nil
	}
	name := "cos"
	for i := 2; ; i++ {
		_, err := s.db.GetAgent(ctx, name)
		if errors.Is(err, db.ErrNotFound) {
			break
		}
		if err != nil {
			return db.Agent{}, err
		}
		name = fmt.Sprintf("cos-%d", i)
	}
	cwd := filepath.Join(s.cfg.Home, "cos")
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		return db.Agent{}, err
	}
	body := jsjson.NewObject()
	body.Set("name", name)
	body.Set("type", "cos")
	body.Set("cwd", cwd)
	body.Set("role", "Chief of staff")
	out, err := s.spawnWrite(ctx, c, write{body: body, human: true, local: local})
	if err != nil {
		return db.Agent{}, err
	}
	return out.(spawnView).Agent, nil
}
