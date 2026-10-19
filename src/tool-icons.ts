// Tool call icons (S-1934): a call shows one icon next to its label, chosen from the harness and tool
// name alone (no model, no request). The built-ins go by their seeded label (src/tool-name-labels.ts), so
// every harness's spelling of a tool (Bash, exec_command, bash) lands on the same icon. `stam` is the
// stam MCP server, any other MCP server is a plug, and a tool nothing knows is a wrench.
import { HARNESSES, SEEDED, splitTool } from './tool-name-labels.ts'

// Seeded label → icon name (web/src/Icon.tsx).
const BY_LABEL: Record<string, string> = {
  Bash: 'terminal', 'Bash output': 'terminal', 'Stop shell': 'terminal', Code: 'terminal',
  Read: 'file-text', Write: 'file-text', 'View image': 'file-text', Edit: 'pencil', 'Edit notebook': 'pencil',
  Grep: 'search', Glob: 'search', 'List files': 'search', 'Tool search': 'search',
  'Web search': 'globe', 'Web fetch': 'globe',
  Agent: 'users', 'Send message': 'users',
  'Todo list': 'list-checks', Plan: 'list-checks', 'Exit plan mode': 'list-checks', 'Enter plan mode': 'list-checks',
}
export const FALLBACK_ICON = 'wrench'

export function toolIcon(harness: string | undefined, name: string): string {
  const { server, tool } = splitTool(name, harness)
  if (server) return server === 'stam' ? 'stam' : 'plug'
  const label = (harness ? SEEDED[harness]?.[tool] : undefined) ?? HARNESSES.map((h) => SEEDED[h][tool]).find(Boolean)
  return (label && BY_LABEL[label]) || FALLBACK_ICON
}
