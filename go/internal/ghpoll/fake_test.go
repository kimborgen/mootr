package ghpoll

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
)

const testToken = "ghp_SECRETtoken0123456789"

// fakeGithub is a GitHub REST API on loopback for the poller's tests, with ETags, 304s and rate-limit headers (the Go twin
// of test/fixtures/fake-github.mjs). No test reaches real GitHub.
type fakeGithub struct {
	mu  sync.Mutex
	srv *httptest.Server
	// data by kind: issues, pulls, reviews, comments (key OWNER/REPO#N), checkRuns, statuses (OWNER/REPO@SHA), events (OWNER/REPO).
	data      map[string]map[string]any
	failSha   map[string]bool
	remaining int
	reset     int64
	// force makes every request answer this status, with a body that echoes the request's headers (what a careless proxy does).
	force int
	// forceOn makes the requests whose path contains it answer 403.
	forceOn string
	// forceOnStatus is the status forceOn answers; 403 when 0.
	forceOnStatus int
	// etagFixed is the ETag every 200 carries, when set.
	etagFixed string
	// forceMsg is the message the forceOn answer carries; "forced" when empty.
	forceMsg string
	// inms is the if-none-match header of each request, in order ("" for none).
	inms []string
	// retryAfter is sent as the retry-after header on forced answers, when set.
	retryAfter string
	// failPage2 makes page 2 of the repository events answer 500.
	failPage2   bool
	pageSize    int
	calls       []string
	notModified int
	auths       []string
}

func newFake(t *testing.T) *fakeGithub {
	f := &fakeGithub{data: map[string]map[string]any{}, failSha: map[string]bool{}, remaining: 5000, reset: 4102444800, pageSize: 100}
	for _, k := range []string{"issues", "pulls", "reviews", "comments", "checkRuns", "statuses", "events"} {
		f.data[k] = map[string]any{}
	}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeGithub) url() string { return f.srv.URL }

func (f *fakeGithub) set(kind, key string, v any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.data[kind][key] = v
}

// patch merges fields into an object already set.
func (f *fakeGithub) patch(kind, key string, fields map[string]any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	cur, _ := f.data[kind][key].(map[string]any)
	next := map[string]any{}
	for k, v := range cur {
		next[k] = v
	}
	for k, v := range fields {
		next[k] = v
	}
	f.data[kind][key] = next
}

func (f *fakeGithub) callList() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string{}, f.calls...)
}

func (f *fakeGithub) clearCalls() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = nil
}

func (f *fakeGithub) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, r.Method+" "+r.URL.RequestURI())
	f.auths = append(f.auths, r.Header.Get("authorization"))
	f.inms = append(f.inms, r.Header.Get("if-none-match"))
	send := func(status int, body any, h map[string]string) {
		w.Header().Set("content-type", "application/json")
		w.Header().Set("x-ratelimit-remaining", strconv.Itoa(f.remaining))
		w.Header().Set("x-ratelimit-reset", strconv.FormatInt(f.reset, 10))
		for k, v := range h {
			w.Header().Set(k, v)
		}
		w.WriteHeader(status)
		if body != nil {
			_ = json.NewEncoder(w).Encode(body)
		}
	}
	if f.force != 0 {
		send(f.force, map[string]any{"message": "forced", "echo": r.Header.Get("authorization") + " " + r.URL.String()}, nil)
		return
	}
	if f.forceOn != "" && strings.Contains(r.URL.Path, f.forceOn) {
		st := f.forceOnStatus
		if st == 0 {
			st = 403
		}
		h := map[string]string{}
		if f.retryAfter != "" {
			h["retry-after"] = f.retryAfter
		}
		msg := f.forceMsg
		if msg == "" {
			msg = "forced"
		}
		send(st, map[string]any{"message": msg}, h)
		return
	}
	if f.failPage2 && r.URL.Query().Get("page") == "2" {
		send(500, map[string]any{"message": "page 2"}, nil)
		return
	}
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	body, ok := f.route(r, parts)
	if !ok {
		send(404, map[string]any{"message": "Not Found"}, nil)
		return
	}
	h := map[string]string{}
	if parts[len(parts)-1] == "events" {
		list, _ := body.([]any)
		size := min(f.pageSize, 100)
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		if page < 1 {
			page = 1
		}
		if page*size < len(list) {
			h["link"] = fmt.Sprintf("<%s%s?page=%d>; rel=\"next\"", f.srv.URL, r.URL.Path, page+1)
		}
		lo, hi := min((page-1)*size, len(list)), min(page*size, len(list))
		body = list[lo:hi]
	}
	b, _ := json.Marshal(body)
	sum := sha1.Sum(b)
	tag := "W/\"" + hex.EncodeToString(sum[:]) + "\""
	if f.etagFixed != "" {
		tag = f.etagFixed
	}
	h["etag"] = tag
	if r.Header.Get("if-none-match") == tag {
		f.notModified++
		send(304, nil, h)
		return
	}
	send(200, body, h)
}

