package catalog

import "stam/internal/jsjson"

// harnessModes is src/permission-modes.ts HARNESS_MODES: each harness's modes in its own words, and which ones Settings
// offers. 'default' is offered only where the harness's own prompts reach stam's permission requests (Claude Code's
// dialogs); Codex's and OpenCode's asks show only in the agent's terminal and conversation view.
const harnessModes = `{"claude":[{"mode":"default","label":"Ask","harness":"--permission-mode default","offered":true},{"mode":"auto","label":"Auto","harness":"--permission-mode auto","offered":true},{"mode":"bypass","label":"Bypass","harness":"--permission-mode bypassPermissions","offered":true}],` +
	`"codex":[{"mode":"default","label":"Ask","harness":"on-request, workspace-write, you review","offered":false},{"mode":"auto","label":"Auto","harness":"on-request, workspace-write, auto review","offered":true},{"mode":"bypass","label":"Bypass","harness":"never, danger-full-access","offered":true}],` +
	`"opencode":[{"mode":"default","label":"Ask","harness":"ask for every tool","offered":false},{"mode":"auto","label":"Auto","harness":"OpenCode's own rules","offered":true},{"mode":"bypass","label":"Bypass","harness":"allow every tool","offered":true}]}`

// HarnessModes is HARNESS_MODES as a value.
func HarnessModes() jsjson.Value {
	v, err := jsjson.Parse([]byte(harnessModes))
	if err != nil {
		panic(err)
	}
	return v
}
