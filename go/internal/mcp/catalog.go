package mcp

import "stam/internal/jsjson"

// toolGroups is src/mcp.ts TOOL_GROUPS: each tool's group key and the name the catalog shows, in the catalog's order.
var toolGroups = []struct{ key, name string }{
	{"mail", "Mail"},
	{"agents", "Agents"},
	{"itsas", "ITSAs"},
	{"requirements", "Requirements"},
	{"cost", "Cost"},
	{"waits", "Waits"},
	{"permissions", "Permissions"},
	{"ring", "Rings"},
	{"registry", "Registry"},
	{"events", "Events"},
	{"layout", "Layout"},
}

// HarnessToolsNote is src/mcp.ts toolCatalog's harnessTools.note.
const HarnessToolsNote = "Tools a harness gives its own agents — Claude Code's Bash, Edit, Write, and Read, Codex's shell and patches, OpenCode's tools — are not listed yet. They could be added later through harness hooks, for example Claude Code's PreToolUse."

// catalogTool is one tool of src/mcp.ts's list as the catalog shows it: its group, its `when` ("" for always), and
// its {name, description, inputSchema} as JSON.
type catalogTool struct{ group, when, listing string }

// Catalog is src/mcp.ts toolCatalog: every tool src/mcp.ts defines, grouped, each as {name, description, inputSchema},
// for Settings › Tools, the decision-steps UI (S-60) and the inventory (S-3776). It lists TS's whole set
// (catalogTools), including tools the Go MCP server doesn't serve yet. A tool with `when: "requirements"` is listed
// only while requirements are on; an empty group is left out.
func Catalog(requirements bool) *jsjson.Object {
	byGroup := map[string][]jsjson.Value{}
	for _, t := range catalogTools {
		if t.when == "requirements" && !requirements {
			continue
		}
		v, err := jsjson.Parse([]byte(t.listing))
		if err != nil {
			continue
		}
		byGroup[t.group] = append(byGroup[t.group], v)
	}
	groups := []jsjson.Value{}
	for _, g := range toolGroups {
		if list := byGroup[g.key]; len(list) > 0 {
			groups = append(groups, jsjson.NewObject("name", g.name, "tools", list))
		}
	}
	return jsjson.NewObject("groups", groups, "harnessTools", jsjson.NewObject("note", HarnessToolsNote))
}
