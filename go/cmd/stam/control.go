package main

import (
	"context"
	"fmt"
	"math"
	"strings"
	"time"
	"unicode/utf16"

	"stam/internal/client"
	"stam/internal/jsfmt"
)

// The agent commands of src/cli.ts (S-4057): `ls`, the agent-control actions (`pause`, `unpause`, `shutdown`,
// `archive`, `resume`, `restart`, `reconnect-mcp`, `compact`), `rename`, `reparent` and `child-notices`. The daemon's
// agent-control route judges who may; these send what the TS commands send and print what they print.

// controlCmds are the actions sent to POST /api/agents/AGENT/ACTION as they are named.
var controlCmds = map[string]bool{"pause": true, "unpause": true, "shutdown": true, "archive": true, "resume": true,
	"restart": true, "reconnect-mcp": true, "compact": true}

var controlSpec = optSpec{bools: []string{"now", "force", "discard", "force-unpushed"}}

// control is `stam ACTION AGENT [TEXT...]`: TEXT is the note, reason and instructions at once, as in TS.
func control(ctx context.Context, cmd string, args []string, e env) error {
	p, err := parseArgs(args, controlSpec)
	if err != nil {
		return err
	}
	ref, err := arg(p.pos, "stam "+cmd+" AGENT")
	if err != nil {
		return err
	}
	// { ...values, force_unpushed, note, reason, instructions }: an option not given and an empty text are left out.
	body := map[string]any{}
	for k := range p.bools {
		body[k] = true
	}
	if p.bools["force-unpushed"] {
		body["force_unpushed"] = true
	}
	if text := strings.Join(p.pos[1:], " "); text != "" {
		body["note"], body["reason"], body["instructions"] = text, text, text
	}
	r, err := getJSON(ctx, client.New(e.getenv), "POST", "/api/agents/"+ref+"/"+cmd, body, 0)
	if err != nil {
		return err
	}
	a, _ := r.Get("agent")
	fmt.Fprintf(e.stdout, "%s: %s\n", displayField(a, "name"), displayField(r, "result"))
	return nil
}

// renameOrReparent is `stam rename AGENT NAME` and `stam reparent AGENT [PARENT...]`; no parent makes it top-level.
func renameOrReparent(ctx context.Context, cmd string, args []string, e env) error {
	ref, err := arg(args, "stam "+cmd+" AGENT")
	if err != nil {
		return err
	}
	body, action := map[string]any{"parent": append([]string{}, args[1:]...)}, "set-parent"
	if cmd == "rename" {
		body, action = map[string]any{}, "rename"
		if len(args) > 1 {
			body["name"] = args[1]
		}
	}
	r, err := getJSON(ctx, client.New(e.getenv), "POST", "/api/agents/"+ref+"/"+action, body, 0)
	if err != nil {
		return err
	}
	fmt.Fprintln(e.stdout, displayField(r, "result"))
	return nil
}

// childNotices is `stam child-notices AGENT turn|tree-idle|none`.
func childNotices(ctx context.Context, args []string, e env) error {
	ref, err := arg(args, "stam child-notices AGENT turn|tree-idle|none")
	if err != nil {
		return err
	}
	body := map[string]any{}
	if len(args) > 1 {
		body["child_notices"] = args[1]
	}
	r, err := getJSON(ctx, client.New(e.getenv), "POST", "/api/agents/"+ref+"/set-child-notices", body, 0)
	if err != nil {
		return err
	}
	// r.agent?.name ?? ref
	name := args[0]
	if a, ok := r.Get("agent"); ok {
		if n, ok := a.Get("name"); ok && n.Kind != jsfmt.Null {
			name = displayValue(n)
		}
	}
	fmt.Fprintf(e.stdout, "%s: %s\n", name, displayField(r, "result"))
	return nil
}

// ls is `stam ls [--all]`: live agents, or with --all stopped and archived ones too, as a padded table.
func ls(ctx context.Context, args []string, e env) error {
	path := "/api/agents"
	if has(args, "--all") {
		path += "?state=all"
	}
	v, err := getJSON(ctx, client.New(e.getenv), "GET", path, nil, 0)
	if err != nil {
		return err
	}
	now := time.Now()
	rows := [][]string{{"ID", "NAME", "MACHINE", "HARNESS", "STATE", "DETAIL", "CTX", "AGE"}}
	for _, a := range v.Items {
		harness := displayField(a, "harness")
		if m, ok := a.Get("model"); ok && m.Truthy() {
			harness += "/" + displayField(a, "model")
		}
		detail := ""
		if d, ok := a.Get("activity_detail"); ok && d.Kind != jsfmt.Null {
			detail = jsSlice(displayField(a, "activity_detail"), 40)
		}
		rows = append(rows, []string{displayField(a, "id"), displayField(a, "name"), displayField(a, "machine"), harness,
			jsState(a), detail, kTokens(a), age(a.Text("updated_at"), now)})
	}
	widths := make([]int, len(rows[0]))
	for _, r := range rows {
		for i, c := range r {
			widths[i] = max(widths[i], jsLen(c))
		}
	}
	for _, r := range rows {
		cells := make([]string, len(r))
		for i, c := range r {
			cells[i] = c + strings.Repeat(" ", widths[i]-jsLen(c))
		}
		fmt.Fprintln(e.stdout, strings.Join(cells, "  "))
	}
	return nil
}

// jsState is agentState as String() prints it: a missing activity or lifecycle is "undefined", a null one "null".
func jsState(a jsfmt.Value) string {
	if r, ok := a.Get("resting"); ok && r.Truthy() {
		return "resting"
	}
	if a.Text("lifecycle") == "active" {
		return displayField(a, "activity")
	}
	return displayField(a, "lifecycle")
}

// kTokens is src/cli.ts k: the context tokens in thousands, "-" when unknown.
func kTokens(a jsfmt.Value) string {
	v, ok := a.Get("context_tokens")
	if !ok || v.Kind == jsfmt.Null {
		return "-"
	}
	var n float64
	fmt.Sscan(v.Num, &n)
	return jsRound(n/1000) + "k"
}

// age is src/cli.ts age: how long ago iso was, in seconds, minutes or hours, rounded as Math.round rounds.
func age(iso string, now time.Time) string {
	t, err := time.Parse(time.RFC3339Nano, iso)
	if err != nil {
		if t, err = time.ParseInLocation("2006-01-02 15:04:05", iso, time.Local); err != nil {
			return "NaNh"
		}
	}
	s := math.Floor(float64(now.Sub(t).Milliseconds())/1000 + 0.5)
	switch {
	case s < 60:
		return jsRound(s) + "s"
	case s < 3600:
		return jsRound(s/60) + "m"
	}
	return jsRound(s/3600) + "h"
}

// jsRound is Math.round printed: half rounds up, and -0 prints as 0.
func jsRound(x float64) string {
	r := math.Floor(x + 0.5)
	if r == 0 {
		r = 0
	}
	return fmt.Sprintf("%.0f", r)
}

// jsLen is a string's JS length, in UTF-16 code units, which padEnd counts.
func jsLen(s string) int { return len(utf16.Encode([]rune(s))) }

// jsSlice is s.slice(0, n) in UTF-16 code units.
func jsSlice(s string, n int) string {
	u := utf16.Encode([]rune(s))
	if len(u) <= n {
		return s
	}
	return string(utf16.Decode(u[:n]))
}
