// The test-only routes (POST /api/test/cost and /api/test/stall, src/daemon.ts) answer only a daemon that test/lib.sh
// started: STAM_TEST_COST_HOOKS is exactly 1, STAM_HOME is set and isn't the live home, the tmux
// socket is a stam-test- one, and STAM_HOME is a test home (src/test-env.ts: the `.stam-test-home`
// marker with test/lib.sh's `owner` file beside it). Anything else, a default home included, gets a 404.
import { join } from 'node:path';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import * as db from './db.ts';
import { defaultHomes } from './default-home.ts';
import { envVar } from './env.ts';

export function testHooksAllowed(env: NodeJS.ProcessEnv, home: string, socket: string): boolean {
  return envVar('TEST_COST_HOOKS', env) === '1' && Boolean(envVar('HOME', env)) && !defaultHomes().includes(home) && socket.startsWith('stam-test-');
}

// Counts every statement execution (get, all, run, iterate) on the database handle until the returned
// stop function is called, which returns the count. Test-only: POST /api/test/statements (test/e2e-agents-route.sh).
export function countStatements(d: { prepare: (sql: string) => unknown }): () => number {
  const prepare = (d.prepare as (sql: string) => any).bind(d);
  let n = 0;
  (d as any).prepare = (sql: string) => {
    const st = prepare(sql);
    for (const m of ['get', 'all', 'run', 'iterate']) {
      const f = st[m].bind(st);
      st[m] = (...args: unknown[]) => {
        n++;
        return f(...args);
      };
    }
    return st;
  };
  return () => {
    delete (d as any).prepare;
    return n;
  };
}

// Agent names whose launch fails once their row exists (POST /api/test/launch-fail, test/e2e-reviewer-ring.sh).
// Always empty outside a test daemon.
export const failLaunch = new Set<string>();

// Holds a spawn's ITSA lookup while a test makes something else happen first (POST /api/test/itsa-gate,
// test/e2e-reviewer-ring.sh). Open unless held; `waiting` counts the spawns parked at it.
export const itsaGate = {
  waiting: 0,
  _held: null as Promise<void> | null,
  _open: () => {},
  hold() {
    if (!this._held) this._held = new Promise<void>((r) => (this._open = r));
  },
  release() {
    this._open();
    this._held = null;
  },
  async pass() {
    if (!this._held) return;
    this.waiting++;
    try {
      await this._held;
    } finally {
      this.waiting--;
    }
  },
};

// One agent write of the test routes and the startup seed (POST /api/test/agent, test-seed.json), shaped like the
// API: `agent` names it (an id, or the id to create with `create`), and each field below is optional. Fields are
// written raw, so no lifecycle or activity observer runs. `parent` and `forwarded_to` are agent refs, resolved by
// `ref`; `workspace` and `pending_action` take an object (stored as JSON text) or text; `token` is stored hashed.
// `create` ({name, role, machine, harness, model, cwd, session_id}, all optional) makes the agent first. A raw write doesn't
// bump `updated_at`, which stays as the agent had it.
export type TestAgentBody = Record<string, unknown> & { agent: string };
export function applyTestAgent(body: TestAgentBody, ref: (r: string) => string, hash: (t: string) => string): string {
  let id = String(body.agent);
  const c = body.create;
  if (c && typeof c === 'object') {
    const o = c as Record<string, string | undefined>;
    db.createAgent({ id, name: o.name ?? id, role: o.role ?? 'dev', machine: o.machine ?? envVar('MACHINE') ?? 'test', harness: (o.harness ?? 'claude') as db.Agent['harness'], model: o.model ?? null, effort: null, cwd: o.cwd ?? '/tmp', parent_id: null, session_id: o.session_id ?? null });
  } else id = ref(id);
  const json = (v: unknown) => (v === null || v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v));
  const f: Record<string, string | null> = {};
  for (const k of ['type', 'lifecycle', 'activity', 'activity_detail', 'harness', 'first_prompt', 'created_at', 'updated_at', 'kind', 'idle_since'] as const) if (body[k] !== undefined) f[k] = body[k] === null ? null : String(body[k]);
  if (body.forwarded_to !== undefined) f.forwarded_to = ref(String(body.forwarded_to));
  if (body.parent !== undefined) f.parent_id = ref(String(body.parent));
  if (body.workspace !== undefined) f.workspace = json(body.workspace);
  if (body.pending_action !== undefined) f.pending_action = json(body.pending_action);
  if (body.token !== undefined) f.token_hash = body.token === null ? null : hash(String(body.token));
  // idle_since marks when an agent stopped working, as db.updateAgent keeps it, unless the write names it.
  if (f.activity && body.idle_since === undefined) f.idle_since = f.activity === 'idle' || f.activity === 'waiting' ? new Date().toISOString() : null;
  const keys = Object.keys(f);
  if (keys.length) db.open().prepare(`UPDATE agents SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => f[k]), id);
  return id;
}

// A permission request's bookkeeping (POST /api/test/permission): `id` names it; `created_at`, `status`, `decided_by`,
// `decided_at` and `expires_at` are each optional, so a test can age or settle a request the way an older daemon left it.
export function applyTestPermission(body: Record<string, unknown>): void {
  const f: Record<string, string | null> = {};
  for (const k of ['created_at', 'status', 'decided_by', 'decided_at', 'expires_at'] as const) if (body[k] !== undefined) f[k] = body[k] === null ? null : String(body[k]);
  const keys = Object.keys(f);
  if (!keys.length) return;
  const r = db.open().prepare(`UPDATE permission_requests SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => f[k]), String(body.id));
  if (!r.changes) throw new Error(`no permission request ${String(body.id)}`);
}

