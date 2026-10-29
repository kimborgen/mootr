package server

import (
	"errors"
	"testing"

	"stam/internal/jsfmt"
)

// The itsa.changed payload leaves the fields key out when the field read fails, so the web keeps the card's fields and only
// status and owner change (web/src/store.ts). A clean read sends the fields, empty when the ITSA has none (S-3233).
func TestItsaChangedPayloadLeavesFieldsOutOnReadError(t *testing.T) {
	x := jsfmt.Value{Kind: jsfmt.Object}
	x.Set("id", jsfmt.StringValue("i1"))
	x.Set("key", jsfmt.StringValue("S-1"))
	x.Set("status", jsfmt.StringValue("done"))
	x.Set("owner", jsfmt.StringValue("a1"))

	failed := itsaChangedPayload(x, nil, errors.New("the kinds of field scope are not a list"))
	if _, ok := failed.Get("fields"); ok {
		t.Errorf("a read error sent fields: %v", failed)
	}
	if failed.Text("status") != "done" || failed.Text("owner") != "a1" || failed.Text("id") != "i1" {
		t.Errorf("a read error dropped the status or owner: %v", failed)
	}

	scope := jsfmt.Value{Kind: jsfmt.Object}
	scope.Set("scope", jsfmt.StringValue("core"))
	values := map[string]jsfmt.Value{"i1": scope}
	ok := itsaChangedPayload(x, values, nil)
	if f, has := ok.Get("fields"); !has || f.Kind != jsfmt.Object {
		t.Errorf("a clean read sent no fields: %v", ok)
	}
	if empty := itsaChangedPayload(x, map[string]jsfmt.Value{}, nil); !hasEmptyFields(empty) {
		t.Errorf("an ITSA with no fields sent %v, want an empty fields object", empty)
	}
}

func hasEmptyFields(ev jsfmt.Value) bool {
	f, ok := ev.Get("fields")
	return ok && f.Kind == jsfmt.Object && len(f.Keys) == 0
}
