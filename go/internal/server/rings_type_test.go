package server

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"stam/internal/jsfmt"
)

// ringTypeFixture is ringSpawnFixture with ring reviewer types of Claude members: rring is a ring of rv-a (a reviewer type)
// and tester (not one) with a tester moderator and rv-a as its fallback, and rnofb the same members with no moderator or
// fallback; rbad's second member runs on codex, which this daemon refuses, so it never starts, and rbad-nofb is rbad with
// no fallback.
func ringTypeFixture(t *testing.T) *fixture {
	f := ringSpawnFixture(t)
	for name, body := range map[string]string{
		"rv-a":   `{"description":"A","harness":"claude","model":"claude-haiku-5-5","brief":"R: {{task}}","review":{"fallback":null,"ring":null}}`,
		"rv-cdx": `{"description":"C","harness":"codex","model":"gpt-6.1-sol","review":{"fallback":null,"ring":null}}`,
	} {
		if rec := f.human("POST", "/api/types/"+name, body); rec.Code != 200 {
			t.Fatalf("the %s type: %d %s", name, rec.Code, rec.Body)
		}
	}
	for name, body := range map[string]string{
		"rring":     `{"description":"R","harness":"","brief":"Topic: {{task}} by {{parent}}","review":{"fallback":"rv-a","ring":{"format":"rounds","members":["rv-a","tester"],"moderator":{"type":"tester","decides":true},"maxRounds":2}}}`,
		"rbad":      `{"description":"B","harness":"","review":{"fallback":"rv-a","ring":{"format":"fire","members":["rv-a","rv-cdx"],"moderator":null,"maxRounds":1}}}`,
		"rbad-nofb": `{"description":"N","harness":"","review":{"fallback":null,"ring":{"format":"fire","members":["rv-a","rv-cdx"],"moderator":null,"maxRounds":1}}}`,
		"rnofb":     `{"description":"F","harness":"","review":{"fallback":null,"ring":{"format":"rounds","members":["rv-a","tester"],"moderator":null,"maxRounds":1}}}`,
	} {
		if rec := f.human("POST", "/api/types/"+name, body); rec.Code != 200 {
			t.Fatalf("the %s type: %d %s", name, rec.Code, rec.Body)
		}
	}
	return f
}

// A ring reviewer type spawns a ring: its members and moderator are the type's, named NAME-1, NAME-2 and NAME-mod, as
// the creator's children; the topic is the type's brief; every member and the moderator join the spawn's ITSA as
// participants, the owner unchanged, whatever their type; the fallback is recorded from the spawn-time request.
func TestRingTypeSpawnsARing(t *testing.T) {
	f := ringTypeFixture(t)
	key := f.createItsa(`{"title":"the pr","owner":"boss"}`)
	rec := f.spawn(bossTok, `"name":"pr","by":"aboss","type":"rring","prompt":"check it","itsa":"`+key+`","brief_vars":{"x":1}`)
	if rec.Code != 200 {
		t.Fatalf("the ring: %d %s", rec.Code, rec.Body)
	}
	v, _ := jsfmt.Parse(rec.Body.Bytes())
	if v.Text("kind") != "ring" || v.Text("name") != "pr" || v.Text("topic") != "Topic: check it by boss" || v.Text("created_by") != "aboss" || v.Text("cwd") != f.home {
		t.Errorf("the reply: %s", rec.Body)
	}
	if r, _ := v.Get("ring"); jsfmt.Compact(r) != `{"id":"`+v.Text("id")+`","name":"pr","format":"rounds","max_rounds":2}` {
		t.Errorf("its ring: %s", jsfmt.Compact(r))
	}
	id := func(n string) string { return f.agentField(n, "id") }
	m, _ := v.Get("members")
	if want := `[{"id":"` + id("pr-1") + `","name":"pr-1","type":"rv-a"},{"id":"` + id("pr-2") + `","name":"pr-2","type":"tester"}]`; jsfmt.Compact(m) != want {
		t.Errorf("members %s, want %s", jsfmt.Compact(m), want)
	}
	if mod, _ := v.Get("moderator"); mod.Text("name") != "pr-mod" || mod.Text("type") != "tester" {
		t.Errorf("moderator %s", jsfmt.Compact(mod))
	}
	if got := f.text("SELECT moderator_decides FROM rings WHERE name = 'pr'"); got != "1" {
		t.Errorf("moderator_decides %s", got)
	}
	for _, n := range []string{"pr-1", "pr-2", "pr-mod"} {
		if got := f.agentField(n, "parent_id"); got != "aboss" {
			t.Errorf("%s's parent %q", n, got)
		}
		if !strings.Contains(f.participants(key), id(n)) {
			t.Errorf("%s isn't a participant of %s: %s", n, key, f.participants(key))
		}
	}
	if owner := f.text("SELECT owner FROM itsas WHERE key = ?", key); owner != "aboss" {
		t.Errorf("the ITSA's owner became %s", owner)
	}
	// The fallback: on the first member, the request without its identity, name or type, with the ring's cwd.
	var ev struct {
		Ring, Type string
		Body       map[string]any
	}
	data := f.text("SELECT data FROM events WHERE type = 'ring:fallback' AND agent_id = ?", id("pr-1"))
	must(t, json.Unmarshal([]byte(data), &ev))
	if ev.Ring != v.Text("id") || ev.Type != "rv-a" || ev.Body["cwd"] != f.home || ev.Body["prompt"] != "check it" || ev.Body["itsa"] != key {
		t.Errorf("the fallback event: %s", data)
	}
	for _, k := range []string{"by", "name", "type", "self", "from"} {
		if _, ok := ev.Body[k]; ok {
			t.Errorf("the fallback body keeps %s: %s", k, data)
		}
	}
}

