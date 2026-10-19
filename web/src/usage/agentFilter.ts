// The agent-type filter of Usage › Activity and Agents (S-1491, replacing S-1444's classes and presets).
// The page keeps the list of registry types it counts (src/agent-class.ts names them); an empty list counts
// every agent. It goes to the summary as `agents=developer,manager`, and the Agents tab filters its rows by
// the same names client-side.
export type AgentFilter = readonly string[]
export const DEFAULT_FILTER: AgentFilter = []

export interface TypeCount { type: string; count: number }

export const isFiltered = (f: AgentFilter) => f.length > 0
// A row without a type (an older daemon) stays in; so does every row until a saved link's legacy tokens are resolved.
export const keepsType = (f: AgentFilter, t: string | undefined) => !f.length || !t || hasLegacy(f) || f.includes(t)

// The `agents=` query value: nothing for every agent, else the types, sorted so one selection is one URL.
export const filterParam = (f: AgentFilter): string => [...new Set(f)].sort().join(',')
// A short name for the crumb and the notes.
export const filterLabel = (f: AgentFilter): string => [...new Set(f)].sort().join(', ')

// A type tapped: in when out, out when in. Taking the last one out leaves every agent counted.
export const toggleType = (f: AgentFilter, t: string): AgentFilter => (f.includes(t) ? f.filter((x) => x !== t) : [...f, t].sort())

// What S-1444 saved: presets and `+class` lists. The page doesn't know their types; it passes the token on as
// `agents=` and the daemon maps it (src/agent-class.ts), then the page adopts the resolved list (useLegacyFilter).
export const LEGACY_PRESETS = ['work', 'managers', 'developers', 'non-managers']
export const isLegacyToken = (t: string) => LEGACY_PRESETS.includes(t) || /^[+-][a-z]+$/.test(t)
export const hasLegacy = (f: AgentFilter) => f.some(isLegacyToken)
// A saved `{ preset, classes }` or a link's `agents=PRESET&classes=a,b` as tokens; `all` and unknown presets count all.
export function legacyTokens(preset: string | null | undefined, classes: readonly string[] = []): string[] {
  if (preset === 'custom') return classes.filter((c) => /^[a-z]+$/.test(c)).map((c) => `+${c}`)
  return LEGACY_PRESETS.includes(preset ?? '') ? [preset!] : []
}

const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/
// Reads a stored filter: a list of names (or legacy tokens), or an older `{ preset, classes }`.
export function decodeFilter(o: unknown): AgentFilter {
  if (Array.isArray(o)) return [...new Set(o.filter((x): x is string => typeof x === 'string' && (NAME.test(x) || isLegacyToken(x))))].sort()
  const v = o as { preset?: string; classes?: string[] } | null | undefined
  return legacyTokens(v?.preset, Array.isArray(v?.classes) ? v!.classes : [])
}
