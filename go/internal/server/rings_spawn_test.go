package server

import (
	"context"
	"errors"
	"strings"
	"testing"

	"stam/internal/jsfmt"
)

// ringSpawnFixture can spawn: the tester type (a brief with no next steps) and the ringer type (one with them).
func ringSpawnFixture(t *testing.T) *fixture {
	f := typeSpawnFixture(t)
	if rec := f.human("POST", "/api/types/ringer", `{"description":"Reviews in rings.","harness":"claude","model":"claude-haiku-5-5","brief":"T={{task}} N={{next_steps}} V={{extra}}"}`); rec.Code != 200 {
		t.Fatalf("the ringer type: %d %s", rec.Code, rec.Body)
	}
	return f
}

func (f *fixture) ringStart(token, body string) (int, jsfmt.Value) {
	f.t.Helper()
	h := human
	if token != sharedTok {
		h = nil
	}
	rec := f.sendH("POST", "/api/rings", token, h, body)
	v, _ := jsfmt.Parse(rec.Body.Bytes())
	return rec.Code, v
}

func (f *fixture) agentField(name, col string) string {
	f.t.Helper()
	return f.text("SELECT COALESCE("+col+", '') FROM agents WHERE name = ?", name)
}

// A ring spawns its members as NAME-1, NAME-2, ... and its moderator as NAME-mod, each as the ring's creator asked: the
// creator is their parent, a `by` inside an entry is ignored, and the role names the ring. A type with a brief gets the
// ring's topic as its task and the ring's next steps.
func TestRingSpawnsItsMembers(t *testing.T) {
	f := ringSpawnFixture(t)
	code, v := f.ringStart(bossTok, `{"by":"aboss","name":"sp","topic":"pick a db","format":"fire","cwd":"`+f.home+`",`+
		`"spawn":[{"model":"claude-haiku-5-5","by":"achild","self":"achild","parent":"achild"},{"type":"ringer","brief_vars":{"extra":"x"}}],`+
		`"moderator":{"type":"tester","prompt":"moderate it"},"moderator_decides":true}`)
	if code != 200 || v.Text("name") != "sp" {
		t.Fatalf("the ring: %d %s", code, jsfmt.Compact(v))
	}
	for name, role := range map[string]string{"sp-1": "Member of ring sp: pick a db", "sp-2": "Member of ring sp: pick a db", "sp-mod": "Moderator of ring sp: pick a db"} {
		if got := f.agentField(name, "role"); got != role {
			t.Errorf("%s role %q", name, got)
		}
		if got := f.agentField(name, "parent_id"); got != "aboss" {
			t.Errorf("%s's parent is %q, not the ring's creator", name, got)
		}
		if got := f.agentField(name, "lifecycle"); got != "active" {
			t.Errorf("%s is %s", name, got)
		}
	}
	steps := "You are the member of ring sp, so don't post a verdict with `pr_review`"
	if got := f.agentField("sp-2", "first_prompt"); !strings.HasPrefix(got, "T=pick a db N="+steps) || !strings.HasSuffix(got, "V=x") {
		t.Errorf("sp-2's brief: %q", got)
	}
	// An entry's own prompt is its task; a brief without next steps gets none.
	if got := f.agentField("sp-mod", "first_prompt"); !strings.HasPrefix(got, "Do: moderate it | parent=boss") {
		t.Errorf("sp-mod's brief: %q", got)
	}
	if got := f.agentField("sp-1", "first_prompt"); got != "" {
		t.Errorf("sp-1, with no type, got a prompt: %q", got)
	}
	members := f.text("SELECT members FROM rings WHERE name = 'sp'")
	for _, n := range []string{"sp-1", "sp-2"} {
		if !strings.Contains(members, f.text("SELECT id FROM agents WHERE name = ?", n)) {
			t.Errorf("%s isn't a member: %s", n, members)
		}
	}
	if got := f.text("SELECT moderator_id FROM rings WHERE name = 'sp'"); got != f.text("SELECT id FROM agents WHERE name = 'sp-mod'") {
		t.Errorf("the moderator is %q", got)
	}
	// The human's ring spawns top-level agents.
	if code, v := f.ringStart(sharedTok, `{"name":"hu","topic":"t","cwd":"`+f.home+`","spawn":[{"model":"claude-haiku-5-5"},{"model":"claude-haiku-5-5"}]}`); code != 200 {
		t.Fatalf("the human's ring: %d %s", code, jsfmt.Compact(v))
	}
	if got := f.agentField("hu-1", "parent_id"); got != "" {
		t.Errorf("the human's member has parent %q", got)
	}
}

