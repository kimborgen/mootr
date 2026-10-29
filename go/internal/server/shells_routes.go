package server

import (
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"stam/internal/adapters/claude"
	"stam/internal/auth"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
	"stam/internal/tmux"
)

// The human's own terminals (src/daemon.ts /api/shells, src/tmux.ts newShell): login shells in tmux sessions named
// sh-XXXXX on this daemon's socket, kept until they exit, so a restart keeps them as TS does. Starting, killing and
// typing into one is the human's; another machine's is forwarded to its daemon as the human (relayHuman). The list is
// open to any token, as in TS. Their terminal sockets are tty.go's.

// shellRef is TS's sh-[\w]+, the id a shell route takes.
var shellRef = regexp.MustCompile(`^sh-\w+$`)

func (s *Server) shellRoutes() {
	s.handle("GET /api/shells", func(r *http.Request, _ auth.Resolved) (any, error) {
		return s.tmux.ListShells(r.Context(), s.cfg.Machine), nil
	})
	s.handle("POST /api/shells", s.newShell)
	s.handle("POST /api/shells/{id}/kill", shellPath(s.killShell))
	s.handle("POST /api/shells/{id}/input", shellPath(s.shellInput))
}

// shellPath refuses a shell route whose id isn't one TS's (sh-[\w]+) matches, as no route.
func shellPath(h handler) handler {
	return func(r *http.Request, c auth.Resolved) (any, error) {
		if !shellRef.MatchString(r.PathValue("id")) {
			return nil, Errorf(http.StatusNotFound, "no route %s %s", r.Method, r.URL.Path)
		}
		return h(r, c)
	}
}

// shellWrite is a terminal write's body, the human's or a 403, and the peer it names (machine), if any but this one.
func (s *Server) shellWrite(r *http.Request, c auth.Resolved) (write, string, error) {
	w, err := s.readWrite(r, c)
	if err != nil {
		return w, "", err
	}
	if !w.human {
		return w, "", Errorf(http.StatusForbidden, "terminals are for the human")
	}
	machine := ""
	if m := get(w.body, "machine"); jsjson.Truthy(m) {
		if name := claude.JSString(m); name != s.cfg.Machine {
			machine = name
		}
	}
	return w, machine, nil
}

// toPeer forwards a terminal write to machine's daemon as the human, and returns the peer's answer and name. A peer's
// non-200 is an error here, its own refusal fields dropped (ownRefusal), so a strict peer's 409 never reaches the page as
// a 200. The caller builds its answer from the fields it checks, never passing the peer's object on.
func (s *Server) toPeer(r *http.Request, w write, machine, path string, body any) (jsfmt.Value, string, error) {
	peer, ok := s.peers.ByName(machine)
	if !ok {
		return jsfmt.Value{}, "", Errorf(http.StatusNotFound, "no peer machine %s", machine)
	}
	carry, err := s.relayHuman(peer, w.human, true, "a terminal", true)
	if err != nil {
		return jsfmt.Value{}, "", err
	}
	timeout := 10 * time.Second
	if strings.HasSuffix(path, "/input") {
		timeout = 30 * time.Second
	}
	reply, err := s.peers.Call(r.Context(), peer, http.MethodPost, path, body, timeout, carry, nil)
	if err != nil {
		return jsfmt.Value{}, "", err
	}
	if reply.Status != http.StatusOK {
		msg := ownRefusal(reply.Status, reply.Data).Text("error")
		if msg == "" {
			msg = "peer failed"
		}
		return jsfmt.Value{}, "", Errorf(reply.Status, "%s", msg)
	}
	return reply.Data, peer.Name, nil
}

// newShell is POST /api/shells: a terminal in cwd (`~` is the home; a folder that doesn't exist is the home), here or
// on machine.
func (s *Server) newShell(r *http.Request, c auth.Resolved) (any, error) {
	w, machine, err := s.shellWrite(r, c)
	if err != nil {
		return nil, err
	}
	if machine != "" {
		body := map[string]any{}
		if v, ok := w.body.Get("cwd"); ok {
			body["cwd"] = v
		}
		data, name, err := s.toPeer(r, w, machine, "/api/shells", body)
		if err != nil {
			return nil, err
		}
		if id, cwd := data.Text("id"), data.Text("cwd"); shellRef.MatchString(id) {
			return tmux.Shell{ID: id, Cwd: cwd, Machine: name}, nil
		}
		return nil, Errorf(http.StatusBadGateway, "%s started no terminal", name)
	}
	home, _ := os.UserHomeDir()
	cwd := home
	if v := get(w.body, "cwd"); v != nil {
		cwd = claude.JSString(v)
	}
	if cwd == "~" || strings.HasPrefix(cwd, "~/") {
		cwd = home + cwd[1:]
	}
	if _, err := os.Stat(cwd); err != nil {
		cwd = home
	}
	return s.tmux.NewShell(r.Context(), cwd, s.cfg.Machine)
}

// killShell is POST /api/shells/:id/kill. Killing one that is gone is no error, as in TS.
func (s *Server) killShell(r *http.Request, c auth.Resolved) (any, error) {
	w, machine, err := s.shellWrite(r, c)
	if err != nil {
		return nil, err
	}
	id := r.PathValue("id")
	if machine != "" {
		if _, _, err := s.toPeer(r, w, machine, "/api/shells/"+id+"/kill", map[string]any{}); err != nil {
			return nil, err
		}
	} else {
		_ = s.tmux.KillSession(r.Context(), id)
	}
	return map[string]string{"killed": id}, nil
}

// shellInput is POST /api/shells/:id/input: text pasted into the terminal, with uploaded files listed after it.
func (s *Server) shellInput(r *http.Request, c auth.Resolved) (any, error) {
	w, machine, err := s.shellWrite(r, c)
	if err != nil {
		return nil, err
	}
	id := r.PathValue("id")
	if machine != "" {
		fwd := jsjson.NewObject()
		for _, k := range w.body.Keys() {
			if k != "machine" {
				v, _ := w.body.Get(k)
				fwd.Set(k, v)
			}
		}
		data, _, err := s.toPeer(r, w, machine, "/api/shells/"+id+"/input", fwd)
		if err != nil {
			return nil, err
		}
		sent, _ := data.Get("sent")
		return map[string]bool{"sent": sent.Kind == jsfmt.Bool && sent.Bool}, nil
	}
	if !s.tmux.HasSession(r.Context(), id) {
		return nil, Errorf(http.StatusNotFound, "no terminal %s", id)
	}
	text := ""
	if v := get(w.body, "text"); v != nil {
		text = claude.JSString(v)
	}
	text, err = s.withUploads(text, get(w.body, "files"), id, true)
	if err != nil {
		return nil, err
	}
	if err := s.tmux.PasteText(r.Context(), id, text); err != nil {
		return nil, err
	}
	return map[string]bool{"sent": true}, nil
}
