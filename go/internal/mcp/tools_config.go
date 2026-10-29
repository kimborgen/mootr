package mcp

import (
	"context"

	"stam/internal/jsfmt"
)

// The config tools of src/mcp.ts (S-3782).
func init() {
	tools = append(tools, tool{name: "settings_ask", listing: configListings["settings_ask"], run: settingsAsk})
}

// settingsAsk is src/mcp.ts settings_ask: the chief of staff or the assistant asks the human to change the settings; the
// daemon refuses anyone else.
func settingsAsk(ctx context.Context, s *Server, args jsfmt.Value) (string, error) {
	body := jsfmt.Value{Kind: jsfmt.Object}
	if p, ok := args.Get("patch"); ok {
		body.Set("patch", p)
	}
	fill, _ := args.Get("fill")
	body.Set("fill", jsfmt.Value{Kind: jsfmt.Bool, Bool: fill.Kind == jsfmt.Bool && fill.Bool})
	// The ask's home (S-3827, askHomeArgs): sent only when given, as JSON.stringify drops an undefined one.
	for _, k := range []string{"thread", "itsa", "override"} {
		if v, ok := args.Get(k); ok {
			body.Set(k, v)
		}
	}
	r, err := s.apiJSON(ctx, "PATCH", "/api/config/settings", raw(body))
	if err != nil {
		return "", err
	}
	hint := ""
	if h, ok := r.Get("hint"); ok && h.Kind == jsfmt.String && h.Str != "" {
		hint = " It found no home thread, so it went to a new one. " + h.Str
	}
	return "Asked the human to change the settings (request " + str(r.Get("requested")) + "). Nothing changes until they approve; stam then applies the patch and tells you the result." + hint, nil
}
