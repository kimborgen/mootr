// Starts the web shell (shell/layout.ts) over a layout the story gives, for the states that
// draw the layout's panes and tabs (the main world, the whole app). The layout comes through
// the stubbed layout stream, as it does from a daemon; the device starts fresh, so it shows
// the layout's current world. Nothing is sent and no storage is touched: a state only draws its layout.
import type { Node } from '../shell/layout'
import * as shell from '../shell/layout'
import { validKey } from '../views/registry'
import { sse } from './types'

interface World { root: Node; focused: string }
export interface SeedLayout { current: string | null; worlds: Record<string, World> }

export function seedShell(layout: SeedLayout) {
  return {
    routes: { 'GET /api/layout/stream': sse([{ version: 1, current: layout.current, agentWorlds: layout.worlds, worlds: {} }], 'layout') },
    // The device starts fresh because /stories keeps its storage in memory (web/public/stories-isolate.js),
    // so nothing is removed or written here; the stories test clears its own between states.
    setup: () => shell.init({ valid: validKey, keep: () => true, keepWorld: () => true }),
  }
}

// One pane holding tabs, as a world's root.
export const pane = (id: string, tabs: string[], active = tabs[0] ?? null): World => ({ root: { id, tabs, active }, focused: id })
