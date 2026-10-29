// ITSA owners: spawning an agent as an ITSA's owner, naming the ITSAs an agent owns,
// notices to a parent ITSA's owner when a child needs attention or its owner stops, and
// unowning ITSAs when their owner is archived or forgotten. See docs/itsa-design.md.
//
// ITSAs live on one home daemon (settings.itsa.home). Anything that reads or changes them
// from another machine goes to the home through peerCall; notices to an agent on another
// machine go through POST /api/agents/:id/notice on its daemon.
import * as db from './db.ts';
import * as itsa from './itsa.ts';
import { isReviewerType } from './agent-types.ts';
import { settings } from './settings.ts';
import { render } from './templates.ts';
import { tellAnywhere, HUMAN } from './mail.ts';
import { MACHINE } from './config.ts';
import { findAgentPeer, locateAgent, peerByName, peerCall, type Via } from './peers.ts';
import { itsaRefusal, mayEditItsa, mayReadItsaThreads } from './mail-visibility.ts';
import { chainMarked, homeSaysMarked } from './developer-cap.ts';
import { envVar } from './env.ts';
import { subjectsForUrl } from './watch.ts';

const log = (what: string, e: unknown) => console.error(`ITSA owners: ${what}: ${e instanceof Error ? e.message : e}`);
const isHome = () => settings().itsa.home === MACHINE;

function homePeer() {
  const home = settings().itsa.home;
  const peer = home ? peerByName(home) : undefined;
  if (!peer) throw new Error(`ITSA home '${home}' is not a configured peer`);
  return peer;
}

// Only a 403 is the home's final answer (no peer holds that agent): asking again can't change it.
// Anything else, a 400 or 401 included, may be a passing failure on the home, so it is retried.
const isFinal = (e: unknown) => e instanceof itsa.ForbiddenError;

// The wait before the next try after `fails` failures in a row: doubles from `every`, capped at an hour.
export const retryDelay = (every: number, fails: number) => Math.min(every * 2 ** Math.max(0, fails - 1), 3_600_000);

// The ITSA home runs a release from before asks had homes (S-3827): an ask then has no ITSA home, never a refusal.
export class OldHome extends Error {}

async function toHome(method: string, path: string, body?: unknown, timeoutMs = 8000, via?: Via): Promise<any> {
  const r = await peerCall(homePeer(), method, path, body, timeoutMs, false, via);
  if (r.status === 403) throw new itsa.ForbiddenError(`the ITSA home ${settings().itsa.home} refused: ${r.data?.error ?? r.status}`);
  if (r.status >= 300) throw new Error(`the ITSA home ${settings().itsa.home} refused: ${r.data?.error ?? r.status}`);
  return r.data;
}

// --- The incident mark (S-2406, S-2421) ----------------------------------------------------

// The bound on the home's answer to an incident spawn's mark question: a spawn waits no longer than this for it.
const INCIDENT_ASK_MS = 5000;

// Whether the ITSA a spawn names, or one of its ancestors, carries the incident mark, read from this daemon's ITSA DB.
// An ITSA this daemon can't read is no mark.
export function incidentMarkedHere(ref: unknown): boolean {
  if (!ref) return false;
  try {
    const x = itsa.find(String(ref));
    const chain = x && itsa.provenChain(x);
    return chain !== null && chain !== undefined && chainMarked(chain);
  } catch {
    return false;
  }
}

// The same question for an incident spawn on this daemon: read here on the ITSA home, else asked of the home (S-2421).
// Fails closed: an unreachable home, a timeout or a bad reply is no mark.
export async function incidentMarked(ref: unknown): Promise<boolean> {
  if (!ref) return false;
  if ((settings().itsa.home ?? MACHINE) === MACHINE) return incidentMarkedHere(ref);
  return homeSaysMarked(() => peerCall(homePeer(), 'GET', `/api/itsas/incident-marked?itsa=${encodeURIComponent(String(ref))}`, undefined, INCIDENT_ASK_MS));
}

// --- Spawning an owner ---------------------------------------------------------------------

// The ITSA a spawn names, from the home daemon (here or a peer): its id and key, its
// current owner, and the first-prompt block that tells the new owner what it owns.
// A reviewer takes part instead (S-501): `asParticipant` words the block that way, and the owner stays.
export async function ownerBlock(ref: string, asParticipant = false): Promise<{ id: string; key: string; owner: string | null; block: string }> {
  const x = await view(ref);
  const chain = x.parent_chain.length ? `Parent chain: ${x.parent_chain.map((p: any) => `${p.key} ${p.title} (${p.status})`).join(' > ')}\n` : '';
  const links = x.links.length ? `Links:\n${x.links.map((l: any) => `- ${l.system}: ${l.url}`).join('\n')}` : '';
  const block = render(asParticipant ? 'itsa-participant' : 'itsa-owner', { key: x.key, title: x.title, status: x.status, chain, summary: x.summary ?? '(none)', body: x.body ?? '', links });
  return { id: x.id, key: x.key, owner: x.owner, block };
}

// Whether the agent asking for a spawn (`via`) may make the new agent this ITSA's owner (S-480): only
// one the ITSA lets change it (mail-visibility.ts). Throws ForbiddenError naming who may. Checked
// here when this daemon is the home; on a peer, assignOwner carries `via` and the home checks it.
export function mayAssign(ref: string, via?: Via): void {
  if (!via || via.boss || !isHome()) return;
  const id = itsa.must(ref).id;
  if (!mayEditItsa(via.agent, id)) throw new itsa.ForbiddenError(itsaRefusal(via.agent, id, 'change'));
}

