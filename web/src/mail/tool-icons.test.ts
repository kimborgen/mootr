// Tool call icons (S-1934, src/tool-icons.ts): chosen by harness and tool name alone.
import { describe, expect, it } from 'vitest'
import { toolIcon } from '../../../src/tool-icons.ts'

describe('toolIcon', () => {
  it('maps built-ins of each harness to the same icon', () => {
    for (const [h, n] of [['claude', 'Bash'], ['codex', 'exec_command'], ['opencode', 'bash']]) expect(toolIcon(h, n)).toBe('terminal')
    expect(toolIcon('claude', 'Read')).toBe('file-text')
    expect(toolIcon('claude', 'Edit')).toBe('pencil')
    expect(toolIcon('codex', 'apply_patch')).toBe('pencil')
    expect(toolIcon('claude', 'Grep')).toBe('search')
    expect(toolIcon('opencode', 'glob')).toBe('search')
    expect(toolIcon('claude', 'WebFetch')).toBe('globe')
    expect(toolIcon('codex', 'web_search')).toBe('globe')
    expect(toolIcon('claude', 'Task')).toBe('users')
    expect(toolIcon('opencode', 'task')).toBe('users')
  })
  it('gives stam MCP tools the stam icon and other servers a plug', () => {
    expect(toolIcon('claude', 'mcp__stam__send_mail')).toBe('stam')
    expect(toolIcon('codex', 'mcp__claude_ai_Gmail__search_threads')).toBe('plug')
  })
  it('reads Codex MCP names (server.tool) as codex emits them', () => {
    expect(toolIcon('codex', 'stam.send_mail')).toBe('stam')
    expect(toolIcon('codex', 'github.create_issue')).toBe('plug')
    expect(toolIcon('codex', 'exec_command')).toBe('terminal')
    expect(toolIcon('claude', 'github.create_issue')).toBe('wrench')
  })
  it('falls back to a wrench for unknown tools, and without a harness uses any harness table', () => {
    expect(toolIcon('claude', 'Frobnicate')).toBe('wrench')
    expect(toolIcon(undefined, 'exec_command')).toBe('terminal')
    expect(toolIcon(undefined, 'Nope')).toBe('wrench')
  })
})
