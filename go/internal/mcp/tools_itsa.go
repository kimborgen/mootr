package mcp

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf16"

	"stam/internal/client"
	"stam/internal/fieldsline"
	"stam/internal/jsfmt"
)

// The ITSA tools of src/mcp.ts (S-2849): itsa_create, itsa_get, itsa_list, itsa_set, itsa_fields, itsa_link and itsa_post. They ask the
// daemon for what the TS tools ask, in the same order and with the same members, and say what they say.

func init() {
	tools = append(tools,
		tool{name: "itsa_create", listing: itsaListings["itsa_create"], run: itsaCreate},
		tool{name: "itsa_get", listing: itsaListings["itsa_get"], run: itsaGet},
		tool{name: "itsa_list", listing: itsaListings["itsa_list"], run: itsaList},
		tool{name: "itsa_set", listing: itsaListings["itsa_set"], run: itsaSet},
		tool{name: "itsa_fields", listing: itsaListings["itsa_fields"], run: itsaFields},
		tool{name: "itsa_link", listing: itsaListings["itsa_link"], run: itsaLink},
		tool{name: "itsa_post", listing: itsaListings["itsa_post"], run: itsaPost},
	)
}

// uriComponent is encodeURIComponent.
func uriComponent(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.IndexByte("-_.!~*'()", c) >= 0 {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// params is URLSearchParams: ordered, `set` replaces in place, and toString form-encodes.
type params struct{ keys, vals []string }

func (p *params) has(k string) bool {
	for _, x := range p.keys {
		if x == k {
			return true
		}
	}
	return false
}

func (p *params) set(k, v string) {
	for i, x := range p.keys {
		if x == k {
			p.vals[i] = v
			return
		}
	}
	p.keys, p.vals = append(p.keys, k), append(p.vals, v)
}

func (p params) clone() params {
	return params{append([]string(nil), p.keys...), append([]string(nil), p.vals...)}
}

func formComponent(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.IndexByte("*-._", c) >= 0:
			b.WriteByte(c)
		case c == ' ':
			b.WriteByte('+')
		default:
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func (p params) String() string {
	parts := make([]string, len(p.keys))
	for i, k := range p.keys {
		parts[i] = formComponent(k) + "=" + formComponent(p.vals[i])
	}
	return strings.Join(parts, "&")
}

// jsString is JS String(v).
func jsString(v jsfmt.Value) string {
	switch v.Kind {
	case jsfmt.Object:
		return "[object Object]"
	case jsfmt.Array:
		parts := make([]string, len(v.Items))
		for i, it := range v.Items {
			if it.Kind != jsfmt.Null {
				parts[i] = jsString(it)
			}
		}
		return strings.Join(parts, ",")
	}
	return str(v, true)
}

// itsaRef is src/mcp.ts itsaRef: the ITSA a tool acts on, from `name`, `ref`, `key` or `id`.
func itsaRef(a jsfmt.Value, name string) (string, error) {
	var ref jsfmt.Value
	for _, k := range []string{name, "ref", "key", "id"} {
		if v, ok := a.Get(k); ok && v.Kind != jsfmt.Null {
			ref = v
			break
		}
	}
	if ref.Kind != jsfmt.String || strings.TrimSpace(ref.Str) == "" {
		return "", errors.New("ref is required: an ITSA key like S-12 or its id")
	}
	return strings.TrimSpace(ref.Str), nil
}

// apiJSON asks the daemon and decodes the answer.
func (s *Server) apiJSON(ctx context.Context, method, path string, body any) (jsfmt.Value, error) {
	reply, err := s.api.Do(ctx, method, path, body, 0)
	if err != nil {
		return jsfmt.Value{}, err
	}
	v, err := jsfmt.Parse(reply)
	if err != nil {
		return jsfmt.Value{}, errors.New("the daemon's reply isn't JSON")
	}
	return v, nil
}

// namesOf is src/mcp.ts namesOf: owner and participant ids as names, as the calling agent sees the registry; an id that
// doesn't resolve stays an id. No ids to resolve, no request. It asks for only those ids, in any state (S-3816): the
// list's default is live agents only, and TS sends the ids in first-seen order, comma-joined.
func (s *Server) namesOf(ctx context.Context, self string, ids []jsfmt.Value) map[string]string {
	out := map[string]string{}
	want := map[string]bool{}
	type seenKey struct {
		kind jsfmt.Kind
		s    string
	}
	seen, order := map[seenKey]bool{}, []string{}
	for _, id := range ids {
		if !id.Truthy() || (id.Kind == jsfmt.String && id.Str == "human") {
			continue
		}
		if k := (seenKey{id.Kind, jsString(id)}); !seen[k] {
			seen[k] = true
			order = append(order, k.s)
		}
		if id.Kind == jsfmt.String {
			want[id.Str] = true
		}
	}
	if len(order) == 0 {
		return out
	}
	var q params
	q.set("as", self)
	q.set("ids", strings.Join(order, ","))
	list, err := s.apiJSON(ctx, "GET", "/api/agents?"+q.String(), nil)
	if err != nil || list.Kind != jsfmt.Array {
		return out
	}
	for _, a := range list.Items {
		if id := a.Text("id"); want[id] {
			out[id] = a.Text("name")
		}
	}
	return out
}

// nameOf is src/mcp.ts nameOf.
func nameOf(id jsfmt.Value, ok bool, m map[string]string) string {
	if !ok || !id.Truthy() {
		return "—"
	}
	if id.Kind == jsfmt.String {
		if id.Str == "human" {
			return "human"
		}
		if n, has := m[id.Str]; has {
			return n
		}
	}
	return str(id, true)
}

func rollupText(r jsfmt.Value) string {
	return fmt.Sprintf("backlog %s, ready %s, active %s, review %s, closed %s", member(r, "backlog"), member(r, "ready"), member(r, "active"), member(r, "review"), member(r, "closed"))
}

// titleWords is src/mcp.ts titleWords: a string's words, 0 for anything else.
func titleWords(v jsfmt.Value, ok bool) int {
	if !ok || v.Kind != jsfmt.String {
		return 0
	}
	return len(strings.Fields(v.Str))
}

// longTitleNote asks for a shorter title once one is past 4 words; nothing is refused.
func longTitleNote(key string, title jsfmt.Value, ok bool) string {
	n := titleWords(title, ok)
	if n <= 5 {
		return ""
	}
	return fmt.Sprintf("\n\nTitle is %d words; titles are 1-4 words, a noun phrase (`Phone mail header`). Shorten it with itsa_set ref=%s title=..., and move the detail to summary.", n, key)
}

// withMembers is {k: a[k]} for each k the arguments hold, in the order given: what JSON.stringify keeps of an object
// literal whose undefined members are dropped.
func withMembers(a jsfmt.Value, keys ...string) jsfmt.Value {
	out := jsfmt.Value{Kind: jsfmt.Object}
	for _, k := range keys {
		if v, ok := a.Get(k); ok {
			out.Set(k, v)
		}
	}
	return out
}

func itsaCreate(ctx context.Context, s *Server, a jsfmt.Value) (string, error) {
	me, err := s.me(a)
	if err != nil {
		return "", err
	}
	body := withMembers(a, "title", "summary", "body", "parent", "kind", "status", "owner")
	// The creator is not added here: the daemon makes the owner a participant (S-586).
	if v, ok := a.Get("participants"); ok && v.Kind != jsfmt.Null {
		body.Set("participants", v)
	} else {
		body.Set("participants", jsfmt.ArrayValue([]jsfmt.Value{}))
	}
	if v, ok := a.Get("links"); ok {
		body.Set("links", v)
	}
	body.Set("by", jsfmt.StringValue(me))
	x, err := s.apiJSON(ctx, "POST", "/api/itsas", raw(body))
	if err != nil {
		return "", err
	}
	owner, hasOwner := x.Get("owner")
	m := s.namesOf(ctx, me, []jsfmt.Value{ownerOrNull(owner, hasOwner)})
	bits := []string{fmt.Sprintf("Created %s \"%s\" [%s]", member(x, "key"), member(x, "title"), member(x, "status"))}
	if hasOwner && owner.Truthy() {
		bits = append(bits, "owner "+nameOf(owner, true, m))
	}
	if p, ok := a.Get("parent"); ok && p.Truthy() {
		bits = append(bits, "parent "+str(p, true))
	}
	title, ok := x.Get("title")
	if !ok || title.Kind == jsfmt.Null {
		title, ok = a.Get("title")
	}
	return strings.Join(bits, ", ") + "." + longTitleNote(member(x, "key"), title, ok), nil
}

func ownerOrNull(v jsfmt.Value, ok bool) jsfmt.Value {
	if !ok {
		return jsfmt.NullValue()
	}
	return v
}

func itsaGet(ctx context.Context, s *Server, a jsfmt.Value) (string, error) {
	ref, err := itsaRef(a, "ref")
	if err != nil {
		return "", err
	}
	x, err := s.apiJSON(ctx, "GET", "/api/itsas/"+uriComponent(ref), nil)
	if err != nil {
		return "", err
	}
	me, err := s.me(a)
	if err != nil {
		return "", err
	}
	owner, hasOwner := x.Get("owner")
	ids := []jsfmt.Value{ownerOrNull(owner, hasOwner)}
	parts, _ := x.Get("participants")
	ids = append(ids, parts.Items...)
	children, _ := x.Get("children")
	for _, c := range children.Items {
		o, ok := c.Get("owner")
		ids = append(ids, ownerOrNull(o, ok))
	}
	m := s.namesOf(ctx, me, ids)
	head := fmt.Sprintf("%s \"%s\" [%s]", member(x, "key"), member(x, "title"), member(x, "status"))
	if truthyMember(x, "kind") {
		head += " · " + member(x, "kind")
	}
	lines := []string{head}
	if truthyMember(x, "summary") {
		lines = append(lines, member(x, "summary"))
	}
	if truthyMember(x, "body") {
		lines = append(lines, member(x, "body"))
	}
	lines = append(lines, "owner: "+nameOf(owner, hasOwner, m))
	// The open ask it waits on: its mail, then its kind, never the ask's text (S-3982).
	if d, ok := x.Get("open_ask_detail"); ok && d.Kind == jsfmt.Object {
		var parts []string
		for _, k := range []string{"mail", "kind"} {
			if truthyMember(d, k) {
				parts = append(parts, member(d, k))
			}
		}
		lines = append(lines, "open ask: "+strings.Join(parts, " · "))
	}
	if chain, ok := x.Get("parent_chain"); ok && len(chain.Items) > 0 {
		var ps []string
		for _, p := range chain.Items {
			ps = append(ps, member(p, "key")+" "+member(p, "title"))
		}
		lines = append(lines, "parents: "+strings.Join(ps, " > "))
	}
	if f, ok := x.Get("fields"); fieldsline.Line(f, ok) != "" {
		lines = append(lines, "fields: "+fieldsline.Line(f, ok))
	}
	if len(parts.Items) > 0 {
		var ns []string
		for _, p := range parts.Items {
			ns = append(ns, nameOf(p, true, m))
		}
		lines = append(lines, "participants: "+strings.Join(ns, ", "))
	}
	links, _ := x.Get("links")
	for _, l := range links.Items {
		ext := ""
		if truthyMember(l, "external_id") {
			ext = " #" + member(l, "external_id")
		}
		lines = append(lines, fmt.Sprintf("link %s%s: %s", member(l, "system"), ext, member(l, "url")))
	}
	if len(children.Items) > 0 {
		lines = append(lines, "children:")
		for _, c := range children.Items {
			co, cok := c.Get("owner")
			roll := ""
			if r, ok := c.Get("rollup"); ok && r.Truthy() {
				roll = " · roll-up: " + rollupText(r)
			}
			lines = append(lines, fmt.Sprintf("  %s \"%s\" [%s] owner %s%s", member(c, "key"), member(c, "title"), member(c, "status"), nameOf(co, cok, m), roll))
		}
	}
	if r, ok := x.Get("rollup"); len(children.Items) > 0 && ok && r.Truthy() {
		lines = append(lines, "roll-up: "+rollupText(r))
	}
	// Mail linked to the ITSA (S-986): the threads that name it, newest first; read one with read_thread.
	linked, err := s.apiJSON(ctx, "GET", "/api/mail/linked/"+uriComponent(member(x, "id"))+"?limit=5", nil)
	if err == nil && len(linked.Items) > 0 {
		lines = append(lines, "linked mail (newest first):")
		for _, l := range linked.Items {
			from := member(l, "from_id")
			if fn, ok := l.Get("from_name"); ok && fn.Kind != jsfmt.Null {
				from = str(fn, true)
			}
			mails := ""
			if n, ok := l.Get("mails"); ok && n.Kind == jsfmt.Number && jsNum(n) > 1 {
				mails = fmt.Sprintf(" (%s mails)", str(n, true))
			}
			lines = append(lines, fmt.Sprintf("  %s \"%s\" from %s, %s%s", member(l, "thread_id"), member(l, "subject"), from, first(jsString(lastAt(l)), 10), mails))
		}
	}
	return strings.Join(lines, "\n"), nil
}

func lastAt(l jsfmt.Value) jsfmt.Value {
	if v, ok := l.Get("last_at"); ok {
		return v
	}
	return jsfmt.StringValue("undefined")
}

// first is String.prototype.slice(0, n): n UTF-16 code units.
func first(s string, n int) string {
	u := utf16.Encode([]rune(s))
	if len(u) <= n {
		return s
	}
	return string(utf16.Decode(u[:n]))
}

func jsNum(v jsfmt.Value) float64 {
	var f float64
	fmt.Sscanf(v.Num, "%g", &f)
	return f
}

func itsaList(ctx context.Context, s *Server, a jsfmt.Value) (string, error) {
	var q params
	for _, k := range []string{"parent", "subtree", "status", "category", "owner", "participant", "kind", "text"} {
		if v, ok := a.Get(k); ok && v.Kind != jsfmt.Null && jsString(v) != "" {
			q.set(k, jsString(v))
		}
	}
	var rows []jsfmt.Value
	if mine, ok := a.Get("mine"); ok && mine.Truthy() {
		// `mine` is "you own or take part in"; the owner is always a participant, so it is exactly "you are a participant".
		me, err := s.me(a)
		if err != nil {
			return "", err
		}
		withMe := q.clone()
		withMe.set("participant", me)
		if !q.has("participant") {
			list, err := s.apiJSON(ctx, "GET", "/api/itsas?"+withMe.String(), nil)
			if err != nil {
				return "", err
			}
			rows = list.Items
		} else {
			a1, err1 := s.apiJSON(ctx, "GET", "/api/itsas?"+withMe.String(), nil)
			a2, err2 := s.apiJSON(ctx, "GET", "/api/itsas?"+q.String(), nil)
			if err1 != nil {
				return "", err1
			}
			if err2 != nil {
				return "", err2
			}
			given := map[string]bool{}
			for _, x := range a2.Items {
				given[x.Text("id")] = true
			}
			for _, x := range a1.Items {
				if given[x.Text("id")] {
					rows = append(rows, x)
				}
			}
		}
		sort.SliceStable(rows, func(i, j int) bool { return rows[i].Text("created_at") < rows[j].Text("created_at") })
	} else {
		path := "/api/itsas"
		if enc := q.String(); enc != "" {
			path += "?" + enc
		}
		list, err := s.apiJSON(ctx, "GET", path, nil)
		if err != nil {
			return "", err
		}
		rows = list.Items
	}
	if len(rows) == 0 {
		return "No ITSAs.", nil
	}
	me, err := s.me(a)
	if err != nil {
		return "", err
	}
	owners := make([]jsfmt.Value, len(rows))
	for i, x := range rows {
		o, ok := x.Get("owner")
		owners[i] = ownerOrNull(o, ok)
	}
	m := s.namesOf(ctx, me, owners)
	lines := make([]string, len(rows))
	for i, x := range rows {
		o, ok := x.Get("owner")
		f, fok := x.Get("fields")
		extra := ""
		if fl := fieldsline.Line(f, fok); fl != "" {
			extra = " {" + fl + "}"
		}
		lines[i] = fmt.Sprintf("%s [%s] %s %s%s", member(x, "key"), member(x, "status"), nameOf(o, ok, m), member(x, "title"), extra)
	}
	return strings.Join(lines, "\n"), nil
}

func itsaSet(ctx context.Context, s *Server, a jsfmt.Value) (string, error) {
	patch := withMembers(a, "title", "summary", "body", "kind", "status", "owner", "parent", "participants", "fields", "incident")
	ref, err := itsaRef(a, "ref")
	if err != nil {
		return "", err
	}
	if len(patch.Keys) == 0 {
		return "", errors.New("nothing to set: pass at least one field (status, owner, title, ...)")
	}
	me, err := s.me(a)
	if err != nil {
		return "", err
	}
	patch.Set("by", jsfmt.StringValue(me))
	r, err := s.apiJSON(ctx, "PATCH", "/api/itsas/"+uriComponent(ref), raw(patch))
	if err != nil {
		return "", err
	}
	itsa, _ := r.Get("itsa")
	changes, _ := r.Get("changes")
	owner, ook := itsa.Get("owner")
	ids := []jsfmt.Value{ownerOrNull(owner, ook)}
	for _, c := range changes.Items {
		ids = append(ids, idsIn(ownerOrNull(c.Get("from")))...)
		ids = append(ids, idsIn(ownerOrNull(c.Get("to")))...)
	}
	m := s.namesOf(ctx, me, ids)
	var changed []string
	for i, f := range changes.Keys {
		c := changes.Items[i]
		from, fok := c.Get("from")
		to, tok := c.Get("to")
		if f == "fields" {
			changed = append(changed, fieldsline.Change(c))
			continue
		}
		changed = append(changed, fmt.Sprintf("%s: %s -> %s", f, showValue(from, fok, m), showValue(to, tok, m)))
	}
	out := member(itsa, "key") + ": "
	if len(changed) == 0 {
		out += "nothing changed"
	} else {
		out += strings.Join(changed, "; ")
	}
	if t, ok := a.Get("title"); ok {
		out += longTitleNote(member(itsa, "key"), t, true)
	}
	if truthyMember(r, "retro_offer") {
		out += "\n\n" + member(r, "retro_offer")
	}
	return out, nil
}

// idsIn is src/mcp.ts idsIn: every non-empty string inside a field value.
func idsIn(v jsfmt.Value) []jsfmt.Value {
	if v.Kind == jsfmt.Array {
		var out []jsfmt.Value
		for _, it := range v.Items {
			out = append(out, idsIn(it)...)
		}
		return out
	}
	if v.Kind == jsfmt.String && v.Str != "" {
		return []jsfmt.Value{v}
	}
	return nil
}

// showValue is src/mcp.ts showValue: ids become names, arrays join, empty becomes an em dash.
func showValue(v jsfmt.Value, ok bool, m map[string]string) string {
	if !ok || v.Kind == jsfmt.Null || (v.Kind == jsfmt.String && v.Str == "") {
		return "—"
	}
	if v.Kind == jsfmt.Array {
		if len(v.Items) == 0 {
			return "—"
		}
		parts := make([]string, len(v.Items))
		for i, it := range v.Items {
			parts[i] = showValue(it, true, m)
		}
		return strings.Join(parts, ", ")
	}
	s := jsString(v)
	if n, has := m[s]; has {
		return n
	}
	if s == "human" {
		return "human"
	}
	return s
}

func itsaFields(ctx context.Context, s *Server, a jsfmt.Value) (string, error) {
	action := "list"
	if v, ok := a.Get("action"); ok && v.Kind != jsfmt.Null {
		action = jsString(v)
	}
	me, err := s.me(a)
	if err != nil {
		return "", err
	}
	body := jsfmt.Value{Kind: jsfmt.Object}
	body.Set("by", jsfmt.StringValue(me))
	for _, k := range []string{"key", "label", "type", "options", "description", "hint", "width", "align", "card", "kinds"} {
		if v, ok := a.Get(k); ok {
			body.Set(k, v)
		}
	}
	need := func() (string, error) {
		f, ok := a.Get("field")
		if !ok || !f.Truthy() {
			return "", fmt.Errorf("%s needs field (the key or id)", action)
		}
		return uriComponent(jsString(f)), nil
	}
	var list jsfmt.Value
	done := ""
	listAll := func() error {
		var err error
		list, err = s.apiJSON(ctx, "GET", "/api/itsas/fields", nil)
		return err
	}
	switch action {
	case "list":
		err = listAll()
	case "create":
		var f jsfmt.Value
		if f, err = s.apiJSON(ctx, "POST", "/api/itsas/fields", raw(body)); err == nil {
			done = "created " + member(f, "key")
			err = listAll()
		}
	case "update":
		var p string
		if p, err = need(); err == nil {
			var f jsfmt.Value
			if f, err = s.apiJSON(ctx, "PATCH", "/api/itsas/fields/"+p, raw(body)); err == nil {
				done = "updated " + member(f, "key")
				err = listAll()
			}
		}
	case "remove":
		var p string
		if p, err = need(); err == nil {
			rm := jsfmt.Value{Kind: jsfmt.Object}
			rm.Set("by", jsfmt.StringValue(me))
			if _, err = s.api.Do(ctx, "DELETE", "/api/itsas/fields/"+p, raw(rm), 0); err == nil {
				f, _ := a.Get("field")
				done = "removed " + str(f, true) + " and its values"
				err = listAll()
			}
		}
	case "order":
		ob := jsfmt.Value{Kind: jsfmt.Object}
		if o, ok := a.Get("order"); ok {
			ob.Set("order", o)
		}
		ob.Set("by", jsfmt.StringValue(me))
		if list, err = s.apiJSON(ctx, "POST", "/api/itsas/fields/order", raw(ob)); err == nil {
			done = "reordered"
		}
	default:
		err = errors.New("action is list, create, update, remove, or order")
	}
	if err != nil {
		return "", err
	}
	var rows []string
	for _, f := range list.Items {
		row := fmt.Sprintf("%s · %s · %s", member(f, "key"), member(f, "label"), member(f, "type"))
		if o, ok := f.Get("options"); ok && o.Truthy() {
			var vals []string
			for _, op := range o.Items {
				vals = append(vals, member(op, "value"))
			}
			row += " (" + strings.Join(vals, " | ") + ")"
		}
		if k, ok := f.Get("kinds"); ok && k.Truthy() {
			var kinds []string
			for _, x := range k.Items {
				kinds = append(kinds, jsString(x))
			}
			row += " · kinds: " + strings.Join(kinds, ", ")
		}
		if truthyMember(f, "description") {
			row += " — " + member(f, "description")
		}
		rows = append(rows, row)
	}
	var out []string
	if done != "" {
		out = append(out, done)
	}
	if len(rows) > 0 {
		out = append(out, strings.Join(rows, "\n"))
	} else {
		out = append(out, "No fields.")
	}
	return strings.Join(out, "\n"), nil
}

func itsaLink(ctx context.Context, s *Server, a jsfmt.Value) (string, error) {
	ref, err := itsaRef(a, "ref")
	if err != nil {
		return "", err
	}
	if n, ok := a.Get("n"); ok {
		rec := withMembers(a, "review", "tests", "screenshots")
		if len(rec.Keys) == 0 {
			return "", errors.New("nothing to record: pass review, tests, or screenshots")
		}
		keys := append([]string(nil), rec.Keys...)
		me, err := s.me(a)
		if err != nil {
			return "", err
		}
		rec.Set("by", jsfmt.StringValue(me))
		r, err := s.apiJSON(ctx, "PATCH", "/api/itsas/"+uriComponent(ref)+"/links/"+str(n, true), raw(rec))
		if err != nil {
			return "", err
		}
		ext := ""
		if truthyMember(r, "external_id") {
			ext = " " + member(r, "external_id")
		}
		return fmt.Sprintf("Recorded on link %s (%s%s): %s.", member(r, "n"), member(r, "system"), ext, strings.Join(keys, ", ")), nil
	}
	me, err := s.me(a)
	if err != nil {
		return "", err
	}
	body := jsfmt.Value{Kind: jsfmt.Object}
	if u, ok := a.Get("url"); ok && u.Kind != jsfmt.Null {
		body.Set("url", u)
	} else {
		body.Set("url", jsfmt.StringValue(""))
	}
	for _, k := range []string{"system", "external_id", "repo"} {
		if v, ok := a.Get(k); ok {
			body.Set(k, v)
		}
	}
	body.Set("by", jsfmt.StringValue(me))
	r, err := s.apiJSON(ctx, "POST", "/api/itsas/"+uriComponent(ref)+"/links", raw(body))
	if err != nil {
		return "", err
	}
	l, _ := r.Get("link")
	out := fmt.Sprintf("Linked %s: %s", member(l, "n"), member(l, "system"))
	if truthyMember(l, "external_id") {
		out += " " + member(l, "external_id")
	}
	if truthyMember(l, "url") {
		out += " " + member(l, "url")
	}
	return out, nil
}

// itsaPost is the itsa_post tool: a comment or update in the ITSA's mail thread.
func itsaPost(ctx context.Context, s *Server, a jsfmt.Value) (string, error) {
	ref, err := itsaRef(a, "itsa")
	if err != nil {
		return "", err
	}
	me, err := s.me(a)
	if err != nil {
		return "", err
	}
	get := func(k string) jsfmt.Value {
		if v, ok := a.Get(k); ok {
			return v
		}
		return jsfmt.NullValue()
	}
	body := jsfmt.Value{Kind: jsfmt.Object}
	for _, k := range []string{"body", "kind", "health", "to", "override"} {
		if v, ok := a.Get(k); ok {
			body.Set(k, v)
		}
	}
	body.Set("by", jsfmt.StringValue(me))
	body.Set("client_id", jsfmt.StringValue(writeID(jsfmt.StringValue("post"), jsfmt.StringValue(me), jsfmt.StringValue(ref), get("body"), get("kind"), get("to"))))
	m, err := s.apiJSONTimeout(ctx, "POST", "/api/itsas/"+uriComponent(ref)+"/post", raw(body), client.WriteTimeout)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("Posted %s in the ITSA's thread %s.", member(m, "id"), member(m, "thread_id")), nil
}

// apiJSONTimeout is apiJSON with a timeout.
func (s *Server) apiJSONTimeout(ctx context.Context, method, path string, body any, timeout time.Duration) (jsfmt.Value, error) {
	reply, err := s.api.Do(ctx, method, path, body, timeout)
	if err != nil {
		return jsfmt.Value{}, err
	}
	v, err := jsfmt.Parse(reply)
	if err != nil {
		return jsfmt.Value{}, errors.New("the daemon's reply isn't JSON")
	}
	return v, nil
}