// Whether the agent asking for a spawn (`via`) may add the new agent as a participant of each of these ITSAs
// (S-2424, `participate`): the same check as mayAssign, so an owner, a participant or an ancestor owner may. Throws
// ForbiddenError when it may not, and an error when the ITSA is unknown or the home can't be asked: nothing
// may start on an unverified spawn. On the home it is checked here; on a peer, the home checks it.
export async function mayParticipate(refs: string[], via?: Via): Promise<void> {
  for (const ref of refs) {
    if (isHome()) {
      itsa.must(ref);
      mayAssign(ref, via);
    } else {
      await toHome('POST', '/api/itsas/may-participate', { itsa: ref }, 8000, via);
    }
  }
}

// Sets the owner on the home and returns who owned it just before, as the write saw it.
// `ifOwner` makes it a compare-and-set that the home checks in the same transaction. `via` is the
// agent asking, which the home checks as mayAssign does.
export async function assignOwner(ref: string, agentId: string | null, by: string, opts: { ifOwner?: string | null } = {}, via?: Via): Promise<string | null> {
  const body = { owner: agentId, by, ...(opts.ifOwner !== undefined ? { ifOwner: opts.ifOwner } : {}) };
  mayAssign(ref, via);
  const r = isHome() ? await itsa.set(ref, body, by) : await toHome('PATCH', `/api/itsas/${encodeURIComponent(ref)}`, body, 8000, via);
  return r.changes?.owner ? (r.changes.owner.from as string | null) : (r.itsa.owner ?? null);
}

// After a failed launch: give the ITSA back to `previous`, but only if the agent that never
// ran still owns it. The home compares and writes in one transaction, so a reassignment in
// between wins.
export async function restoreOwner(ref: string, failed: string, previous: string | null, by: string): Promise<boolean> {
  try {
    await assignOwner(ref, previous, by, { ifOwner: failed });
    return true;
  } catch (e) {
    if (/owner changed/.test(e instanceof Error ? e.message : String(e))) return false;
    throw e;
  }
}

async function view(ref: string): Promise<itsa.ItsaView> {
  if (isHome()) return itsa.get(ref);
  return toHome('GET', `/api/itsas/${encodeURIComponent(ref)}`);
}

// --- The system prompt line ----------------------------------------------------------------

const label = (x: { key: string; title: string; status: string }) => `${x.key} "${x.title}" (${x.status})`;
const isOpen = (x: { status: string }) => itsa.statusOf(x.status)?.category !== 'closed';

const line = (rows: { key: string; title: string; status: string }[]) => {
  const open = rows.filter(isOpen);
  return open.length ? `You own these ITSAs: ${open.map(label).join('; ')}.` : '';
};

// The ITSAs an agent takes part in but doesn't own, listed separately and briefly. An
// owned ITSA already appears in the owned line, so it is left out here.
const partLine = (rows: (itsa.Itsa & { owner: string | null })[], agentId: string) => {
  const open = rows.filter((x) => isOpen(x) && x.owner !== agentId);
  return open.length ? `You participate in these ITSAs: ${open.map(label).join('; ')}.` : '';
};

// On a daemon that isn't the home the lines come from this cache, filled by loadOwned.
const remoteOwned = new Map<string, string>();
const remoteParticipating = new Map<string, string>();
// The ITSA field definitions and the chief of staff's name as the home last returned them,
// for the prompt on a non-home daemon. A failed read keeps the last good value.
let remoteFields: itsa.Field[] = [];
let remoteCos: string | null = null;

// Fetches the lines from the home before a launch, resume, or prompt is built. An
// unreachable home leaves them out rather than failing the launch.
export async function loadOwned(agentId: string): Promise<void> {
  if (isHome()) return;
  const soft = <T>(what: string, p: Promise<T>, keep: T): Promise<T> =>
    p.catch((e) => {
      log(`couldn't read ${what} from the home`, e);
      return keep;
    });
  const [ownedRows, partRows, fieldRows, cos] = await Promise.all([
    soft(`${agentId}'s owned ITSAs`, toHome('GET', `/api/itsas?owner=${encodeURIComponent(agentId)}`, undefined, 2500) as Promise<itsa.Itsa[]>, null),
    soft(`${agentId}'s ITSAs`, toHome('GET', `/api/itsas?participant=${encodeURIComponent(agentId)}`, undefined, 2500) as Promise<itsa.Itsa[]>, null),
    soft('the ITSA fields', toHome('GET', '/api/itsas/fields', undefined, 2500) as Promise<itsa.Field[]>, remoteFields),
    soft('the chief of staff', toHome('GET', '/api/chief-of-staff', undefined, 2500).then((r) => (r?.setting ?? null) as string | null), remoteCos),
  ]);
  if (ownedRows && partRows) {
    remoteOwned.set(agentId, line(ownedRows));
    remoteParticipating.set(agentId, partLine(partRows, agentId));
  } else {
    remoteOwned.delete(agentId);
    remoteParticipating.delete(agentId);
  }
  remoteFields = fieldRows;
  remoteCos = cos;
}

// S-1393: the ITSAs an agent owns that are not closed, read from the home. Null when the home
// can't be asked, so a caller that needs the answer can skip rather than guess.
export async function openOwnedItsas(agentId: string): Promise<itsa.Itsa[] | null> {
  try {
    const rows = isHome() ? await itsa.list({ owner: agentId }) : ((await toHome('GET', `/api/itsas?owner=${encodeURIComponent(agentId)}`, undefined, 2500)) as itsa.Itsa[]);
    return rows.filter((x) => !itsa.isClosedStatus(x.status));
  } catch {
    return null;
  }
}

