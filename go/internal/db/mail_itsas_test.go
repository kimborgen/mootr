package db

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"reflect"
	"testing"
)

// The keys a text names are the ones src/itsa-keys.ts namedKeys finds: outside fenced blocks and code spans, whole words
// only, each once, in order.
func TestNamedKeysMatchTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to run src/itsa-keys.ts")
	}
	inputs := []string{
		"",
		"S-1",
		"see S-12, S-3 and S-12 again",
		"TEAM-S-7 and a-b-c-9 and X1-2",
		"S-1x S-1-2 S_1 xS-1 -S-1 S-1_ S-1- S--1 S-",
		"S-1\nS-2\n",
		"`S-1` S-2 `` S-3 `` ``S-4`` `S-5",
		"```\nS-1\n```\nS-2",
		"text\n```js\nS-1\n```\nS-2\n~~~\nS-3\n~~~\nS-4",
		"```\nS-1 never closed\nS-2",
		"  ```\n  S-1\n  ```\nS-2",
		"a ``` S-1 ``` b S-2",
		"````\nS-1\n````\nS-2",
		"```\nS-1\n~~~\nS-2\n```\nS-3",
		"\n```\nS-1\n```\nS-2",
		"```\n```\nS-1",
		"`a``b` S-1 `c",
		"é S-1 é, ünï-S-2, S-3é",
		"S-1 S-2\tS-3\r\nS-4",
		"(S-1) [S-2] {S-3} <S-4> \"S-5\" 'S-6' S-7. S-8!",
		"ab-12 Ab-Cd-345 a1-b2-3 1a-2",
		"```\n",
		"~~~ S-1\nS-2\n~~~ x\nS-3",
	}
	payload, _ := json.Marshal(inputs)
	cmd := exec.Command("node", "--no-warnings", "testdata/keys.mjs")
	cmd.Stdin = bytes.NewReader(payload)
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		t.Fatalf("keys.mjs: %v", err)
	}
	var want [][]string
	if err := json.Unmarshal(out.Bytes(), &want); err != nil {
		t.Fatal(err)
	}
	for i, in := range inputs {
		got := NamedKeys(in)
		if len(got) == 0 && len(want[i]) == 0 {
			continue
		}
		if !reflect.DeepEqual(got, want[i]) {
			t.Errorf("%q: go %v, ts %v", in, got, want[i])
		}
	}
}
