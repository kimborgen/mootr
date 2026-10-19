// Which target the bottom world's prompt input writes to, from what the main world shows (S-1436).
// One input, always in the bottom world; its target follows the main pane. The Alt-A and Alt-C top
// worlds keep their own. `none` is a main pane nothing can be written to: the bottom slot shows the
// normal input, disabled, with `context` (a plain one-line string) as its placeholder.
import { baseName, parseFileKey } from './files/fileKey'
import { byId, chiefsOfStaff, getData } from './store'
import { live } from './format'
import { getUsageState } from './usage/state'

export type BottomTarget =
  | { kind: 'agent' | 'shell' | 'thread' | 'itsa' | 'chief'; key: string; name: string; to: string; enabled: boolean }
  | { kind: 'none'; world: string | null; context: string }

// An agent's own tabs (mail, details, instructions, inventory) write to that agent, as its terminal does.
const AGENT_TABS = ['mail:', 'details:', 'instructions:', 'inventory:']

// A staged image's tab (S-1475) only shows a picture of what the input holds: the input keeps writing for
// what the main world showed before it, so the staged images stay in the box.
let beforeImage: string | null = null
// The main-world tab the input writes for: the shown tab, or what an image tab was opened over.
export const targetKey = () => beforeImage

// The one-line name of a main world no input writes to: the title its tab shows (the same words as
// `viewMeta` in views/registry.tsx, which pulls in every view, so they are written here).
function contextOf(key: string): string {
  if (!key) return 'Nothing selected'
  const id = key.slice(key.indexOf(':') + 1)
  if (key.startsWith('board:')) { const x = getData().itsas.find((i) => i.id === id); return id === 'all' ? 'All issues' : x ? `${x.key} board` : 'Board' }
  if (key.startsWith('type:')) return `${id} · type`
  if (key.startsWith('file:')) { const f = parseFileKey(key); return f ? baseName(f.path) : 'File' }
  const named: Record<string, string> = { compliance: 'Compliance', system: 'System', swipe: 'Swipe', files: 'Files', inventory: 'Inventory by type' }
  return named[key] ?? 'Another view'
}

export function bottomTarget(mainWorld: string | null): BottomTarget {
  if (mainWorld?.startsWith('image:')) return bottomTarget(beforeImage)
  beforeImage = mainWorld
  const key = mainWorld ?? ''
  // Your own inbox is not an agent's tab.
  if (key === 'mail:human') return { kind: 'none', world: mainWorld, context: 'Your inbox' }
  const tab = AGENT_TABS.find((p) => key.startsWith(p))
  if (key.startsWith('agent:') || key.startsWith('view:') || tab) {
    const id = key.slice(key.indexOf(':') + 1)
    const a = byId(id)
    if (!a) return { kind: 'none', world: mainWorld, context: 'An agent that is gone' }
    return { kind: 'agent', key: tab ? 'agent:' + id : key, name: a.name, to: id, enabled: live(a) }
  }
  if (key.startsWith('shell:')) return { kind: 'shell', key, name: 'a terminal', to: key.split(':')[2] ?? '', enabled: true }
  if (key.startsWith('thread:')) {
    const tid = key.slice(7)
    return { kind: 'thread', key, name: 'the thread', to: tid, enabled: true }
  }
  if (key.startsWith('itsa:')) {
    const id = key.slice(5)
    const x = getData().itsas.find((i) => i.id === id)
    return { kind: 'itsa', key, name: x ? `${x.key} ${x.title}` : 'an ITSA', to: id, enabled: true }
  }
  // The Work page writes to the chief of staff, by mail.
  if (key === 'work') {
    const cos = chiefsOfStaff()[0]
    return cos ? { kind: 'chief', key, name: cos.name, to: cos.id, enabled: true } : { kind: 'none', world: mainWorld, context: 'Work · no chief of staff' }
  }
  if (key === 'config') return { kind: 'none', world: mainWorld, context: 'Settings' }
  if (key === 'usage') return { kind: 'none', world: mainWorld, context: `Usage · ${getUsageState().tab}` }
  if (key === 'process') return { kind: 'none', world: mainWorld, context: 'Process' }
  if (key.startsWith('req:')) return { kind: 'none', world: mainWorld, context: 'A requirement' }
  return { kind: 'none', world: mainWorld, context: contextOf(key) }
}