// The ITSA an ask belongs to (S-3827, ask-home.ts): the one the agent names, which it must be able to read (a
// ForbiddenError says who may), else the one ITSA it owns whose status is in the active category; none with several.
// Its thread is allocated here on the home if it has none yet, so the ask can join it. Read from the home off it.
export type AskItsa = { id: string; key: string; title: string; thread_id: string };
export async function askItsa(agentId: string, ref?: string, timeoutMs = 8000): Promise<AskItsa | null> {
  // A daemon with no home set is its own home, as itsa.ts reads it.
  if ((settings().itsa.home ?? MACHINE) !== MACHINE) {
    const r = await peerCall(homePeer(), 'POST', '/api/itsas/ask-home', { itsa: ref ?? null }, timeoutMs, false, { agent: agentId, boss: false });
    // A home from before S-3827 has no such route (`no route POST …`); a missing ITSA is `no ITSA …`, also a 404.
    if (r.status === 404 && /^no route /.test(String(r.data?.error ?? ''))) throw new OldHome(`the ITSA home ${settings().itsa.home} can't place asks yet`);
    if (r.status === 403) throw new itsa.ForbiddenError(`the ITSA home ${settings().itsa.home} refused: ${r.data?.error ?? r.status}`);
    if (r.status >= 300) throw new Error(`the ITSA home ${settings().itsa.home} refused: ${r.data?.error ?? r.status}`);
    return r.data as AskItsa | null;
  }
  return askItsaHere(agentId, ref);
}

export async function askItsaHere(agentId: string, ref?: string): Promise<AskItsa | null> {
  let x: itsa.Itsa;
  if (ref) {
    x = itsa.must(ref);
    if (!mayReadItsaThreads(agentId, x.id)) throw new itsa.ForbiddenError(itsaRefusal(agentId, x.id, 'ask in the thread of'));
  } else {
    const active = (await itsa.list({ owner: agentId })).filter((y) => itsa.statusOf(y.status)?.category === 'active');
    if (active.length !== 1) return null;
    x = itsa.must(active[0].id);
  }
  return { id: x.id, key: x.key, title: x.title, thread_id: itsa.ensureThread(x.id) };
}

// The ITSAs an agent owns that are not closed, for its system prompt. Rebuilt on every
// start and resume, so the list stays true after a restart.
export function ownedPrompt(agentId: string): string {
  if (!isHome()) return remoteOwned.get(agentId) ?? '';
  return line(ownedBy(agentId));
}

// The ITSAs an agent takes part in and doesn't own, for its system prompt, listed apart
// from the ones it owns.
export function participatingPrompt(agentId: string): string {
  if (!isHome()) return remoteParticipating.get(agentId) ?? '';
  return partLine(participatedBy(agentId), agentId);
}

// The ITSA template as one agent gets it: the owned line and the participated line, from
// the same source on every call site (system prompt, Instructions view, OpenCode's system).
export function itsaPrompt(agentId: string): string {
  return render('itsa', { owned: ownedPrompt(agentId), participating: participatingPrompt(agentId), fields: fieldsPrompt(), columns: columnsPrompt(agentId) });
}

// The shared Work page columns (ITSA fields) as a list agents fill with itsa_set `fields`.
// Left out when there are none; a failed read leaves it out rather than breaking the prompt.
export function fieldsPrompt(): string {
  try {
    const list = isHome() ? itsa.fields() : remoteFields;
    if (!list.length) return '';
    const rows = list.map((f) => {
      const opts = f.type === 'choice' && f.options ? ` (${f.options.map((o) => o.value).join(' | ')})` : '';
      const kinds = f.kinds ? ` · only for kind ${f.kinds.join(' or ')}` : '';
      return `- \`${f.key}\` · ${f.label} · ${f.type}${opts}${kinds}${f.description ? `: ${f.description}` : ''}`;
    });
    return `Work page columns (ITSA fields) you fill with \`itsa_set\` \`fields\`:\n${rows.join('\n')}`;
  } catch (e) {
    log("couldn't list the ITSA fields", e);
    return '';
  }
}

// Who changes the columns, with the chief of staff's name from settings.chiefOfStaff.
export function columnsPrompt(agentId: string): string {
  const cos = isHome() ? settings().chiefOfStaff : remoteCos;
  if (!cos) return 'No chief of staff is set, so any agent may add, change, or remove Work columns (ITSA fields) with `itsa_fields`; do it sparingly.';
  const me = db.getAgent(agentId);
  if (me && (me.id === cos || me.name === cos)) return 'You own the Work column definitions (ITSA fields): other agents mail you to add, change, or remove a column. Change them with `itsa_fields`.';
  return `Only the chief of staff (@${cos}) adds, changes, or removes Work columns (ITSA fields); mail them to ask.`;
}

function ownedBy(agentId: string): itsa.Itsa[] {
  return db.open().prepare('SELECT * FROM itsas WHERE owner = ? ORDER BY created_at').all(agentId) as unknown as itsa.Itsa[];
}

function participatedBy(agentId: string): itsa.Itsa[] {
  return db
    .open()
    .prepare('SELECT i.* FROM itsas i JOIN itsa_participants p ON p.itsa_id = i.id WHERE p.agent_id = ? AND p.left_at IS NULL ORDER BY i.created_at')
    .all(agentId) as unknown as itsa.Itsa[];
}

// --- Joining the parent's ITSA on spawn ----------------------------------------------------

// The ITSA a spawned child with no `itsa` joins (step 10): the parent's most recently
// updated open ITSA that it owns, else the most recently updated open one it takes part in.
// On the home daemon; undefined when the parent has neither.
export function parentItsaFor(parentId: string): itsa.Itsa | undefined {
  const owned = db.open().prepare('SELECT * FROM itsas WHERE owner = ? ORDER BY updated_at DESC').all(parentId) as unknown as itsa.Itsa[];
  const own = owned.find(isOpen);
  if (own) return own;
  const part = participatedBy(parentId)
    .slice()
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return part.find(isOpen);
}

