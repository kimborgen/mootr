package server

import (
	"context"
	"log/slog"
	"net/http"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"stam/internal/auth"
	"stam/internal/ghpoll"
	"stam/internal/linearpoll"
)

// The GitHub event source (src/sources/github.ts, S-4329) and the routes around it: GET /api/watch/state, the poller's last
// view of each subject for the dashboard, and GET /api/pr/github-repo, the default repo for a bare PR number.
//
// Not ported yet: the head mirror a poll triggers (mirrorEventPr, mirrorEventMain: the poller's Mirror hooks are nil)
// and Linear (its subjects answer with no state). The origin of the pr_open checkout is read for the default repo.

func (s *Server) githubRoutes() {
	s.handle("GET /api/watch/state", s.watchState)
	s.handle("GET /api/pr/github-repo", s.prGithubRepo)
}

// githubToken is the token the poller uses: the test override, else the `gh` login's.
func (s *Server) githubToken(ctx context.Context) (string, error) {
	if t := getenvStam("GITHUB_TOKEN"); t != "" {
		return t, nil
	}
	return s.mcp.GhToken(ctx)
}

// githubBase is the API's base url: STAM_GITHUB_API for a test, else GitHub's.
func githubBase() string {
	if b := getenvStam("GITHUB_API"); b != "" {
		return b
	}
	return "https://api.github.com"
}

func (s *Server) newGithubPoller() *ghpoll.Poller {
	return ghpoll.New(ghpoll.Options{
		Store:    ghpoll.DBStore{DB: s.db, Svc: s.events},
		Token:    s.githubToken,
		Base:     githubBase,
		HTTP:     &http.Client{},
		Interval: time.Duration(s.settings.Get().WatchGithubSeconds * float64(time.Second)),
	})
}

// startGithub starts the poller (src/daemon.ts at start); 0 seconds in watch.githubSeconds disables it. StartEvents stops
// it before the event service it ingests into.
func (s *Server) startGithub(ctx context.Context) {
	s.github = s.newGithubPoller()
	s.github.Start(ctx)
}

func (s *Server) watchState(r *http.Request, _ auth.Resolved) (any, error) {
	var gh, lin []string
	for _, subj := range r.URL.Query()["subject"] {
		if strings.HasPrefix(subj, "linear:") {
			lin = append(lin, subj)
		} else {
			gh = append(gh, subj)
		}
	}
	out, err := ghpoll.StateFor(r.Context(), ghpoll.DBStore{DB: s.db}, gh)
	if err != nil {
		return nil, err
	}
	views, err := linearpoll.StateFor(r.Context(), s.linearStore(), lin)
	if err != nil {
		return nil, err
	}
	for subj, v := range views {
		out[subj] = v
	}
	return out, nil
}

type githubRepo struct {
	Github *string `json:"github"`
}

// prGithubRepo is the default GitHub repo for a bare PR number (S-614), asked of the ITSA home so a peer's watch_pr gets the
// home's.
func (s *Server) prGithubRepo(r *http.Request, _ auth.Resolved) (any, error) {
	if !s.onItsaHome() {
		v, err := s.toHome(r.Context(), "GET", "/api/pr/github-repo", nil, 15*time.Second, nil)
		if err != nil {
			slog.Error("github repo: home did not answer", "err", err)
			return nil, err
		}
		g := githubRepo{}
		if t := v.Text("github"); t != "" {
			g.Github = &t
		}
		return g, nil
	}
	g := githubRepo{}
	if t := s.defaultGithubRepo(r.Context()); t != "" {
		g.Github = &t
	}
	return g, nil
}

// defaultGithubRepo is src/github-repo.ts defaultGithubRepo: itsa.prOpen.github, else the GitHub repo the prOpen checkout's
// origin names. The checkout is the repo itsa.prOpen.repo names, or the only one configured; TS also takes the first of
// several, in the file's order, which a Go map doesn't keep, so with several repos and no prOpen.repo this answers none.
func (s *Server) defaultGithubRepo(ctx context.Context) string {
	it := s.settings.Get().Itsa
	if it.PrOpenGithub != "" {
		return it.PrOpenGithub
	}
	path := it.Repos[it.PrOpenRepo]
	if it.PrOpenRepo == "" && len(it.Repos) == 1 {
		for _, p := range it.Repos {
			path = p
		}
	}
	if path == "" {
		return ""
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "git", "-C", path, "remote", "get-url", it.PrOpenOrigin).Output()
	if err != nil {
		return ""
	}
	return parseGithubRepo(string(out))
}

var reGithubRemote = regexp.MustCompile(`^(?:https?://(?:[^@/]+@)?|ssh://(?:[^@/]+@)?|[^@/\s]+@)github\.com[:/]([^/\s]+)/([^/\s]+?)(?:\.git)?/?$`)

// parseGithubRepo is src/github-repo.ts parseGithubRepo: OWNER/NAME from an https, ssh:// or scp-style github.com url.
func parseGithubRepo(url string) string {
	m := reGithubRemote.FindStringSubmatch(strings.TrimSpace(url))
	if m == nil {
		return ""
	}
	return m[1] + "/" + m[2]
}
