package main

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"unicode/utf16"

	"stam/internal/client"
	"stam/internal/fieldsline"
	"stam/internal/jsfmt"
)

const itsaUsage = "usage: stam itsa ls|show|new|set|field|post|thread|link"

// itsaCmd is `stam itsa ls|show|new|set|field|post|thread|mails|link` (src/cli.ts). The reference is put in the path as it
// was typed, as TS does.
func itsaCmd(ctx context.Context, args []string, e env) error {
	if len(args) == 0 {
		return errors.New(itsaUsage)
	}
	sub, rest := args[0], args[1:]
	p, err := parseArgs(rest, optSpec{
		str: []string{"parent", "subtree", "status", "category", "owner", "kind", "since", "title", "summary", "body", "update", "system", "override",
			"external-id", "repo", "remove", "type", "label", "description", "hint", "width", "align", "card", "if-status"},
		multi: []string{"participant", "link", "to", "field", "option"},
		bools: []string{"json"},
	})
	if err != nil {
		return err
	}
	// An ITSA action is the agent's own when the CLI runs inside one (STAM_AGENT_ID); otherwise it is the human's.
	by := e.getenv("STAM_AGENT_ID")
	c := client.New(e.getenv)
	call := func(method, path string, body any) (jsfmt.Value, error) {
		return getJSON(ctx, c, method, path, body, 0)
	}
	pos := p.pos
	switch sub {
	case "ls":
		var q []string
		for _, k := range []string{"parent", "subtree", "status", "category", "owner", "kind"} {
			if p.str[k] != "" {
				q = append(q, formEncode(k, p.str[k]))
			}
		}
		if len(p.multi["participant"]) > 0 {
			q = append(q, formEncode("participant", p.multi["participant"][0]))
		}
		if len(pos) > 0 {
			q = append(q, formEncode("text", strings.Join(pos, " ")))
		}
		// --since is passed as typed; the daemon reads it and refuses a bad one (S-1396).
		if since, ok := p.str["since"]; ok {
			q = append(q, formEncode("since", since))
		}
		path := "/api/itsas"
		if len(q) > 0 {
			path += "?" + strings.Join(q, "&")
		}
		rows, err := call("GET", path, nil)
		if err != nil {
			return err
		}
		if p.bools["json"] {
			fmt.Fprintln(e.stdout, jsfmt.Stringify(rows))
			return nil
		}
		for _, x := range rows.Items {
			fmt.Fprintf(e.stdout, "%s %s %s %s\n", padEnd(displayField(x, "key"), 6), padEnd(displayField(x, "status"), 14), padEnd(orDash(x, "owner"), 16), displayField(x, "title"))
		}
		return nil
	case "show":
		if len(pos) == 0 || pos[0] == "" {
			return errors.New("usage: stam itsa show REF")
		}
		x, err := call("GET", "/api/itsas/"+pos[0], nil)
		if err != nil {
			return err
		}
		fmt.Fprintln(e.stdout, jsfmt.Stringify(x))
		return nil
	case "new":
		title := strings.Join(pos, " ")
		if title == "" {
			return errors.New("usage: stam itsa new TITLE [--parent REF] ...")
		}
		body := newObject()
		body.Set("title", jsfmt.StringValue(title))
		for _, k := range []string{"parent", "kind", "status", "owner", "summary", "body"} {
			setStr(&body, k, p)
		}
		if ps := p.multi["participant"]; len(ps) > 0 {
			body.Set("participants", stringArray(ps))
		}
		links := make([]jsfmt.Value, 0, len(p.multi["link"]))
		for _, u := range p.multi["link"] {
			l := newObject()
			l.Set("url", jsfmt.StringValue(u))
			links = append(links, l)
		}
		body.Set("links", jsfmt.ArrayValue(links))
		setBy(&body, by)
		setStrAs(&body, "as_system", "system", p)
		x, err := call("POST", "/api/itsas", body)
		if err != nil {
			return err
		}
		fmt.Fprintf(e.stdout, "%s  %s\n", displayField(x, "key"), displayField(x, "title"))
		return nil
	case "set":
		return itsaSet(call, p, by, e)
	case "field":
		return itsaField(call, p, by, e)
	case "post":
		if len(pos) == 0 || pos[0] == "" || strings.Join(pos[1:], " ") == "" {
			return errors.New("usage: stam itsa post REF BODY [--update HEALTH] [--to REF]...")
		}
		body := newObject()
		body.Set("body", jsfmt.StringValue(strings.Join(pos[1:], " ")))
		kind := "comment"
		if p.str["update"] != "" {
			kind = "update"
		}
		body.Set("kind", jsfmt.StringValue(kind))
		setStrAs(&body, "health", "update", p)
		if to := p.multi["to"]; len(to) > 0 {
			body.Set("to", stringArray(to))
		}
		setStr(&body, "override", p)
		setBy(&body, by)
		setStrAs(&body, "as_system", "system", p)
		m, err := call("POST", "/api/itsas/"+pos[0]+"/post", body)
		if err != nil {
			return err
		}
		fmt.Fprintf(e.stdout, "posted %s in thread %s\n", displayField(m, "id"), displayField(m, "thread_id"))
		return nil
	case "thread":
		if len(pos) == 0 || pos[0] == "" {
			return errors.New("usage: stam itsa thread REF")
		}
		t, err := call("GET", "/api/itsas/"+pos[0]+"/thread", nil)
		if err != nil {
			return err
		}
		items, _ := t.Get("items")
		for _, i := range items.Items {
			if displayField(i, "type") == "event" {
				fmt.Fprintf(e.stdout, "%s  -- %s\n", displayField(i, "ts"), displayField(i, "text"))
				continue
			}
			m, _ := i.Get("mail")
			update := ""
			if displayField(m, "kind") == "update" {
				update = " [update " + displayField(m, "health") + "]"
			}
			first, _, _ := strings.Cut(displayField(m, "body"), "\n")
			fmt.Fprintf(e.stdout, "%s  %s%s: %s\n", displayField(i, "ts"), displayField(m, "from_name"), update, first)
		}
		return nil
	case "mails":
		// The mails of an ITSA's own thread as this daemon holds it (no peer fan-out), as JSON: scripts/merge-pr.mjs reads the
		// user's mailed yes (S-1490).
		if len(pos) == 0 || pos[0] == "" {
			return errors.New("usage: stam itsa mails REF")
		}
		t, err := call("GET", "/api/itsas/"+pos[0]+"/thread?local=1", nil)
		if err != nil {
			return err
		}
		items, _ := t.Get("items")
		out := make([]jsfmt.Value, 0, len(items.Items))
		for _, i := range items.Items {
			if displayField(i, "type") != "mail" {
				continue
			}
			m, _ := i.Get("mail")
			row := newObject()
			for _, k := range []string{"id", "thread_id", "from_id", "kind", "created_at", "reply_to", "subject", "body"} {
				v, ok := m.Get(k)
				if k == "kind" || k == "reply_to" {
					// m.kind ?? null
					if !ok || v.Kind == jsfmt.Null {
						v, ok = jsfmt.NullValue(), true
					}
				}
				if ok {
					row.Set(k, v)
				}
			}
			out = append(out, row)
		}
		fmt.Fprintln(e.stdout, jsfmt.Compact(jsfmt.ArrayValue(out)))
		return nil
	case "link":
		const use = "usage: stam itsa link REF URL | stam itsa link REF --system branch --external-id BRANCH --repo REPO | stam itsa link REF --remove N"
		if len(pos) == 0 || pos[0] == "" {
			return errors.New(use)
		}
		ref := pos[0]
		if rm := p.str["remove"]; rm != "" {
			body := newObject()
			setBy(&body, by)
			if _, err := call("DELETE", "/api/itsas/"+ref+"/links/"+rm, body); err != nil {
				return err
			}
			fmt.Fprintf(e.stdout, "removed link %s\n", rm)
			return nil
		}
		u := ""
		if len(pos) > 1 {
			u = pos[1]
		}
		if u == "" && p.str["system"] != "branch" {
			return errors.New("usage: stam itsa link REF URL | stam itsa link REF --system branch --external-id BRANCH --repo REPO")
		}
		body := newObject()
		body.Set("url", jsfmt.StringValue(u))
		setStr(&body, "system", p)
		setStrAs(&body, "external_id", "external-id", p)
		setStr(&body, "repo", p)
		setBy(&body, by)
		r, err := call("POST", "/api/itsas/"+ref+"/links", body)
		if err != nil {
			return err
		}
		l, _ := r.Get("link")
		fmt.Fprintf(e.stdout, "link %s: %s %s\n", displayField(l, "n"), displayField(l, "system"), displayField(l, "url"))
		return nil
	}
	return errors.New(itsaUsage)
}

