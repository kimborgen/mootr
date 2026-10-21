package jsjson

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"testing"
)

// cases are JSON documents whose JSON.stringify(JSON.parse(doc), null, 2) node prints, for Parse and Stringify to match.
var cases = []string{
	`{}`,
	`[]`,
	`{"b":1,"a":[1,2,{"c":null}],"10":true,"2":false,"01":"x","4294967295":0,"4294967294":1}`,
	`{"a":1,"b":2,"a":3}`,
	`{"n":[0,-0,1.5,1e21,1e20,123456789012345678901,1e-6,1e-7,0.1,-2.5e-10,5e-324,1.7976931348623157e308,100,1.0]}`,
	`{"s":"quote \" back \\ nl \n tab \t cr \r bs \b ff \f ctl \u0001 \u001f del \u007f html <&> ls   ps   é 😀"}`,
	`{"nested":{"deep":{"deeper":[[],{},[{}]]}},"empty":"","t":true}`,
	`"top"`,
	`12`,
	`null`,
}

func TestStringifyMatchesNode(t *testing.T) {
	script := `const docs = JSON.parse(require('fs').readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(docs.map((d) => [JSON.stringify(JSON.parse(d), null, 2), JSON.stringify(JSON.parse(d))])));`
	in, _ := json.Marshal(cases)
	cmd := exec.Command("node", "-e", script)
	cmd.Stdin = bytes.NewReader(in)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("node: %v", err)
	}
	var want [][2]string
	if err := json.Unmarshal(out, &want); err != nil {
		t.Fatal(err)
	}
	for i, doc := range cases {
		v, err := Parse([]byte(doc))
		if err != nil {
			t.Fatalf("Parse(%s): %v", doc, err)
		}
		if got := Stringify(v, "  "); got != want[i][0] {
			t.Errorf("Stringify(%s, 2):\n got %s\nwant %s", doc, got, want[i][0])
		}
		if got := Stringify(v, ""); got != want[i][1] {
			t.Errorf("Stringify(%s):\n got %s\nwant %s", doc, got, want[i][1])
		}
	}
}

func TestTruthy(t *testing.T) {
	for _, c := range []struct {
		v    Value
		want bool
	}{{nil, false}, {false, false}, {0.0, false}, {"", false}, {"x", true}, {1.0, true}, {[]Value{}, true}, {NewObject(), true}} {
		if Truthy(c.v) != c.want {
			t.Errorf("Truthy(%#v) = %v", c.v, !c.want)
		}
	}
}

func TestParseRejectsTrailingData(t *testing.T) {
	if _, err := Parse([]byte(`{} {}`)); err == nil {
		t.Fatal("want an error for two documents")
	}
}