// On the home: adds the new agent as a participant of its parent's ITSA. A no-op when the
// parent owns and takes part in no open ITSA, or when ITSAs aren't required. Returns the key
// it joined, for the caller's log.
export async function joinParentLocal(agentId: string, parentId: string, by: string): Promise<string | null> {
  if (!settings().itsa.required) return null;
  const pick = parentItsaFor(parentId);
  if (!pick) return null;
  await itsa.addParticipant(pick.id, agentId, by);
  return pick.key;
}

// Ties a spawned agent to the ITSA it was spawned for: it becomes the owner, or for a reviewer (S-501)
// a participant with the owner unchanged. Returns the owner before the call (`owner` as the caller read it, for a reviewer).
export async function attachSpawned(ref: string, agentId: string, reviewer: boolean, owner: string | null, by: string, via?: Via): Promise<string | null> {
  if (!reviewer) return assignOwner(ref, agentId, by, {}, via);
  await joinItsa(ref, agentId, by, via);
  return owner;
}

// Adds a spawned reviewer as a participant of the ITSA it was spawned for, leaving the owner (S-501).
// On the home it is local; on a peer, the home records it. `via` is the agent asking.
export async function joinItsa(ref: string, agentId: string, by: string, via?: Via): Promise<void> {
  mayAssign(ref, via);
  if (isHome()) await itsa.addParticipant(ref, agentId, by);
  else await toHome('POST', '/api/itsas/join', { itsa: ref, agent: agentId, by }, 8000, via);
}

// Undoes a join that a spawn made before it failed (S-2441): removes the agent's row from the ITSA. The agent is
// new, so every row for it came from that spawn; nothing else is touched. Routed like joinItsa: the home removes it,
// on a peer over the same route. A failure is the caller's to log.
export async function leaveItsa(ref: string, agentId: string, by: string, via?: Via): Promise<void> {
  mayAssign(ref, via);
  if (isHome()) await itsa.removeParticipant(ref, agentId, by);
  else await toHome('POST', '/api/itsas/leave', { itsa: ref, agent: agentId, by }, 8000, via);
}

// Routed like the owner assignment: the home daemon records the join, whether the spawn
// happened here or on a peer. A failure is the caller's to log; it never fails the spawn.
export async function joinParentItsa(agentId: string, parentId: string, by: string): Promise<string | null> {
  if (isHome()) return joinParentLocal(agentId, parentId, by);
  const r = await toHome('POST', '/api/itsas/join-parent', { agent: agentId, parent: parentId, by });
  return (r?.key as string) ?? null;
}

// The agents in at least one open ITSA, from the home, for `GET /api/agents`. Null when the
// home can't be reached, so the tree marks nobody rather than everybody.
export async function openAgentSet(): Promise<Set<string> | null> {
  try {
    const rows = isHome() ? itsa.openAgentIds() : ((await toHome('GET', '/api/itsas/open-agents', undefined, 2500)) as string[]);
    return new Set(rows ?? []);
  } catch {
    // The list is polled, so this stays quiet; an unreachable home marks nobody.
    return null;
  }
}

// --- Notices to the parent ITSA's owner ------------------------------------------------------

// The agent that hears about `child`: the owner of its parent ITSA, when that is an agent
// that is running (here or on a peer). The human and nobody hear nothing here.
async function parentOwner(child: itsa.Itsa): Promise<{ id: string; parent: itsa.Itsa } | undefined> {
  if (settings().itsa.ownerNotices !== 'on' || !child.parent_id) return undefined;
  const parent = itsa.find(child.parent_id);
  if (!parent?.owner || parent.owner === HUMAN) return undefined;
  const a = db.getAgent(parent.owner) ?? (await findAgentPeer(parent.owner))?.agent;
  if (!a || (a.lifecycle !== 'active' && a.lifecycle !== 'paused')) return undefined;
  return { id: a.id, parent };
}

// Called after an ITSA's status changed: a child that is blocked, waits on the human, or
// closed tells its parent's owner. Not when the owner itself made the change.
export function statusChanged(x: itsa.Itsa, actor: string): void {
  const st = itsa.statusOf(x.status);
  if (!st) return;
  const why = st.category === 'closed' ? ' (closed)' : st.human ? ' (waits on the human)' : x.status === 'blocked' ? '' : null;
  if (why === null) return;
  parentOwner(x)
    .then((t) => (t && t.id !== actor ? tellAnywhere(t.id, render('itsa-child-status', { key: x.key, title: x.title, parent: t.parent.key, status: x.status, why })) : undefined))
    .catch((e) => log(`notice for ${x.key}`, e));
}

interface Who {
  id: string;
  name: string;
  // The agent's parent, sent by the machine that holds it; the home can't read a peer's agent row.
  parent?: string | null;
  // The agent's type, sent the same way; a reviewer type leaves the ITSAs it joined when it is unowned (S-3015).
  type?: string | null;
}

const isLive = (a: { lifecycle: string }) => a.lifecycle !== 'archived';

type Found = Pick<db.Agent, 'id' | 'name' | 'lifecycle' | 'parent_id'>;

// The agent for an id or name, here or on a peer; 'unreachable' when a peer that may hold it didn't answer.
async function lookup(ref: string): Promise<Found | 'absent' | 'unreachable'> {
  const local = db.getAgent(ref);
  if (local) return local;
  const r = await locateAgent(ref);
  return typeof r === 'object' ? r.agent : r;
}