// The ring type's refusals: no prompt is no topic; a taken name; no creator. None leaves an agent behind.
func TestRingTypeRefusals(t *testing.T) {
	f := ringTypeFixture(t)
	f.sql("UPDATE agents SET name = 'taken' WHERE id = 'achild'")
	for _, tc := range []struct {
		token, fields, want string
		code                int
	}{
		{bossTok, `"name":"np","by":"aboss","type":"rring"`, "rring is a ring: give a prompt, the topic of the review", 400},
		{bossTok, `"name":"taken","by":"aboss","type":"rring","prompt":"p"`, "name taken is taken", 409},
		{bossTok, `"name":"Bad","by":"aboss","type":"rring","prompt":"p"`, "name must be lowercase letters, digits, and dashes", 400},
		{sharedTok, `"name":"nc","type":"rring","prompt":"p"`, "a ring needs a creator", 403},
		{bossTok, `"name":"hm","by":"aboss","type":"rring","prompt":"p","model":"claude-haiku-5-5"`, "a ring reviewer type takes no harness, model, or preset", 400},
	} {
		rec := f.spawn(tc.token, tc.fields)
		if rec.Code != tc.code || !strings.Contains(rec.Body.String(), tc.want) {
			t.Errorf("%s: %d %s, want %d %q", tc.fields, rec.Code, rec.Body, tc.code, tc.want)
		}
	}
	if n := f.count("SELECT COUNT(*) FROM agents WHERE name GLOB 'np*' OR name GLOB 'nc*' OR name GLOB 'hm*' OR name GLOB 'taken-*'"); n != 0 {
		t.Errorf("%d agents left by refused ring spawns", n)
	}
	if n := f.count("SELECT COUNT(*) FROM rings"); n != 0 {
		t.Errorf("%d rings stored", n)
	}
}

