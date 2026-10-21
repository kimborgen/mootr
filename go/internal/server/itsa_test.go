package server

import (
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"stam/internal/jsfmt"
)

// maskedKeys are the members that hold an id a run draws: an ITSA's or a field's.
var maskedKeys = map[string]bool{"id": true, "itsa_id": true, "parent_id": true, "field_id": true}

// maskedItsa hides what differs between two runs: the values of the id members (numbered in the order they appear, also
// inside an event's data) and the times. Words that only look like an id stay as they are.
func maskedItsa(s string) string {
	v, err := jsfmt.Parse([]byte(s))
	if err != nil {
		return reStamp.ReplaceAllString(s, "T")
	}
	ids := map[string]string{}
	var walk func(v jsfmt.Value, key string) jsfmt.Value
	walk = func(v jsfmt.Value, key string) jsfmt.Value {
		switch v.Kind {
		case jsfmt.String:
			if maskedKeys[key] {
				if _, ok := ids[v.Str]; !ok {
					ids[v.Str] = "I" + strconv.Itoa(len(ids))
				}
				return jsfmt.StringValue(ids[v.Str])
			}
			if key == "data" || key == "data:parent" {
				if inner, err := jsfmt.Parse([]byte(v.Str)); err == nil {
					return jsfmt.StringValue(jsfmt.Compact(walk(inner, strings.TrimPrefix(key, "data:"))))
				}
			}
		case jsfmt.Array:
			out := make([]jsfmt.Value, len(v.Items))
			for i, it := range v.Items {
				out[i] = walk(it, key)
			}
			return jsfmt.ArrayValue(out)
		case jsfmt.Object:
			out := jsfmt.Value{Kind: jsfmt.Object}
			for i, k := range v.Keys {
				child := k
				switch {
				// A parent change holds ITSA ids in its from and to; an event of type parent holds it in its data.
				case key == "parent" && (k == "from" || k == "to"):
					child = "id"
				case k == "data" && v.Text("type") == "parent":
					child = "data:parent"
				}
				out.Keys, out.Items = append(out.Keys, k), append(out.Items, walk(v.Items[i], child))
			}
			return out
		}
		return v
	}
	return reStamp.ReplaceAllString(jsfmt.Compact(walk(v, "")), "T")
}