// Who takes over an archived agent's ITSAs: its parent if live, else the nearest live ancestor,
// else the chief of staff. Undefined when none is live, and also when a peer that may hold the
// parent or the chief of staff is unreachable, so a briefly down machine isn't passed over.
async function heir(agent: Who): Promise<{ id: string; name: string } | undefined> {
  const seen = new Set([agent.id]);
  let next: string | null | undefined = agent.parent ?? db.getAgent(agent.id)?.parent_id;
  while (next && !seen.has(next)) {
    seen.add(next);
    const a = await lookup(next);
    if (a === 'unreachable') return undefined;
    if (a === 'absent') break;
    if (isLive(a)) return a;
    next = a.parent_id;
  }
  const cos = settings().chiefOfStaff;
  const c = cos ? await lookup(cos) : undefined;
  return c && typeof c === 'object' && isLive(c) && !seen.has(c.id) ? c : undefined;
}

// On the home: tells the owner of each parent ITSA, once with all the children, that the
// owner of those ITSAs stopped.
export async function stopped(agent: Who, what: string, only?: itsa.Itsa[]): Promise<void> {
  const byParent = new Map<string, { parent: itsa.Itsa; kids: itsa.Itsa[] }>();
  for (const x of only ?? ownedBy(agent.id)) {
    if (itsa.statusOf(x.status)?.category === 'closed') continue;
    const t = await parentOwner(x);
    if (!t || t.id === agent.id) continue;
    const e = byParent.get(t.id) ?? { parent: t.parent, kids: [] };
    e.kids.push(x);
    byParent.set(t.id, e);
  }
  for (const [id, { parent, kids }] of byParent) {
    await tellAnywhere(id, render('itsa-owner-stopped', { what: `${agent.name} ${what}`, parent: parent.key, list: kids.map((k) => `${k.key} "${k.title}" (${k.status})`).join(', ') }));
  }
}

// An agent here stopped: the home resolves its ITSAs and their parent owners.
function reportStop(agent: Who, what: string): void {
  (isHome() ? stopped(agent, what) : toHome('POST', '/api/itsas/owner-stopped', { id: agent.id, name: agent.name, what })).catch((e) => log(`report that ${agent.name} ${what}`, e));
}

// An owner that was shut down or errored tells the parent owner of each ITSA it holds. A
// restart or an archive in progress is not a stop worth telling. Shutdown is a lifecycle
// change with no activity change, so it has its own observer; an error that also shuts the
// agent down (a failed launch) is told once, by the activity observer.
export function watchOwnerStops(): void {
  itsa.onStatus(statusChanged);
  const every = Number(envVar('ITSA_RETRY_MS')) || 30_000;
  retryPendingUnowns().catch((e) => log('retry', e));
  setInterval(() => retryPendingUnowns().catch((e) => log('retry', e)), every).unref();
  // A switch's hand-off to the home that failed before a restart, or fails now, is asked again (S-3636).
  seedSwitchedItsas();
  retrySwitchedItsas().catch((e) => log('retry switch', e));
  setInterval(() => retrySwitchedItsas().catch((e) => log('retry switch', e)), every).unref();
  db.onLifecycleChange((_before, after) => {
    if (after.lifecycle !== 'shut_down' || after.activity === 'errored') return;
    if (/^(restarting|archiving)/.test(after.activity_detail ?? '')) return;
    // S-273: a shut-down for a compaction is resumed right after it, so it isn't a stop.
    const pending = after.pending_action ? JSON.parse(after.pending_action) : null;
    if (pending?.type === 'recover' && pending.compact) return;
    reportStop(after, 'was shut down');
  });
  db.onActivityChange((before, after) => {
    if (before.activity !== 'errored' && after.activity === 'errored') reportStop(after, 'errored');
  });
}

// --- Unowning ------------------------------------------------------------------------------

// One unown at a time per agent on the home, so two requests for the same agent (a retry
// and the original) can't both unown its ITSAs or both notify.
const unowning = new Map<string, Promise<unknown>>();

// S-3015: a reviewer whose approve is posted, or that is archived or forgotten, leaves the ITSAs it joined: each
// row is marked left (a soft leave, so spend and reviewer counts keep it), with a participant event. An ITSA it still
// owns keeps it as a member. `scope` limits it to the ITSAs whose branch link names that branch in that repo (a
// verdict's PR, S-3161): a branch of the same name in another repo is not touched. Runs on the home, where the rows
// are. The caller checks the agent is a reviewer.
export async function releaseReviewer(agentId: string, by: string, scope?: { branch: string; repo: string; subject?: string }): Promise<number> {
  const notOwned = '(i.owner IS NULL OR i.owner <> ?)';
  const mine = db.open().prepare(`SELECT p.itsa_id FROM itsa_participants p JOIN itsas i ON i.id = p.itsa_id WHERE p.agent_id = ? AND p.left_at IS NULL AND ${notOwned}`).all(agentId, agentId) as { itsa_id: string }[];
  // A verdict's scope (S-3161, S-3508): the ITSAs whose branch link names the branch in that repo, or whose github link names the PR.
  const rows = scope === undefined ? mine : mine.filter((r) => prScopeIds(scope).has(r.itsa_id));
  for (const r of rows) await itsa.leaveParticipant(r.itsa_id, agentId, by);
  return rows.length;
}

// The ITSAs a verdict's scope names: a branch link in its repo, or a github link to its PR (S-3508).
function prScopeIds(scope: { branch: string; repo: string; subject?: string }): Set<string> {
  const ids = new Set((db.open().prepare("SELECT itsa_id FROM itsa_links WHERE system = 'branch' AND external_id = ? AND json_extract(meta, '$.repo') = ?").all(scope.branch, scope.repo) as { itsa_id: string }[]).map((r) => r.itsa_id));
  if (scope.subject) for (const id of linkIdsForSubject(scope.subject)) ids.add(id);
  return ids;
}

