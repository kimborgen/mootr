// The Work board's saved views (grouping, scope, the closed column's "all") per board, kept in
// stam settings as `boardViews` (S-293). The closed column's fold stays on this device, and so do
// column widths. A board with no saved view takes the defaults.
import { settingsRecord } from '../settings-views'

export type Mode = 'category' | 'status'
export type Scope = 'children' | 'subtree'
// What settings keep for a board.
export interface View { mode: Mode; scope: Scope; closedAll: boolean }
export interface Prefs extends View { closedFolded: boolean }

export const DEFAULT_VIEW: View = { mode: 'category', scope: 'children', closedAll: false }
const FOLDS = 'stam/board-folded'

// A view with each field a valid value; anything missing or wrong takes the default.
export function sanitize(x: unknown): View {
  const o: Partial<Record<keyof View, unknown>> = x && typeof x === 'object' ? x : {}
  return {
    mode: o.mode === 'status' ? 'status' : 'category',
    scope: o.scope === 'subtree' ? 'subtree' : 'children',
    closedAll: o.closedAll === true,
  }
}

// The folds on this device, by board.
function folds(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(FOLDS) ?? '{}') } catch { return {} }
}
function setFold(key: string, folded: boolean) {
  const all = folds()
  if (folded) all[key] = true
  else delete all[key]
  try { localStorage.setItem(FOLDS, JSON.stringify(all)) } catch {}
}

const views = settingsRecord<View>({
  field: 'boardViews',
  legacy: 'stam/board',
  clean: sanitize,
  // This browser's copy also kept each board's fold, which stays here.
  migrated: (raw) => {
    if (!raw || typeof raw !== 'object') return
    for (const [k, p] of Object.entries(raw as Record<string, { closedFolded?: unknown }>)) {
      if (p?.closedFolded === true) setFold(k, true)
    }
  },
})

// The board's prefs as this page has them: its saved view, or the defaults, with its fold.
export function prefsFor(key: string): Prefs {
  const v = views.cached(key) ?? DEFAULT_VIEW
  return { ...v, closedFolded: folds()[key] === true }
}

// Loads the saved views from settings, then answers the board's prefs.
export async function loadPrefs(key: string): Promise<Prefs> {
  await views.load();
  return prefsFor(key);
}

// Saves a board's prefs: the view to settings (when it changed), the fold to this device.
export function saveView(key: string, p: Prefs) {
  setFold(key, p.closedFolded);
  const view: View = { mode: p.mode, scope: p.scope, closedAll: p.closedAll };
  // A board on its defaults with no saved view has nothing to save.
  if (!views.cached(key) && JSON.stringify(view) === JSON.stringify(DEFAULT_VIEW)) return;
  views.save(key, view);
}
