// A requirement draft an agent wrote needs the human's approval (settings.requirements.approval
// is `human`, the default). It reaches the human the way every other ask does, through the
// attention list of ITSAs in a human status (src/itsa-human.ts): the draft gets an ITSA of kind
// `requirement-approval`, linked to the requirement (system `requirement`, external id the key),
// moved to `needs_approval` with a comment that carries the statement. No new list, no separate
// mail. The human's Approve action moves the requirement to `in_force` and closes that ITSA;
// Request changes leaves the draft a draft and sends the human's text to the agent as the
// ITSA's other actions do.
//
// With settings.requirements.approval `cos` the ask goes to the chief of staff instead, by mail
// through the same ITSA: the chief of staff owns it, it never enters a human status, and the
// chief of staff approves with `req_set status=in_force`. With no chief of staff (or when it
// wrote the draft itself) the ask goes to the human as above. A requirement that reaches
// `in_force` any other way closes its open ask as done (approvedElsewhere).
//
// An approval applies to the draft that was shown. The ask records the requirement's `rev`, a
// counter every edit bumps (table req_approvals); Approve passes it back, and the requirement
// refuses the move when it changed since. The same ITSA is then refreshed with the new
// statement and asks again; an edit to a draft while its ask is open refreshes it the same way.
import * as db from './db.ts';
import * as itsa from './itsa.ts';
import { HUMAN } from './mail.ts';
import { settings } from './settings.ts';
import { chiefOfStaff } from './org.ts';
import * as requirements from './requirements.ts';

export const APPROVAL_KIND = 'requirement-approval';
const log = (what: string, e: unknown) => console.error(`requirement approval: ${what}: ${e instanceof Error ? e.message : e}`);