// A wait row as an older daemon, or a clock, would have left it (POST /api/test/wait): `agent` (a ref), `kind`, and
// optional `id`, `target`, `detail`, `since`, `until`, `source`, `data` (an object, or JSON text). Written as given,
// so nothing ties it to a request or rolls it forward.
export function applyTestWait(body: Record<string, unknown>, ref: (r: string) => string): void {
  const text = (v: unknown) => (v === null || v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v));
  const id = typeof body.id === 'string' ? body.id : `wtest${Math.random().toString(36).slice(2, 10)}`;
  db.open()
    .prepare('INSERT INTO waits (id, agent_id, kind, target, detail, since, until, source, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, ref(String(body.agent)), String(body.kind), text(body.target), text(body.detail), String(body.since ?? new Date().toISOString()), text(body.until), String(body.source ?? 'stam'), text(body.data));
}

// Usage rows (POST /api/test/usage): `table` is `usage` (per agent and day) or `usage_samples` (per agent and 5-minute
// bucket), `rows` each name `agent` (a ref) and the table's other columns by their API names.
export function applyTestUsage(body: { table?: unknown; rows?: Record<string, unknown>[] }, ref: (r: string) => string): void {
  const cols = {
    usage: ['day', 'harness', 'model', 'account', 'cost_usd', 'tokens_in', 'tokens_out', 'tokens_cache_read', 'tokens_cache_write'],
    usage_samples: ['account', 'harness', 'model', 'bucket', 'cost_usd', 'tokens_in', 'tokens_out', 'tokens_cache_read', 'tokens_cache_write'],
  }[String(body.table) as 'usage'];
  if (!cols) throw new Error('table must be usage or usage_samples');
  for (const row of body.rows ?? []) {
    const have = cols.filter((c) => row[c] !== undefined);
    db.open()
      .prepare(`INSERT INTO ${String(body.table)} (agent_id, ${have.join(', ')}) VALUES (?, ${have.map(() => '?').join(', ')})`)
      .run(ref(String(row.agent)), ...have.map((c) => row[c] as string | number | null));
  }
}

// A mail's created_at (POST /api/test/mail set-time): `mail` is its id.
export function applyTestMailTime(mail: string, at: string): void {
  db.open().prepare('UPDATE mail SET created_at = ? WHERE id = ?').run(at, mail);
}