func (f *fakeGithub) route(r *http.Request, parts []string) (any, bool) {
	if len(parts) < 4 || parts[0] != "repos" {
		return nil, false
	}
	owner, repo, rest := parts[1], parts[2], parts[3:]
	rk := owner + "/" + repo
	key := func(n string) string { return rk + "#" + n }
	switch {
	case len(rest) == 1 && rest[0] == "events":
		if v, ok := f.data["events"][rk]; ok {
			return v, true
		}
		return []any{}, true
	case rest[0] == "issues" && len(rest) == 3 && rest[2] == "comments":
		list, _ := f.data["comments"][key(rest[1])].([]any)
		since := r.URL.Query().Get("since")
		out := []any{}
		for _, c := range list {
			m, _ := c.(map[string]any)
			t, _ := m["updated_at"].(string)
			if t == "" {
				t, _ = m["created_at"].(string)
			}
			if since == "" || t > since {
				out = append(out, c)
			}
		}
		return out, true
	case rest[0] == "issues" && len(rest) == 2:
		v, ok := f.data["issues"][key(rest[1])]
		return v, ok
	case rest[0] == "pulls" && len(rest) == 3 && rest[2] == "reviews":
		if v, ok := f.data["reviews"][key(rest[1])]; ok {
			return v, true
		}
		return []any{}, true
	case rest[0] == "pulls" && len(rest) == 2:
		v, ok := f.data["pulls"][key(rest[1])]
		return v, ok
	case rest[0] == "commits" && len(rest) == 3:
		sk := rk + "@" + rest[1]
		if f.failSha[sk] || (f.failSha[sk+"/status"] && rest[2] == "status") {
			return nil, false
		}
		if rest[2] == "check-runs" {
			l, _ := f.data["checkRuns"][sk].([]any)
			if l == nil {
				l = []any{}
			}
			return map[string]any{"total_count": len(l), "check_runs": l}, true
		}
		if v, ok := f.data["statuses"][sk]; ok {
			return v, true
		}
		return map[string]any{"state": "pending", "statuses": []any{}}, true
	}
	return nil, false
}

// seedOpenPR makes PR o/r#1 open on head, with one run in progress.
func (f *fakeGithub) seedOpenPR(head string) {
	f.set("issues", "o/r#1", map[string]any{"number": 1, "title": "PR one", "state": "open", "html_url": "https://github.com/o/r/pull/1", "user": map[string]any{"login": "octocat"}, "pull_request": map[string]any{"url": "x"}, "updated_at": "2026-10-13T10:00:00Z"})
	f.set("pulls", "o/r#1", map[string]any{"number": 1, "title": "PR one", "state": "open", "merged": false, "draft": false, "html_url": "https://github.com/o/r/pull/1", "user": map[string]any{"login": "octocat"}, "head": map[string]any{"sha": head, "ref": "feature"}, "base": map[string]any{"ref": "main"}})
	f.set("checkRuns", "o/r@"+head, []any{map[string]any{"name": "build", "status": "in_progress", "conclusion": nil}})
	f.set("statuses", "o/r@"+head, map[string]any{"state": "pending", "statuses": []any{}})
}

func jsonOf(v any) string {
	return jsjsonStringify(v)
}
