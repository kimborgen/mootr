package db

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"zombiezen.com/go/sqlite"

	"stam/internal/jsfmt"
)

// The ITSA fields of src/itsa.ts (S-364, S-2849 PR 2): the column definitions and the values ITSAs hold. Each write is one
// transaction. An error is the text TS throws, returned as it is for the route to map (a missing field is 404, the rest 400).

var (
	fieldTypes  = []string{"text", "number", "choice", "link", "date", "check"}
	fieldTones  = []string{"ok", "warn", "bad", "muted", "accent"}
	fieldWidths = []string{"s", "m", "l"}
	fieldAligns = []string{"start", "end"}
	fieldCards  = []string{"chip", "meta"}
)

// fieldEvents is the pseudo ITSA id the events of definition changes carry.
const fieldEvents = "fields"

var (
	reFieldKey  = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)
	reFieldDate = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})$`)
	reHTTPURL   = regexp.MustCompile(`^(?i:(https?)):[/\\]*(.*)$`)
)

func fieldIn(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// jsTrim is String.prototype.trim: white space and line terminators, and the byte order mark, but not U+0085.
func jsTrim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool { return (unicode.IsSpace(r) && r != 0x85) || r == 0xfeff })
}

// jsStr is JS String(v).
func jsStr(v jsfmt.Value) string {
	switch v.Kind {
	case jsfmt.String:
		return v.Str
	case jsfmt.Null:
		return "null"
	case jsfmt.Array:
		parts := make([]string, len(v.Items))
		for i, it := range v.Items {
			if it.Kind != jsfmt.Null {
				parts[i] = jsStr(it)
			}
		}
		return strings.Join(parts, ",")
	case jsfmt.Object:
		return "[object Object]"
	}
	return jsfmt.Compact(v)
}

// strOr is String(v ?? ”): absent and null are empty.
func strOr(v jsfmt.Value, ok bool) string {
	if !ok || v.Kind == jsfmt.Null {
		return ""
	}
	return jsStr(v)
}

// optFieldText is itsa.ts optText: an empty or blank value is null, anything else is kept as it is.
func optFieldText(v jsfmt.Value, ok bool) jsfmt.Value {
	if !ok || v.Kind == jsfmt.Null || jsTrim(jsStr(v)) == "" {
		return jsfmt.NullValue()
	}
	return jsfmt.StringValue(jsStr(v))
}

func oneOf(list []string, v jsfmt.Value, ok bool, what string) (string, error) {
	if !ok || v.Kind != jsfmt.String || !fieldIn(list, v.Str) {
		return "", fmt.Errorf("%s must be one of: %s", what, strings.Join(list, ", "))
	}
	return v.Str, nil
}

// checkOptions is itsa.ts checkOptions: a choice field's options, as stored.
func checkOptions(raw jsfmt.Value, ok bool) (jsfmt.Value, error) {
	if !ok || raw.Kind != jsfmt.Array || len(raw.Items) == 0 {
		return jsfmt.Value{}, fmt.Errorf("a choice field needs options: a list of { value, label, tone }")
	}
	seen := map[string]bool{}
	out := make([]jsfmt.Value, 0, len(raw.Items))
	for _, o := range raw.Items {
		var value string
		if o.Kind == jsfmt.Object {
			v, has := o.Get("value")
			value = jsTrim(strOr(v, has))
		}
		if value == "" {
			return jsfmt.Value{}, fmt.Errorf("every option needs a value")
		}
		if seen[value] {
			return jsfmt.Value{}, fmt.Errorf("duplicate option %s", value)
		}
		seen[value] = true
		tone := jsfmt.NullValue()
		if tv, has := o.Get("tone"); has && tv.Kind != jsfmt.Null && !(tv.Kind == jsfmt.String && tv.Str == "") {
			t, err := oneOf(fieldTones, tv, true, fmt.Sprintf("option %s's tone", value))
			if err != nil {
				return jsfmt.Value{}, err
			}
			tone = jsfmt.StringValue(t)
		}
		lv, has := o.Get("label")
		label := jsTrim(strOr(lv, has))
		if label == "" {
			label = value
		}
		opt := jsfmt.Value{Kind: jsfmt.Object}
		opt.Set("value", jsfmt.StringValue(value))
		opt.Set("label", jsfmt.StringValue(label))
		opt.Set("tone", tone)
		out = append(out, opt)
	}
	return jsfmt.ArrayValue(out), nil
}

// httpURL approximates `new URL(v)` with an http or https protocol: the scheme, then a host the WHATWG parser would take.
// Slashes after the scheme are forgiven as it forgives them; a space or a port out of range is not.
func httpURL(v string) bool {
	s := strings.Trim(v, "\x00\x01\x02\x03\x04\x05\x06\x07\x08\t\n\x0b\x0c\r\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f ")
	m := reHTTPURL.FindStringSubmatch(s)
	if m == nil {
		return false
	}
	u, err := url.Parse(strings.ToLower(m[1]) + "://" + m[2])
	if err != nil || u.Host == "" || u.Hostname() == "" {
		return false
	}
	if p := u.Port(); p != "" {
		if n, err := strconv.Atoi(p); err != nil || n > 65535 {
			return false
		}
	}
	return true
}

// CheckFieldValue is itsa.ts checkFieldValue: the stored form of a value for a field, or the reason it is refused. null
// clears the value.
func CheckFieldValue(key, typ string, options jsfmt.Value, v jsfmt.Value) (jsfmt.Value, error) {
	if v.Kind == jsfmt.Null {
		return v, nil
	}
	bad := func(why string) error { return fmt.Errorf("field %s (%s): %s", key, typ, why) }
	switch typ {
	case "text":
		if v.Kind != jsfmt.String {
			return v, bad("expected a string")
		}
	case "number":
		f, err := strconv.ParseFloat(v.Num, 64)
		if v.Kind != jsfmt.Number || err != nil || f > 1.7976931348623157e308 || f < -1.7976931348623157e308 {
			return v, bad("expected a number")
		}
	case "choice":
		var values []string
		for _, o := range options.Items {
			values = append(values, o.Text("value"))
		}
		if v.Kind != jsfmt.String || !fieldIn(values, v.Str) {
			return v, bad("expected one of " + strings.Join(values, ", "))
		}
	case "link":
		if v.Kind != jsfmt.String || !httpURL(v.Str) {
			return v, bad("expected an http or https URL")
		}
	case "date":
		m := reFieldDate.FindStringSubmatch(jsOrEmpty(v))
		if v.Kind != jsfmt.String || m == nil {
			return v, bad("expected an ISO date (YYYY-MM-DD)")
		}
		y, _ := strconv.Atoi(m[1])
		mo, _ := strconv.Atoi(m[2])
		d, _ := strconv.Atoi(m[3])
		// V8 reads a day up to 31 in any month and rolls it over, and refuses a month or day out of range outright, which
		// toISOString throws as a RangeError rather than the field's message.
		if mo < 1 || mo > 12 || d < 1 || d > 31 {
			return v, fmt.Errorf("Invalid time value")
		}
		if time.Date(y, time.Month(mo), d, 0, 0, 0, 0, time.UTC).Format("2006-01-02") != v.Str {
			return v, bad("expected an ISO date (YYYY-MM-DD)")
		}
	case "check":
		if v.Kind != jsfmt.Bool {
			return v, bad("expected true or false")
		}
	}
	return v, nil
}

func jsOrEmpty(v jsfmt.Value) string {
	if v.Kind == jsfmt.String {
		return v.Str
	}
	return ""
}

// fieldOut is itsa.ts fieldOut: the row with its options and kinds decoded (null when there are none).
func fieldOut(r jsfmt.Value) (jsfmt.Value, error) {
	opts := jsfmt.NullValue()
	if raw := r.Text("options"); raw != "" {
		var err error
		if opts, err = jsfmt.Parse([]byte(raw)); err != nil {
			return r, fmt.Errorf("the options of field %s are not JSON", r.Text("key"))
		}
	}
	r.Set("options", opts)
	kinds, err := parseKinds(r.Text("kinds"))
	if err != nil {
		return r, fmt.Errorf("the kinds of field %s are not JSON", r.Text("key"))
	}
	r.Set("kinds", kinds)
	return r, nil
}

// parseKinds decodes a field's stored kinds, null when it has none (S-3180).
func parseKinds(raw string) (jsfmt.Value, error) {
	if raw == "" {
		return jsfmt.NullValue(), nil
	}
	return jsfmt.Parse([]byte(raw))
}

// FieldApplies is itsa.ts fieldApplies (S-3180): a field with no kinds applies to every ITSA; otherwise the ITSA's kind must
// match one of them, ignoring case. An ITSA with no kind matches none. Stored kinds that are a list of strings are matched in
// order, stopping at the first match. As TS does, a list item that isn't a string is an error where it is reached, and so is any
// other truthy value (an object, a string, a number) once the ITSA has a kind (S-3233).
func FieldApplies(kinds jsfmt.Value, kind string) (bool, error) {
	if kinds.Kind != jsfmt.Array && !kinds.Truthy() {
		return true, nil
	}
	k := strings.ToLower(kind)
	if k == "" {
		return false, nil
	}
	if kinds.Kind != jsfmt.Array {
		return false, fmt.Errorf("the kinds of a field are not a list of ITSA kinds")
	}
	for _, x := range kinds.Items {
		if x.Kind != jsfmt.String {
			return false, fmt.Errorf("the kinds of a field hold a value that is not a string")
		}
		if strings.ToLower(x.Str) == k {
			return true, nil
		}
	}
	return false, nil
}

// checkKinds is itsa.ts checkKinds (S-3180): a field's kinds, null for every kind. An empty list is every kind too, and a
// kind repeated in another case is kept once.
func checkKinds(raw jsfmt.Value, ok bool) (jsfmt.Value, error) {
	if !ok || raw.Kind == jsfmt.Null {
		return jsfmt.NullValue(), nil
	}
	if raw.Kind != jsfmt.Array {
		return jsfmt.Value{}, fmt.Errorf(`kinds is a list of ITSA kinds, such as ["issue"]`)
	}
	var out []jsfmt.Value
	seen := map[string]bool{}
	for _, k := range raw.Items {
		label := ""
		if k.Kind == jsfmt.String {
			label = jsTrim(k.Str)
		}
		if label == "" {
			return jsfmt.Value{}, fmt.Errorf("every kind in kinds needs a label")
		}
		if !seen[strings.ToLower(label)] {
			seen[strings.ToLower(label)] = true
			out = append(out, jsfmt.StringValue(label))
		}
	}
	if len(out) == 0 {
		return jsfmt.NullValue(), nil
	}
	return jsfmt.ArrayValue(out), nil
}

func fieldsOn(conn *sqlite.Conn) ([]jsfmt.Value, error) {
	found, err := rows(conn, "SELECT * FROM itsa_fields ORDER BY position, created_at")
	if err != nil {
		return nil, err
	}
	out := make([]jsfmt.Value, 0, len(found))
	for _, r := range found {
		f, err := fieldOut(r)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, nil
}

// findFieldOn is itsa.ts findField: a field by id, or by key.
func findFieldOn(conn *sqlite.Conn, ref string) (jsfmt.Value, bool, error) {
	found, err := rows(conn, "SELECT * FROM itsa_fields WHERE id = ? OR key = ? ORDER BY id = ? DESC", ref, ref, ref)
	if err != nil || len(found) == 0 {
		return jsfmt.Value{}, false, err
	}
	f, err := fieldOut(found[0])
	return f, err == nil, err
}

func mustFieldOn(conn *sqlite.Conn, ref string) (jsfmt.Value, error) {
	f, ok, err := findFieldOn(conn, ref)
	if err != nil {
		return f, err
	}
	if !ok {
		return f, fmt.Errorf("no field %s", ref)
	}
	return f, nil
}

// inFields runs fn in one write transaction. An error from fn is the caller's to read as it is, not a database failure.
func (d *DB) inFields(ctx context.Context, fn func(conn *sqlite.Conn) error) error {
	var refused error
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		if err := fn(conn); err != nil {
			refused = err
			return err
		}
		return nil
	})
	if refused != nil {
		return refused
	}
	return wrap("ITSA field", err)
}

// ItsaFields is itsa.fields.
func (d *DB) ItsaFields(ctx context.Context) ([]jsfmt.Value, error) {
	var out []jsfmt.Value
	err := d.Read(ctx, func(conn *sqlite.Conn) (err error) { out, err = fieldsOn(conn); return })
	return out, wrap("ITSA fields", err)
}

func checkFieldKey(conn *sqlite.Conn, raw jsfmt.Value, has bool, exceptID string) (string, error) {
	k := jsTrim(strOr(raw, has))
	if !reFieldKey.MatchString(k) {
		return "", fmt.Errorf("a field key is a slug: lowercase letters, digits, - and _, starting with a letter, up to 32 characters")
	}
	clash, err := rows(conn, "SELECT id FROM itsa_fields WHERE key = ?", k)
	if err != nil {
		return "", err
	}
	if len(clash) > 0 && clash[0].Text("id") != exceptID {
		return "", fmt.Errorf("a field with key %s exists", k)
	}
	// A ref names an id before a key, so a key equal to another field's id would never be found.
	asID, err := rows(conn, "SELECT id FROM itsa_fields WHERE id = ?", k)
	if err != nil {
		return "", err
	}
	if len(asID) > 0 && asID[0].Text("id") != exceptID {
		return "", fmt.Errorf("key %s is another field's id", k)
	}
	return k, nil
}

func nullable(v jsfmt.Value) any {
	if v.Kind == jsfmt.Null {
		return nil
	}
	return v.Str
}

// kindsArg is a field's kinds as the column holds them: the JSON list, or null for every kind.
func kindsArg(kinds jsfmt.Value) any {
	if kinds.Kind == jsfmt.Null {
		return nil
	}
	return jsfmt.Compact(kinds)
}

// CreateItsaField is itsa.createField after the caller's right to define was checked: the field, as the API shows it.
func (d *DB) CreateItsaField(ctx context.Context, actor string, in jsfmt.Value) (jsfmt.Value, error) {
	label := jsTrim(strOr(in.Get("label")))
	if label == "" {
		return jsfmt.Value{}, fmt.Errorf("a field needs a label")
	}
	tv, has := in.Get("type")
	typ, err := oneOf(fieldTypes, tv, has, "type")
	if err != nil {
		return jsfmt.Value{}, err
	}
	ov, hasOpts := in.Get("options")
	options := jsfmt.NullValue()
	if typ == "choice" {
		if options, err = checkOptions(ov, hasOpts); err != nil {
			return jsfmt.Value{}, err
		}
	} else if hasOpts && ov.Kind != jsfmt.Null {
		return jsfmt.Value{}, fmt.Errorf("only a choice field has options")
	}
	pick := func(k string, list []string, def string) (string, error) {
		v, has := in.Get(k)
		if !has {
			return def, nil
		}
		return oneOf(list, v, true, k)
	}
	width, err := pick("width", fieldWidths, "m")
	if err != nil {
		return jsfmt.Value{}, err
	}
	align, err := pick("align", fieldAligns, "start")
	if err != nil {
		return jsfmt.Value{}, err
	}
	card, err := pick("card", fieldCards, "meta")
	if err != nil {
		return jsfmt.Value{}, err
	}
	kinds, err := checkKinds(in.Get("kinds"))
	if err != nil {
		return jsfmt.Value{}, err
	}
	desc, hint := optFieldText(in.Get("description")), optFieldText(in.Get("hint"))
	var created jsfmt.Value
	err = d.inFields(ctx, func(conn *sqlite.Conn) error {
		kv, hasKey := in.Get("key")
		key, err := checkFieldKey(conn, kv, hasKey, "")
		if err != nil {
			return err
		}
		id, err := freshItsaID(conn, "f", "itsa_fields", "ITSA field")
		if err != nil {
			return err
		}
		t := now()
		pos, err := rows(conn, "SELECT MAX(position) AS m FROM itsa_fields")
		if err != nil {
			return err
		}
		position := int64(0)
		if m, _ := pos[0].Get("m"); m.Kind == jsfmt.Number {
			position, _ = strconv.ParseInt(m.Num, 10, 64)
			position++
		}
		var opts any
		if options.Kind != jsfmt.Null {
			opts = jsfmt.Compact(options)
		}
		if err := runSQL(conn, "INSERT INTO itsa_fields (id, key, label, type, options, description, hint, width, align, card, kinds, position, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			id, key, label, typ, opts, nullable(desc), nullable(hint), width, align, card, kindsArg(kinds), position, actor, t, t); err != nil {
			return err
		}
		if created, err = mustFieldOn(conn, id); err != nil {
			return err
		}
		return addItsaEvent(conn, fieldEvents, actor, "field_created", &created)
	})
	return created, err
}

// UpdateItsaField is itsa.updateField after the right to define was checked: any definition member but the id. A new type
// or option list must still hold every value already set.
func (d *DB) UpdateItsaField(ctx context.Context, ref, actor string, patch jsfmt.Value) (jsfmt.Value, error) {
	var out jsfmt.Value
	err := d.inFields(ctx, func(conn *sqlite.Conn) error {
		cur, err := mustFieldOn(conn, ref)
		if err != nil {
			return err
		}
		next := cur
		next.Keys, next.Items = append([]string(nil), cur.Keys...), append([]jsfmt.Value(nil), cur.Items...)
		curType := cur.Text("type")
		if v, has := patch.Get("key"); has {
			k, err := checkFieldKey(conn, v, true, cur.Text("id"))
			if err != nil {
				return err
			}
			next.Set("key", jsfmt.StringValue(k))
		}
		if v, has := patch.Get("label"); has {
			label := jsTrim(strOr(v, true))
			if label == "" {
				return fmt.Errorf("a field needs a label")
			}
			next.Set("label", jsfmt.StringValue(label))
		}
		if v, has := patch.Get("type"); has {
			t, err := oneOf(fieldTypes, v, true, "type")
			if err != nil {
				return err
			}
			next.Set("type", jsfmt.StringValue(t))
		}
		nextType := next.Text("type")
		ov, hasOpts := patch.Get("options")
		if hasOpts || nextType != curType {
			raw, rawOK := ov, hasOpts
			if !hasOpts {
				raw, rawOK = cur.Get("options")
			}
			switch {
			case nextType == "choice":
				o, err := checkOptions(raw, rawOK)
				if err != nil {
					return err
				}
				next.Set("options", o)
			case rawOK && raw.Kind != jsfmt.Null && hasOpts:
				return fmt.Errorf("only a choice field has options")
			default:
				next.Set("options", jsfmt.NullValue())
			}
		}
		if v, has := patch.Get("description"); has {
			next.Set("description", optFieldText(v, true))
		}
		if v, has := patch.Get("hint"); has {
			next.Set("hint", optFieldText(v, true))
		}
		for _, p := range []struct {
			k    string
			list []string
		}{{"width", fieldWidths}, {"align", fieldAligns}, {"card", fieldCards}} {
			if v, has := patch.Get(p.k); has {
				s, err := oneOf(p.list, v, true, p.k)
				if err != nil {
					return err
				}
				next.Set(p.k, jsfmt.StringValue(s))
			}
		}
		if v, has := patch.Get("kinds"); has {
			k, err := checkKinds(v, true)
			if err != nil {
				return err
			}
			next.Set("kinds", k)
		}
		curOpts, _ := cur.Get("options")
		nextOpts, _ := next.Get("options")
		if nextType != curType || jsfmt.Compact(nextOpts) != jsfmt.Compact(curOpts) {
			held, err := rows(conn, "SELECT v.value AS value, i.key AS key FROM itsa_field_values v JOIN itsas i ON i.id = v.itsa_id WHERE v.field_id = ?", cur.Text("id"))
			if err != nil {
				return err
			}
			for _, r := range held {
				val, perr := jsfmt.Parse([]byte(r.Text("value")))
				if perr != nil {
					return perr
				}
				if _, err := CheckFieldValue(next.Text("key"), nextType, nextOpts, val); err != nil {
					return fmt.Errorf("%s can't change: %s holds a value it would refuse (%s)", cur.Text("key"), r.Text("key"), err.Error())
				}
			}
		}
		changes := jsfmt.Value{Kind: jsfmt.Object}
		for _, k := range []string{"key", "label", "type", "options", "description", "hint", "width", "align", "card", "kinds"} {
			a, _ := cur.Get(k)
			b, _ := next.Get(k)
			if jsfmt.Compact(a) != jsfmt.Compact(b) {
				ch := jsfmt.Value{Kind: jsfmt.Object}
				ch.Set("from", a)
				ch.Set("to", b)
				changes.Set(k, ch)
			}
		}
		if len(changes.Keys) == 0 {
			out = cur
			return nil
		}
		var opts any
		if nextOpts.Kind != jsfmt.Null {
			opts = jsfmt.Compact(nextOpts)
		}
		desc, _ := next.Get("description")
		hint, _ := next.Get("hint")
		nextKinds, _ := next.Get("kinds")
		if err := runSQL(conn, "UPDATE itsa_fields SET key = ?, label = ?, type = ?, options = ?, description = ?, hint = ?, width = ?, align = ?, card = ?, kinds = ?, updated_at = ? WHERE id = ?",
			next.Text("key"), next.Text("label"), nextType, opts, nullable(desc), nullable(hint), next.Text("width"), next.Text("align"), next.Text("card"), kindsArg(nextKinds), now(), cur.Text("id")); err != nil {
			return err
		}
		ev := jsfmt.Value{Kind: jsfmt.Object}
		ev.Set("id", jsfmt.StringValue(cur.Text("id")))
		ev.Set("key", jsfmt.StringValue(cur.Text("key")))
		ev.Set("changes", changes)
		if err := addItsaEvent(conn, fieldEvents, actor, "field_updated", &ev); err != nil {
			return err
		}
		out, err = mustFieldOn(conn, cur.Text("id"))
		return err
	})
	return out, err
}

// RemoveItsaField is itsa.removeField after the right to define was checked: the definition and every value held for it.
func (d *DB) RemoveItsaField(ctx context.Context, ref, actor string) (jsfmt.Value, error) {
	var out jsfmt.Value
	err := d.inFields(ctx, func(conn *sqlite.Conn) error {
		cur, err := mustFieldOn(conn, ref)
		if err != nil {
			return err
		}
		if err := runSQL(conn, "DELETE FROM itsa_field_values WHERE field_id = ?", cur.Text("id")); err != nil {
			return err
		}
		values := int64(conn.Changes())
		if err := runSQL(conn, "DELETE FROM itsa_fields WHERE id = ?", cur.Text("id")); err != nil {
			return err
		}
		ev := jsfmt.Value{Kind: jsfmt.Object}
		ev.Set("id", jsfmt.StringValue(cur.Text("id")))
		ev.Set("key", jsfmt.StringValue(cur.Text("key")))
		ev.Set("values", jsfmt.IntValue(values))
		if err := addItsaEvent(conn, fieldEvents, actor, "field_removed", &ev); err != nil {
			return err
		}
		out = jsfmt.Value{Kind: jsfmt.Object}
		out.Set("removed", jsfmt.StringValue(cur.Text("key")))
		out.Set("values", jsfmt.IntValue(values))
		return nil
	})
	return out, err
}

// ReorderItsaFields is itsa.reorderFields after the right to define was checked: `order` lists field ids or keys, first to
// last; the fields it leaves out follow in their old order.
func (d *DB) ReorderItsaFields(ctx context.Context, order jsfmt.Value, actor string) ([]jsfmt.Value, error) {
	if order.Kind != jsfmt.Array {
		return nil, fmt.Errorf("order is a list of field ids")
	}
	var out []jsfmt.Value
	err := d.inFields(ctx, func(conn *sqlite.Conn) error {
		all, err := fieldsOn(conn)
		if err != nil {
			return err
		}
		var ids []string
		seen := map[string]bool{}
		dup := false
		for _, r := range order.Items {
			f, err := mustFieldOn(conn, jsStr(r))
			if err != nil {
				return err
			}
			if seen[f.Text("id")] {
				dup = true
			}
			seen[f.Text("id")] = true
			ids = append(ids, f.Text("id"))
		}
		if dup {
			return fmt.Errorf("order names a field twice")
		}
		sorted := append([]string(nil), ids...)
		keyOf := map[string]string{}
		var from []jsfmt.Value
		for _, f := range all {
			keyOf[f.Text("id")] = f.Text("key")
			from = append(from, jsfmt.StringValue(f.Text("key")))
			if !seen[f.Text("id")] {
				sorted = append(sorted, f.Text("id"))
			}
		}
		var to []jsfmt.Value
		for i, id := range sorted {
			if err := runSQL(conn, "UPDATE itsa_fields SET position = ? WHERE id = ?", i, id); err != nil {
				return err
			}
			to = append(to, jsfmt.StringValue(keyOf[id]))
		}
		ev := jsfmt.Value{Kind: jsfmt.Object}
		ev.Set("from", jsfmt.ArrayValue(nonNil(from)))
		ev.Set("to", jsfmt.ArrayValue(nonNil(to)))
		if err := addItsaEvent(conn, fieldEvents, actor, "field_order", &ev); err != nil {
			return err
		}
		out, err = fieldsOn(conn)
		return err
	})
	return out, err
}

// FieldValuesChange is what a write of field values changed: each key's value before and after.
type FieldValuesChange struct{ From, To jsfmt.Value }

// ApplyFieldValues is itsa.ts applyFieldValues inside the caller's transaction: it sets values by field key (null clears)
// and returns what changed, or false if nothing did.
// kind is the ITSA's kind, "" for none: it decides which fields apply.
func (t ItsaTx) ApplyFieldValues(itsaID string, values jsfmt.Value, actor, kind string) (FieldValuesChange, bool, error) {
	return applyFieldValues(t.conn, itsaID, values, actor, kind)
}

// checkedField is a field and the value checked for it, waiting to be written.
type checkedField struct{ f, v jsfmt.Value }

func applyFieldValues(conn *sqlite.Conn, itsaID string, values jsfmt.Value, actor, kind string) (FieldValuesChange, bool, error) {
	var ch FieldValuesChange
	if values.Kind != jsfmt.Object {
		return ch, false, fmt.Errorf("fields is an object of field key to value")
	}
	from, to := jsfmt.Value{Kind: jsfmt.Object}, jsfmt.Value{Kind: jsfmt.Object}
	done := map[string]bool{}
	var checked []checkedField
	for _, k := range values.Keys {
		if done[k] {
			continue
		}
		done[k] = true
		raw, _ := values.Get(k)
		f, ok, err := findFieldOn(conn, k)
		if err != nil {
			return ch, false, err
		}
		if !ok {
			all, err := fieldsOn(conn)
			if err != nil {
				return ch, false, err
			}
			keys := make([]string, len(all))
			for i, x := range all {
				keys[i] = x.Text("key")
			}
			list := strings.Join(keys, ", ")
			if list == "" {
				list = "none defined"
			}
			return ch, false, fmt.Errorf("no field %s; fields: %s", k, list)
		}
		opts, _ := f.Get("options")
		v, err := CheckFieldValue(f.Text("key"), f.Text("type"), opts, raw)
		if err != nil {
			return ch, false, err
		}
		// A value for a field that doesn't apply to the ITSA's kind is refused; clearing it is always allowed (S-3180).
		kinds, _ := f.Get("kinds")
		applies := true
		if v.Kind != jsfmt.Null {
			applies, err = FieldApplies(kinds, kind)
			if err != nil {
				return ch, false, fmt.Errorf("field %s: %w", f.Text("key"), err)
			}
		}
		if !applies {
			var names []string
			for _, x := range kinds.Items {
				names = append(names, jsStr(x))
			}
			what := kind + " ones"
			if kind == "" {
				what = "ITSAs with no kind"
			}
			return ch, false, fmt.Errorf("field %s applies only to %s ITSAs, not %s", f.Text("key"), strings.Join(names, ", "), what)
		}
		checked = append(checked, checkedField{f, v})
	}
	// Every value is checked before any is written, so a refused field leaves the others unset (S-3180).
	for _, c := range checked {
		f, v := c.f, c.v
		held, err := rows(conn, "SELECT value FROM itsa_field_values WHERE itsa_id = ? AND field_id = ?", itsaID, f.Text("id"))
		if err != nil {
			return ch, false, err
		}
		before := jsfmt.NullValue()
		if len(held) > 0 {
			if before, err = jsfmt.Parse([]byte(held[0].Text("value"))); err != nil {
				return ch, false, err
			}
		}
		if jsfmt.Compact(before) == jsfmt.Compact(v) {
			continue
		}
		if v.Kind == jsfmt.Null {
			err = runSQL(conn, "DELETE FROM itsa_field_values WHERE itsa_id = ? AND field_id = ?", itsaID, f.Text("id"))
		} else {
			err = runSQL(conn, "INSERT OR REPLACE INTO itsa_field_values (itsa_id, field_id, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)",
				itsaID, f.Text("id"), jsfmt.Compact(v), actor, now())
		}
		if err != nil {
			return ch, false, err
		}
		from.Set(f.Text("key"), before)
		to.Set(f.Text("key"), v)
	}
	if len(to.Keys) == 0 {
		return ch, false, nil
	}
	if err := runSQL(conn, "UPDATE itsas SET updated_at = ? WHERE id = ?", now(), itsaID); err != nil {
		return ch, false, err
	}
	return FieldValuesChange{From: from, To: to}, true, nil
}

// JSStr is JS String(v), and JSTrim String.prototype.trim, for callers outside the package.
func JSStr(v jsfmt.Value) string { return jsStr(v) }

func JSTrim(s string) string { return jsTrim(s) }