// A ring that can't start runs its type's fallback reviewer under the ring's name, with the same request and a warning
// saying why; the members spawned for it are archived. With no fallback the spawn is refused with the ring's status.
func TestRingTypeFallsBack(t *testing.T) {
	f := ringTypeFixture(t)
	rec := f.spawn(bossTok, `"name":"fb","by":"aboss","type":"rbad","prompt":"check it"`)
	if rec.Code != 200 {
		t.Fatalf("the fallback: %d %s", rec.Code, rec.Body)
	}
	v, _ := jsfmt.Parse(rec.Body.Bytes())
	want := "ring rbad didn't start (spawn: codex is not ported to the Go daemon yet), so fb is a single rv-a reviewer (type rv-a) with the same task"
	if v.Text("name") != "fb" || v.Text("type") != "rv-a" || v.Text("parent_id") != "aboss" || v.Text("warning") != want {
		t.Errorf("the fallback reviewer: %s", rec.Body)
	}
	if _, ok := v.Get("view"); !ok {
		t.Errorf("no view: %s", rec.Body)
	}
	if got := f.agentField("fb", "first_prompt"); got != "R: check it" {
		t.Errorf("its brief %q", got)
	}
	if got := f.agentField("fb-1", "lifecycle"); got != "archived" {
		t.Errorf("fb-1 is %q, not archived", got)
	}
	rec = f.spawn(bossTok, `"name":"nf","by":"aboss","type":"rbad-nofb","prompt":"check it"`)
	if want := "can't start ring nf: spawn: codex is not ported to the Go daemon yet. rbad-nofb has no fallback reviewer type."; rec.Code != 501 || !strings.Contains(rec.Body.String(), want) {
		t.Errorf("no fallback: %d %s", rec.Code, rec.Body)
	}
	if got := f.agentField("nf-1", "lifecycle"); got != "archived" {
		t.Errorf("nf-1 is %q, not archived", got)
	}
	if n := f.count("SELECT COUNT(*) FROM rings"); n != 0 {
		t.Errorf("%d rings stored", n)
	}
}

// The human's ring and the assistant's are the human's: created by human, with top-level members. A member's
// itsa_participant is no permission: a caller who may not change the ITSA is refused before any member exists.
func TestRingTypeCreators(t *testing.T) {
	f := ringTypeFixture(t)
	if rec := f.human("POST", "/api/agents", `{"name":"hu","type":"rnofb","prompt":"p","cwd":"`+f.home+`"}`); rec.Code != 200 {
		t.Fatalf("the human's ring: %d %s", rec.Code, rec.Body)
	}
	f.sql("UPDATE agents SET kind = 'assistant' WHERE id = 'achild'")
	if rec := f.spawn(agentTok, `"name":"as","by":"achild","type":"rnofb","prompt":"p"`); rec.Code != 200 {
		t.Fatalf("the assistant's ring: %d %s", rec.Code, rec.Body)
	}
	for _, n := range []string{"hu", "as"} {
		if got := f.text("SELECT created_by FROM rings WHERE name = ?", n); got != "human" {
			t.Errorf("ring %s's creator %q", n, got)
		}
		if got := f.agentField(n+"-1", "parent_id"); got != "" {
			t.Errorf("%s-1's parent %q", n, got)
		}
	}
	f.sql("UPDATE agents SET kind = NULL WHERE id = 'achild'")
	other := f.createItsa(`{"title":"not yours","owner":"human"}`)
	rec := f.spawn(agentTok, `"name":"ip","by":"achild","type":"rnofb","prompt":"p","itsa":"`+other+`"`)
	if rec.Code != 403 || !strings.Contains(rec.Body.String(), "child can't change "+other) {
		t.Errorf("a ring on an ITSA the caller may not change: %d %s", rec.Code, rec.Body)
	}
	if n := f.count("SELECT COUNT(*) FROM agents WHERE name GLOB 'ip*' AND lifecycle != 'archived'"); n != 0 {
		t.Errorf("%d agents left by the refused ring", n)
	}
	if id, got := f.agentField("ip-1", "id"), f.participants(other); id != "" && strings.Contains(got, id) {
		t.Errorf("the refused ring's member joined %s: %s", other, got)
	}
}

// A caller that hangs up mid-ring doesn't strand the members already spawned: the ring that then fails still discards them.
func TestRingTypeOutlivesItsCaller(t *testing.T) {
	f := ringTypeFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f.srv.devSlots.beforeStore = func(name string) error {
		switch name {
		case "cx-1":
			cancel()
		case "cx-2":
			return errors.New("the store failed")
		}
		return nil
	}
	rec := f.do(call{method: "POST", path: "/api/agents", token: bossTok, ctx: ctx, body: `{"cwd":"` + f.home + `","name":"cx","by":"aboss","type":"rnofb","prompt":"p"}`})
	f.srv.devSlots.beforeStore = nil
	if rec.Code == 200 {
		t.Fatalf("the ring started: %s", rec.Body)
	}
	for _, n := range []string{"cx-1", "cx-2"} {
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
}
