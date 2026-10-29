package mcp

import (
	"context"
	"strings"

	"stam/internal/jsfmt"
)

// The layout tools of src/mcp.ts (S-100): layout_get reads the human's web layout, layout_arrange changes it for the
// agent, which names itself with `by`.
func init() {
	tools = append(tools,
		tool{name: "layout_get", listing: layoutListings["layout_get"], run: layoutGet},
		tool{name: "layout_arrange", listing: layoutListings["layout_arrange"], run: layoutArrange},
	)
}

func layoutGet(ctx context.Context, s *Server, _ jsfmt.Value) (string, error) {
	l, err := s.apiJSON(ctx, "GET", "/api/layout", nil)
	if err != nil {
		return "", err
	}
	return layoutText(l), nil
}

func layoutArrange(ctx context.Context, s *Server, args jsfmt.Value) (string, error) {
	me, err := s.me(args)
	if err != nil {
		return "", err
	}
	// { ops: a.ops, base: a.base, by: me(a) }: JSON.stringify leaves out an undefined ops or base.
	body := jsfmt.Value{Kind: jsfmt.Object}
	for _, k := range []string{"ops", "base"} {
		if v, ok := args.Get(k); ok {
			body.Set(k, v)
		}
	}
	body.Set("by", jsfmt.StringValue(me))
	l, err := s.apiJSON(ctx, "POST", "/api/layout/ops", raw(body))
	if err != nil {
		return "", err
	}
	return layoutText(l), nil
}

// layoutText is src/mcp.ts layoutText: each world's panes as an indented tree, then the raw JSON.
func layoutText(l jsfmt.Value) string {
	// l.current ?? 'home'
	cur, curOK := l.Get("current")
	current := "home"
	if curOK && cur.Kind != jsfmt.Null {
		current = str(cur, true)
	}
	version, ok := l.Get("version")
	lines := []string{"Layout version " + str(version, ok) + ", current: " + current + " (the world an agent last sent the human to; each device may show another one, as the human navigates there)"}
	var node func(n jsfmt.Value, depth int, focused jsfmt.Value)
	node = func(n jsfmt.Value, depth int, focused jsfmt.Value) {
		pad := strings.Repeat("  ", depth)
		if split, _ := n.Get("split"); split.Truthy() {
			dir := "column"
			if split.Kind == jsfmt.String && split.Str == "row" {
				dir = "row"
			}
			lines = append(lines, pad+dir+" split")
			children, _ := n.Get("children")
			for _, c := range children.Items {
				node(c, depth+1, focused)
			}
			return
		}
		id, idOK := n.Get("id")
		line := pad + "pane " + str(id, idOK)
		if idOK && sameValue(id, focused) {
			line += " (focused)"
		}
		tabs, _ := n.Get("tabs")
		if len(tabs.Items) == 0 {
			line += " (empty)"
		}
		lines = append(lines, line)
		active, activeOK := n.Get("active")
		for _, t := range tabs.Items {
			if activeOK && sameValue(t, active) {
				lines = append(lines, pad+"  * "+str(t, true)+" (active)")
			} else {
				lines = append(lines, pad+"  - "+str(t, true))
			}
		}
	}
	world := func(label string, w jsfmt.Value) {
		lines = append(lines, label+":")
		root, _ := w.Get("root")
		focused, _ := w.Get("focused")
		node(root, 1, focused)
	}
	// l.current ?? '_home': the world shown as current.
	shown := "_home"
	if cur.Kind == jsfmt.String {
		shown = cur.Str
	}
	agentWorlds, _ := l.Get("agentWorlds")
	for i, id := range agentWorlds.Keys {
		label := "agent " + id
		if id == "_home" {
			label = "home"
		}
		if id == shown {
			label += " (current)"
		}
		world(label, agentWorlds.Items[i])
	}
	worlds, _ := l.Get("worlds")
	for i, name := range worlds.Keys {
		world("world "+name, worlds.Items[i])
	}
	if len(agentWorlds.Keys) == 0 && len(worlds.Keys) == 0 {
		lines = append(lines, "No panes yet.")
	}
	lines = append(lines, "", "Raw: "+jsfmt.Compact(l))
	return strings.Join(lines, "\n")
}

// sameValue is === for two parsed JSON values of the kinds a pane holds: strings, numbers, booleans and null.
func sameValue(a, b jsfmt.Value) bool {
	if a.Kind != b.Kind {
		return false
	}
	switch a.Kind {
	case jsfmt.String:
		return a.Str == b.Str
	case jsfmt.Number:
		return a.Num == b.Num
	case jsfmt.Bool:
		return a.Bool == b.Bool
	case jsfmt.Null:
		return true
	}
	return false
}
