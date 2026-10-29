package server

import (
	"context"
	"strings"
	"testing"
)

// A spawn may name a parent on another machine (spawn_peer.go): the daemon "here" has only achild, and far, a Go daemon,
// has aboss (boss). A parent nobody has, or one that may sit on a peer that does not answer, refuses the spawn before any
// agent exists.
func TestSpawnParentOnAPeer(t *testing.T) {
	_, ps := farDaemon(t)
	f := relayFixture(t, ps.ts.URL, "", nil)
	withLifeRootTmux(f, "../../..", sessionTmux(t))
	ctx := context.Background()
	count := func() int {
		t.Helper()
		list, err := f.db.ListAgents(ctx)
		must(t, err)
		return len(list)
	}

	for _, ref := range []string{"boss", "aboss"} {
		id, _ := f.spawned(sharedTok, `"name":"kid-`+ref+`","parent":"`+ref+`"`)
		a, err := f.db.GetAgent(ctx, id)
		must(t, err)
		if a.ParentID == nil || *a.ParentID != "aboss" {
			t.Errorf("parent %s: parent_id %v, want aboss", ref, a.ParentID)
		}
	}

	before := count()
	if rec := f.spawn(sharedTok, `"name":"orphan","parent":"nosuch"`); rec.Code != 404 || !strings.Contains(rec.Body.String(), "no agent nosuch") {
		t.Errorf("a parent nobody has: %d %s", rec.Code, rec.Body.String())
	}
	// A peer that doesn't answer may hold the parent: refused as unreachable, never spawned without its parent.
	ps.ts.Close()
	if rec := f.spawn(sharedTok, `"name":"orphan2","parent":"nosuch"`); rec.Code != 503 || !strings.Contains(rec.Body.String(), "unreachable") {
		t.Errorf("a parent on a peer that is down: %d %s", rec.Code, rec.Body.String())
	}
	if n := count(); n != before {
		t.Errorf("a refused spawn left an agent: %d agents, want %d", n, before)
	}
}
