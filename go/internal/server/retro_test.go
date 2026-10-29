package server

import (
	"strings"
	"testing"
)

// TestPlusOnes: GET /api/itsas/:id/plus-ones counts the `+1 from` and `Reported again by` comments alone. On the open
// board (a retro item) any agent reads the count; elsewhere only those who may read the threads, and an unknown ITSA is
// a 404.
func TestPlusOnes(t *testing.T) {
	f := newFixture(t, nil)
	board := f.createItsa(`{"title":"Idle pane","kind":"retro","by":"human"}`)
	other := f.createItsa(`{"title":"Private","kind":"issue","owner":"aboss","by":"human"}`)
	for _, key := range []string{board, other} {
		for _, body := range []string{"+1 from dev: me too", "Reported again by a2:\n\nagain", "plain comment", "a +1 from dev"} {
			if rec := f.post2("POST", "/api/itsas/"+key+"/post", `{"body":"`+strings.ReplaceAll(body, "\n", `\n`)+`","by":"human"}`); rec.Code != 200 {
				t.Fatalf("post on %s: %d %s", key, rec.Code, rec.Body)
			}
		}
	}
	if rec := f.send("GET", "/api/itsas/"+board+"/plus-ones", agentTok, ""); rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != `{"count":2}` {
		t.Errorf("an agent on the open board: %d %s", rec.Code, rec.Body)
	}
	if rec := f.send("GET", "/api/itsas/"+other+"/plus-ones", agentTok, ""); rec.Code != 403 {
		t.Errorf("an agent outside the ITSA: %d %s", rec.Code, rec.Body)
	}
	if rec := f.post2("GET", "/api/itsas/"+other+"/plus-ones", ""); rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != `{"count":2}` {
		t.Errorf("the human: %d %s", rec.Code, rec.Body)
	}
	if rec := f.post2("GET", "/api/itsas/S-99999/plus-ones", ""); rec.Code != 404 {
		t.Errorf("an unknown ITSA: %d %s", rec.Code, rec.Body)
	}
	if rec := f.post2("GET", "/api/itsas/"+f.createItsa(`{"title":"Quiet","kind":"retro","by":"human"}`)+"/plus-ones", ""); strings.TrimSpace(rec.Body.String()) != `{"count":0}` {
		t.Errorf("no thread yet: %d %s", rec.Code, rec.Body)
	}
}
