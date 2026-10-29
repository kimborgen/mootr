package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strconv"

	"stam/internal/auth"
	"stam/internal/diff"
	"stam/internal/files"
)

// The human's PR diff (S-1530, src/daemon.ts GET /api/diff(/file|/repos)?, src/diff.ts), built from git on the ITSA
// home. Another machine's daemon forwards there over the peer token as the human, as the Files API does for a peer.

func (s *Server) diffRoutes() {
	s.diffs = &diff.Service{Home: s.cfg.Home, Settings: s.settings.Get, Repos: s.repos, Paths: s.filePaths()}
	for _, kind := range []string{"", "/file", "/repos"} {
		pattern := "GET /api/diff" + kind
		s.patterns = append(s.patterns, pattern)
		s.mux.Handle(pattern, s.stream(func(w http.ResponseWriter, r *http.Request, c auth.Resolved) error { return s.diffRoute(w, r, c, kind) }))
	}
}

// diffKept are the headers of the home's answer that are passed on; a body that came encoded keeps no length.
var diffKept = []string{"Content-Type", "Content-Length", "Content-Disposition", "X-Stam-Size", "X-Stam-Sha", "X-Stam-Head", "X-Stam-Base", "X-Stam-Truncated"}

func (s *Server) diffRoute(w http.ResponseWriter, r *http.Request, c auth.Resolved, sub string) error {
	human := s.isHuman(r, c)
	if !human {
		return Errorf(http.StatusForbidden, "only the human can read diffs, %s", s.humanWays("stam"))
	}
	home := s.settings.Get().Itsa.Home
	if home == "" {
		home = s.cfg.Machine
	}
	if home != s.cfg.Machine {
		peer, ok := s.peers.ByName(home)
		if !ok {
			return Errorf(http.StatusServiceUnavailable, "ITSA home '%s' is not a configured peer", home)
		}
		carry, err := s.relayHuman(peer, human, true, "a diff", true)
		if err != nil {
			return err
		}
		up := s.peers.Raw(r.Context(), peer, "/api/diff"+sub+search(r), nil, carry)
		if up == nil {
			return Errorf(http.StatusServiceUnavailable, "%s (the ITSA home) is stopped", home)
		}
		defer up.Body.Close()
		h := w.Header()
		files.SetSafe(h)
		h.Set("Accept-Ranges", "none")
		encoded := up.Header.Get("Content-Encoding") != ""
		for _, k := range diffKept {
			if v := up.Header.Get(k); v != "" && !(encoded && k == "Content-Length") {
				h.Set(k, v)
			}
		}
		w.WriteHeader(up.StatusCode)
		_, _ = io.Copy(w, up.Body)
		return nil
	}
	err := s.diffRequest(w, r, sub)
	if e, ok := diff.AsError(err); ok {
		return Errorf(e.Status, "%s", e.Message)
	}
	return err
}

var prNumber = regexp.MustCompile(`^[1-9]\d{0,8}$`)

// diffListed is src/diff.ts request's answer for a list: the list and the stam reviewer's verdict.
type diffListed struct {
	diff.List
	Review *diff.Review `json:"review"`
}

// diffRequest is src/diff.ts request on the ITSA home: the parameters, and the answer. A list or the repos are JSON; a
// file is written to w.
func (s *Server) diffRequest(w http.ResponseWriter, r *http.Request, sub string) error {
	if sub == "/repos" {
		writeJSON(w, http.StatusOK, s.diffRepos(r.Context()))
		return nil
	}
	q := r.URL.Query()
	repo, pr := q.Get("repo"), q.Get("pr")
	if repo == "" {
		return Errorf(http.StatusBadRequest, "repo is required")
	}
	if !prNumber.MatchString(pr) {
		return Errorf(http.StatusBadRequest, "pr must be a PR number")
	}
	n, _ := strconv.Atoi(pr)
	if sub == "" {
		out, err := s.diffs.List(r.Context(), repo, n)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, diffListed{List: out, Review: s.diffReview(r.Context(), repo, n, out.Head)})
		return nil
	}
	side := "head"
	if q.Has("side") {
		side = q.Get("side")
	}
	if side != "base" && side != "head" {
		return Errorf(http.StatusBadRequest, "side must be base or head")
	}
	want := map[string]string{}
	for _, k := range []string{"head", "base"} {
		if v := q.Get(k); v != "" {
			if !diff.IsSha(v) {
				return Errorf(http.StatusBadRequest, "%s must be a commit sha", k)
			}
			want[k] = v
		}
	}
	return s.diffs.ServeFile(r.Context(), w, repo, n, q.Get("path"), side, q.Get("all") == "1", want["head"], want["base"])
}

// diffReview is src/diff.ts reviewFor: the verdict in the poller's snapshot of the watched PR, kept after a merge or a
// close. Nil when the repo has no GitHub origin, the PR isn't watched, or nothing is posted.
func (s *Server) diffReview(ctx context.Context, repo string, pr int, head string) *diff.Review {
	checkout, err := s.diffs.Checkout(repo)
	if err != nil {
		return nil
	}
	url, _ := gitOut(ctx, checkout, "config", "--get", "remote.origin.url")
	slug := diff.GithubSlug(url)
	if slug == "" {
		return nil
	}
	text, ok, err := s.db.WatchState(ctx, "github:"+slug+"#"+strconv.Itoa(pr))
	if err != nil || !ok {
		return nil
	}
	var state any
	if json.Unmarshal([]byte(text), &state) != nil {
		return nil
	}
	return diff.ReviewOf(state, head)
}

type diffRepo struct {
	Name   string  `json:"name"`
	Github *string `json:"github"`
	Path   string  `json:"path"`
	Sha    *string `json:"sha"`
}

type diffReposOut struct {
	Machine string     `json:"machine"`
	Repos   []diffRepo `json:"repos"`
}

// diffRepos is src/diff.ts repos (S-1533, S-2104): each repo in settings.itsa.repos, with the GitHub repo its origin
// names, its checkout's path and HEAD, and whose checkouts these are.
func (s *Server) diffRepos(ctx context.Context) diffReposOut {
	out := diffReposOut{Machine: s.cfg.Machine, Repos: []diffRepo{}}
	for _, r := range s.orderedRepos() {
		row := diffRepo{Name: r.Name, Path: r.Path}
		if url, err := gitOut(ctx, r.Path, "config", "--get", "remote.origin.url"); err == nil {
			if slug := diff.GithubSlug(url); slug != "" {
				row.Github = &slug
			}
		}
		if sha, err := gitOut(ctx, r.Path, "rev-parse", "HEAD"); err == nil && sha != "" {
			row.Sha = &sha
		}
		out.Repos = append(out.Repos, row)
	}
	return out
}
