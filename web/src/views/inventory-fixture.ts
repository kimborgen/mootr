// Invented inventories for the Inventory view's stories and test (S-879). Nothing here comes from a
// live daemon; sizes are characters ÷ 4 like the server's.
import type { Inv, InvBlock, InvLayer } from './InventoryView'

const words = (n: number, seed: string) => Array.from({ length: n }, (_, i) => `${seed}${i % 17}`).join(' ')
const hash = (s: string) => Array.from(s).reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).padStart(64, '0')

export function block(layer: string, title: string, o: Partial<InvBlock> & { body?: string; path?: string[] } = {}): InvBlock {
  const text = o.text ?? `## ${title}\n\n${o.body ?? words(40, 'rule')}`
  return {
    id: `${layer}:${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    title,
    headingPath: o.path ?? [title],
    tokens: Math.ceil(text.length / 4),
    hash: hash(text),
    format: 'markdown',
    text,
    summaryState: 'auto',
    summary: `Fixture summary: what ${title} tells the agent to do.`,
    ...o,
  }
}
export function layer(key: string, label: string, source: string, blocks: InvBlock[], o: Partial<InvLayer> = {}): InvLayer {
  return { key, label, source, tokens: blocks.reduce((n, b) => n + b.tokens, 0), blocks, ...o }
}
const total = (layers: InvLayer[]) => layers.reduce((n, l) => n + l.tokens, 0)

export const tool = (i: number): InvBlock => {
  const text = JSON.stringify({ name: `fixture_tool_${i}`, description: `Fixture tool ${i}: does one thing for an agent.`, inputSchema: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string', description: words(30, 'arg') } } } }, null, 2)
  return block('mcp-tools', `fixture_tool_${i}`, { id: `mcp-tools:fixture-tool-${i}`, text, format: 'json', headingPath: [], summary: `Fixture tool ${i}: does one thing for an agent.`, summaryState: 'source' })
}

export const small: Inv = (() => {
  const layers = [
    layer('system-prompt', 'System prompt', 'stam-generated', [block('system-prompt', 'Working with others'), block('system-prompt', 'Mail to your user', { summaryState: 'pending', summary: undefined })]),
    layer('instruction-files', 'Instruction files', 'repo', [block('instruction-files', 'Status', { path: ['CLAUDE.md', 'Status'], summaryState: 'off', summary: undefined })], { path: '/home/fixture/project/CLAUDE.md' }),
    layer('first-prompt', 'First prompt', 'stam', [block('first-prompt', 'First prompt')]),
    layer('skills', 'Skills', 'skill', []),
    layer('mcp-instructions', 'MCP instructions', 'stam', [block('mcp-instructions', 'MCP instructions')]),
    layer('mcp-tools', 'MCP tools', 'mcp', [tool(1), tool(2)]),
  ]
  return { agent: { id: 'fx-dev', name: 'fixture-dev', type: 'developer', harness: 'claude', model: 'claude-opus-5-5' }, harness: 'claude', totalTokens: total(layers), layers, flags: [{ kind: 'duplicate-file', layer: 'instruction-files', message: '/home/fixture/project/CLAUDE.md and /home/fixture/project/AGENTS.md are the same file, so the agent is given it twice.' }, { kind: 'empty-layer', layer: 'skills', message: 'Skills is empty.' }] }
})()

// Realistic scale: a long CLAUDE.md, ~60 stam MCP tools, several skills.
export const large: Inv = (() => {
  const claude = Array.from({ length: 24 }, (_, i) => block('instruction-files', `Section ${i + 1}: ${['Status', 'Idea doc', 'Rules', 'Web UI design', 'Testing and spending'][i % 5]}`, { path: ['CLAUDE.md', `Section ${i + 1}`], body: words(180, 'claude') }))
  const layers = [
    layer('system-prompt', 'System prompt', 'stam-generated', Array.from({ length: 14 }, (_, i) => block('system-prompt', `Prompt part ${i + 1}`, { body: words(120, 'sys') }))),
    layer('instruction-files', 'Instruction files', 'repo', claude, { path: '/home/fixture/project/CLAUDE.md' }),
    layer('first-prompt', 'First prompt', 'stam', [block('first-prompt', 'First prompt', { body: words(150, 'task') })]),
    layer('skills', 'Skills', 'skill', ['adhd', 'kim-style', 'run', 'init'].map((n) => block('skills', n, { body: words(400, n) }))),
    layer('mcp-instructions', 'MCP instructions', 'stam', [block('mcp-instructions', 'MCP instructions')]),
    layer('mcp-tools', 'MCP tools', 'mcp', Array.from({ length: 60 }, (_, i) => tool(i + 1))),
  ]
  return { agent: { id: 'fx-dev', name: 'fixture-dev', type: 'developer', harness: 'claude', model: 'claude-opus-5-5' }, harness: 'claude', totalTokens: total(layers), layers, flags: [] }
})()

// A type that switched one global block off and replaced another (S-886).
export const composed: Inv = {
  ...small,
  layers: [
    layer('system-prompt', 'System prompt', 'stam-generated', [
      block('system-prompt', 'Working with others'),
      block('system-prompt', 'Waiting for a reply', { id: 'system-prompt:off-waiting', state: 'off', by: 'developer' }),
      block('system-prompt', 'Mail to your user', { id: 'system-prompt:replaced-mail', state: 'replaced', by: 'developer' }),
      block('system-prompt', 'Mail to your user, short', { id: 'system-prompt:replaces-mail', state: 'replaces', by: 'developer' }),
    ], { tokens: block('system-prompt', 'Working with others').tokens }),
  ],
}