// An ITSA as the API shows it, with its `participants` (agent ids) and `events` ({ts, actor, type, data}): `id`, `key`,
// `kind`, `title`, `status`, `owner`, `created_by`, `parent_id`, `created_at`, `updated_at`, `closed_at`. Written as given.
export function applyTestItsa(b: Record<string, unknown>): void {
  const d = db.open();
  d.prepare('INSERT INTO itsas (id, key, parent_id, kind, title, status, owner, created_by, created_at, updated_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    ...(['id', 'key', 'parent_id', 'kind', 'title', 'status', 'owner', 'created_by', 'created_at', 'updated_at', 'closed_at'].map((k) => (b[k] ?? null) as string | null) as [string, string, string | null, string, string, string, string | null, string, string, string, string | null]),
  );
  for (const e of (b.events ?? []) as Record<string, unknown>[]) d.prepare('INSERT INTO itsa_events (itsa_id, ts, actor, type, data) VALUES (?, ?, ?, ?, ?)').run(String(b.id), String(e.ts), String(e.actor), String(e.type), JSON.stringify(e.data));
  for (const p of (b.participants ?? []) as string[]) d.prepare('INSERT OR IGNORE INTO itsa_participants (itsa_id, agent_id) VALUES (?, ?)').run(String(b.id), p);
}

// Activity items (the rows the activity summary reads): `agent` (an id), `seq`, `turn`, `kind`, `start`, `end`,
// `wait_kind`, `raw_cost_usd`, `est_cost_usd`, `category`, `category_source`.
export function applyTestActivity(rows: Record<string, unknown>[]): void {
  const ins = db.open().prepare('INSERT INTO activity_items (agent_id, seq, turn, kind, name, start, "end", summary, wait_kind, raw_cost_usd, est_cost_usd, tokens_in, tokens_out, category, category_source, confidence) VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, 0, 0, ?, ?, 1)');
  for (const x of rows) ins.run(String(x.agent), Number(x.seq), Number(x.turn), String(x.kind), String(x.start), String(x.end), (x.wait_kind ?? null) as string | null, Number(x.raw_cost_usd ?? 0), Number(x.est_cost_usd ?? 0), (x.category ?? null) as string | null, (x.category_source ?? null) as string | null);
}

// Subscription window readings: `readings` ({name, window, at, used_percentage, resets_at}) and the `subscription`
// row ({name, data, updated_at}) the usage snapshot calibrates from.
export function applyTestWindows(w: { readings?: Record<string, unknown>[]; subscription?: Record<string, unknown> | null } | undefined): void {
  const d = db.open();
  const ins = d.prepare('INSERT INTO window_readings (name, window, at, used_percentage, resets_at) VALUES (?, ?, ?, ?, ?)');
  for (const x of w?.readings ?? []) ins.run(String(x.name), String(x.window), String(x.at), Number(x.used_percentage), Number(x.resets_at));
  const s = w?.subscription;
  if (s) d.prepare('INSERT INTO subscriptions (name, data, updated_at) VALUES (?, ?, ?)').run(String(s.name), JSON.stringify(s.data), String(s.updated_at));
}