type apiCall func(method, path string, body any) (jsfmt.Value, error)

func itsaSet(call apiCall, p parsed, by string, e env) error {
	ref := ""
	if len(p.pos) > 0 {
		ref = p.pos[0]
	}
	patch := newObject()
	for _, k := range []string{"title", "summary", "body", "kind", "status", "owner", "parent"} {
		setStr(&patch, k, p)
	}
	if ps := p.multi["participant"]; len(ps) > 0 {
		patch.Set("participants", stringArray(ps))
	}
	// Compare-and-set (S-3802): refused, as "status changed", unless the ITSA is still in this status.
	setStrAs(&patch, "ifStatus", "if-status", p)
	if fs := p.multi["field"]; len(fs) > 0 {
		// Values are typed by their field: a number field takes a finite number, a check true or false, the rest strings.
		defs, err := call("GET", "/api/itsas/fields", nil)
		if err != nil {
			return err
		}
		fields := newObject()
		for _, kv := range fs {
			i := strings.Index(kv, "=")
			if i < 1 {
				return fmt.Errorf("--field takes key=value (key= clears), got %s", kv)
			}
			key, raw := kv[:i], kv[i+1:]
			if raw == "" {
				fields.Set(key, jsfmt.NullValue())
				continue
			}
			typ := ""
			for _, d := range defs.Items {
				if d.Text("key") == key || d.Text("id") == key {
					typ = d.Text("type")
					break
				}
			}
			switch typ {
			case "number":
				n, ok := jsNumber(raw)
				if !ok {
					return fmt.Errorf("field %s is a number: %s isn't one", key, raw)
				}
				fields.Set(key, jsfmt.Value{Kind: jsfmt.Number, Num: formatJSNumber(n)})
			case "check":
				if raw != "true" && raw != "false" {
					return fmt.Errorf("field %s is a check: use true or false, not %s", key, raw)
				}
				fields.Set(key, jsfmt.Value{Kind: jsfmt.Bool, Bool: raw == "true"})
			default:
				fields.Set(key, jsfmt.StringValue(raw))
			}
		}
		patch.Set("fields", fields)
	}
	if ref == "" || len(patch.Keys) == 0 {
		return errors.New("usage: stam itsa set REF [--status S] [--owner REF] ...")
	}
	// --system NAME acts as a local script (the deploy watcher, S-474), not as the human.
	setBy(&patch, by)
	setStrAs(&patch, "as_system", "system", p)
	r, err := call("PATCH", "/api/itsas/"+ref, patch)
	if err != nil {
		return err
	}
	var changed []string
	if ch, ok := r.Get("changes"); ok {
		for i, k := range ch.Keys {
			if k == "fields" {
				changed = append(changed, fieldsline.Change(ch.Items[i]))
				continue
			}
			changed = append(changed, fmt.Sprintf("%s: %s -> %s", k, orDash(ch.Items[i], "from"), orDash(ch.Items[i], "to")))
		}
	}
	x, _ := r.Get("itsa")
	summary := strings.Join(changed, "; ")
	if summary == "" {
		summary = "nothing changed"
	}
	fmt.Fprintf(e.stdout, "%s: %s\n", displayField(x, "key"), summary)
	if truthyMember(r, "retro_offer") {
		fmt.Fprintf(e.stdout, "\n%s\n", displayField(r, "retro_offer"))
	}
	return nil
}

