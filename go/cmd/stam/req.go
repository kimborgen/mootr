package main

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"stam/internal/client"
	"stam/internal/jsfmt"
)

// The requirement, ring and permission commands of src/cli.ts (S-4154): `req`, `ring`, `permissions`, `authorize` and
// `deny`. The daemon judges who may; these send what the TS commands send and print what they print.

const reqUsage = "usage: stam req ls|show|new|set|link|check|seed"

// ringCall is the TS ring start's 180 s call: starting a ring spawns its members.
const ringCall = 180 * time.Second

// agentID is envVar('AGENT_ID'): MOOTR_AGENT_ID when it is set, else STAM_AGENT_ID.
func agentID(e env) string {
	if v := e.getenv("MOOTR_AGENT_ID"); v != "" {
		return v
	}
	return e.getenv("STAM_AGENT_ID")
}

// reqCmd is `stam req ls|show|new|set|link|check|seed`. As for itsa, the CLI acts as the agent when run inside one, else
// the human. The reference is put in the path as it was typed, as TS does.
func reqCmd(ctx context.Context, args []string, e env) error {
	sub, rest := "", args
	if len(args) > 0 {
		sub, rest = args[0], args[1:]
	}
	p, err := parseArgs(rest, optSpec{
		str: []string{"parent", "status", "level", "title", "text", "rationale", "source", "severity", "mode", "threshold", "owner",
			"kind", "role", "remove", "keys"},
		multi: []string{"verify", "scope"},
	})
	if err != nil {
		return err
	}
	by := agentID(e)
	c := client.New(e.getenv)
	call := func(method, path string, body any) (jsfmt.Value, error) {
		return getJSON(ctx, c, method, path, body, 0)
	}
	pos := p.pos
	first := ""
	if len(pos) > 0 {
		first = pos[0]
	}
	switch sub {
	case "check":
		body := newObject()
		setStr(&body, "text", p)
		if len(pos) > 0 {
			body.Set("subject", jsfmt.StringValue(first))
		}
		setStr(&body, "keys", p)
		r, err := call("POST", "/api/requirements/check", body)
		if err != nil {
			return err
		}
		results, _ := r.Get("results")
		none := ""
		if len(results.Items) == 0 {
			none = ": no requirement in scope, or no answer"
		}
		fmt.Fprintf(e.stdout, "%s%s\n", displayField(r, "subject"), none)
		for _, x := range results.Items {
			cached := ""
			if truthyMember(x, "cached") {
				cached = "\t(cached)"
			}
			fmt.Fprintf(e.stdout, "%s\t%s\tp(violates) %s%s\n", displayField(x, "key"), displayField(x, "verdict"), toFixed2(x, "p_violates"), cached)
		}
		return nil
	case "ls":
		var q []string
		for _, k := range []string{"status", "parent"} {
			if p.str[k] != "" {
				q = append(q, formEncode(k, p.str[k]))
			}
		}
		if len(pos) > 0 {
			q = append(q, formEncode("text", strings.Join(pos, " ")))
		}
		path := "/api/requirements"
		if len(q) > 0 {
			path += "?" + strings.Join(q, "&")
		}
		rows, err := call("GET", path, nil)
		if err != nil {
			return err
		}
		for _, x := range rows.Items {
			fmt.Fprintf(e.stdout, "%s %s %s %s\n", padEnd(displayField(x, "key"), 6), padEnd(jsMember(x, "status"), 10), padEnd(orDash(x, "owner"), 16), displayField(x, "title"))
		}
		return nil
	case "show":
		if first == "" {
			return errors.New("usage: stam req show REF")
		}
		x, err := call("GET", "/api/requirements/"+pathSegment(first), nil)
		if err != nil {
			return err
		}
		fmt.Fprintln(e.stdout, jsfmt.Stringify(x))
		return nil
	case "new":
		title := strings.Join(pos, " ")
		if title == "" {
			return errors.New("usage: stam req new TITLE [--parent REF] ...")
		}
		body, err := reqFields(p)
		if err != nil {
			return err
		}
		body.Set("title", jsfmt.StringValue(title))
		setBy(&body, by)
		x, err := call("POST", "/api/requirements", body)
		if err != nil {
			return err
		}
		fmt.Fprintf(e.stdout, "%s  %s\n", displayField(x, "key"), displayField(x, "title"))
		return nil
	case "set":
		patch, err := reqFields(p)
		if err != nil {
			return err
		}
		if first == "" || len(patch.Keys) == 0 {
			return errors.New("usage: stam req set REF [--status S] [--text T] ...")
		}
		setBy(&patch, by)
		r, err := call("PATCH", "/api/requirements/"+pathSegment(first), patch)
		if err != nil {
			return err
		}
		var changed []string
		if ch, ok := r.Get("changes"); ok {
			for i, k := range ch.Keys {
				changed = append(changed, fmt.Sprintf("%s: %s -> %s", k, orDash(ch.Items[i], "from"), orDash(ch.Items[i], "to")))
			}
		}
		x, _ := r.Get("requirement")
		summary := strings.Join(changed, "; ")
		if summary == "" {
			summary = "nothing changed"
		}
		fmt.Fprintf(e.stdout, "%s: %s\n", displayField(x, "key"), summary)
		return nil
	case "seed":
		// A JSON file of drafts, a list or {requirements: [...]} (docs/requirements-seed.json).
		if first == "" {
			return errors.New("usage: stam req seed FILE")
		}
		b, err := os.ReadFile(first)
		if err != nil {
			return err
		}
		raw, err := jsfmt.Parse(b)
		if err != nil {
			return fmt.Errorf("%s isn't JSON", first)
		}
		body := newObject()
		if raw.Kind == jsfmt.Array {
			body.Set("requirements", raw)
		} else if reqs, ok := raw.Get("requirements"); ok {
			body.Set("requirements", reqs)
		}
		setBy(&body, by)
		r, err := call("POST", "/api/requirements/batch", body)
		if err != nil {
			return err
		}
		out, _ := r.Get("requirements")
		for _, x := range out.Items {
			fmt.Fprintf(e.stdout, "%s %s\n", padEnd(displayField(x, "key"), 6), displayField(x, "title"))
		}
		note := ""
		if a, ok := r.Get("approval"); ok {
			if truthyMember(a, "itsa") {
				note = fmt.Sprintf("; approval ask %s (to %s)", displayField(a, "itsa"), displayField(a, "to"))
			} else if truthyMember(a, "error") {
				note = "; no ask: " + displayField(a, "error")
			}
		}
		fmt.Fprintf(e.stdout, "%d drafts%s\n", len(out.Items), note)
		return nil
	case "link":
		if first == "" {
			return errors.New("usage: stam req link REF TARGET [--kind K] [--role R] | stam req link REF --remove ID")
		}
		if rm := p.str["remove"]; rm != "" {
			if _, err := call("DELETE", "/api/requirements/"+pathSegment(first)+"/links/"+pathSegment(rm), nil); err != nil {
				return err
			}
			fmt.Fprintf(e.stdout, "removed link %s\n", rm)
			return nil
		}
		if len(pos) < 2 || pos[1] == "" {
			return errors.New("usage: stam req link REF TARGET [--kind K] [--role R]")
		}
		body := newObject()
		body.Set("target", jsfmt.StringValue(pos[1]))
		setStrAs(&body, "target_kind", "kind", p)
		setStr(&body, "role", p)
		r, err := call("POST", "/api/requirements/"+pathSegment(first)+"/links", body)
		if err != nil {
			return err
		}
		fmt.Fprintf(e.stdout, "link %s: %s %s %s\n", displayField(r, "id"), displayField(r, "target_kind"), displayField(r, "role"), displayField(r, "target"))
		return nil
	}
	return errors.New(reqUsage)
}