// The ITSAs with a github link that names the PR or issue `subject` (`github:OWNER/REPO#N`), a link's URL read as watch.ts's
// subjectsForUrl reads it.
function linkIdsForSubject(subject: string): string[] {
  const links = db.open().prepare("SELECT itsa_id, url FROM itsa_links WHERE url LIKE '%github.com/%'").all() as { itsa_id: string; url: string }[];
  return [...new Set(links.filter((l) => subjectsForUrl(l.url) === subject).map((l) => l.itsa_id))];
}

// S-3508: a reviewer that watches a PR joins each open ITSA the PR is linked to, as a participant with the owner unchanged,
// so it can reply in their threads until its verdict (a verdict's approve leaves them, releaseReviewer). Only a reviewer
// type joins; any other agent is left alone. The agent is local (its watch is), and the join is made on the home.
export async function joinPrReviewer(agentId: string, subject: string, by: string): Promise<string[]> {
  const a = db.getAgent(agentId);
  if (!a?.type || !isReviewerType(a.type) || !subject.startsWith('github:')) return [];
  if (isHome()) return joinPrItsas(agentId, subject, by);
  const r = await toHome('POST', '/api/itsas/join-pr-reviewer', { agent: agentId, subject, by }, 8000);
  return (r?.keys as string[]) ?? [];
}

// Runs on the home, where the links are: joins the agent to each open ITSA whose link names the PR `subject`.
// Returns the keys it joined.
export async function joinPrItsas(agentId: string, subject: string, by: string): Promise<string[]> {
  const ids = linkIdsForSubject(subject);
  const keys: string[] = [];
  for (const id of ids) {
    const x = itsa.find(id);
    if (!x || itsa.isClosedStatus(x.status)) continue;
    await itsa.addParticipant(x.id, agentId, by);
    keys.push(x.key);
  }
  return keys;
}

// On the home: the owner is gone. Each open ITSA goes to its heir (the parent, else the nearest
// live ancestor, else the chief of staff) with its status kept, an event, and a notice to the heir
// for the active ones; review ITSAs are closed by the watcher. With no heir an ITSA becomes
// unowned and the active ones go back to `ready` (recorded in itsa_events); the parent ITSAs'
// owners hear it once, about the rows this call actually changed.
export function unownLocal(agent: Who, how: 'archived' | 'forgotten'): Promise<void> {
  const run = (unowning.get(agent.id) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const ready = itsa.statuses().find((s) => s.name === 'ready') ?? itsa.statuses().find((s) => s.category === 'ready');
    const changed: itsa.Itsa[] = [];
    const given = new Map<string, itsa.Itsa[]>();
    const next = await heir(agent);
    for (const x of ownedBy(agent.id)) {
      const active = itsa.statusOf(x.status)?.category === 'active';
      const open = itsa.statusOf(x.status)?.category !== 'closed';
      // Try the heir first; if that write fails (the heir's machine dropped), fall back to unowning this ITSA.
      for (const to of next && open ? [next, null] : [null]) {
        try {
          await itsa.set(x.id, { owner: to ? to.id : null, ifOwner: agent.id, ...(!to && active && ready ? { status: ready.name } : {}) }, agent.id);
        } catch (e) {
          if (/owner changed/.test(e instanceof Error ? e.message : String(e))) break;
          if (to) {
            log(`couldn't hand ${x.key} to ${to.name}, unowning it`, e);
            continue;
          }
          // A guard's refusal skips this ITSA, so the agent's others still get unowned; any other failure
          // throws, and the peer's pending unown retries.
          if (!(e instanceof itsa.GuardRefusal)) throw e;
          log(`couldn't unown ${x.key}`, e);
          break;
        }
        if (!open) break;
        if (to) {
          await itsa.addParticipant(x.id, to.id, agent.id).catch((e) => log(`couldn't add ${to.name} to ${x.key}`, e));
          itsa.addEvent(x.id, agent.id, 'handoff', `Owner @${agent.name} ${how}; ownership passed to @${to.name}.`);
          if (active) given.set(to.id, [...(given.get(to.id) ?? []), x]);
        } else changed.push(x);
        break;
      }
    }
    // S-3015: a reviewer that is unowned (archived or forgotten) leaves its ITSAs too. Its own try: a failure is logged,
    // and the unown above stands.
    if (agent.type && isReviewerType(agent.type)) await releaseReviewer(agent.id, agent.id).catch((e) => log(`couldn't take ${agent.name} out of its ITSAs`, e));
    for (const [id, list] of given) {
      await tellAnywhere(id, render('itsa-owner-handoff', { what: `${agent.name} was ${how}`, list: list.map((k) => `${k.key} "${k.title}" (${k.status})`).join(', ') })).catch((e) => log(`handoff notice to ${id}`, e));
    }
    if (changed.length) await stopped(agent, `was ${how}, so its ITSAs are now unowned`, changed);
  });
  unowning.set(agent.id, run);
  return run.finally(() => {
    if (unowning.get(agent.id) === run) unowning.delete(agent.id);
  });
}

// Records, before anything is sent, that the home must unown this agent's ITSAs. The
// archive writes it in the same transaction as its lifecycle change. A row that already
// exists stays, so its created_at identifies the request.
export function queueUnown(agent: Who, how: 'archived' | 'forgotten'): void {
  if (isHome()) return;
  db.open().prepare('INSERT OR IGNORE INTO itsa_pending_unown (agent_id, name, how, type, created_at) VALUES (?, ?, ?, ?, ?)').run(agent.id, agent.name, how, agent.type ?? null, new Date().toISOString());
}

