// Package fieldsline prints ITSA field values as one line, as src/itsa-fields-line.ts does. The MCP tools and the
// CLI both print it, so a fields change reads the same in each (S-2786).
package fieldsline

import (
	"strings"

	"stam/internal/jsfmt"
)

// Line is src/itsa-fields-line.ts fieldsLine: `key=value` pairs, with a value that is an object as JSON and a null
// one as (none). Empty when the ITSA holds none.
func Line(f jsfmt.Value, ok bool) string {
	if !ok || f.Kind != jsfmt.Object {
		return ""
	}
	var parts []string
	seen := map[string]bool{}
	for _, k := range f.Keys {
		if seen[k] {
			continue
		}
		seen[k] = true
		v, _ := f.Get(k)
		val := "(none)"
		switch v.Kind {
		case jsfmt.Null:
		case jsfmt.String:
			val = v.Str
		default:
			val = jsfmt.Compact(v)
		}
		parts = append(parts, k+"="+val)
	}
	return strings.Join(parts, " ")
}

// Change is src/itsa-fields-line.ts fieldsChange: `fields: a=1 -> a=2` from a change's {from, to} maps.
func Change(c jsfmt.Value) string {
	from, fok := c.Get("from")
	to, tok := c.Get("to")
	return "fields: " + Line(from, fok) + " -> " + Line(to, tok)
}