// reqFields is the TS fields(): the options given, a --threshold as Number(), --verify as {method, detail} or a bare
// method, and --scope field=a,b as {field: [a, b]}.
func reqFields(p parsed) (jsfmt.Value, error) {
	patch := newObject()
	for _, k := range []string{"title", "text", "rationale", "source", "level", "severity", "mode", "status", "owner", "parent"} {
		setStr(&patch, k, p)
	}
	if t, ok := p.str["threshold"]; ok {
		// Number(x): NaN and the infinities are written as null by JSON.stringify.
		if n, finite := jsNumber(t); finite {
			patch.Set("threshold", jsfmt.Value{Kind: jsfmt.Number, Num: formatJSNumber(n)})
		} else {
			patch.Set("threshold", jsfmt.NullValue())
		}
	}
	if vs, ok := p.multi["verify"]; ok {
		items := make([]jsfmt.Value, 0, len(vs))
		for _, s := range vs {
			method, detail, found := strings.Cut(s, ":")
			if !found {
				items = append(items, jsfmt.StringValue(s))
				continue
			}
			o := newObject()
			o.Set("method", jsfmt.StringValue(method))
			o.Set("detail", jsfmt.StringValue(detail))
			items = append(items, o)
		}
		patch.Set("verification", jsfmt.ArrayValue(items))
	}
	if ss := p.multi["scope"]; len(ss) > 0 {
		scope := newObject()
		for _, s := range ss {
			i := strings.Index(s, "=")
			if i < 1 {
				return jsfmt.Value{}, fmt.Errorf("--scope takes field=a,b (got %s)", s)
			}
			var vals []string
			for _, x := range strings.Split(s[i+1:], ",") {
				if x = strings.TrimSpace(x); x != "" {
					vals = append(vals, x)
				}
			}
			scope.Set(s[:i], stringArray(vals))
		}
		patch.Set("scope", scope)
	}
	return patch, nil
}

