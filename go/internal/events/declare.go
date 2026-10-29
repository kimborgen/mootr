package events

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"time"

	"stam/internal/db"
	"stam/internal/jsjson"
)

// Value is the filter as the object sanitizeFilter builds, its keys in order, for a wait's data.
func (f Filter) Value() *jsjson.Object {
	o := jsjson.NewObject()
	strs := func(l []string) []any {
		out := make([]any, len(l))
		for i, s := range l {
			out[i] = s
		}
		return out
	}
	if f.Source != "" {
		o.Set("source", f.Source)
	}
	for _, p := range []struct {
		k string
		v []string
	}{{"subjects", f.Subjects}, {"types", f.Types}, {"actors", f.Actors}, {"exclude_actors", f.ExcludeActors}, {"ends_on", f.EndsOn}} {
		if len(p.v) > 0 {
			o.Set(p.k, strs(p.v))
		}
	}
	if f.Since != "" {
		o.Set("since", f.Since)
	}
	return o
}

// dedupeKey is src/waits.ts dedupeKey: the filter as a key, its lists sorted (their order doesn't change what matches)
// and `since` left out, since it moves on each wake.
func dedupeKey(f Filter) string {
	f.Since = ""
	sorted := func(l []string) []string {
		out := append([]string(nil), l...)
		sort.Strings(out)
		return out
	}
	f.Subjects, f.Types, f.Actors, f.ExcludeActors = sorted(f.Subjects), sorted(f.Types), sorted(f.Actors), sorted(f.ExcludeActors)
	return f.JSON()
}

// parseTime is Date.parse for the ISO forms a source or an agent stamps.
func parseTime(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04Z07:00", "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// laterSince is src/waits.ts laterSince: the stored filter after a re-declare, the later `since` of the two, so a
// `since` that moves each wake keeps the newest.
func laterSince(stored, next Filter) Filter {
	if next.Since == "" {
		return stored
	}
	if stored.Since != "" {
		a, okA := parseTime(stored.Since)
		b, okB := parseTime(next.Since)
		if okA && okB && !a.Before(b) {
			return stored
		}
	}
	stored.Since = next.Since
	return stored
}

// Declare is a wait_for on an external event (src/waits.ts declare, on 'event').
type Declare struct {
	Filter Filter
	Note   string
	// Timeout and Expect are minutes, nil for none.
	Timeout, Expect *float64
}

func iso(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

func minutesFrom(t time.Time, n float64) string {
	return iso(t.Add(time.Duration(n * float64(time.Minute))))
}

// DeclareWait declares an event wait: it clears on the first event its filter fits. Without a selector it would clear on
// any event, so a re-declared one piled up (S-2317) and the declare is refused. The check for the same wait and the
// insert are one transaction, so two identical declares can't both insert; the rows are the database's, so a restart
// keeps the dedupe.
func (s *Service) DeclareWait(ctx context.Context, agentID string, d Declare) (db.Wait, error) {
	if !d.Filter.HasSelector() {
		return db.Wait{}, &ErrInvalid{"wait_for on 'event' needs a filter: pass source, subjects, types or actors, so the wait clears on the events you mean"}
	}
	now := s.o.Now()
	var until *string
	if d.Timeout != nil {
		u := minutesFrom(now, *d.Timeout)
		until = &u
	}
	var out db.Wait
	err := s.o.DB.InEventWaitTx(ctx, func(tx db.EventWaitTx) error {
		ws, err := tx.Waits(agentID)
		if err != nil {
			return err
		}
		for _, w := range ws {
			if w.Kind != "event" || w.Source != "declared" || w.Data == nil {
				continue
			}
			stored, _ := jsjson.Parse([]byte(*w.Data))
			so, _ := stored.(*jsjson.Object)
			if so == nil {
				continue
			}
			fv, _ := so.Get("filter")
			if fv == nil || dedupeKey(Sanitize(fv)) != dedupeKey(d.Filter) {
				continue
			}
			// The same wait again: keep it, take the later `since` of the two filters, and take the new timeout or
			// expectation if one is given.
			so.Set("filter", laterSince(Sanitize(fv), d.Filter).Value())
			if d.Timeout != nil {
				so.Set("timeout_minutes", *d.Timeout)
			}
			if d.Expect != nil {
				so.Set("expect_at", minutesFrom(now, *d.Expect))
			}
			keep := w.Until
			if d.Timeout != nil {
				keep = until
			}
			out, err = tx.SetTiming(w.ID, keep, jsjson.Stringify(so, ""))
			return err
		}
		detail := d.Note
		if detail == "" {
			detail = "an external event (" + d.Filter.Describe() + ")"
		}
		data := jsjson.NewObject("on", "event", "filter", d.Filter.Value())
		if d.Timeout != nil {
			data.Set("timeout_minutes", *d.Timeout)
		}
		if d.Expect != nil {
			data.Set("expect_at", minutesFrom(now, *d.Expect))
		}
		text := jsjson.Stringify(data, "")
		out, err = tx.Add(db.NewWait{AgentID: agentID, Kind: "event", Source: "declared", Detail: &detail, Until: until, Data: &text})
		if err != nil {
			return err
		}
		ev := jsjson.NewObject("id", out.ID, "kind", "event", "filter", d.Filter.Value())
		if d.Timeout != nil {
			ev.Set("timeout_minutes", *d.Timeout)
		} else {
			ev.Set("timeout_minutes", nil)
		}
		return tx.AddEvent(agentID, "wait:declared", json.RawMessage(jsjson.Stringify(ev, "")))
	})
	return out, err
}
