// Tool name labels (S-1933): a tool shows as one human-readable label, not as the raw name the
// harness gave it. Pure, so the daemon (src/tool-names.ts) and the web share it. The built-in tools
// of each harness are seeded here and never need a model; the rest get a label from the summaries
// tiny model once, stored by (harness, tool name). `mcp__server__tool` shows as "server · Label":
// the label is for the tool part only, the server stays as it is.

export const HARNESSES = ['claude', 'codex', 'opencode'] as const;

// harness → raw tool name → label. A name that isn't here has no seeded label.
export const SEEDED: Record<string, Record<string, string>> = {
  claude: {
    Bash: 'Bash', BashOutput: 'Bash output', KillShell: 'Stop shell', KillBash: 'Stop shell',
    Read: 'Read', Edit: 'Edit', MultiEdit: 'Edit', Write: 'Write', NotebookEdit: 'Edit notebook',
    Grep: 'Grep', Glob: 'Glob', WebSearch: 'Web search', WebFetch: 'Web fetch',
    Task: 'Agent', Agent: 'Agent', TodoWrite: 'Todo list', ExitPlanMode: 'Exit plan mode', EnterPlanMode: 'Enter plan mode',
    Skill: 'Skill', ToolSearch: 'Tool search', SendMessage: 'Send message', AskUserQuestion: 'Ask question', Monitor: 'Monitor', ScheduleWakeup: 'Schedule wakeup',
  },
  codex: {
    exec_command: 'Bash', shell: 'Bash', local_shell: 'Bash', write_stdin: 'Send input', apply_patch: 'Edit',
    read_file: 'Read', list_dir: 'List files', grep_files: 'Grep', web_search: 'Web search', view_image: 'View image',
    update_plan: 'Plan', spawn_agent: 'Agent', execute: 'Code',
  },
  opencode: {
    bash: 'Bash', read: 'Read', edit: 'Edit', write: 'Write', patch: 'Edit', multiedit: 'Edit',
    grep: 'Grep', glob: 'Glob', list: 'List files', webfetch: 'Web fetch', websearch: 'Web search',
    task: 'Agent', todowrite: 'Todo list', todoread: 'Todo list', skill: 'Skill', execute: 'Code',
  },
};

// A tool name split into its MCP server (when it has one) and the tool part. Claude and OpenCode name an
// MCP tool `mcp__server__tool`; Codex names it `server.tool` (src/adapters/codex-view.ts), read so only
// for the codex harness, where no built-in has a dot (`exec_command` stays a built-in).
export function splitTool(name: string, harness?: string): { server?: string; tool: string } {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (m) return { server: m[1], tool: m[2] };
  const c = harness === 'codex' ? /^([^.]+)\.(.+)$/.exec(name) : null;
  return c ? { server: c[1], tool: c[2] } : { tool: name };
}

// A raw name read as words: `send_mail` → "Send mail", `WebSearch` → "Web search", `Bash` → "Bash".
export function prettyTool(tool: string): string {
  const words = tool.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return tool;
  const text = words.map((w, i) => (i === 0 ? w : /^[A-Z0-9]+$/.test(w) && w.length > 1 ? w : w.toLowerCase())).join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// The seeded label for the tool part of a name, if the harness has one.
export function seededLabel(harness: string, tool: string): string | undefined {
  return SEEDED[harness]?.[tool];
}

// What a tool shows as: the server prefix (an MCP tool) and the label of the tool part. `label` is the
// stored or seeded label; without one the prettified raw name stands in.
export function toolTitle(name: string, label?: string, harness?: string): string {
  const { server, tool } = splitTool(name, harness);
  const l = label || prettyTool(tool);
  return server ? `${server} · ${l}` : l;
}
