package process

import (
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"stam/internal/jsfmt"
)

// The fixture api/fixtures/process-validate is what src/process-validate.ts answers (scripts/fixtures-lib.mjs): every case is
// the same here, in the key order of the reply too.
func TestParseTextMatchesFixture(t *testing.T) {
	raw, err := os.ReadFile("../../../api/fixtures/process-validate/cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Cases []struct {
			Name  string
			Input struct {
				Yaml          string
				File          string
				KnownTypes    []string
				HasTypes      bool
				KnownStatuses []string
			}
			ErrorPrefix string
			Output      json.RawMessage
		}
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	// knownTypes is absent in some cases: decode the raw input to tell absent from empty.
	var rawCases struct {
		Cases []struct {
			Input map[string]json.RawMessage
		}
	}
	if err := json.Unmarshal(raw, &rawCases); err != nil {
		t.Fatal(err)
	}
	for i, c := range f.Cases {
		t.Run(c.Name, func(t *testing.T) {
			opts := ParseOptions{File: c.Input.File, KnownStatuses: map[string]bool{}}
			for _, s := range c.Input.KnownStatuses {
				opts.KnownStatuses[s] = true
			}
			if _, has := rawCases.Cases[i].Input["knownTypes"]; has {
				opts.KnownTypes = map[string]bool{}
				for _, s := range c.Input.KnownTypes {
					opts.KnownTypes[s] = true
				}
			}
			def, errs := ParseText(c.Input.Yaml, opts)
			out := jsfmt.Value{Kind: jsfmt.Object}
			if def != nil {
				out.Set("process", def.Value())
			}
			list := make([]jsfmt.Value, len(errs))
			for i, e := range errs {
				if c.ErrorPrefix != "" && strings.HasPrefix(e, c.ErrorPrefix) {
					e = c.ErrorPrefix
				}
				list[i] = jsfmt.StringValue(e)
			}
			out.Set("errors", jsfmt.ArrayValue(list))
			want, err := jsfmt.Parse(c.Output)
			if err != nil {
				t.Fatal(err)
			}
			if got, w := jsfmt.Compact(out), jsfmt.Compact(want); got != w {
				t.Errorf("\n got %s\nwant %s", got, w)
			}
		})
	}
}

// A file built to make the reader slow or deep is read in a bounded time and never crashes it: a map that holds itself many
// times (no alias count `yaml` stops), a list that holds itself, and a long chain of lists that hold the one before.
func TestParseTextBoundedWork(t *testing.T) {
	var self strings.Builder
	self.WriteString("process: tiny\nm: &m\n")
	for i := 0; i < 20000; i++ {
		self.WriteString("  k" + strconv.Itoa(i) + ": *m\n")
	}
	var chain strings.Builder
	chain.WriteString("process: tiny\nx0: &a0 [x]\n")
	for i := 1; i < 3000; i++ {
		chain.WriteString("x" + strconv.Itoa(i) + ": &a" + strconv.Itoa(i) + " [*a" + strconv.Itoa(i-1) + "]\n")
	}
	for name, text := range map[string]string{"self": self.String(), "chain": chain.String(), "list": "process: tiny\nl: &l [*l, *l, *l]\nkind: *l\n"} {
		done := make(chan struct{})
		go func() {
			defer close(done)
			ParseText(text, ParseOptions{File: "processes/tiny.yaml"})
		}()
		select {
		case <-done:
		case <-time.After(20 * time.Second):
			t.Fatalf("%s: still reading after 20 s", name)
		}
	}
}
