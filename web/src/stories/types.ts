// The story format (docs/stories.md): one Story per visual component, in a file next to it
// named <File>.stories.tsx that exports `stories: Story[]`. The stories page (/stories) finds
// them with import.meta.glob, so a new file shows without being registered anywhere.
import type { ReactNode } from 'react'
import type { Data } from '../store'

// The sidebar's groups, in the order it lists them.
export const GROUPS = ['Primitives', 'Mail', 'Mail blocks', 'Composer', 'Tree and shell', 'ITSA and work', 'Settings', 'System view'] as const
export type Group = (typeof GROUPS)[number]

// How a frame is shown: at its real size ('actual', the default: a 20 px mark stays 20 px, and
// the 2× zoom applies), or shrunk to fit the column ('page', for whole-page states at 1280).
export type Fit = 'actual' | 'page'

// What a stub route answers: a body (200), or reply(status, body) for an error.
export interface Reply { status: number; body: unknown }
const REPLY = Symbol('reply')
export const reply = (status: number, body: unknown): Reply => ({ status, body, [REPLY]: true }) as Reply
export const isReply = (x: unknown): x is Reply => typeof x === 'object' && x !== null && REPLY in x

// A stub route that answers as a server-sent event stream (text/event-stream) with these events,
// each a `data:` line (after an `event:` line when `event` names one), and then stays open as a live stream does. For a view that follows a stream.
export interface Sse { events: unknown[]; event?: string }
const SSE = Symbol('sse')
export const sse = (events: unknown[], event?: string): Sse => ({ events, event, [SSE]: true }) as Sse
export const isSse = (x: unknown): x is Sse => typeof x === 'object' && x !== null && SSE in x

// A stub route that answers with a raw body of a given type and headers, for a view that reads a file (S-1526).
export interface Raw { body: string; type: string; headers: Record<string, string> }
const RAW = Symbol('raw')
export const raw = (body: string, type = 'text/plain; charset=utf-8', headers: Record<string, string> = {}): Raw => ({ body, type, headers, [RAW]: true }) as Raw
export const isRaw = (x: unknown): x is Raw => typeof x === 'object' && x !== null && RAW in x

// A stub route that never answers, for a view's loading state (S-1451).
const PENDING = Symbol('pending')
export const pending = (): object => ({ [PENDING]: true })
export const isPending = (x: unknown): boolean => typeof x === 'object' && x !== null && PENDING in x

export interface StoryState {
  // Empty, loading, long, error, each harness: whichever the component has.
  name: string
  render: () => ReactNode
  // Store data for this state alone, over the shared fixtures (fixtures.ts). The store and the
  // routes reset before each state, so one state's data never leaks into the next.
  data?: Partial<Data>
  // Stub answers for this state, by "METHOD /path" (or "METHOD /path?query"), over the shared ones.
  routes?: Record<string, unknown>
  // Anything else to arrange before it draws, after data and routes apply.
  setup?: () => void
  // Overrides the story's fit for this state.
  fit?: Fit
  // The frame's height in px when its content can't size it: a menu, sheet, or overlay is
  // position: fixed, so the frame's document has no height of its own. Others size to fit.
  height?: number
  // A CSS selector for what the overlay draws, which the stories test must find (in the state or in
  // the menu layer beside it); without one, the test only sees that the menu layer changed.
  overlay?: string
}

export interface Story {
  name: string
  group: Group
  // What it is, in one paragraph.
  what: string
  // The app state or route that shows it.
  when: string
  // Where it lives, as `path#Symbol` from the repo root (`web/src/Tree.tsx#Tree`); no line numbers.
  code: string[]
  // Its design-system rules: touch sizes, tokens, motion. `code` and [links](url) render; ds()
  // links a heading of docs/design-system.md.
  rules: string[]
  // How its frames are shown; 'actual' when unset. A state may override it.
  fit?: Fit
  states: StoryState[]
}

const DS = 'https://github.com/kimborgen/mootr/blob/main/docs/design-system.md'
// A Markdown link to a heading of docs/design-system.md, for a rule.
export const ds = (heading: string) => `[${heading}](${DS}#${heading.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-')})`
