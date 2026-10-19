// Where each setting lives (S-405, S-380 change 5): shared by all machines on the settings home,
// or local to one machine (LOCAL_KEYS in src/settings.ts, sent by GET /api/config/settings).
export interface SettingsScope {
  // The machine that keeps the shared settings; '' when the daemon didn't say.
  home: string
  // Settings keys (dotted paths) that belong to the machine they are on.
  local: string[]
  // True on a daemon that isn't the home: shared settings are read-only there, unless it knows homeWeb.
  peer: boolean
  stale: boolean
  fetchedAt: string | null
  // On a peer, the home's web origin, where shared changes are sent (S-414); null when it has none.
  homeWeb: string | null
}

export interface SettingsReply { text: string; local?: string[]; home?: string; stale?: boolean; fetchedAt?: string | null; homeWeb?: string }

// The home sends no `stale`, and its `home` is its own name; a peer says which machine is the home.
export function scopeOf(r: SettingsReply, machine: string): SettingsScope {
  const home = r.home ?? ''
  return { home, local: r.local ?? [], peer: !!home && home !== machine, stale: !!r.stale, fetchedAt: r.fetchedAt ?? null, homeWeb: r.homeWeb ?? null }
}

// A path is local when it is a local key or inside one (peers.0.url is inside peers).
export function isLocalKey(path: string, local: string[]): boolean {
  return local.some((k) => path === k || path.startsWith(k + '.') || k.startsWith(path + '.'))
}

// A shared setting can't be changed on a peer that doesn't know where the home's page is; the home
// and local keys can, and a peer that knows sends shared changes to the home (S-414).
// MCP servers name commands every machine runs: the home takes them only from its own page.
export function readOnly(path: string, scope: SettingsScope | null): boolean {
  if (scope?.peer && (path === 'mcpServers' || path.startsWith('mcpServers.'))) return true
  return !!scope?.peer && !scope.homeWeb && !isLocalKey(path, scope.local)
}

// Whether shared changes on this page go to the home's page rather than this daemon.
export const writesToHome = (scope: SettingsScope | null): scope is SettingsScope & { homeWeb: string } => !!scope?.peer && !!scope.homeWeb

type Obj = { [k: string]: unknown }
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const get = (o: unknown, path: string[]): unknown => path.reduce<unknown>((x, k) => (isObj(x) ? x[k] : undefined), o)
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
// A value with the local sub-paths under a mixed key (itsa.home under itsa) taken out.
function withoutLocal(v: unknown, subs: string[][]): unknown {
  if (!isObj(v)) return v
  const out: Obj = JSON.parse(JSON.stringify(v))
  for (const p of subs) {
    const parent = get(out, p.slice(0, -1))
    if (isObj(parent)) delete parent[p[p.length - 1]]
  }
  return out
}

// A peer's top-level patch split by where it is saved (S-414): `local` for this daemon, `shared` for
// the home. A key that mixes both (itsa) goes, whole, to each side whose part of it changed; each
// daemon takes only its own part.
export function splitPatch(patch: Obj, base: Obj, local: string[]): { local: Obj; shared: Obj } {
  const out = { local: {} as Obj, shared: {} as Obj }
  for (const [k, v] of Object.entries(patch)) {
    if (local.some((l) => k === l || k.startsWith(l + '.'))) { out.local[k] = v; continue }
    const subs = local.filter((l) => l.startsWith(k + '.')).map((l) => l.split('.').slice(1))
    if (!subs.length) { out.shared[k] = v; continue }
    if (subs.some((p) => !same(get(v, p), get(base[k], p)))) out.local[k] = v
    if (!same(withoutLocal(v, subs), withoutLocal(base[k], subs))) out.shared[k] = v
  }
  return out
}

export function staleNote(scope: SettingsScope, now = Date.now()): string | null {
  if (!scope.peer || !scope.stale) return null
  const at = scope.fetchedAt ? Date.parse(scope.fetchedAt) : NaN
  if (!Number.isFinite(at)) return `Can't reach ${scope.home}; no copy of the shared settings has arrived yet.`
  const mins = Math.max(0, Math.round((now - at) / 60000))
  const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`
  return `Can't reach ${scope.home}; showing the last copy from ${ago}.`
}