let ready = false;
function table(): void {
  if (ready) return;
  const d = db.open();
  d.exec('CREATE TABLE IF NOT EXISTS req_approvals (itsa_id TEXT PRIMARY KEY, req_key TEXT NOT NULL, updated_at TEXT NOT NULL)');
  // `rev`: the requirement's edit counter when shown; `via`: who is asked, `human` or `cos`. A
  // table made before them gets the columns; an ask with no rev counts as changed.
  const cols = (d.prepare('PRAGMA table_info(req_approvals)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('rev')) d.exec('ALTER TABLE req_approvals ADD COLUMN rev INTEGER');
  if (!cols.includes('via')) d.exec("ALTER TABLE req_approvals ADD COLUMN via TEXT NOT NULL DEFAULT 'human'");
  ready = true;
}
interface Stamp {
  req_key: string;
  rev: number | null;
  via: 'human' | 'cos';
}
const stampOf = (itsaId: string): Stamp | undefined => {
  table();
  return db.open().prepare('SELECT req_key, rev, via FROM req_approvals WHERE itsa_id = ?').get(itsaId) as Stamp | undefined;
};
const setStamp = (itsaId: string, r: requirements.Requirement, via: Stamp['via']): void => {
  table();
  db.open().prepare('INSERT OR REPLACE INTO req_approvals (itsa_id, req_key, updated_at, rev, via) VALUES (?, ?, ?, ?, ?)').run(itsaId, r.key, r.updated_at, r.rev, via);
};

function statement(r: requirements.Requirement, via: Stamp['via'] = 'human'): string {
  const lines = [`**${r.key}: ${r.title}**`, '', r.text ?? '(no text yet)'];
  if (r.rationale) lines.push('', `Why: ${r.rationale}`);
  if (r.source) lines.push(`Source: ${r.source}`);
  if (r.verification?.length) lines.push(`Verification: ${r.verification.map((v) => (v.detail ? `${v.method} (${v.detail})` : v.method)).join(', ')}`);
  if (r.scope) lines.push(`Scope: ${JSON.stringify(r.scope)}`);
  lines.push(`Severity ${r.severity}, mode ${r.mode}. Rev ${r.rev}.`, '');
  lines.push(via === 'cos' ? `To put it in force: req_set key=${r.key} status=in_force if_rev=${r.rev}. To send it back, comment on this ITSA.` : 'Approve to put it in force; Request changes to send it back to its author.');
  return lines.join('\n');
}

// Raises the ask for a draft an agent made. Returns the ITSA's key, or the reason when no ask was
// made: the draft then stays a draft, listed under `stam req ls`.
export async function ask(r: requirements.Requirement, by: string): Promise<{ key: string; to: 'human' | 'chief of staff' } | { error: string }> {
  const approval = settings().requirements.approval;
  if (by === HUMAN || r.status !== 'draft' || (approval !== 'human' && approval !== 'cos')) return { error: 'no ask needed' };
  // The chief of staff can't approve its own draft, so that one goes to the human.
  const cos = approval === 'cos' ? chiefOfStaff() : undefined;
  if (cos && cos.id !== by) return askCos(r, by, cos);
  let made: itsa.Itsa | undefined;
  try {
    const x = await itsa.create({
      title: `Approve requirement ${r.key}: ${r.title}`,
      summary: r.text ?? undefined,
      body: statement(r),
      kind: APPROVAL_KIND,
      status: 'waiting',
      owner: by,
      participants: [by],
      links: [{ system: 'requirement', external_id: r.key, url: `stam:requirement/${r.key}` }],
      by,
    });
    made = x;
    setStamp(x.id, r, 'human');
    // The comment comes first: the move into a human status mails the ask with it.
    await itsa.post(x.id, { by, body: statement(r) });
    const moved = await itsa.set(x.id, { status: 'needs_approval' }, by);
    return { key: moved.itsa.key, to: 'human' };
  } catch (e) {
    // An ask that couldn't be raised leaves no orphan ITSA behind.
    if (made) await itsa.set(made.id, { status: 'canceled' }, by).catch(() => {});
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// The ask to the chief of staff: the same kind of ITSA, owned by the chief of staff, in an active
// status (no human status, so nothing reaches the human). The author's post carries the statement
// and names the chief of staff, which mails it and interrupts it.
async function askCos(r: requirements.Requirement, by: string, cos: db.Agent): Promise<{ key: string; to: 'chief of staff' } | { error: string }> {
  let made: itsa.Itsa | undefined;
  try {
    const x = await itsa.create({
      title: `Approve requirement ${r.key}: ${r.title}`,
      summary: r.text ?? undefined,
      body: statement(r, 'cos'),
      kind: APPROVAL_KIND,
      status: 'waiting',
      owner: cos.id,
      participants: [by, cos.id],
      links: [{ system: 'requirement', external_id: r.key, url: `stam:requirement/${r.key}` }],
      by,
    });
    made = x;
    setStamp(x.id, r, 'cos');
    await itsa.post(x.id, { by, body: `@${cos.name} a draft needs your approval.\n\n${statement(r, 'cos')}` });
    return { key: x.key, to: 'chief of staff' };
  } catch (e) {
    if (made) await itsa.set(made.id, { status: 'canceled' }, by).catch(() => {});
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// --- One ask for a batch (`stam req seed`) ----------------------------------------------------
//
// A batch of drafts gets one `requirement-approval` ITSA, never one per draft: it links every
// draft and carries one comment that lists each key, title, and text. Table req_batch_asks holds
// each draft's rev at ask time. Approve puts every draft in force only if each is still at its
// stored rev; otherwise nothing is approved and the same ask is refreshed with the new texts.
// Request changes leaves them all drafts. Who is asked follows the single-draft rules.

let batchReady = false;
function batchTable(): void {
  if (batchReady) return;
  const d = db.open();
  d.exec('CREATE TABLE IF NOT EXISTS req_batch_asks (itsa_id TEXT NOT NULL, req_key TEXT NOT NULL, rev INTEGER NOT NULL, via TEXT NOT NULL, PRIMARY KEY (itsa_id, req_key))');
  // `dropped`: the human took this draft out of the batch. It stays a draft and isn't approved.
  const cols = (d.prepare('PRAGMA table_info(req_batch_asks)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('dropped')) d.exec('ALTER TABLE req_batch_asks ADD COLUMN dropped INTEGER NOT NULL DEFAULT 0');
  batchReady = true;
}
interface Member {
  req_key: string;
  rev: number;
  via: Stamp['via'];
  dropped: number;
}
const membersOf = (itsaId: string): Member[] => {
  batchTable();
  return db.open().prepare('SELECT req_key, rev, via, dropped FROM req_batch_asks WHERE itsa_id = ? ORDER BY rowid').all(itsaId) as unknown as Member[];
};
// A re-stamp keeps `dropped`: a draft changed in the batch doesn't come back into it.
const stampBatch = (itsaId: string, rs: requirements.Requirement[], via: Stamp['via']): void => {
  batchTable();
  const st = db.open().prepare('INSERT INTO req_batch_asks (itsa_id, req_key, rev, via) VALUES (?, ?, ?, ?) ON CONFLICT (itsa_id, req_key) DO UPDATE SET rev = excluded.rev, via = excluded.via');
  for (const r of rs) st.run(itsaId, r.key, r.rev, via);
};
// The batch members that are still drafts and not dropped, in the batch's order: what Approve puts in force.
const draftsOf = (members: Member[]): requirements.Requirement[] =>
  members.filter((m) => !m.dropped).map((m) => requirements.find(m.req_key)).filter((r): r is requirements.Requirement => !!r && r.status === 'draft');

// One line per draft: key and title, the text, and why (the rationale), then the source, verification, and meta.
function batchStatement(rs: requirements.Requirement[], via: Stamp['via']): string {
  const ids = new Set(rs.map((r) => r.id));
  const byKey = (a: requirements.Requirement, b: requirements.Requirement) => a.key.localeCompare(b.key, undefined, { numeric: true });
  const lines = [`**${rs.length} requirement drafts** for approval as one batch. Each starts in the mode shown; observe records verdicts and tells nobody.`, ''];
  // A sentence ends with one full stop: a text that already ends with punctuation keeps it.
  const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);
  const line = (r: requirements.Requirement, depth: number) => {
    const parent = r.parent_id && !ids.has(r.parent_id) ? ` (under ${requirements.find(r.parent_id)?.key ?? r.parent_id})` : '';
    const meta = [r.source && `source ${r.source}`, r.verification?.length && `verify ${r.verification.map((v) => v.method).join('+')}`, r.severity, r.mode, `rev ${r.rev}`].filter(Boolean).join(', ');
    const why = r.rationale ? ` Why: ${sentence(r.rationale)}` : '';
    lines.push(`${'  '.repeat(depth)}- **${r.key}: ${r.title}**${parent}${r.text ? `: ${sentence(r.text)}` : ''}${why} _(${meta})_`);
    for (const c of rs.filter((x) => x.parent_id === r.id).sort(byKey)) line(c, depth + 1);
  };
  for (const r of rs.filter((x) => !x.parent_id || !ids.has(x.parent_id)).sort(byKey)) line(r, 0);
  lines.push('');
  lines.push(
    via === 'cos'
      ? `To put one in force: req_set key=KEY status=in_force if_rev=REV, with the rev listed. To send the batch back, comment on this ITSA.`
      : 'Approve puts every draft listed in force; Request changes sends the batch back to its author.',
  );
  return lines.join('\n');
}

// Raises one ask for a batch of drafts an agent made. Returns the ITSA's key, or the reason when
// no ask was made (the drafts then stay drafts).
export async function askBatch(rs: requirements.Requirement[], by: string): Promise<{ key: string; to: 'human' | 'chief of staff' } | { error: string }> {
  const approval = settings().requirements.approval;
  const drafts = rs.filter((r) => r.status === 'draft');
  if (by === HUMAN || !drafts.length || (approval !== 'human' && approval !== 'cos')) return { error: 'no ask needed' };
  const cos = approval === 'cos' ? chiefOfStaff() : undefined;
  const via: Stamp['via'] = cos && cos.id !== by ? 'cos' : 'human';
  const keys = drafts.map((r) => r.key);
  const span = keys.length > 1 ? `${keys[0]} to ${keys[keys.length - 1]}` : keys[0];
  let made: itsa.Itsa | undefined;
  try {
    const x = await itsa.create({
      title: `Approve ${drafts.length} requirements: ${span}`,
      summary: `${drafts.length} requirement drafts for approval as one batch.`,
      body: batchStatement(drafts, via),
      kind: APPROVAL_KIND,
      status: 'waiting',
      owner: via === 'cos' ? cos!.id : by,
      participants: via === 'cos' ? [by, cos!.id] : [by],
      links: drafts.map((r) => ({ system: 'requirement', external_id: r.key, url: `stam:requirement/${r.key}` })),
      by,
    });
    made = x;
    stampBatch(x.id, drafts, via);
    if (via === 'cos') {
      await itsa.post(x.id, { by, body: `@${cos!.name} a batch of drafts needs your approval.\n\n${batchStatement(drafts, via)}` });
      return { key: x.key, to: 'chief of staff' };
    }
    // The comment comes first: the move into a human status mails the ask with it.
    await itsa.post(x.id, { by, body: batchStatement(drafts, via) });
    const moved = await itsa.set(x.id, { status: 'needs_approval' }, by);
    return { key: moved.itsa.key, to: 'human' };
  } catch (e) {
    if (made) await itsa.set(made.id, { status: 'canceled' }, by).catch(() => {});
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// The open batch ask that holds this draft, if any.
function openBatchAsk(key: string): itsa.Itsa | undefined {
  batchTable();
  const rows = db.open().prepare('SELECT itsa_id FROM req_batch_asks WHERE req_key = ? ORDER BY rowid DESC').all(key) as { itsa_id: string }[];
  for (const r of rows) {
    const x = itsa.find(r.itsa_id);
    if (x && itsa.statusOf(x.status)?.category !== 'closed') return x;
  }
  return undefined;
}

// A draft in the batch changed, or an Approve found one changed: the same ITSA gets the batch as
// it is now, with every rev stamped again, and asks again. The human's own edit only moves the stamps.
async function refreshBatch(x: itsa.Itsa, by: string): Promise<void> {
  const members = membersOf(x.id);
  const via = members[0]?.via ?? 'human';
  const drafts = draftsOf(members);
  if (!drafts.length) return;
  stampBatch(x.id, drafts, via);
  if (by === HUMAN) return;
  const sender = via === 'cos' || !x.owner || x.owner === HUMAN ? by : x.owner;
  await itsa.set(x.id, { body: batchStatement(drafts, via) }, sender);
  const mention = via === 'cos' && x.owner && db.getAgent(x.owner) ? `@${db.getAgent(x.owner)!.name} ` : '';
  await itsa.post(x.id, { by: sender, body: `${mention}A draft in this batch changed. This is the batch now:\n\n${batchStatement(drafts, via)}` });
  if (via === 'human' && x.status !== 'needs_approval') await itsa.set(x.id, { status: 'needs_approval' }, sender);
}

// The human's Approve on a batch ask: every draft in force at its stored rev, or none. The check
// and the writes are one transaction (requirements.approveAtRevs); the ITSA follows after.
async function approveBatch(x: itsa.Itsa): Promise<void> {
  const members = membersOf(x.id);
  const drafts = draftsOf(members);
  const rev = new Map(members.map((m) => [m.req_key, m.rev]));
  const r = requirements.approveAtRevs(drafts.map((d) => ({ key: d.key, rev: rev.get(d.key)! })));
  if ('stale' in r) {
    await refreshBatch(x, x.owner ?? HUMAN);
    return;
  }
  await itsa.set(x.id, { status: 'done' }, HUMAN);
}

// A batch ask's drafts as the human sees them, each with its text and rationale; `dropped` marks
// the ones taken out of the batch. Undefined when the ITSA isn't a batch ask.
export interface BatchItem {
  key: string;
  title: string;
  text: string | null;
  rationale: string | null;
  rev: number;
  status: string;
  dropped: boolean;
}
export function batchOf(ref: string): { itsa: itsa.Itsa; items: BatchItem[] } | undefined {
  const x = itsa.find(ref);
  if (!x || x.kind !== APPROVAL_KIND) return undefined;
  const members = membersOf(x.id);
  if (!members.length) return undefined;
  const items = members.flatMap((m): BatchItem[] => {
    const r = requirements.find(m.req_key);
    return r ? [{ key: r.key, title: r.title, text: r.text, rationale: r.rationale, rev: m.rev, status: r.status, dropped: !!m.dropped }] : [];
  });
  return { itsa: x, items };
}

// The human drops one draft from an open batch ask. It stays a draft and Approve leaves it out;
// with `obsolete` it is marked obsolete as well. `ifRev` is the rev the human was shown: a draft
// that changed since, or that is no longer a draft (an Approve put it in force), refuses the drop.
// The checks and the writes are one transaction with no await before it ends, so an Approve can't
// land between them (approveBatch writes its drafts synchronously too). Only that draft changes, so
// the others keep their revs and Approve stays all or nothing for the rest.
export async function dropFromBatch(ref: string, key: string, obsolete: boolean, ifRev: number): Promise<void> {
  const posted = db.transaction((): itsa.Itsa | null => {
    const b = batchOf(ref);
    if (!b) throw new Error(`no requirement approval ${ref}`);
    if (itsa.statusOf(b.itsa.status)?.category === 'closed') throw new Error(`${b.itsa.key} is closed`);
    const m = membersOf(b.itsa.id).find((x) => x.req_key === key);
    if (!m) throw new Error(`${key} is not in ${b.itsa.key}`);
    if (m.dropped) return null;
    if (obsolete) requirements.obsoleteDraftAtRev(key, ifRev);
    else requirements.assertDraftAtRev(key, ifRev);
    db.open().prepare('UPDATE req_batch_asks SET dropped = 1 WHERE itsa_id = ? AND req_key = ?').run(b.itsa.id, key);
    return b.itsa;
  });
  if (!posted) return;
  await itsa.post(posted.id, { by: HUMAN, body: `${key} is dropped from this batch and ${obsolete ? 'marked obsolete' : 'stays a draft'}. Approve all approves what is left.` });
}

// The open approval ITSA of a requirement, if any.
function openAsk(key: string): itsa.Itsa | undefined {
  table();
  const rows = db.open().prepare('SELECT itsa_id FROM req_approvals WHERE req_key = ? ORDER BY rowid DESC').all(key) as { itsa_id: string }[];
  for (const r of rows) {
    const x = itsa.find(r.itsa_id);
    if (x && itsa.statusOf(x.status)?.category !== 'closed') return x;
  }
  return undefined;
}

// The draft changed (by `by`) while an ask for it is open, or an Approve found it changed: the
// same ITSA now carries the new statement, and asks again if it isn't waiting. The human's own
// edit only moves the stamp, since they know what they changed.
export async function refresh(key: string, by: string): Promise<void> {
  try {
    const b = openBatchAsk(key);
    if (b) return await refreshBatch(b, by);
    const x = openAsk(key);
    const r = requirements.find(key);
    if (!x || !r || r.status !== 'draft') return;
    const via = stampOf(x.id)?.via ?? 'human';
    setStamp(x.id, r, via);
    if (by === HUMAN) return;
    // A human ask is owned by the draft's author. A chief-of-staff ask is owned by the chief of
    // staff, so the editor posts, naming it, and the ask never moves to a human status.
    const sender = via === 'cos' || !x.owner || x.owner === HUMAN ? by : x.owner;
    await itsa.set(x.id, { body: statement(r, via), summary: r.text ?? '' }, sender);
    const mention = via === 'cos' && x.owner && db.getAgent(x.owner) ? `@${db.getAgent(x.owner)!.name} ` : '';
    await itsa.post(x.id, { by: sender, body: `${mention}The draft changed. This is the text now:\n\n${statement(r, via)}` });
    if (via === 'human' && x.status !== 'needs_approval') await itsa.set(x.id, { status: 'needs_approval' }, sender);
  } catch (e) {
    log(`refreshing the ask for ${key}`, e);
  }
}

// The human's action on the ask: Approve puts the requirement in force and closes the ITSA, if the
// draft is still the one that was shown.
function onStatus(x: itsa.Itsa, actor: string, from: string): void {
  if (x.kind !== APPROVAL_KIND || from !== 'needs_approval' || actor !== HUMAN) return;
  void (async () => {
    try {
      if (!isApprove(x)) return;
      if (membersOf(x.id).length) return await approveBatch(x);
      const key = itsa.links(x.id).find((l) => l.system === 'requirement')?.external_id;
      const stamp = stampOf(x.id);
      if (!key || !stamp) return;
      try {
        // No rev recorded (an ask from before it existed): never matches, so the ask is raised again.
        await requirements.set(key, { status: 'in_force', ifRev: stamp.rev ?? -1 }, HUMAN);
      } catch (e) {
        if (!/changed since it was shown/.test(String((e as Error)?.message))) throw e;
        // Not approved: it changed after the ask. Ask again, on this ITSA, with the new text.
        await refresh(key, x.owner ?? HUMAN);
        if (itsa.must(x.id).status !== 'needs_approval') log(`${key} changed, but its ask could not be raised again`, 'no human status');
        return;
      }
      await itsa.set(x.id, { status: 'done' }, HUMAN);
    } catch (e) {
      log(`approving for ${x.key}`, e);
    }
  })();
}

// A requirement reached `in_force` without going through the ask (the human set it directly, or
// the chief of staff did): its open ask closes as done, with a one-line comment.
export async function approvedElsewhere(key: string, by: string): Promise<void> {
  try {
    // A batch ask closes once none of its drafts is left a draft.
    const b = openBatchAsk(key);
    if (b) {
      if (draftsOf(membersOf(b.id)).length) return;
      await itsa.post(b.id, { by, body: `Every draft in this batch is now out of draft (the last, ${key}, by ${by === HUMAN ? 'your user' : db.getAgent(by)?.name ?? by}); closing this ask.` }).catch((e) => log(`commenting on the ask for ${key}`, e));
      await itsa.set(b.id, { status: 'done' }, by);
      return;
    }
    const x = openAsk(key);
    if (!x) return;
    const name = by === HUMAN ? 'your user' : db.getAgent(by)?.name ?? by;
    await itsa.post(x.id, { by, body: `${key} was put in force by ${name}; closing this ask.` }).catch((e) => log(`commenting on the ask for ${key}`, e));
    await itsa.set(x.id, { status: 'done' }, by);
  } catch (e) {
    log(`closing the ask for ${key}`, e);
  }
}

// Whether the last action event on the ITSA was the Approve action.
function isApprove(x: itsa.Itsa): boolean {
  const e = itsa.events(x.id, 50).findLast((v) => v.type === 'action');
  try {
    return !!e?.data && JSON.parse(e.data).id === 'approve';
  } catch {
    return false;
  }
}

export function watch(): void {
  itsa.onStatus(onStatus);
}