// The startup seed: STAM_HOME/test-seed.json, applied once before the daemon's first reconcile, so a test sees how
// startup treats a state it could not make through the API (also one written while the daemon was down, for the next
// start). Keys: agents [TestAgentBody], events [{agent, type}], permissions [applyTestPermission bodies], waits
// [applyTestWait bodies], mail [{mail, at}], usage [applyTestUsage bodies], itsas [applyTestItsa bodies], activity
// [applyTestActivity rows], windows [{readings, subscription}]. The whole seed is one transaction. Taken only by a test daemon, and renamed
// to test-seed.json.done so a restart doesn't seed twice.
export function applyTestSeed(home: string, ref: (r: string) => string, hash: (t: string) => string): void {
  const file = join(home, 'test-seed.json');
  if (!existsSync(file)) return;
  const seed = JSON.parse(readFileSync(file, 'utf8')) as {
    agents?: TestAgentBody[];
    events?: { agent: string; type: string }[];
    permissions?: Record<string, unknown>[];
    waits?: Record<string, unknown>[];
    mail?: { mail: string; at: string }[];
    usage?: { table?: unknown; rows?: Record<string, unknown>[] }[];
    itsas?: Record<string, unknown>[];
    activity?: Record<string, unknown>[];
    windows?: { readings?: Record<string, unknown>[]; subscription?: Record<string, unknown> | null };
  };
  const d = db.open();
  d.exec('BEGIN');
  try {
    for (const a of seed.agents ?? []) applyTestAgent(a, ref, hash);
    for (const e of seed.events ?? []) db.addEvent(e.agent, e.type);
    for (const p of seed.permissions ?? []) applyTestPermission(p);
    for (const w of seed.waits ?? []) applyTestWait(w, ref);
    for (const m of seed.mail ?? []) applyTestMailTime(m.mail, m.at);
    for (const u of seed.usage ?? []) applyTestUsage(u, ref);
    for (const i of seed.itsas ?? []) applyTestItsa(i);
    applyTestActivity(seed.activity ?? []);
    applyTestWindows(seed.windows);
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  renameSync(file, `${file}.done`);
}

// The read side of the test routes (GET /api/test/...): purpose-named reads of what the API doesn't show, so a test
// never opens the database and a rewrite of the daemon has a narrow contract to meet. Each returns rows named after
// the API, and an empty list for a table that does not exist yet.
const rows = (sql: string, ...args: (string | number | null)[]): Record<string, unknown>[] => {
  try {
    return db.open().prepare(sql).all(...args) as Record<string, unknown>[];
  } catch (e) {
    if (e instanceof Error && /no such table/.test(e.message)) return [];
    throw e;
  }
};
// `agent` is an agent id, or null for every agent.
export const testReads = {
  // Cost blockers: [{agent, kind, account, reason}].
  blockers: (agent: string | null) => rows('SELECT agent_id AS agent, kind, account, reason FROM blockers WHERE (? IS NULL OR agent_id = ?)', agent, agent),
  // Cost notices: [{agent, kind, acked_by}].
  costNotices: (agent: string | null) => rows('SELECT agent_id AS agent, kind, acked_by FROM cost_notices WHERE (? IS NULL OR agent_id = ?)', agent, agent),
  // Cost fallbacks, with the kind of the notice each belongs to: [{agent, kind, notice_kind, state, result}].
  costFallbacks: (agent: string | null) =>
    rows('SELECT f.agent_id AS agent, f.kind AS kind, n.kind AS notice_kind, f.state AS state, f.result AS result FROM cost_fallbacks f JOIN cost_notices n ON n.id = f.notice_id WHERE (? IS NULL OR f.agent_id = ?)', agent, agent),
  // Whether a mail was pushed to an agent yet: [{subject, pushed}].
  mailPushed: (agent: string, subject: string) =>
    rows('SELECT m.subject AS subject, r.pushed_at IS NOT NULL AS pushed FROM mail_recipients r JOIN mail m ON m.id = r.mail_id WHERE r.agent_id = ? AND m.subject = ?', agent, subject).map((r) => ({ ...r, pushed: Boolean(r.pushed) })),
  // What an account spent in the usage ledger.
  usageTotal: (account: string) => ({ cost_usd: (rows('SELECT COALESCE(SUM(cost_usd), 0) AS n FROM usage WHERE account = ?', account)[0]?.n as number) ?? 0 }),
  // The agents on other machines this daemon remembers: [{name, machine}].
  peerAgents: () => rows('SELECT name, machine FROM peer_agents ORDER BY name'),
  // Requirement waivers: [{kind, reason}].
  reqWaivers: () => rows('SELECT kind, reason FROM req_waivers'),
  // Row counts of what a boot writes; the agents' own hook events (hook:*) are left out of `events`.
  counts: () => ({
    agents: rows('SELECT COUNT(*) AS n FROM agents')[0].n,
    events: rows("SELECT COUNT(*) AS n FROM events WHERE type NOT LIKE 'hook:%'")[0].n,
    mail: rows('SELECT COUNT(*) AS n FROM mail')[0].n,
    itsas: rows('SELECT COUNT(*) AS n FROM itsas')[0].n,
  }),
};
