package main

import (
	"context"
	"errors"
	"fmt"
	"math"
	"math/big"
	"strconv"
	"strings"
	"time"

	"stam/internal/client"
	"stam/internal/jsfmt"
	"stam/internal/mcp"
)

var retroSpec = optSpec{
	str:   []string{"search", "plus-one", "kind", "title", "summary", "details", "target", "evidence", "evidence-detail", "when", "effort"},
	bools: []string{"final", "digest"},
}

// retro is `stam retro` (src/cli.ts): search, +1, file a retro item, or record the final round, as the agent it runs
// inside (STAM_AGENT_ID), through the same RunRetro the MCP tool runs; `--digest` mails the retro digest now.
func retro(ctx context.Context, args []string, e env) error {
	p, err := parseArgs(args, retroSpec)
	if err != nil {
		return err
	}
	c := client.New(e.getenv)
	// The digest now (S-161); the human or the shared token only, an agent's token is refused (S-587).
	if p.bools["digest"] {
		r, err := getJSON(ctx, c, "POST", "/api/retros/digest", map[string]any{}, 0)
		if err != nil {
			return err
		}
		if t, _ := r.Get("sent"); t.Truthy() {
			fmt.Fprintf(e.stdout, "Mailed the retro digest to %s.\n", jsText(r, "to"))
		} else {
			fmt.Fprintf(e.stdout, "No retro digest sent: %s.\n", jsText(r, "reason"))
		}
		return nil
	}
	by := e.getenv("STAM_AGENT_ID")
	if by == "" {
		return errors.New("stam retro files as an agent: run it inside one (STAM_AGENT_ID is not set)")
	}
	a := jsfmt.Value{Kind: jsfmt.Object}
	for _, k := range [][2]string{{"search", "search"}, {"plus_one", "plus-one"}} {
		if v, ok := p.str[k[1]]; ok {
			a.Set(k[0], jsfmt.StringValue(v))
		}
	}
	if p.bools["final"] {
		a.Set("final", jsfmt.Value{Kind: jsfmt.Bool, Bool: true})
	}
	// --effort reading=50,implementing=30 for the final round (--final).
	if v, ok := p.str["effort"]; ok && v != "" {
		effort := jsfmt.Value{Kind: jsfmt.Object}
		for _, kv := range strings.Split(v, ",") {
			// TS takes kv.split('=')'s second part: none is Number(undefined), NaN, and `a=1=2` reads 1.
			parts := strings.Split(kv, "=")
			n := jsfmt.StringValue("NaN")
			if len(parts) > 1 {
				n = jsNumberOf(parts[1])
			}
			effort.Set(strings.TrimSpace(parts[0]), n)
		}
		a.Set("effort", effort)
	}
	for _, k := range [][2]string{{"kind", "kind"}, {"title", "title"}, {"summary", "summary"}, {"details", "details"}, {"target", "target"},
		{"evidence", "evidence"}, {"evidence_detail", "evidence-detail"}, {"when", "when"}} {
		if v, ok := p.str[k[1]]; ok {
			a.Set(k[0], jsfmt.StringValue(v))
		}
	}
	call := func(ctx context.Context, method, path string, body any, timeout time.Duration) (jsfmt.Value, error) {
		return getJSON(ctx, c, method, path, body, timeout)
	}
	out, err := mcp.RunRetro(ctx, call, by, a)
	if err != nil {
		return err
	}
	fmt.Fprintln(e.stdout, out)
	return nil
}

// jsNumberOf is Number(s) for an --effort value: a number, or NaN, which the final round refuses as no percentage.
// Like Number, it reads unsigned 0x, 0o and 0b integers of any size.
func jsNumberOf(s string) jsfmt.Value {
	t := strings.TrimSpace(s)
	if t == "" {
		return jsfmt.Value{Kind: jsfmt.Number, Num: "0"}
	}
	f, err := strconv.ParseFloat(t, 64)
	if len(t) > 2 && t[0] == '0' {
		if base, ok := map[byte]int{'x': 16, 'o': 8, 'b': 2}[t[1]|0x20]; ok {
			err = nil
			n, okN := new(big.Int).SetString(t[2:], base)
			if !okN || t[2] == '+' || t[2] == '-' {
				err = strconv.ErrSyntax
			} else {
				f, _ = new(big.Float).SetInt(n).Float64()
			}
		}
	}
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) || strings.ContainsAny(strings.ToLower(t), "in_") {
		return jsfmt.StringValue("NaN")
	}
	return jsfmt.Value{Kind: jsfmt.Number, Num: strconv.FormatFloat(f, 'g', -1, 64)}
}

// jsText is a member as a template string shows it.
func jsText(v jsfmt.Value, key string) string {
	m, ok := v.Get(key)
	switch {
	case !ok:
		return "undefined"
	case m.Kind == jsfmt.Null:
		return "null"
	case m.Kind == jsfmt.String:
		return m.Str
	}
	return jsfmt.Compact(m)
}
