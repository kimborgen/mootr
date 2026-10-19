// Permission modes in the web UI (S-1967): the shapes GET /api/permission-modes sends and the
// words each mode is shown in. The daemon owns which modes a harness offers (`offered`).
export type PermissionMode = 'default' | 'auto' | 'bypass'

export interface HarnessMode { mode: PermissionMode; label: string; harness: string; offered: boolean }
export interface StaleAgent {
  id: string; name: string; harness: string; type: string | null
  mode: string; want: string
  // false: an OpenCode agent, which takes the new mode only in a new session.
  inPlace: boolean
  // Why its last switch failed, or null.
  failed: string | null
}
export interface PermissionModes {
  settings: { harness: Record<string, string>; types: Record<string, string> }
  harnesses: Record<string, HarnessMode[]>
  types: string[]
  stale: StaleAgent[]
}
export interface ApplyReply {
  applied: { name: string; mode: string; result: string }[]
  skipped: { name: string; reason: string }[]
  stale: StaleAgent[]
}

export const MODE_LABEL: Record<string, string> = { default: 'Ask', auto: 'Auto', bypass: 'Bypass' }
export const modeLabel = (m: string) => MODE_LABEL[m] ?? m

// The modes Settings lists for a harness, in the daemon's order, each with whether it can be picked.
// The mode now set stays in the list when the harness doesn't offer it, disabled, so a saved value is
// never shown as another one and can't be picked again.
export function offeredModes(modes: HarnessMode[] | undefined, current?: string): (HarnessMode & { pickable: boolean })[] {
  const list = (modes ?? []).filter((m) => m.offered || m.mode === current).map((m) => ({ ...m, pickable: m.offered }))
  return list.length ? list : (modes ?? []).map((m) => ({ ...m, pickable: m.offered }))
}

// Whether an agent follows the settings: the daemon's rule for one with no source is that an 'auto'
// agent does and a bypass one was the human's own pick (src/permission-modes.ts permissionSource).
export const followsSettings = (a: { permission_mode?: string | null; permission_source?: string | null }) =>
  a.permission_source === 'settings' || a.permission_source === 'manual' ? a.permission_source === 'settings' : (a.permission_mode ?? 'auto') === 'auto'

export const BYPASS_WARNING = 'Bypass runs every action without asking: no prompts, no checks.'