// jsMember is String(x[key]): "undefined" when the member is absent.
func jsMember(x jsfmt.Value, key string) string {
	v, ok := x.Get(key)
	if !ok {
		return "undefined"
	}
	return jsString(v)
}

// toFixed2 is `x[key]?.toFixed(2) ?? '-'`: a number rounded to two places, a tie away from zero as Number.prototype.toFixed
// rounds the exact binary value. A member that is absent or null is '-'.
func toFixed2(x jsfmt.Value, key string) string {
	m, ok := x.Get(key)
	if !ok || m.Kind == jsfmt.Null {
		return "-"
	}
	f, err := strconv.ParseFloat(m.Num, 64)
	if m.Kind != jsfmt.Number || err != nil {
		return "-"
	}
	r := new(big.Rat)
	if r.SetFloat64(f) == nil {
		return "-"
	}
	neg := r.Sign() < 0
	r.Abs(r)
	r.Mul(r, big.NewRat(100, 1))
	n := new(big.Int).Quo(r.Num(), r.Denom())
	frac := new(big.Rat).Sub(r, new(big.Rat).SetInt(n))
	if frac.Cmp(big.NewRat(1, 2)) >= 0 {
		n.Add(n, big.NewInt(1))
	}
	s := n.String()
	for len(s) < 3 {
		s = "0" + s
	}
	out := s[:len(s)-2] + "." + s[len(s)-2:]
	if neg && n.Sign() != 0 {
		out = "-" + out
	}
	return out
}

// ringCmd is `stam ring` (the rings), `stam ring NAME` (one, as JSON) and `stam ring NAME TOPIC... [options]` (start one).
func ringCmd(ctx context.Context, args []string, e env) error {
	p, err := parseArgs(args, optSpec{str: []string{"format", "members", "spawn", "moderator", "rounds", "cwd"}, bools: []string{"decide"}})
	if err != nil {
		return err
	}
	c := client.New(e.getenv)
	if len(p.pos) == 0 || p.pos[0] == "" {
		rows, err := getJSON(ctx, c, "GET", "/api/rings", nil, 0)
		if err != nil {
			return err
		}
		for _, r := range rows.Items {
			fmt.Fprintf(e.stdout, "%s  %s  %s  %s  round %s/%s\n", displayField(r, "id"), displayField(r, "name"), displayField(r, "format"),
				displayField(r, "status"), displayField(r, "round"), displayField(r, "max_rounds"))
		}
		return nil
	}
	name, topic := p.pos[0], p.pos[1:]
	if len(topic) == 0 {
		r, err := getJSON(ctx, c, "GET", "/api/rings/"+pathSegment(name), nil, 0)
		if err != nil {
			return err
		}
		fmt.Fprintln(e.stdout, jsfmt.Stringify(r))
		return nil
	}
	format := "rounds"
	if f, ok := p.str["format"]; ok {
		format = f
	}
	// --spawn takes presets or models, comma-separated: "fast,second-opinion" or "openrouter/deepseek/deepseek-v4.1-flash".
	var spawns []jsfmt.Value
	for _, s := range splitNonEmpty(p.str["spawn"]) {
		o := newObject()
		if strings.Contains(s, "/") || strings.HasPrefix(s, "claude-") {
			harness := "claude"
			if strings.Contains(s, "/") {
				harness = "opencode"
			}
			o.Set("harness", jsfmt.StringValue(harness))
			o.Set("model", jsfmt.StringValue(s))
		} else {
			o.Set("preset", jsfmt.StringValue(s))
		}
		spawns = append(spawns, o)
	}
	cwd := p.str["cwd"]
	if _, ok := p.str["cwd"]; !ok {
		if cwd, err = e.cwd(); err != nil {
			return err
		}
	}
	body := newObject()
	body.Set("name", jsfmt.StringValue(name))
	body.Set("topic", jsfmt.StringValue(strings.Join(topic, " ")))
	body.Set("format", jsfmt.StringValue(format))
	body.Set("members", stringArray(splitNonEmpty(p.str["members"])))
	body.Set("spawn", jsfmt.ArrayValue(spawns))
	setStr(&body, "moderator", p)
	if p.bools["decide"] {
		body.Set("moderator_decides", jsfmt.Value{Kind: jsfmt.Bool, Bool: true})
	}
	setStrAs(&body, "max_rounds", "rounds", p)
	body.Set("cwd", jsfmt.StringValue(cwd))
	// The creator: the daemon takes it from `by` (checked against the caller's token) or a human caller. TS's CLI sends
	// none, so inside an agent its ring start is refused with "a ring needs a creator".
	setBy(&body, agentID(e))
	r, err := getJSON(ctx, c, "POST", "/api/rings", body, ringCall)
	if err != nil {
		return err
	}
	fmt.Fprintf(e.stdout, "ring %s (%s) started; the result arrives in your inbox\n", displayField(r, "name"), displayField(r, "id"))
	return nil
}