// TestItsaMatchesTS runs the steps of testdata/itsa-steps.json through src/itsa.ts (create, set, get, list) on one database
// and through the routes on a copy of it, and compares every answer, status and error, and the tables the steps leave behind.
func TestItsaMatchesTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to run src/itsa.ts")
	}
	home := filepath.Join(t.TempDir(), "home")
	must(t, os.Mkdir(home, 0o700))
	if out, err := exec.Command("node", "--no-warnings", "testdata/itsaref.mjs", home).CombinedOutput(); err != nil {
		t.Fatalf("itsaref.mjs: %v\n%s", err, out)
	}
	raw, err := os.ReadFile(filepath.Join(home, "expect.json"))
	must(t, err)
	want, err := jsfmt.Parse(raw)
	must(t, err)

	f := newFixtureFrom(t, nil, filepath.Join(home, "stam.pre.db"))
	writeFile(t, filepath.Join(f.home, "settings.json"), `{"itsa":{"repos":{"r1":"/tmp"},"ownerNotices":"off"}}`)
	stepsRaw, err := os.ReadFile("testdata/itsa-steps.json")
	must(t, err)
	var steps []struct {
		Op     string
		Input  json.RawMessage
		Ref    string
		Fields json.RawMessage
		By     *string
		Query  map[string]string
		Link   json.RawMessage
		Rec    json.RawMessage
		N      int
		Patch  json.RawMessage
		Order  json.RawMessage
		SQL    string
	}
	must(t, json.Unmarshal(stepsRaw, &steps))
	var ids []string
	sub := func(s string) string {
		if len(s) > 1 && s[0] == '#' {
			if n, err := strconv.Atoi(s[1:]); err == nil && n < len(ids) && ids[n] != "" {
				return ids[n]
			}
		}
		return s
	}
	// subJSON replaces a "#n" string anywhere in a JSON document.
	subJSON := func(raw json.RawMessage) string {
		return regexp.MustCompile(`"#(\d+)"`).ReplaceAllStringFunc(string(raw), func(m string) string {
			n, _ := strconv.Atoi(m[2 : len(m)-1])
			if n < len(ids) && ids[n] != "" {
				return `"` + ids[n] + `"`
			}
			return m
		})
	}
	wantResults, _ := want.Get("results")
	for i, st := range steps {
		var rec *httptest.ResponseRecorder
		switch st.Op {
		case "create":
			rec = f.post2("POST", "/api/itsas", subJSON(st.Input))
		case "set":
			body := jsfmt.Value{Kind: jsfmt.Object}
			by := "human"
			if st.By != nil {
				by = *st.By
			}
			fields, perr := jsfmt.Parse([]byte(subJSON(st.Fields)))
			must(t, perr)
			body = fields
			body.Set("by", jsfmt.StringValue(by))
			rec = f.post2("PATCH", "/api/itsas/"+sub(st.Ref), jsfmt.Compact(body))
		case "link", "record", "unlink":
			body, perr := jsfmt.Parse([]byte(subJSON(append(json.RawMessage(nil), orEmpty(st.Link, st.Rec)...))))
			must(t, perr)
			by := "human"
			if st.By != nil {
				by = *st.By
			}
			body.Set("by", jsfmt.StringValue(by))
			method, path := "POST", "/api/itsas/"+sub(st.Ref)+"/links"
			if st.Op == "record" {
				method, path = "PATCH", path+"/"+strconv.Itoa(st.N)
			} else if st.Op == "unlink" {
				method, path = "DELETE", path+"/"+strconv.Itoa(st.N)
			}
			rec = f.post2(method, path, jsfmt.Compact(body))
		case "fields", "deffield", "editfield", "rmfield", "order":
			body := jsfmt.Value{Kind: jsfmt.Object}
			var perr error
			switch st.Op {
			case "deffield":
				body, perr = jsfmt.Parse([]byte(subJSON(st.Input)))
			case "editfield":
				body, perr = jsfmt.Parse([]byte(subJSON(st.Patch)))
			case "order":
				var order jsfmt.Value
				order, perr = jsfmt.Parse([]byte(orEmptyList(st.Order)))
				body.Set("order", order)
			}
			must(t, perr)
			by := "human"
			if st.By != nil {
				by = *st.By
			}
			body.Set("by", jsfmt.StringValue(by))
			method, path := "POST", "/api/itsas/fields"
			switch st.Op {
			case "fields":
				method, body = "GET", jsfmt.Value{}
			case "editfield":
				method, path = "PATCH", path+"/"+st.Ref
			case "rmfield":
				method, path = "DELETE", path+"/"+st.Ref
			case "order":
				path += "/order"
			}
			payload := jsfmt.Compact(body)
			if st.Op == "fields" {
				payload = ""
			}
			rec = f.post2(method, path, payload)
		case "sql":
			// A soft leave: no route sets it on this daemon (the setters are TS's), so the step is the row it leaves.
			f.sql(st.SQL)
			ids = append(ids, "")
			continue
		case "get":
			rec = f.post2("GET", "/api/itsas/"+sub(st.Ref), "")
		default:
			q := url.Values{}
			for k, v := range st.Query {
				q.Set(k, sub(v))
			}
			rec = f.post2("GET", "/api/itsas?"+q.Encode(), "")
		}
		exp := wantResults.Items[i]
		if code := int(mustInt(t, exp, "status")); rec.Code != code {
			t.Errorf("step %d (%s): status %d, TS %d\n go: %s\n ts: %s", i, st.Op, rec.Code, code, rec.Body.String(), jsfmt.Compact(exp))
			ids = append(ids, "")
			continue
		}
		got, perr := jsfmt.Parse(rec.Body.Bytes())
		must(t, perr)
		var wantBody jsfmt.Value
		if e, ok := exp.Get("error"); ok {
			wantBody = jsfmt.Value{Kind: jsfmt.Object}
			wantBody.Set("error", e)
		} else {
			wantBody, _ = exp.Get("result")
		}
		if g, w := maskedItsa(jsfmt.Compact(got)), maskedItsa(jsfmt.Compact(wantBody)); g != w {
			t.Errorf("step %d (%s %s):\n go: %s\n ts: %s", i, st.Op, st.Ref, g, w)
		}
		id := ""
		if st.Op == "create" && rec.Code == 200 {
			id = got.Text("id")
		}
		ids = append(ids, id)
	}

	wantTables, _ := want.Get("tables")
	for _, tc := range []struct{ name, query string }{
		{"itsas", "SELECT * FROM itsas ORDER BY rowid"},
		{"participants", "SELECT itsa_id, agent_id, left_at FROM itsa_participants ORDER BY rowid"},
		{"events", "SELECT itsa_id, actor, type, data FROM itsa_events ORDER BY id"},
		{"counter", "SELECT name, value FROM itsa_counter"},
		{"links", "SELECT * FROM itsa_links ORDER BY rowid"},
		{"fields", "SELECT * FROM itsa_fields ORDER BY position, created_at"},
		{"values", "SELECT itsa_id, field_id, value, updated_by FROM itsa_field_values ORDER BY rowid"},
	} {
		w, _ := wantTables.Get(tc.name)
		if g, e := maskedItsa(jsfmt.Compact(dump(t, f, tc.query))), maskedItsa(jsfmt.Compact(w)); g != e {
			t.Errorf("table %s:\n go: %s\n ts: %s", tc.name, g, e)
		}
	}
}

func mustInt(t *testing.T, v jsfmt.Value, key string) int64 {
	t.Helper()
	x, _ := v.Get(key)
	n, err := strconv.ParseInt(x.Num, 10, 64)
	must(t, err)
	return n
}

// post2 sends a request as the human with the shared token.
func (f *fixture) post2(method, path, body string) *httptest.ResponseRecorder {
	f.t.Helper()
	return f.sendH(method, path, sharedTok, human, body)
}

// orEmptyList is the JSON a step's order carries: a missing order is the empty list, null stays null.
func orEmptyList(raw json.RawMessage) string {
	if len(raw) == 0 {
		return "null"
	}
	return string(raw)
}

// orEmpty is the raw JSON a step carries: a link, a record, or an empty object.
func orEmpty(parts ...json.RawMessage) json.RawMessage {
	for _, p := range parts {
		if len(p) > 0 {
			return p
		}
	}
	return json.RawMessage(`{}`)
}
