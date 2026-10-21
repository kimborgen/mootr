package main

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"stam/internal/client"
	"stam/internal/jsfmt"
)

// spawnUsage is the spawn lines of src/cli.ts USAGE, printed alone when spawn gets no NAME or --help.
const spawnUsage = `  stam spawn NAME [--type T] [--var KEY=VALUE]... [--role TEXT] [--preset P | --harness claude|opencode|codex --model M --effort E] [--cwd DIR] [--parent AGENT] [--itsa ID|KEY] [--machine M] [--urgent red-main|deploy-hold|approved-pr|incident]
             [--worktree [--branch B] [--base REF] | --workspace-script CMD | --workspace-instructions TEXT] [--standing] [--workspace[=NAME]  (the name only with "=", never a separate word)] [PROMPT]
`

// remoteSpawnTimeout is how long a spawn on another machine may wait for that peer to start and deploy (S-234, S-236).
const remoteSpawnTimeout = 960 * time.Second

var workspaceName = regexp.MustCompile(`^[a-z0-9-]+$`)

// arg is the command's one AGENT argument.
func arg(args []string, use string) (string, error) {
	if len(args) == 0 || args[0] == "" {
		return "", &exitError{code: 1, msg: "usage: " + use}
	}
	return url.PathEscape(args[0]), nil
}

// getJSON calls the daemon and parses the reply.
func getJSON(ctx context.Context, c *client.Client, method, path string, body any, timeout time.Duration) (jsfmt.Value, error) {
	raw, err := c.Do(ctx, method, path, body, timeout)
	if err != nil {
		return jsfmt.Value{}, err
	}
	v, err := jsfmt.Parse(raw)
	if err != nil {
		return jsfmt.Value{}, errors.New("the daemon's reply isn't JSON")
	}
	return v, nil
}

func show(ctx context.Context, args []string, e env) error {
	id, err := arg(args, "stam show AGENT")
	if err != nil {
		return err
	}
	v, err := getJSON(ctx, client.New(e.getenv), "GET", "/api/agents/"+id, nil, 0)
	if err != nil {
		return err
	}
	fmt.Fprintln(e.stdout, jsfmt.Stringify(v))
	return nil
}

func events(ctx context.Context, args []string, e env) error {
	p, err := parseArgs(args, optSpec{str: []string{"type", "limit"}})
	if err != nil {
		return err
	}
	if len(p.pos) == 0 {
		return &exitError{code: 1, msg: "usage: stam events AGENT [--type GLOB] [--limit N]"}
	}
	q := url.Values{}
	if t := p.str["type"]; t != "" {
		q.Set("type", t)
	}
	if l := p.str["limit"]; l != "" {
		q.Set("limit", l)
	}
	qs := ""
	if len(q) > 0 {
		qs = "?" + q.Encode()
	}
	v, err := getJSON(ctx, client.New(e.getenv), "GET", "/api/agents/"+url.PathEscape(p.pos[0])+"/events"+qs, nil, 0)
	if err != nil {
		return err
	}
	// console.log(e.ts, e.type, e.data ?? ''): the three joined by a space, a missing data as the empty string.
	for _, ev := range v.Items {
		data := ""
		if d, ok := ev.Get("data"); ok && d.Kind != jsfmt.Null {
			data = displayValue(d)
		}
		fmt.Fprintf(e.stdout, "%s %s %s\n", displayField(ev, "ts"), displayField(ev, "type"), data)
	}
	return nil
}

// displayField is what console.log prints for a member: a string as is, undefined as "undefined".
func displayField(v jsfmt.Value, key string) string {
	m, ok := v.Get(key)
	if !ok {
		return "undefined"
	}
	return displayValue(m)
}

// displayValue is console.log's text for one argument: a string as is, anything else inspected.
func displayValue(v jsfmt.Value) string {
	if v.Kind == jsfmt.String {
		return v.Str
	}
	return jsfmt.Inspect(v)
}