// splitNonEmpty is `s.split(',').filter(Boolean)`.
func splitNonEmpty(s string) []string {
	out := []string{}
	for _, x := range strings.Split(s, ",") {
		if x != "" {
			out = append(out, x)
		}
	}
	return out
}

// permissions is `stam permissions`: the requests pending with the human, then the harness dialogs still with an agent's
// parent or the chief of staff (S-594), who deny one or send it on; `stam authorize` still approves one.
func permissions(ctx context.Context, e env) error {
	c := client.New(e.getenv)
	rows, err := getJSON(ctx, c, "GET", "/api/permissions?status=pending&audience=human", nil, 0)
	if err != nil {
		return err
	}
	for _, r := range rows.Items {
		details := ""
		if truthyMember(r, "details") {
			details = "\n        details: " + displayField(r, "details")
		}
		fmt.Fprintf(e.stdout, "%s  %s  %s\n        why: %s%s\n", displayField(r, "id"), displayField(r, "agent_id"), displayField(r, "action"), displayField(r, "reason"), details)
	}
	all, err := getJSON(ctx, c, "GET", "/api/permissions?status=pending&audience=delegate", nil, 0)
	if err != nil {
		return err
	}
	var delegated []jsfmt.Value
	for _, r := range all.Items {
		if truthyMember(r, "dialog") {
			delegated = append(delegated, r)
		}
	}
	if len(delegated) > 0 {
		fmt.Fprintln(e.stdout, "\nWith a parent or the chief of staff, who deny it or send it on to you:")
	}
	for _, r := range delegated {
		var names []string
		if w, ok := r.Get("with"); ok {
			for _, n := range w.Items {
				names = append(names, "@"+jsString(n))
			}
		}
		with := strings.Join(names, ", ")
		if with == "" {
			with = "its reviewers"
		}
		fmt.Fprintf(e.stdout, "%s  %s  %s\n        with: %s\n", displayField(r, "id"), displayField(r, "agent_id"), displayField(r, "action"), with)
	}
	return nil
}

// answer is `stam authorize|deny ID [NOTE...]`. Only the human answers from the CLI; the daemon judges the token too.
func answer(ctx context.Context, cmd string, args []string, e env) error {
	if agentID(e) != "" {
		return errors.New("only the human answers permission requests from the CLI")
	}
	id := ""
	if len(args) > 0 {
		id = args[0]
	}
	note := ""
	if len(args) > 1 {
		note = strings.Join(args[1:], " ")
	}
	body := map[string]any{"approve": cmd == "authorize", "note": note}
	r, err := getJSON(ctx, client.New(e.getenv), "POST", "/api/permissions/"+pathSegment(id)+"/answer", body, 0)
	if err != nil {
		return err
	}
	tail := ""
	if truthyMember(r, "typed") {
		tail = ", typed into the agent's input as yours"
	} else if displayField(r, "status") == "approved" {
		tail = "; the agent was busy or had a draft, so it got a notice instead"
	}
	fmt.Fprintf(e.stdout, "%s: %s%s\n", displayField(r, "id"), displayField(r, "status"), tail)
	return nil
}

// pathSegment is a reference typed on the command line as one escaped path segment, so a ref with a slash or a query
// can't reach another route; no ref is "undefined", as TS's template literal writes it.
func pathSegment(s string) string {
	if s == "" {
		return "undefined"
	}
	return url.PathEscape(s)
}
