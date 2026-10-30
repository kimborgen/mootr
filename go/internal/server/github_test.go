package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The routes around the GitHub poller (S-4329): the dashboard's state view and the default repo.
func TestWatchStateRoute(t *testing.T) {
	f, _ := eventsFixture(t)
	f.sql("INSERT INTO watch_state (subject, state, etags, updated_at) VALUES ('github:o/r#1', ?, '{}', '2026-10-28T10:00:00.000Z')",
		`{"type":"pr","state":"open","draft":true,"checks":"failure","review":"approved","head":"h","base":"main","title":"T","url":"u"}`)
	f.sql("INSERT INTO watch_state (subject, state, etags, updated_at) VALUES ('github:o/r#2', ?, '{}', '2026-10-28T10:00:00.000Z')", `{"type":"issue","state":"closed","title":"I","url":"iu"}`)
	rec := f.post2("GET", "/api/watch/state?subject=github:o/r%231&subject=github:o/r%232&subject=github:o/r%239&subject=linear:T-1", "")
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	want := `{"github:o/r#1":{"state":"open","draft":true,"checks":"failure","review":"approved","head":"h","base":"main","title":"T","url":"u","updated_at":"2026-10-28T10:00:00.000Z"},` +
		`"github:o/r#2":{"state":"closed","title":"I","url":"iu","updated_at":"2026-10-28T10:00:00.000Z"},` +
		`"github:o/r#9":{"updated_at":null},"linear:T-1":{"updated_at":null}}`
	if got := strings.TrimSpace(rec.Body.String()); got != want {
		t.Errorf("\n got  %s\n want %s", got, want)
	}
}

func TestGithubRepoRoute(t *testing.T) {
	f, _ := eventsFixture(t)
	f.sql("UPDATE agents SET id = id")
	if rec := f.post2("GET", "/api/pr/github-repo", ""); rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != `{"github":null}` {
		t.Errorf("no default repo: %d %s", rec.Code, rec.Body.String())
	}
}

// The daemon's start wires the poller to the event service: a tick polls the fake GitHub, stores the event, and the watch's
// subscription is matched.
func TestStartEventsPollsThroughTheEventService(t *testing.T) {
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("authorization") != "Bearer test-token" {
			w.WriteHeader(401)
			return
		}
		w.Header().Set("content-type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/issues/4"):
			w.Write([]byte(`{"title":"Bug","state":"` + issueState + `","html_url":"u","updated_at":"` + issueAt + `"}`))
		case strings.HasSuffix(r.URL.Path, "/comments"):
			w.Write([]byte(`[]`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer gh.Close()
	t.Setenv("STAM_GITHUB_API", gh.URL)
	t.Setenv("STAM_GITHUB_TOKEN", "test-token")
	f, _ := eventsFixture(t)
	if rec := f.subscribe(bossTok, `{"subscriber_kind":"agent","subscriber_id":"aboss","by":"aboss","filter":{"source":"github","subjects":["github:o/r#4"]}}`); rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	ctx, cancel := context.WithCancel(context.Background())
	f.srv.StartEvents(ctx)
	defer func() {
		cancel()
		f.srv.WaitBackground()
	}()
	issueState, issueAt = "open", "t1"
	if n, err := f.srv.github.Tick(ctx); err != nil || n != 0 {
		t.Fatalf("first tick: %d %v", n, err)
	}
	issueState, issueAt = "closed", "t2"
	if n, err := f.srv.github.Tick(ctx); err != nil || n != 1 {
		t.Fatalf("second tick: %d %v", n, err)
	}
	if got := f.count("SELECT COUNT(*) FROM ext_events WHERE type = 'issue.closed' AND source = 'github'"); got != 1 {
		t.Errorf("%d issue.closed events", got)
	}
	rec := f.post2("GET", "/api/watch/state?subject=github:o/r%234", "")
	if !strings.Contains(rec.Body.String(), `"state":"closed"`) {
		t.Errorf("state view: %s", rec.Body.String())
	}
}

var issueState, issueAt string