func itsaField(call apiCall, p parsed, by string, e env) error {
	op, rest := "", []string(nil)
	if len(p.pos) > 0 {
		op, rest = p.pos[0], p.pos[1:]
	}
	showField := func(f jsfmt.Value) string {
		s := padEnd(displayField(f, "key"), 12) + " " + padEnd(displayField(f, "type"), 7) + " " + displayField(f, "label")
		if o, ok := f.Get("options"); ok && o.Truthy() {
			var vals []string
			for _, x := range o.Items {
				vals = append(vals, orEmpty(x, "value"))
			}
			s += " (" + strings.Join(vals, "|") + ")"
		}
		if truthyMember(f, "description") {
			s += " — " + displayField(f, "description")
		}
		return s
	}
	body := newObject()
	setBy(&body, by)
	for _, k := range []string{"label", "type", "description", "hint", "width", "align", "card"} {
		setStr(&body, k, p)
	}
	// Options named again keep their label and tone; new ones start bare. On `set`, the list given replaces the old one.
	if opts := p.multi["option"]; len(opts) > 0 {
		var old []jsfmt.Value
		if op == "set" && len(rest) > 0 && rest[0] != "" {
			defs, err := call("GET", "/api/itsas/fields", nil)
			if err != nil {
				return err
			}
			for _, f := range defs.Items {
				if f.Text("key") == rest[0] || f.Text("id") == rest[0] {
					if o, ok := f.Get("options"); ok && o.Kind == jsfmt.Array {
						old = o.Items
					}
					break
				}
			}
		}
		list := make([]jsfmt.Value, 0, len(opts))
		for _, v := range opts {
			found := false
			for _, o := range old {
				if o.Text("value") == v {
					list, found = append(list, o), true
					break
				}
			}
			if !found {
				o := newObject()
				o.Set("value", jsfmt.StringValue(v))
				list = append(list, o)
			}
		}
		body.Set("options", jsfmt.ArrayValue(list))
	}
	switch op {
	case "", "ls":
		defs, err := call("GET", "/api/itsas/fields", nil)
		if err != nil {
			return err
		}
		for _, f := range defs.Items {
			fmt.Fprintln(e.stdout, showField(f))
		}
		return nil
	case "new":
		if len(rest) == 0 || rest[0] == "" || (len(rest) == 1 && p.str["label"] == "") || p.str["type"] == "" {
			return errors.New("usage: stam itsa field new KEY LABEL --type text|number|choice|link|date|check [--option VALUE]... [--description T]")
		}
		body.Set("key", jsfmt.StringValue(rest[0]))
		label := strings.Join(rest[1:], " ")
		if l, ok := p.str["label"]; ok {
			label = l
		}
		body.Set("label", jsfmt.StringValue(label))
		f, err := call("POST", "/api/itsas/fields", body)
		if err != nil {
			return err
		}
		fmt.Fprintln(e.stdout, showField(f))
		return nil
	case "set":
		if len(rest) == 0 || rest[0] == "" {
			return errors.New("usage: stam itsa field set KEY [--label T] [--type T] [--description T] [--option V]...")
		}
		f, err := call("PATCH", "/api/itsas/fields/"+rest[0], body)
		if err != nil {
			return err
		}
		fmt.Fprintln(e.stdout, showField(f))
		return nil
	case "rm":
		if len(rest) == 0 || rest[0] == "" {
			return errors.New("usage: stam itsa field rm KEY")
		}
		d := newObject()
		setBy(&d, by)
		if _, err := call("DELETE", "/api/itsas/fields/"+rest[0], d); err != nil {
			return err
		}
		fmt.Fprintf(e.stdout, "removed field %s and its values\n", rest[0])
		return nil
	case "order":
		o := newObject()
		o.Set("order", stringArray(rest))
		setBy(&o, by)
		fs, err := call("POST", "/api/itsas/fields/order", o)
		if err != nil {
			return err
		}
		for _, f := range fs.Items {
			fmt.Fprintln(e.stdout, showField(f))
		}
		return nil
	}
	return errors.New("usage: stam itsa field ls|new|set|rm|order")
}

