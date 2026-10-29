package main

import (
	"context"
	"fmt"
	"strings"

	"stam/internal/client"
	"stam/internal/jsfmt"
)

// registry is `stam registry` (src/cli.ts): the agent types, presets, harnesses with their versions, and models the
// daemon's registry holds (GET /api/registry). `stam registry migrate-reviewers` is not ported.
func registry(ctx context.Context, args []string, e env) error {
	if len(args) > 0 && args[0] == "migrate-reviewers" {
		return fmt.Errorf("registry migrate-reviewers is not ported to the Go CLI yet")
	}
	r, err := getJSON(ctx, client.New(e.getenv), "GET", "/api/registry", nil, 0)
	if err != nil {
		return err
	}
	out := e.stdout
	section := func(key string) jsfmt.Value {
		v, _ := r.Get(key)
		return v
	}
	// target is `${harness}/${model ?? 'default'}${effort ? ` (${effort})` : ''}`.
	target := func(v jsfmt.Value) string {
		model := "default"
		if m, ok := v.Get("model"); ok && m.Kind != jsfmt.Null {
			model = tmpl(m, true)
		}
		s := tmpl(v.Get("harness")) + "/" + model
		if eff, ok := v.Get("effort"); ok && eff.Truthy() {
			s += " (" + tmpl(eff, true) + ")"
		}
		return s
	}
	fmt.Fprintln(out, "Agent types (stam spawn NAME --type T):")
	types := section("types")
	for i, n := range types.Keys {
		t := types.Items[i]
		what := "ring"
		if h, ok := t.Get("harness"); ok && h.Truthy() {
			what = target(t)
		}
		fmt.Fprintf(out, "  %s %s: %s\n", padEnd(n, 16), what, tmpl(t.Get("description")))
	}
	fmt.Fprintln(out, "Presets:")
	presets := section("presets")
	for i, n := range presets.Keys {
		p := presets.Items[i]
		fmt.Fprintf(out, "  %s %s: %s\n", padEnd(n, 16), target(p), tmpl(p.Get("description")))
	}
	fmt.Fprintln(out, "Harnesses:")
	harnesses := section("harnesses")
	for i, n := range harnesses.Keys {
		version := "not installed"
		if v, ok := harnesses.Items[i].Get("version"); ok && v.Kind != jsfmt.Null {
			version = tmpl(v, true)
		}
		fmt.Fprintf(out, "  %s %s\n", padEnd(n, 16), version)
	}
	fmt.Fprintln(out, "Models:")
	models := section("models")
	for i, n := range models.Keys {
		hs, _ := models.Items[i].Get("harnesses")
		names := make([]string, len(hs.Items))
		for j, h := range hs.Items {
			if h.Kind != jsfmt.Null {
				names[j] = tmpl(h, true)
			}
		}
		fmt.Fprintf(out, "  %s %s\n", padEnd(n, 48), strings.Join(names, ", "))
	}
	fmt.Fprintln(out, "Any other model name also works; it passes straight to the harness.")
	return nil
}

// tmpl is a value as a template literal shows it: "undefined" when absent, else String(v).
func tmpl(v jsfmt.Value, ok bool) string {
	if !ok {
		return "undefined"
	}
	return jsString(v)
}
