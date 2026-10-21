package steps

import (
	"context"
	"math"
	"strconv"
	"strings"
	"sync"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"

	"stam/internal/jsfmt"
	"stam/internal/jsjson"
)

type example struct {
	subject
	summary string
}

// rows runs a query and gives each row to fn.
func (s *Store) rows(ctx context.Context, query string, args []any, fn func(stmt *sqlite.Stmt)) error {
	return s.DB.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, query, &sqlitex.ExecOptions{Args: args, ResultFunc: func(stmt *sqlite.Stmt) error { fn(stmt); return nil }})
	})
}

func optText(stmt *sqlite.Stmt, i int) jsjson.Value {
	if stmt.ColumnIsNull(i) {
		return nil
	}
	return stmt.ColumnText(i)
}

// argsLine is a tool call's arguments on one line for the preview, as `key: value` pairs; `self` is left out.
func argsLine(args jsjson.Value) string {
	var parts []string
	add := func(k string, v jsjson.Value) {
		if k == "self" {
			return
		}
		text, isStr := v.(string)
		if !isStr {
			text = jsjson.Stringify(v, "")
		}
		parts = append(parts, k+": "+text)
	}
	switch x := args.(type) {
	case *jsjson.Object:
		for _, k := range x.Keys() {
			v, _ := x.Get(k)
			add(k, v)
		}
	case []any:
		// Object.entries of an array: its indexes.
		for i, v := range x {
			add(strconv.Itoa(i), v)
		}
	}
	line := collapse(strings.Join(parts, " · "))
	// The cut counts runes, where JavaScript counts UTF-16 units: the two differ only for text beyond the BMP.
	if r := []rune(line); len(r) > 160 {
		return string(r[:159]) + "…"
	}
	if line == "" {
		return "(no arguments)"
	}
	return line
}

// collapse is .replace(/\s+/g, ' ').
func collapse(s string) string {
	var b strings.Builder
	space := false
	for _, r := range s {
		if jsjson.IsSpace(r) {
			if !space {
				b.WriteByte(' ')
			}
			space = true
			continue
		}
		space = false
		b.WriteRune(r)
	}
	return b.String()
}

// examples is the last n real examples of a trigger, newest first, as subjects.
func (s *Store) examples(ctx context.Context, st Step, n int) ([]example, string, error) {
	var out []example
	if st.Kind == "tool" {
		var err error
		err = s.rows(ctx, "SELECT ts, agent, args FROM tool_calls WHERE tool = ? ORDER BY id DESC LIMIT ?", []any{st.Tool, n}, func(stmt *sqlite.Stmt) {
			payload, perr := jsjson.Parse([]byte(stmt.ColumnText(2)))
			if perr != nil {
				payload = jsjson.NewObject("truncated", stmt.ColumnText(2))
			}
			// An array is an object to JavaScript and stays one.
			switch payload.(type) {
			case *jsjson.Object, []any:
			default:
				payload = jsjson.NewObject("value", payload)
			}
			actor := s.ActorOf(ctx, stmt.ColumnText(1))
			out = append(out, example{subject{"tool:" + st.Tool, payload, actor}, actor.Name + ": " + argsLine(payload)})
		})
		if err != nil {
			return nil, "", err
		}
		if len(out) == 0 {
			return nil, "stam has no recorded calls of " + st.Tool + " yet", nil
		}
		return out, "", nil
	}
	return nil, "", errEventPreview
}

type eventPreview struct{}

func (eventPreview) Error() string {
	return "previewing a step on an event is not ported to the Go daemon yet"
}

var errEventPreview error = eventPreview{}

// IsNotPorted is whether err says the step is on an event whose examples are not ported.
func IsNotPorted(err error) bool { _, ok := err.(eventPreview); return ok }

// Preview runs the step's question on the last n examples of its trigger. It takes no action and writes no log; the cost is
// recorded as `decide:step:<id>:preview`. The examples of an event trigger are not ported (the event hooks are not).
func (s *Store) Preview(ctx context.Context, id string, n float64) (jsfmt.Value, error) {
	st, err := s.Must(ctx, id)
	if err != nil {
		return jsfmt.Value{}, err
	}
	// Math.floor(Number(n)) || 5: a count that floors to 0 or is NaN is the default.
	fl := math.Floor(n)
	if math.IsNaN(fl) || fl == 0 {
		fl = 5
	}
	count := int(math.Max(1, math.Min(previewMax, fl)))
	examples, note, err := s.examples(ctx, st, count)
	if err != nil {
		return jsfmt.Value{}, err
	}
	results := make([]jsfmt.Value, len(examples))
	var wg sync.WaitGroup
	for i, ex := range examples {
		wg.Add(1)
		go func() {
			defer wg.Done()
			p, e := s.ask(ctx, st, stateFor(st, ex.subject), "decide:step:"+st.ID+":preview", 0)
			if e != "" {
				results[i] = obj("subject", str(ex.ref), "summary", str(ex.summary), "p", jsfmt.NullValue(), "answer", jsfmt.NullValue(), "error", str(e))
				return
			}
			results[i] = obj("subject", str(ex.ref), "summary", str(ex.summary), "p", num(p), "answer", boolean(p >= st.Threshold))
		}()
	}
	wg.Wait()
	out := obj("examples", jsfmt.ArrayValue(results))
	if results == nil {
		out = obj("examples", jsfmt.Value{Kind: jsfmt.Array})
	}
	if note != "" {
		out.Keys, out.Items = append(out.Keys, "note"), append(out.Items, str(note))
	}
	return out, nil
}