// Tells the home. The row stays until the home acknowledges, and only the row this call
// read is deleted, so a retry and a new request can't remove each other's.
async function sendUnown(agentId: string): Promise<void> {
  const row = db.open().prepare('SELECT agent_id, name, how, type, created_at FROM itsa_pending_unown WHERE agent_id = ?').get(agentId) as { agent_id: string; name: string; how: string; type: string | null; created_at: string } | undefined;
  if (!row) return;
  // The type is the one queued with the request: a forgotten agent's row is gone by the time a retry sends it.
  await toHome('POST', '/api/itsas/unown-agent', { id: row.agent_id, name: row.name, how: row.how, parent: db.getAgent(row.agent_id)?.parent_id ?? null, type: row.type }, 15_000);
  db.open().prepare('DELETE FROM itsa_pending_unown WHERE agent_id = ? AND created_at = ?').run(row.agent_id, row.created_at);
}

// An owner archived or forgotten hands its ITSAs to its heir, or leaves them unowned. Awaited, so a forget can finish
// this before the agent is deleted. A failure leaves the pending row for the retry and is
// thrown for the caller to log.
export async function unownAgent(agent: Who, how: 'archived' | 'forgotten'): Promise<void> {
  if (isHome()) return unownLocal(agent, how);
  queueUnown(agent, how);
  await sendUnown(agent.id);
}

// Whether an unown for this agent is waiting for the home. A forget must wait for it.
export function hasPendingUnown(agentId: string): boolean {
  return !!db.open().prepare('SELECT 1 FROM itsa_pending_unown WHERE agent_id = ?').get(agentId);
}

// A resumed agent is active again and keeps its ITSAs: its pending unown is void.
export function dropPendingUnown(agentId: string): void {
  backoff.delete(agentId);
  db.open().prepare('DELETE FROM itsa_pending_unown WHERE agent_id = ?').run(agentId);
}

let retrying = false;
// Per agent: failures in a row and when to try again. In memory only; a restart tries at once.
const backoff = new Map<string, { fails: number; next: number }>();

// Sends every pending unown to the home, one pass at a time. A row whose agent is running
// again (or gone) is dropped instead of retried.
export async function retryPendingUnowns(): Promise<void> {
  if (isHome() || retrying) return;
  retrying = true;
  try {
    const rows = db.open().prepare('SELECT agent_id, name, how FROM itsa_pending_unown').all() as { agent_id: string; name: string; how: string }[];
    for (const r of rows) {
      const a = db.getAgent(r.agent_id);
      // Running again, or a forget that was refused and left the agent here: nothing to unown.
      if (!a || a.lifecycle === 'active' || a.lifecycle === 'paused' || (r.how === 'forgotten' && a)) {
        dropPendingUnown(r.agent_id);
        continue;
      }
      const b = backoff.get(r.agent_id);
      if (b && Date.now() < b.next) continue;
      try {
        await sendUnown(r.agent_id);
        backoff.delete(r.agent_id);
      } catch (e) {
        if (isFinal(e)) {
          // Asking again can't change a final refusal: give up on this row, once.
          log(`giving up on unowning ${r.name}'s ITSAs`, e);
          dropPendingUnown(r.agent_id);
          continue;
        }
        const fails = (b?.fails ?? 0) + 1;
        const every = Number(envVar('ITSA_RETRY_MS')) || 30_000;
        backoff.set(r.agent_id, { fails, next: Date.now() + retryDelay(every, fails) });
        log(`still can't unown ${r.name}'s ITSAs (try ${fails})`, e);
      }
    }
  } finally {
    retrying = false;
  }
}

// Checks on the home, for a request that says a peer's agent stopped or was archived: some
// peer must hold that agent, in the state claimed. 'no' is final; 'unknown' means a peer that
// may hold it didn't answer, so the caller may try again. A row here for an agent of another
// machine, such as one whose id another machine minted too, doesn't count as holding it.
export async function peerHolds(agentId: string, lifecycles: string[]): Promise<'yes' | 'no' | 'unknown'> {
  const mine = db.getAgent(agentId);
  if (mine && (!mine.machine || mine.machine === MACHINE)) return 'no';
  const r = await locateAgent(agentId);
  if (r === 'unreachable') return 'unknown';
  if (r === 'absent') return 'no';
  return lifecycles.includes(r.agent.lifecycle) ? 'yes' : 'no';
}

export class HolderRefusal extends Error {
  status: 403 | 503;
  constructor(status: 403 | 503, msg: string) {
    super(msg);
    this.status = status;
  }
}

// The home's side of a peer's report about an agent it holds: check a peer holds it in one of
// `lifecycles`, then run `act`. 403 (final) when none does; 503 (try again) when a peer that may
// hold it didn't answer, or `act` failed for any reason but a ForbiddenError, which stays 403.
export async function guardPeerReport<T>(local: boolean, id: string, lifecycles: string[], what: string, act: () => Promise<T> | T): Promise<T> {
  const v = local ? await peerHolds(id, lifecycles) : 'no';
  if (v === 'unknown') throw new HolderRefusal(503, `no peer answered about ${id}; try again`);
  if (v === 'no') throw new HolderRefusal(403, `only a peer holding ${what}`);
  try {
    return await act();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new HolderRefusal(e instanceof itsa.ForbiddenError ? 403 : 503, msg);
  }
}

// --- A switch's ITSAs (S-3636) -------------------------------------------------------------