func newObject() jsfmt.Value { return jsfmt.Value{Kind: jsfmt.Object} }

// setStr, setStrAs and setBy add a member the way JSON.stringify keeps one: only when the option was given.
func setStr(o *jsfmt.Value, key string, p parsed) { setStrAs(o, key, key, p) }

func setStrAs(o *jsfmt.Value, key, opt string, p parsed) {
	if v, ok := p.str[opt]; ok {
		o.Set(key, jsfmt.StringValue(v))
	}
}

func setBy(o *jsfmt.Value, by string) {
	if by != "" {
		o.Set("by", jsfmt.StringValue(by))
	}
}

func stringArray(l []string) jsfmt.Value {
	items := make([]jsfmt.Value, 0, len(l))
	for _, s := range l {
		items = append(items, jsfmt.StringValue(s))
	}
	return jsfmt.ArrayValue(items)
}

// padEnd is String.prototype.padEnd, which counts UTF-16 code units.
func padEnd(s string, n int) string {
	if l := len(utf16.Encode([]rune(s))); l < n {
		return s + strings.Repeat(" ", n-l)
	}
	return s
}

// jsString is String(v) in a template literal.
func jsString(v jsfmt.Value) string {
	switch v.Kind {
	case jsfmt.Null:
		return "null"
	case jsfmt.Bool:
		return strconv.FormatBool(v.Bool)
	case jsfmt.Array:
		parts := make([]string, len(v.Items))
		for i, x := range v.Items {
			if x.Kind != jsfmt.Null {
				parts[i] = jsString(x)
			}
		}
		return strings.Join(parts, ",")
	case jsfmt.Object:
		return "[object Object]"
	}
	return displayValue(v)
}

