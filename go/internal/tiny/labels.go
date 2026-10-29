package tiny

import "regexp"

// Tool name labels (src/tool-name-labels.ts, S-1933): the built-in tools of each harness are seeded here and never need a
// model; an MCP tool's label is for its tool part, the server prefix stays as it is.

// seeded is SEEDED: harness, then raw tool name, then label.
var seeded = map[string]map[string]string{
	"claude": {
		"Bash": "Bash", "BashOutput": "Bash output", "KillShell": "Stop shell", "KillBash": "Stop shell",
		"Read": "Read", "Edit": "Edit", "MultiEdit": "Edit", "Write": "Write", "NotebookEdit": "Edit notebook",
		"Grep": "Grep", "Glob": "Glob", "WebSearch": "Web search", "WebFetch": "Web fetch",
		"Task": "Agent", "Agent": "Agent", "TodoWrite": "Todo list", "ExitPlanMode": "Exit plan mode", "EnterPlanMode": "Enter plan mode",
		"Skill": "Skill", "ToolSearch": "Tool search", "SendMessage": "Send message", "AskUserQuestion": "Ask question", "Monitor": "Monitor", "ScheduleWakeup": "Schedule wakeup",
	},
	"codex": {
		"exec_command": "Bash", "shell": "Bash", "local_shell": "Bash", "write_stdin": "Send input", "apply_patch": "Edit",
		"read_file": "Read", "list_dir": "List files", "grep_files": "Grep", "web_search": "Web search", "view_image": "View image",
		"update_plan": "Plan", "spawn_agent": "Agent", "execute": "Code",
	},
	"opencode": {
		"bash": "Bash", "read": "Read", "edit": "Edit", "write": "Write", "patch": "Edit", "multiedit": "Edit",
		"grep": "Grep", "glob": "Glob", "list": "List files", "webfetch": "Web fetch", "websearch": "Web search",
		"task": "Agent", "todowrite": "Todo list", "todoread": "Todo list", "skill": "Skill", "execute": "Code",
	},
}

// jsDot is JavaScript's `.`: any character but a line terminator.
const jsDot = `[^\n\r\x{2028}\x{2029}]`

var (
	mcpName   = regexp.MustCompile(`^mcp__(` + jsDot + `+?)__(` + jsDot + `+)$`)
	codexName = regexp.MustCompile(`^([^.]+)\.(` + jsDot + `+)$`)
)

// SplitTool is splitTool: an MCP tool's server and tool part. Claude and OpenCode name one `mcp__server__tool`; Codex
// names it `server.tool`, read so only for the codex harness.
func SplitTool(name, harness string) (server, tool string) {
	if m := mcpName.FindStringSubmatch(name); m != nil {
		return m[1], m[2]
	}
	if harness == "codex" {
		if m := codexName.FindStringSubmatch(name); m != nil {
			return m[1], m[2]
		}
	}
	return "", name
}

// SeededLabel is seededLabel: the seeded label for the tool part of a name, "" when the harness has none.
func SeededLabel(harness, tool string) string { return seeded[harness][tool] }
