package server

import (
	"fmt"
	"sort"
	"strings"

	"stam/internal/db"
	"stam/internal/jsjson"
)

// Agent types for filtering (src/agent-class.ts, S-1491, S-3807): the registry `type` of an agent, which Usage and Agents
// filter by, so a cost or time number can leave out the chief of staff or show only developers.

// roleTypes is src/agent-class.ts ROLE_TYPES: agents without a registry type (or with one the registry no longer has) are
// named by their role; the rest are `untyped`.
var roleTypes = []string{"chief-of-staff", "assistant", "intake", "untyped"}

// agentRegistry is the registry's agent types: their names in the registry's order, and which are reviewer types.
type agentRegistry struct {
	names  []string
	has    map[string]bool
	review map[string]bool
}

// agentRegistry reads the registry's types; a server without templates (a test) has none.
func (s *Server) agentRegistry() (agentRegistry, error) {
	r := agentRegistry{has: map[string]bool{}, review: map[string]bool{}}
	if s.tpl == nil {
		return r, nil
	}
	types, names, err := s.tpl.TypesInOrder()
	if err != nil {
		return r, err
	}
	r.names = names
	for name, t := range types {
		r.has[name], r.review[name] = true, t.Review
	}
	return r, nil
}

// typeOf is src/agent-class.ts typeOf. cos is settings().chiefOfStaff, the configured id or name: the chief of staff is
// its own type whatever its registry type.
func (r agentRegistry) typeOf(a db.Agent, cos string) string {
	switch {
	case cos != "" && (a.ID == cos || a.Name == cos):
		return "chief-of-staff"
	case a.Type != nil && *a.Type != "" && r.has[*a.Type]:
		return *a.Type
	case a.Kind != nil && *a.Kind == "assistant":
		return "assistant"
	case a.Name == "intake" && (a.Type == nil || *a.Type == ""):
		return "intake"
	}
	return "untyped"
}

// knownTypes is every name `agents=` takes: the registry's types and the role names.
func (r agentRegistry) knownTypes() []string {
	out := append([]string(nil), r.names...)
	for _, t := range roleTypes {
		if !r.has[t] {
			out = append(out, t)
		}
	}
	return out
}

// legacyClass is src/agent-class.ts LEGACY_CLASS: the coarse classes the filter took before S-1491.
var legacyClass = []string{"cos", "assistant", "intake", "manager", "developer", "reviewer", "advisor", "other"}

func (r agentRegistry) legacyClassTypes(c string) []string {
	var reviewers []string
	for _, n := range r.names {
		if r.review[n] {
			reviewers = append(reviewers, n)
		}
	}
	switch c {
	case "cos":
		return []string{"chief-of-staff"}
	case "assistant", "intake", "developer", "advisor":
		return []string{c}
	case "manager":
		return []string{"manager", "coordinator"}
	case "reviewer":
		return reviewers
	}
	named := map[string]bool{"manager": true, "coordinator": true, "developer": true, "advisor": true}
	for _, n := range reviewers {
		named[n] = true
	}
	out := []string{"untyped"}
	for _, n := range r.names {
		if !named[n] {
			out = append(out, n)
		}
	}
	return out
}

// typeSet is a JavaScript Set of type names: insertion order, each once.
type typeSet struct {
	order []string
	has   map[string]bool
}

func newTypeSet(xs ...[]string) *typeSet {
	s := &typeSet{has: map[string]bool{}}
	for _, x := range xs {
		s.add(x...)
	}
	return s
}

func (s *typeSet) add(xs ...string) {
	for _, x := range xs {
		if !s.has[x] {
			s.has[x], s.order = true, append(s.order, x)
		}
	}
}

func (s *typeSet) remove(x string) {
	if !s.has[x] {
		return
	}
	delete(s.has, x)
	for i, y := range s.order {
		if y == x {
			s.order = append(s.order[:i], s.order[i+1:]...)
			return
		}
	}
}

// sorted is [...keep].sort().
func (s *typeSet) sorted() []string {
	out := append([]string(nil), s.order...)
	sort.Strings(out)
	return out
}

func (r agentRegistry) legacyAll() []string {
	s := newTypeSet()
	for _, c := range legacyClass {
		s.add(r.legacyClassTypes(c)...)
	}
	return s.order
}

func (r agentRegistry) legacyWork() []string {
	var out []string
	for _, t := range r.legacyAll() {
		if t != "chief-of-staff" && t != "assistant" && t != "intake" {
			out = append(out, t)
		}
	}
	return out
}

func (r agentRegistry) legacyPreset(v string) ([]string, bool) {
	switch v {
	case "work":
		return r.legacyWork(), true
	case "managers":
		return []string{"manager", "coordinator"}, true
	case "developers":
		return []string{"developer"}, true
	case "non-managers":
		var out []string
		for _, t := range r.legacyWork() {
			if t != "manager" && t != "coordinator" {
				out = append(out, t)
			}
		}
		return out, true
	}
	return nil, false
}

// parseAgentFilter is src/agent-class.ts parseAgentFilter: the types an `agents=` value keeps, a comma list of type
// names, or an older preset name or `+class,-class` list (mapped to its types). Nil for no filter (empty, `all`); an
// unknown name is an error the caller answers 400 with.
func (r agentRegistry) parseAgentFilter(raw string) (*typeSet, error) {
	v := strings.ToLower(jsjson.Trim(raw))
	if v == "" || v == "all" {
		return nil, nil
	}
	if p, ok := r.legacyPreset(v); ok {
		return newTypeSet(p), nil
	}
	bad := func() error {
		return fmt.Errorf("agents must be a comma list of agent types (%s), not %s", strings.Join(r.knownTypes(), ", "), raw)
	}
	var parts []string
	for _, p := range strings.Split(v, ",") {
		if p = jsjson.Trim(p); p != "" {
			parts = append(parts, p)
		}
	}
	signed := false
	for _, p := range parts {
		signed = signed || p[0] == '+' || p[0] == '-'
	}
	if signed {
		var plus, minus []string
		for _, p := range parts {
			sign, name := p[0], p[1:]
			known := false
			for _, c := range legacyClass {
				known = known || c == name
			}
			if (sign != '+' && sign != '-') || !known {
				return nil, bad()
			}
			if sign == '+' {
				plus = append(plus, r.legacyClassTypes(name)...)
			} else {
				minus = append(minus, r.legacyClassTypes(name)...)
			}
		}
		keep := newTypeSet(plus)
		if len(plus) == 0 {
			keep = newTypeSet(r.legacyAll())
		}
		for _, t := range minus {
			keep.remove(t)
		}
		return keep, nil
	}
	known := newTypeSet(r.knownTypes())
	for _, p := range parts {
		if !known.has[p] {
			return nil, bad()
		}
	}
	return newTypeSet(parts), nil
}

// filterKey is src/agent-class.ts filterKey: the filter as one stable string, the types kept sorted.
func filterKey(keep *typeSet) string {
	if keep == nil {
		return ""
	}
	if k := strings.Join(keep.sorted(), ","); k != "" {
		return k
	}
	return "none"
}