// A ring that can't start leaves nothing running: the agents spawned for it are stopped and archived, a failed spawn's
// own row too, and no ring is stored. A name already taken is refused before anything is spawned, and that agent stays
// as it was.
func TestRingStartFailureDiscardsItsSpawns(t *testing.T) {
	f := ringSpawnFixture(t)
	for _, tc := range []struct {
		name, body, msg string
		code            int
		spawned         []string
	}{
		{"a bad format", `"format":"round","spawn":[{"model":"claude-haiku-5-5"},{"model":"claude-haiku-5-5"}]`, "format must be rounds, fire, or debate", 400, []string{"bf-1", "bf-2"}},
		{"a member that can't spawn", `"spawn":[{"model":"claude-haiku-5-5"},{"type":"nosuch"}]`, "no agent type nosuch", 400, []string{"bf-1"}},
		{"a moderator that can't spawn", `"spawn":[{"model":"claude-haiku-5-5"},{"model":"claude-haiku-5-5"}],"moderator":{"harness":"codex"}`, "codex is not ported", 501, []string{"bf-1", "bf-2"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f.sql("DELETE FROM agents WHERE name LIKE 'bf-%'")
			code, v := f.ringStart(sharedTok, `{"name":"bf","topic":"t","cwd":"`+f.home+`",`+tc.body+`}`)
			if code != tc.code || !strings.Contains(v.Text("error"), tc.msg) {
				t.Fatalf("%d %s", code, jsfmt.Compact(v))
			}
			for _, n := range tc.spawned {
				if got := f.agentField(n, "lifecycle"); got != "archived" {
					t.Errorf("%s is %q, not archived", n, got)
				}
			}
			if n := f.count("SELECT COUNT(*) FROM agents WHERE name LIKE 'bf-%' AND lifecycle != 'archived'"); n != 0 {
				t.Errorf("%d agents left running", n)
			}
		})
	}
	if n := f.count("SELECT COUNT(*) FROM rings"); n != 0 {
		t.Errorf("%d rings stored", n)
	}
	// A spawn that fails after its row exists leaves that row behind: it is discarded too, by the id the spawn made.
	f.srv.devSlots.beforeStore = func(name string) error {
		if name == "bs-2" {
			return errors.New("the store failed")
		}
		return nil
	}
	code, v := f.ringStart(sharedTok, `{"name":"bs","topic":"t","cwd":"`+f.home+`","spawn":[{"model":"claude-haiku-5-5"},{"model":"claude-haiku-5-5"}]}`)
	f.srv.devSlots.beforeStore = nil
	if code != 500 || v.Text("error") != "the store failed" {
		t.Fatalf("a spawn failing after its row: %d %s", code, jsfmt.Compact(v))
	}
	for _, n := range []string{"bs-1", "bs-2"} {
		if got := f.agentField(n, "lifecycle"); got != "archived" {
			t.Errorf("%s is %q, not archived", n, got)
		}
		if f.srv.life.HasSession(context.Background(), f.agentField(n, "id")) {
			t.Errorf("%s's session still runs", n)
		}
	}
	if n := f.count("SELECT COUNT(*) FROM rings"); n != 0 {
		t.Errorf("%d rings stored", n)
	}
	f.sql("UPDATE agents SET name = 'tk-2' WHERE id = 'achild'")
	before := f.agentField("tk-2", "lifecycle")
	code, v = f.ringStart(sharedTok, `{"name":"tk","topic":"t","cwd":"`+f.home+`","spawn":[{"model":"claude-haiku-5-5"},{"model":"claude-haiku-5-5"}]}`)
	if code != 409 || v.Text("error") != "name tk-2 is taken" {
		t.Fatalf("a taken name: %d %s", code, jsfmt.Compact(v))
	}
	if got := f.agentField("tk-2", "lifecycle"); got != before {
		t.Errorf("the agent holding the name went from %s to %s", before, got)
	}
	if got := f.agentField("tk-1", "lifecycle"); got != "archived" {
		t.Errorf("tk-1, spawned before the taken name, is %q", got)
	}
}