func wait(ctx context.Context, args []string, e env) error {
	p, err := parseArgs(args, optSpec{str: []string{"until", "timeout"}})
	if err != nil {
		return err
	}
	if len(p.pos) == 0 {
		return &exitError{code: 1, msg: "usage: stam wait AGENT [--until STATE[,STATE]...] [--timeout SECONDS]"}
	}
	until, timeout := orDefault(p.str["until"], "idle"), orDefault(p.str["timeout"], "120")
	secs, err := strconv.ParseFloat(timeout, 64)
	if err != nil {
		secs = 0
	}
	want := strings.Split(until, ",")
	deadline := time.Now().Add(time.Duration(secs * float64(time.Second)))
	c := client.New(e.getenv)
	path := "/api/agents/" + url.PathEscape(p.pos[0])
	for time.Now().Before(deadline) {
		a, err := getJSON(ctx, c, "GET", path, nil, 0)
		if err != nil {
			return err
		}
		state := agentState(a)
		if has(want, state) {
			fmt.Fprintf(e.stdout, "%s: %s %s\n", a.Text("name"), state, a.Text("activity_detail"))
			return nil
		}
		select {
		case <-ctx.Done():
			return &exitError{code: 130}
		case <-time.After(time.Second):
		}
	}
	return &exitError{code: 2, msg: "timed out waiting for " + until}
}

func orDefault(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}

// agentState is the state `stam ls` and `stam wait` name: resting, else the activity of an active agent, else its
// lifecycle.
func agentState(a jsfmt.Value) string {
	if r, ok := a.Get("resting"); ok && r.Truthy() {
		return "resting"
	}
	if a.Text("lifecycle") == "active" {
		return a.Text("activity")
	}
	return a.Text("lifecycle")
}

func kill(ctx context.Context, args []string, e env) error {
	id, err := arg(args, "stam kill AGENT")
	if err != nil {
		return err
	}
	a, err := getJSON(ctx, client.New(e.getenv), "POST", "/api/agents/"+id+"/kill", nil, 0)
	if err != nil {
		return err
	}
	fmt.Fprintf(e.stdout, "killed %s\n", a.Text("name"))
	return nil
}

func forget(ctx context.Context, args []string, e env) error {
	id, err := arg(args, "stam forget AGENT")
	if err != nil {
		return err
	}
	// The agent-control route answers {agent, result}; result is the "forgot NAME" line.
	r, err := getJSON(ctx, client.New(e.getenv), "POST", "/api/agents/"+id+"/forget", nil, 0)
	if err != nil {
		return err
	}
	fmt.Fprintln(e.stdout, r.Text("result"))
	return nil
}

var spawnSpec = optSpec{
	str: []string{"role", "harness", "model", "effort", "cwd", "parent", "preset", "type", "itsa", "machine", "urgent",
		"branch", "base", "workspace-script", "workspace-instructions"},
	multi: []string{"var"},
	bools: []string{"chief-of-staff", "worktree", "standing", "help"},
}