// orDash is `x[key] ?? '-'`.
func orDash(x jsfmt.Value, key string) string {
	m, ok := x.Get(key)
	if !ok || m.Kind == jsfmt.Null {
		return "-"
	}
	return jsString(m)
}

// orEmpty is a member in a join: null and a missing one are the empty string.
func orEmpty(x jsfmt.Value, key string) string {
	m, ok := x.Get(key)
	if !ok || m.Kind == jsfmt.Null {
		return ""
	}
	return jsString(m)
}

// formEncode is one `key=value` of URLSearchParams: a space is +, and only letters, digits and *-._ stay as they are.
func formEncode(k, v string) string {
	enc := func(s string) string {
		var b strings.Builder
		for _, c := range []byte(s) {
			switch {
			case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '*', c == '-', c == '.', c == '_':
				b.WriteByte(c)
			case c == ' ':
				b.WriteByte('+')
			default:
				fmt.Fprintf(&b, "%%%02X", c)
			}
		}
		return b.String()
	}
	return enc(k) + "=" + enc(v)
}

// jsNumber is Number(s) for a non-empty string, and whether the result is finite.
func jsNumber(s string) (float64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, true
	}
	base := 0
	switch {
	case strings.HasPrefix(s, "0x"), strings.HasPrefix(s, "0X"):
		base = 16
	case strings.HasPrefix(s, "0o"), strings.HasPrefix(s, "0O"):
		base = 8
	case strings.HasPrefix(s, "0b"), strings.HasPrefix(s, "0B"):
		base = 2
	}
	if base != 0 {
		n, err := strconv.ParseUint(s[2:], base, 64)
		return float64(n), err == nil
	}
	if strings.ContainsAny(s, "_pP") || strings.HasPrefix(s, "+0x") || strings.HasPrefix(strings.ToLower(s), "inf") || strings.HasPrefix(strings.ToLower(s), "nan") {
		return 0, false
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsInf(f, 0) || math.IsNaN(f) {
		return 0, false
	}
	return f, true
}

// formatJSNumber is how JSON.stringify writes a finite number.
func formatJSNumber(f float64) string {
	if f == 0 {
		return "0"
	}
	if a := math.Abs(f); a >= 1e-6 && a < 1e21 {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	s := strconv.FormatFloat(f, 'e', -1, 64)
	mant, exp, _ := strings.Cut(s, "e")
	sign := exp[:1]
	exp = strings.TrimLeft(exp[1:], "0")
	return mant + "e" + sign + exp
}
