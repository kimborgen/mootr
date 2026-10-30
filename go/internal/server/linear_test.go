package server

import (
	"strings"
	"testing"
)

// The dashboard's view of a polled Linear issue (S-65, S-4331): the fields of its snapshot and when the row was stored; a
// subject nothing polled has no time.
func TestWatchStateRouteShowsLinearIssues(t *testing.T) {
	f, _ := eventsFixture(t)
	f.sql("INSERT INTO watch_state (subject, state, etags, updated_at) VALUES ('linear:ENG-1', ?, '{}', '2026-10-28T10:00:00.000Z')",
		`{"id":"ENG-1","title":"Fix login","url":"https://linear.app/a/issue/ENG-1","state":"In Progress","assignee":"Dana","priority":"High","updatedAt":"x","createdAt":null,"commentIds":["c1"]}`)
	f.sql("INSERT INTO watch_state (subject, state, etags, updated_at) VALUES ('github:o/r#1', ?, '{}', '2026-10-28T10:00:00.000Z')", `{"type":"issue","state":"open","title":"I","url":"iu"}`)
	rec := f.post2("GET", "/api/watch/state?subject=linear:ENG-1&subject=linear:ENG-2&subject=github:o/r%231", "")
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	want := `{"github:o/r#1":{"state":"open","title":"I","url":"iu","updated_at":"2026-10-28T10:00:00.000Z"},` +
		`"linear:ENG-1":{"state":"In Progress","assignee":"Dana","priority":"High","title":"Fix login","url":"https://linear.app/a/issue/ENG-1","updated_at":"2026-10-28T10:00:00.000Z"},` +
		`"linear:ENG-2":{"updated_at":null}}`
	if got := strings.TrimSpace(rec.Body.String()); got != want {
		t.Errorf("\n got  %s\n want %s", got, want)
	}
}
