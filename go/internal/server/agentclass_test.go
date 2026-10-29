package server

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"

	"stam/internal/db"
)

// agentClassRegistry adds a reviewer type and drops none, so the legacy classes have a reviewer and an `other` type.
const agentClassRegistry = `{"types":{"auditor":{"review":true},"scribe":{}}}`

// parseAgentFilter and typeOf answer as src/agent-class.ts does over the same registry: presets, the legacy +/- lists,
// type lists, and the unknown-name error with its list of known types.
func TestAgentClassMatchesTS(t *testing.T) {
	f := newFixture(t, nil)
	must(t, os.WriteFile(filepath.Join(f.home, "registry.json"), []byte(agentClassRegistry), 0o600))
	inputs := []string{"", "all", " Developer ", "developer,manager", "work", "non-managers", "managers", "developers", "+manager,-cos", "-cos",
		"+reviewer", "+other", "+bogus", "bogus,developer", "untyped,intake,chief-of-staff", "auditor", "manager,,", "*"}
	str := func(s string) *string { return &s }
	cases := []struct {
		Agent map[string]any `json:"agent"`
		Cos   *string        `json:"cos"`
		a     db.Agent
	}{
		{map[string]any{"id": "a1", "name": "boss", "type": "manager"}, str("boss"), db.Agent{ID: "a1", Name: "boss", Type: str("manager")}},
		{map[string]any{"id": "a2", "name": "dev", "type": "developer"}, str("a1"), db.Agent{ID: "a2", Name: "dev", Type: str("developer")}},
		{map[string]any{"id": "a3", "name": "x", "type": "gone"}, nil, db.Agent{ID: "a3", Name: "x", Type: str("gone")}},
		{map[string]any{"id": "a4", "name": "helper", "type": nil, "kind": "assistant"}, nil, db.Agent{ID: "a4", Name: "helper", Kind: str("assistant")}},
		{map[string]any{"id": "a5", "name": "intake", "type": nil}, nil, db.Agent{ID: "a5", Name: "intake"}},
		{map[string]any{"id": "a6", "name": "intake", "type": "developer"}, nil, db.Agent{ID: "a6", Name: "intake", Type: str("developer")}},
		{map[string]any{"id": "a7", "name": "plain", "type": nil}, str(""), db.Agent{ID: "a7", Name: "plain"}},
	}
	in, _ := json.Marshal(inputs)
	cs, _ := json.Marshal(cases)
	var stderr bytes.Buffer
	cmd := exec.Command("node", "--no-warnings", "testdata/agentclassref.mjs", agentClassRegistry, string(in), string(cs))
	cmd.Stderr = &stderr
	raw, err := cmd.Output()
	if err != nil {
		t.Fatalf("agentclassref.mjs: %v\n%s", err, stderr.String())
	}
	var want struct {
		Filters []*string `json:"filters"`
		Types   []string  `json:"types"`
	}
	must(t, json.Unmarshal(raw, &want))

	reg, err := f.srv.agentRegistry()
	must(t, err)
	for i, raw := range inputs {
		var got *string
		keep, err := reg.parseAgentFilter(raw)
		switch {
		case err != nil:
			got = str("error: " + err.Error())
		case keep != nil:
			got = str(filterKey(keep))
		}
		if !reflect.DeepEqual(got, want.Filters[i]) {
			t.Errorf("parseAgentFilter(%q) = %v, TS %v", raw, shown(got), shown(want.Filters[i]))
		}
	}
	for i, c := range cases {
		cos := ""
		if c.Cos != nil {
			cos = *c.Cos
		}
		if got := reg.typeOf(c.a, cos); got != want.Types[i] {
			t.Errorf("typeOf(%v) = %s, TS %s", c.Agent, got, want.Types[i])
		}
	}
}

// shown is a filter result for a message: its text, or <nil>.
func shown(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}