func spawn(ctx context.Context, args []string, e env) error {
	// --workspace, --workspace=NAME: a personal workspace (bare means the agent's own name). It is scanned out by hand,
	// because it takes a value only with "=".
	var workspace any
	var rest []string
	for i, a := range args {
		switch {
		case a == "--workspace":
			// `--workspace NAME` would make NAME the prompt and the workspace the agent's own name.
			if i+1 < len(args) && workspaceName.MatchString(args[i+1]) && !strings.HasPrefix(args[i+1], "-") {
				return fmt.Errorf("--workspace takes its name with '=': use --workspace=%s (a bare --workspace uses the agent's name)", args[i+1])
			}
			workspace = true
		case strings.HasPrefix(a, "--workspace="):
			workspace = strings.TrimPrefix(a, "--workspace=")
		default:
			rest = append(rest, a)
		}
	}
	p, err := parseArgs(rest, spawnSpec)
	if err != nil {
		return err
	}
	if p.bools["help"] {
		fmt.Fprint(e.stdout, spawnUsage)
		return nil
	}
	if len(p.pos) == 0 {
		fmt.Fprint(e.stderr, spawnUsage)
		return &exitError{code: 1}
	}
	body := map[string]any{"name": p.pos[0]}
	for _, k := range []string{"role", "harness", "model", "effort", "parent", "preset", "type", "itsa", "machine", "urgent", "branch", "base"} {
		if v, ok := p.str[k]; ok {
			body[k] = v
		}
	}
	for flag, key := range map[string]string{"workspace-script": "workspace_script", "workspace-instructions": "workspace_instructions"} {
		if v, ok := p.str[flag]; ok {
			body[key] = v
		}
	}
	for _, k := range []string{"worktree", "standing"} {
		if p.bools[k] {
			body[k] = true
		}
	}
	if p.bools["chief-of-staff"] {
		body["chief_of_staff"] = true
	}
	if workspace != nil {
		body["workspace"] = workspace
	}
	if vars := p.multi["var"]; len(vars) > 0 {
		m := map[string]any{}
		for _, v := range vars {
			k, val, _ := strings.Cut(v, "=")
			m[k] = val
		}
		body["brief_vars"] = m
	}
	cwd := p.str["cwd"]
	if cwd == "" {
		if cwd, err = e.cwd(); err != nil {
			return err
		}
	}
	body["cwd"] = cwd
	if prompt := strings.Join(p.pos[1:], " "); prompt != "" {
		body["prompt"] = prompt
	}
	// A spawn on another machine may wait for that peer to start and deploy.
	var timeout time.Duration
	if m, ok := p.str["machine"]; ok && m != machine(e) {
		timeout = remoteSpawnTimeout
	}
	a, err := getJSON(ctx, client.New(e.getenv), "POST", "/api/agents", body, timeout)
	if err != nil {
		return err
	}
	if w := a.Text("warning"); w != "" {
		fmt.Fprintf(e.stderr, "warning: %s\n", w)
	}
	switch {
	case a.Text("kind") == "ring":
		ring, _ := a.Get("ring")
		var members []string
		if ms, ok := a.Get("members"); ok {
			for _, m := range ms.Items {
				members = append(members, m.Text("name"))
			}
		}
		line := fmt.Sprintf("started ring %s (%s); members %s", ring.Text("name"), ring.Text("id"), strings.Join(members, ", "))
		if mod, ok := a.Get("moderator"); ok && mod.Truthy() {
			line += "; moderator " + mod.Text("name")
		}
		fmt.Fprintf(e.stdout, "%s; result by mail; see: stam ring %s\n", line, ring.Text("name"))
	case truthyMember(a, "queued"):
		var holders []string
		if hs, ok := a.Get("holders"); ok {
			for _, h := range hs.Items {
				holders = append(holders, displayValue(h))
			}
		}
		fmt.Fprintf(e.stdout, "queued %s: place %s of %s for a developer slot on %s (%s in use: %s); it starts when a slot frees\n",
			a.Text("name"), numberMember(a, "place"), numberMember(a, "queue_length"), a.Text("machine"), numberMember(a, "cap"), strings.Join(holders, ", "))
	default:
		fmt.Fprintf(e.stdout, "spawned %s (%s); attach with: stam attach %s\n", a.Text("name"), a.Text("id"), a.Text("name"))
	}
	return nil
}

func truthyMember(v jsfmt.Value, key string) bool {
	m, ok := v.Get(key)
	return ok && m.Truthy()
}

func numberMember(v jsfmt.Value, key string) string {
	if m, ok := v.Get(key); ok {
		return displayValue(m)
	}
	return "undefined"
}

// machine is STAM_MACHINE, else the hostname (src/config.ts MACHINE).
func machine(e env) string {
	if m := e.getenv("STAM_MACHINE"); m != "" {
		return m
	}
	h, _ := os.Hostname()
	return h
}