// On the home: a peer ran a cost_switch, so the predecessor's open ITSAs go to its successor. The proof is the holder's own
// word: a peer must hold `from` with forwarded_to naming `to`, and hold `to` too, so a crafted call can't take an agent's
// ITSAs. Only open ITSAs move, each by compare-and-set on the owner, so a repeat (a retry, a restart) moves what is left
// and nothing twice. 403 (final) when no peer shows the switch; 503 (try again) when a peer that may hold them didn't answer.
export async function moveSwitchedItsas(local: boolean, from: string, to: string): Promise<{ moved: string[] }> {
  const mine = db.getAgent(from);
  if (!local || !from || !to || from === to || (mine && (!mine.machine || mine.machine === MACHINE))) throw new HolderRefusal(403, 'only a peer holding a switched agent can move its ITSAs');
  const [a, b] = await Promise.all([locateAgent(from), locateAgent(to)]);
  if (a === 'unreachable' || b === 'unreachable') throw new HolderRefusal(503, `no peer answered about ${from}; try again`);
  if (a === 'absent' || b === 'absent' || a.agent.id !== from || b.agent.id !== to || a.peer.name !== b.peer.name || a.agent.forwarded_to !== to)
    throw new HolderRefusal(403, 'only a peer holding a switched agent can move its ITSAs');
  // Final: ITSAs never land on an archived successor. A shut-down one can be resumed, so it takes them, as in a local switch.
  if (b.agent.lifecycle === 'archived') throw new HolderRefusal(403, `${b.agent.name} is archived, so it can't take ITSAs`);
  const moved: string[] = [];
  try {
    for (const x of ownedBy(from)) {
      if (itsa.statusOf(x.status)?.category === 'closed') continue;
      try {
        await itsa.set(x.id, { owner: to, ifOwner: from }, from);
      } catch (e) {
        if (/owner changed/.test(e instanceof Error ? e.message : String(e))) continue;
        throw e;
      }
      await itsa.addParticipant(x.id, to, from).catch((e) => log(`couldn't add ${to} to ${x.key}`, e));
      itsa.addEvent(x.id, from, 'handoff', `Owner @${a.agent.name} was switched; ownership passed to @${b.agent.name}.`);
      moved.push(x.key);
    }
    // The open ITSAs the predecessor only took part in: the successor joins them, as the local switch does.
    for (const x of participatedBy(from)) {
      if (itsa.statusOf(x.status)?.category === 'closed' || x.owner === from) continue;
      await itsa.addParticipant(x.id, to, from).catch((e) => log(`couldn't add ${to} to ${x.key}`, e));
    }
  } catch (e) {
    throw new HolderRefusal(e instanceof itsa.ForbiddenError ? 403 : 503, e instanceof Error ? e.message : String(e));
  }
  return { moved };
}

// On the machine that ran the switch: asks the ITSA home to pass the predecessor's open ITSAs to the successor. On the home
// the switch's own transaction did it. Soft: a home that is down or older than this route is logged, never fails the switch;
// the event it leaves lets retrySwitchedItsas ask again. Messages carry no URL or token (peerCall's errors may).
export async function handOffSwitchedItsas(from: Who, to: Who): Promise<void> {
  if ((settings().itsa.home ?? MACHINE) === MACHINE) return;
  try {
    const r = await toHome('POST', '/api/itsas/switch-owner', { from: from.id, to: to.id }, 15_000);
    pendingSwitched.delete(from.id);
    switchBackoff.delete(from.id);
    db.addEvent(from.id, 'cost:switch', { step: 'itsa-owner', to: to.name, itsas: (r?.moved as string[] | undefined)?.length ?? 0 });
  } catch (e) {
    const msg = e instanceof Error && e.message.startsWith('the ITSA home') ? e.message : 'the ITSA home did not answer';
    log(`couldn't move ${from.name}'s ITSAs to ${to.name}`, new Error(msg));
    if (isFinal(e)) {
      // The home's final answer (a 403): asking again can't change it. The event keeps a restart from seeding it again.
      pendingSwitched.delete(from.id);
      switchBackoff.delete(from.id);
      db.addEvent(from.id, 'cost:switch', { step: 'itsa-owner-refused', to: to.name, error: msg });
      return;
    }
    // One event per outage: the retry interval doesn't write another while the home stays down.
    if (!pendingSwitched.has(from.id)) db.addEvent(from.id, 'cost:switch', { step: 'itsa-owner-failed', to: to.name, error: msg });
    pendingSwitched.add(from.id);
    const fails = (switchBackoff.get(from.id)?.fails ?? 0) + 1;
    switchBackoff.set(from.id, { fails, next: Date.now() + retryDelay(Number(envVar('ITSA_RETRY_MS')) || 30_000, fails) });
  }
}

// Predecessors whose hand-off to the home failed and isn't done: seeded from the events at start, so a restart keeps them.
const pendingSwitched = new Set<string>();
// Per predecessor: failures in a row and when to ask again. In memory only; a restart asks at once.
const switchBackoff = new Map<string, { fails: number; next: number }>();
let retryingSwitched = false;
// How many retry passes finished, for a test to wait on (GET /api/test/switch-retries).
export let switchRetryPasses = 0;

function seedSwitchedItsas(): void {
  for (const a of db.listAgents()) {
    if (!a.forwarded_to) continue;
    const last = db.listEvents(a.id, 500).filter((e) => e.type === 'cost:switch' && /"step":"itsa-owner/.test(e.data ?? '')).at(-1);
    if (last && /"step":"itsa-owner-failed"/.test(last.data ?? '')) pendingSwitched.add(a.id);
  }
}

// Asks the home again for each pending switch (the home's move is idempotent). Runs from the retry interval.
export async function retrySwitchedItsas(): Promise<void> {
  if (retryingSwitched) return;
  retryingSwitched = true;
  try {
    for (const id of [...pendingSwitched]) {
      const a = db.getAgent(id);
      const s = a?.forwarded_to ? db.getAgent(a.forwarded_to) : undefined;
      if (!a || !s) {
        pendingSwitched.delete(id);
        switchBackoff.delete(id);
      } else if (Date.now() >= (switchBackoff.get(id)?.next ?? 0)) await handOffSwitchedItsas(a, s);
    }
  } finally {
    retryingSwitched = false;
    switchRetryPasses++;
  }
}
