package jsfmt

import "testing"

func mustParse(t *testing.T, s string) Value {
	t.Helper()
	v, err := Parse([]byte(s))
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// The expected texts were printed by Node's util.inspect and JSON.stringify.
func TestInspect(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"health with a release", `{"ok":true,"machine":"m","release":"abc","memory":{"heapUsed":1,"heapTotal":2,"rss":3,"external":0},"stalls":[]}`,
			"{\n  ok: true,\n  machine: 'm',\n  release: 'abc',\n  memory: { heapUsed: 1, heapTotal: 2, rss: 3, external: 0 },\n  stalls: []\n}"},
		{"short object", `{"ok":true,"machine":"m"}`, "{ ok: true, machine: 'm' }"},
		{"wide nested object", `{"ok":true,"machine":"test-machine","memory":{"rss":12345678,"heapTotal":23456789,"heapUsed":3456789,"external":0,"arrayBuffers":0},"stalls":[{"at":"2026-10-20T00:00:00.000Z","label":"x","ms":3}]}`,
			"{\n  ok: true,\n  machine: 'test-machine',\n  memory: {\n    rss: 12345678,\n    heapTotal: 23456789,\n    heapUsed: 3456789,\n    external: 0,\n    arrayBuffers: 0\n  },\n  stalls: [ { at: '2026-10-20T00:00:00.000Z', label: 'x', ms: 3 } ]\n}"},
		{"quoted key and string", `{"a-b":"it's","s":"x\ny"}`, `{ 'a-b': "it's", s: 'x\ny' }`},
	}
	for _, c := range cases {
		if got := Inspect(mustParse(t, c.in)); got != c.want {
			t.Errorf("%s:\n got %q\nwant %q", c.name, got, c.want)
		}
	}
}

func TestStringify(t *testing.T) {
	in := `{"id":"a1","empty":[],"none":{},"n":[1,2.5,null,true],"s":"quo\"te \\ \u0001 é <&>","o":{"k":"v"}}`
	want := "{\n  \"id\": \"a1\",\n  \"empty\": [],\n  \"none\": {},\n  \"n\": [\n    1,\n    2.5,\n    null,\n    true\n  ],\n  \"s\": \"quo\\\"te \\\\ \\u0001 é <&>\",\n  \"o\": {\n    \"k\": \"v\"\n  }\n}"
	if got := Stringify(mustParse(t, in)); got != want {
		t.Errorf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestParseRejectsTrailingData(t *testing.T) {
	if _, err := Parse([]byte(`{} {}`)); err == nil {
		t.Fatal("two documents parsed")
	}
	if _, err := Parse([]byte(`{"a":`)); err == nil {
		t.Fatal("truncated JSON parsed")
	}
}

func TestMembers(t *testing.T) {
	v := mustParse(t, `{"a":"x","a":"y","n":0,"z":null}`)
	if v.Text("a") != "y" {
		t.Errorf("a = %q: the last duplicate wins", v.Text("a"))
	}
	if n, _ := v.Get("n"); n.Truthy() {
		t.Error("0 is truthy")
	}
	if v.Text("z") != "" || v.Text("missing") != "" {
		t.Error("null and missing members aren't empty text")
	}
}

// The expected texts are what JSON.stringify prints for the numbers these literals parse to.
func TestNumbers(t *testing.T) {
	for in, want := range map[string]string{
		"1.50": "1.5", "1e2": "100", "-0": "0", "0.0": "0", "12345678901234567890": "12345678901234567000",
		"1e21": "1e+21", "1.5e-7": "1.5e-7", "0.000001": "0.000001", "-2.50E+1": "-25", "100": "100",
	} {
		if got := Stringify(mustParse(t, in)); got != want {
			t.Errorf("%s: %s, want %s", in, got, want)
		}
	}
	if got := Inspect(mustParse(t, "-0")); got != "-0" {
		t.Errorf("inspect -0: %s", got)
	}
}
