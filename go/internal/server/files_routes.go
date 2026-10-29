package server

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"stam/internal/auth"
	"stam/internal/files"
)

// The human's view of files on this machine or a peer (S-1525, src/daemon.ts GET /api/files/(list|read)), inside
// `files.roots` and past the fixed deny list (internal/files). Another host is forwarded over the peer token as the
// human; a peer that is down answers {state:'stopped'} so the UI can offer Start instead of hanging.

func (s *Server) filesRoutes() {
	s.patterns = append(s.patterns, "GET /api/files/{kind}")
	s.mux.Handle("GET /api/files/{kind}", s.stream(s.filesRoute))
}

// filePaths is where the deny list and the default roots look on this daemon.
func (s *Server) filePaths() files.Paths {
	home, _ := os.UserHomeDir()
	return files.Paths{Home: home, StamHome: s.cfg.Home}
}

func (s *Server) filesRoute(w http.ResponseWriter, r *http.Request, c auth.Resolved) error {
	kind := r.PathValue("kind")
	if kind != "list" && kind != "read" {
		return Errorf(http.StatusNotFound, "no route %s %s", r.Method, r.URL.Path)
	}
	human := s.isHuman(r, c)
	if !human {
		return Errorf(http.StatusForbidden, "only the human can read files, %s", s.humanWays("stam"))
	}
	q := r.URL.Query()
	host := q.Get("host")
	if host == "" {
		host = s.cfg.Machine
	}
	path := q.Get("path")
	all := q.Get("all") == "1"
	if host != s.cfg.Machine {
		return s.forwardFiles(w, r, kind, host, path, all, human)
	}
	p := s.filePaths()
	root := ""
	if s.tpl != nil {
		root = s.tpl.Root
	}
	roots := p.RealRoots(s.settings.Get().FilesRoots, root)
	if path == "" {
		writeJSON(w, http.StatusOK, filesRoots{Host: host, Roots: files.ListRoots(roots)})
		return nil
	}
	real, err := p.ResolveIn(path, roots)
	if err == nil {
		if kind == "list" {
			var entries []files.Entry
			if entries, err = p.ListDir(real, roots); err == nil {
				writeJSON(w, http.StatusOK, filesListing{Host: host, Path: real, Entries: entries})
				return nil
			}
		} else if err = p.Serve(w, r, real, all, roots); err == nil {
			return nil
		}
	}
	if e, ok := files.AsError(err); ok {
		return Errorf(e.Status, "%s", e.Message)
	}
	return err
}

// peerStopped is the answer for a peer that is down, in TS's key order.
type peerStopped struct {
	State string `json:"state"`
	Host  string `json:"host"`
	Error string `json:"error"`
}

type filesRoots struct {
	Host  string       `json:"host"`
	Roots []files.Root `json:"roots"`
}

type filesListing struct {
	Host    string        `json:"host"`
	Path    string        `json:"path"`
	Entries []files.Entry `json:"entries"`
}

// filesKept are the headers of a peer's file answer that are passed on; a body that came encoded keeps no length.
var filesKept = []string{"Content-Type", "Content-Length", "Content-Range", "Content-Disposition", "X-Stam-Size", "X-Stam-Truncated"}

// forwardFiles asks host's daemon for the file or listing as the human, and streams its answer on.
func (s *Server) forwardFiles(w http.ResponseWriter, r *http.Request, kind, host, path string, all, human bool) error {
	peer, ok := s.peers.ByName(host)
	if !ok {
		return Errorf(http.StatusNotFound, "no machine %s", host)
	}
	carry, err := s.relayHuman(peer, human, true, "a file", true)
	if err != nil {
		return err
	}
	target := "/api/files/" + kind + "?path=" + encodeURIComponent(path)
	if all {
		target += "&all=1"
	}
	headers := map[string]string{}
	if rg := r.Header.Get("Range"); rg != "" {
		headers["range"] = rg
	}
	up := s.peers.Raw(r.Context(), peer, target, headers, carry)
	if up == nil {
		writeJSON(w, http.StatusServiceUnavailable, peerStopped{State: "stopped", Host: host, Error: host + " is stopped"})
		return nil
	}
	defer up.Body.Close()
	h := w.Header()
	files.SetSafe(h)
	encoded := up.Header.Get("Content-Encoding") != ""
	for _, k := range filesKept {
		if v := up.Header.Get(k); v != "" && !(encoded && k == "Content-Length") {
			h.Set(k, v)
		}
	}
	w.WriteHeader(up.StatusCode)
	_, _ = io.Copy(w, up.Body)
	return nil
}

// encodeURIComponent is JavaScript's: every byte but A-Z a-z 0-9 - _ . ! ~ * ' ( ) percent-encoded.
func encodeURIComponent(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if 'a' <= c && c <= 'z' || 'A' <= c && c <= 'Z' || '0' <= c && c <= '9' || strings.IndexByte("-_.!~*'()", c) >= 0 {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}
