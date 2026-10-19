// Org structures: parents and children (a tree, or a DAG once an agent has several
// parents), who a child may reach, and the optional chief of staff. All optional: an
// agent with no parent and no rules can reach everyone.
import * as db from './db.ts';
import * as tree from './tree.ts';
import { timed } from './stall.ts';
import { settings } from './settings.ts';
import { render } from './templates.ts';
import { memoryBlock } from './blocks.ts';
import { typeSkillsBlock } from './instructions.ts';
import { typeTemplate, agentTypes, defaultReviewer, fallbackChain, reviewerTypes } from './agent-types.ts';
import { typeTarget } from './reviewer-chain.ts';
import { queueNotice, tellAnywhere, sendMail, HUMAN } from './mail.ts';
import { requestWaitedOn, settledNamed } from './waits.ts';

export interface Visibility {
  // Whom the agent may mail: everyone, its tree (ancestors, descendants, and siblings
  // if allowed), or only its parents.
  reach: 'all' | 'tree' | 'parent';
  siblings: boolean;
  // Whether find_agents shows it the whole registry, or only whom it may reach.
  registry: boolean;
}

const OPEN: Visibility = { reach: 'all', siblings: true, registry: true };

export function visibilityOf(a: db.Agent): Visibility {
  try {
    return { ...OPEN, ...(a.visibility ? JSON.parse(a.visibility) : {}) };
  } catch {
    return OPEN;
  }
}

export function chiefOfStaff(): db.Agent | undefined {
  const name = settings().chiefOfStaff;
  const a = name ? db.getAgent(name) : undefined;
  return a && (a.lifecycle === 'active' || a.lifecycle === 'paused') ? a : undefined;
}

export function ancestors(a: db.Agent, seen = new Set<string>()): Set<string> {
  for (const p of db.parentsOf(a)) {
    if (seen.has(p)) continue;
    seen.add(p);
    const pa = db.getAgent(p);
    if (pa) ancestors(pa, seen);
  }
  return seen;
}

// Every agent above `id`, local or peer, walking the parents remembered for peer agents too. Only the busy re-sync
// uses it: org.ancestors stays local, since its other callers (mail visibility, usage scope) read it as such.
function ancestorsThroughPeers(id: string, seen = new Set<string>()): Set<string> {
  const a = db.getAgent(id);
  for (const p of a ? db.parentsOf(a) : db.peerParentsOf(id)) {
    if (seen.has(p)) continue;
    seen.add(p);
    ancestorsThroughPeers(p, seen);
  }
  return seen;
}

// A peer agent turned busy or quiet (db.onPeerBusyChange, from every path that remembers a peer agent): the
// 'children' waits of the local agents above it follow, and a parent whose subtree just went quiet owes its notice.
export function peerBusyChanged(id: string): void {
  syncChildrenWaits(id);
  for (const pid of ancestorsThroughPeers(id)) {
    const p = db.getAgent(pid);
    if (p) announceTreeIdle(p);
  }
}

export const descendants = tree.descendantsOf;

// The agents `a` may mail under its visibility rules. Undefined means everyone.
export function reachable(a: db.Agent): Set<string> | undefined {
  const v = visibilityOf(a);
  if (v.reach === 'all') return undefined;
  const parents = db.parentsOf(a);
  if (v.reach === 'parent') return new Set(parents);
  const out = new Set([...ancestors(a), ...descendants(a.id)]);
  if (v.siblings) for (const p of parents) for (const s of tree.childrenOf(p)) if (s !== a.id) out.add(s);
  return out;
}

// Throws if `from` may not mail `to`. The human, the chief of staff, and an agent's
// parents are always reachable, so a restricted agent can still escalate.
export function checkCanMail(from: string, to: string): void {
  if (from === HUMAN || to === HUMAN) return;
  const a = db.getAgent(from);
  if (!a) return;
  const allowed = reachable(a);
  if (!allowed || allowed.has(to) || to === chiefOfStaff()?.id) return;
  throw new Error(`${a.name} may not mail ${db.getAgent(to)?.name ?? to}: its parent limited it to ${visibilityOf(a).reach === 'parent' ? 'its parents' : 'its tree'}`);
}

// Filters a registry listing for an agent that may not see all of it. With reach 'tree',
// its children on other machines are only in the listing, so their parent_id counts too.
export function visibleTo<T extends { id: string; parent_id?: string | null }>(viewerId: string, agents: T[]): T[] {
  const a = db.getAgent(viewerId);
  if (!a || visibilityOf(a).registry) return agents;
  const allowed = reachable(a) ?? new Set<string>();
  const cos = chiefOfStaff()?.id;
  const tree = visibilityOf(a).reach === 'tree';
  return agents.filter((x) => x.id === a.id || allowed.has(x.id) || x.id === cos || (tree && x.parent_id === a.id));
}

// The Cost section: the user's free-text instructions for the agents who manage cost,
// with how to watch the subscription windows. Empty when the user set none
// (docs/cost-policy.md). It goes to the chief of staff and to every agent with children.
export function costPrompt(): string {
  const text = settings().cost.instructions?.trim();
  if (!text) return '';
  return `## Cost\n\nWatch the 5-hour and weekly windows with \`usage_info\`, pace your work to them, and follow these instructions:\n\n${text}`;
}

// The Cost section an agent's own system prompt carries: only the agents that manage cost
// get it — an agent with children. The chief of staff gets it in its own paragraph instead.
export function managerCostPrompt(a: db.Agent): string {
  if (chiefOfStaff()?.id === a.id) return '';
  return tree.childrenOf(a.id).length ? costPrompt() : '';
}

// The instructions of the agent's type, from its template; empty without a type or text.
export function typePrompt(a: db.Agent): string {
  return typeSegments(a).map((s) => s.text).join('\n\n');
}

// Who merges an approved PR (S-1357): under process.run `on` the runner does, on the verdict for the PR's current head.
export const mergeLine = () => settings().process.run === 'on'
  ? "Wait for the reviewer's `stam/review` status on the PR's current head; the process runner then merges it with `scripts/merge-pr.mjs` and, if merge-pr refuses, moves the stage back to code and mails you. Don't run `merge-pr.mjs` yourself unless the runner's refusal mail says the fault is fixed and asks you to."
  : "Wait for the reviewer's `stam/review` status, and check it is on the PR's current head; then merge with `node scripts/merge-pr.mjs N` on the ITSA home.";

// The type's slot in segments: its template text, then (S-891) the "Skills available" block when the
// type names skills, then its memory block, so notes stay last. Without skills, one segment with
// exactly the rendered template.
export function typeSegments(a: db.Agent): { key: 'type' | 'skills' | 'memory'; text: string }[] {
  if (!a.type) return [];
  let text = '';
  try {
    text = render(typeTemplate(a.type), { name: a.name, type: a.type, merge: mergeLine() });
  } catch {
    return [];
  }
  const skills = agentTypes()[a.type]?.skills?.length ? typeSkillsBlock(agentTypes()[a.type]?.skills).text : '';
  if (!skills) return text ? [{ key: 'type', text }] : [];
  const mem = memoryBlock(a.type)?.body.replace(/\{\{(\w+)\}\}/g, (_, k) => ({ name: a.name, type: a.type } as Record<string, string>)[k] ?? '').trim();
  if (mem && text.endsWith(mem)) {
    const head = text.slice(0, -mem.length).trim();
    return [...(head ? [{ key: 'type' as const, text: head }] : []), { key: 'skills', text: skills }, { key: 'memory', text: mem }];
  }
  return [...(text ? [{ key: 'type' as const, text }] : []), { key: 'skills', text: skills }];
}

// The org paragraph in an agent's system prompt, after its type's instructions.
export function orgPrompt(a: db.Agent): string {
  return [typePrompt(a), orgRest(a)].filter(Boolean).join('\n\n');
}

// What the reviewer types tell a manager about spawning reviewers (S-360, S-412), from the registry:
// the default reviewer and its fallback chain, then each other reviewer type that the chain doesn't name.
// Never throws: a malformed registry gives an empty prompt, not a broken manager.
export function reviewerProcessPrompt(): string {
  try {
    const types = agentTypes();
    const name = defaultReviewer();
    // A default that is missing or not a reviewer type is said plainly, never spawned.
    if (!types[name]?.review) return 'No default reviewer is set; spawn a reviewer type from registry_info.';
    const chain = fallbackChain(name);
    const q = (n: string) => `\`${n}\``;
    const target = (t: string): string => {
      const ring = types[t]?.review?.ring;
      if (ring) return `ring, ${ring.format}, ${(ring.members ?? []).map(q).join(' + ')}, at most ${ring.maxRounds} rounds`;
      const tt = typeTarget(t);
      return tt ? [[tt.harness, tt.model].filter(Boolean).join(' '), tt.effort].filter(Boolean).join(', ') : 'no harness';
    };
    const others = reviewerTypes().filter((t) => t !== name && !chain.includes(t));
    const otherLines = others.map((t) => {
      const fb = fallbackChain(t);
      const falls = fb.length ? ` Falls back to ${fb.map(q).join(' → ')}.` : '';
      const desc = (types[t].description ?? '').replace(/\.$/, '');
      return `- ${q(t)}${desc ? `: ${desc}` : ''} (${target(t)}).${falls}`;
    });
    const spawn = 'Spawn a reviewer with `spawn_agent` `type` alone, with no harness, model, or preset';
    const ringed = reviewerTypes().some((t) => types[t]?.review?.ring);
    const fallback = [
      chain.length ? `${spawn}: stam then uses its fallback reviewer (${[name, ...chain].map(q).join(' → ')}) when its account is held, and the brief says so.` : `${spawn}.`,
      ringed ? 'A ring reviewer is spawned with `spawn_agent` `type` like any other, and starts several reviewers and mails you their result.' : '',
    ].filter(Boolean).join(' ');
    return render('reviewer-process', {
      default: name,
      target: target(name),
      scenario: others.length ? ', unless a scenario below fits' : '',
      others: otherLines.length ? `Other reviewers:\n${otherLines.join('\n')}` : '',
      fallback,
    }).replace(/\n{3,}/g, '\n\n');
  } catch {
    return '';
  }
}

export function orgRest(a: db.Agent): string {
  const lines: string[] = [];
  const cos = chiefOfStaff();
  if (a.kind === 'assistant') lines.push(render('assistant', {}));
  if (a.type === 'manager' || a.type === 'coordinator' || cos?.id === a.id) lines.push(reviewerProcessPrompt());
  if (cos?.id === a.id) lines.push(render('chief-of-staff', { cost: costPrompt() }));
  else if (cos) lines.push(`Your user's chief of staff is ${cos.name} (${cos.id}). You may escalate anything to it by mail.`);
  const parents = db.parentsOf(a).map((p) => db.getAgent(p)?.name ?? p);
  if (parents.length) lines.push(`Your parent agent${parents.length > 1 ? 's are' : ' is'} ${parents.join(', ')}: report to ${parents.length > 1 ? 'them' : 'it'} by mail when you finish or get stuck.`);
  lines.push(`You choose how much you hear about your children's finished turns with agent_control "set-child-notices": "turn" (every turn), "tree-idle" (once a child and its whole subtree are idle; the default), or "none". Blocked and errored children always reach you.`);
  const v = visibilityOf(a);
  if (v.reach !== 'all') lines.push(`You may mail only ${v.reach === 'parent' ? 'your parents' : 'agents in your tree'}, the chief of staff, and the human.`);
  return lines.join('\n\n');
}

// Who hears about an agent's trouble: its parents, here or on another machine; without
// one, the chief of staff; without one, the human. A parent on a machine that doesn't
// answer is still its parent: the notice waits for it (`deliver`). Only a parent every
// machine confirms gone (forgotten) leaves the agent to the fallback.
function trouble(a: db.Agent, template: string, subject: string, detail: string): void {
  const fallback = () => {
    const cos = chiefOfStaff();
    const id = cos && cos.id !== a.id ? cos.id : HUMAN;
    const text = render(template, { agent: a.name, relation: 'an agent without a parent', detail });
    if (id === HUMAN) sendMail({ from: a.id, to: [HUMAN], subject, body: text, from_stam: true }).catch(() => {});
    else queueNotice(id, text);
  };
  const text = render(template, { agent: a.name, relation: 'your child', detail });
  const parents = db.parentsOf(a);
  const here = parents.filter((p) => db.getAgent(p));
  const away = parents.filter((p) => !db.getAgent(p));
  for (const p of here) queueNotice(p, text);
  if (!away.length) return void (here.length ? undefined : fallback());
  Promise.all(away.map((p) => deliver(p, text))).then((r) => {
    if (!here.length && r.every((x) => x === 'absent')) fallback();
  });
}

// A notice for a parent here, or on the daemon that has it (a parent on another machine).
// `want` checks the parent first, on its own daemon's record: its child-notices mode.
function tell(id: string, text: string, want?: (p: db.Agent) => boolean): void {
  const p = db.getAgent(id);
  if (p) return void (!want || want(p) ? queueNotice(p.id, text) : undefined);
  void deliver(id, text, want);
}

// Delivers a notice to an agent on another machine, retrying while its machine doesn't
// answer, for up to a day. 'failed' when it never got through, or the daemon refused it.
const RETRY_FOR_MS = 24 * 3600_000;
async function deliver(id: string, text: string, want?: (p: db.Agent) => boolean): Promise<'told' | 'absent' | 'failed'> {
  const every = Number(process.env.STAM_PEER_RETRY_MS) || 30_000;
  for (const start = Date.now(); Date.now() - start < RETRY_FOR_MS; await new Promise((r) => setTimeout(r, every))) {
    try {
      const r = await tellAnywhere(id, text, want);
      if (r !== 'unreachable') return r;
    } catch (e) {
      console.error(`notice for parent ${id}: ${e instanceof Error ? e.message : e}`);
      return 'failed';
    }
  }
  console.error(`notice for parent ${id}: its machine didn't answer for a day; dropped`);
  return 'failed';
}

export type ChildNotices = 'turn' | 'tree-idle' | 'none';

// How much a parent hears about a child's finished turns. The parent's own setting;
// agents from before it existed, and registered ones, follow settings.childNotices.
export function childNoticesOf(a: db.Agent): ChildNotices {
  const v = a.child_notices;
  return v === 'turn' || v === 'tree-idle' || v === 'none' ? v : settings().childNotices;
}

// Busy means not done as far as a parent's tree-idle notice is concerned (tree.busyDescendantCount):
// working, blocked, waiting, still starting, or holding an unresolved permission request.
// Idle, errored, and unknown don't hold a subtree back.

// Whether every descendant of `id` is non-busy: nothing under it is still working, so its
// whole subtree has gone quiet.
function subtreeIdle(id: string): boolean {
  return tree.busyDescendantCount(id) === 0;
}

// How many agents below `id` are still busy: the count a 'children' wait names.
function busyDescendants(id: string): number {
  return tree.busyDescendantCount(id);
}

// The one 'children' wait for `a`: present while any agent below it is busy, with a detail
// counting the busy ones, and cleared when its whole subtree goes quiet. Adding or clearing
// it can turn `a` waiting or idle, and syncChildrenWaits carries that to the agents above
// it, so the change climbs the tree and stops at the root. `source: 'stam'` marks it
// ours, against a wait an agent declares itself.
// Returns whether it changed the wait.
function syncChildrenWait(a: Pick<db.Agent, 'id'>, n = busyDescendants(a.id)): boolean {
  const w = db.listWaits(a.id).find(isChildrenWait);
  if (!n) {
    if (w) db.clearWaits(a.id, 'children', null);
    return !!w;
  }
  const detail = n === 1 ? '1 child' : `${n} children`;
  if (!w) db.addWait({ agent_id: a.id, kind: 'children', source: 'stam', detail });
  else if (w.detail !== detail) db.updateWaitDetail(w.id, detail);
  else return false;
  return true;
}

const isChildrenWait = (w: db.Wait): boolean => w.kind === 'children' && w.target === null && w.source === 'stam';

// The agents a syncChildrenWaits call is settling. The waits it writes flip them between idle and waiting, and the
// activity observer calls back for each; those calls return, since the settle counts the flip itself (S-1739).
let settling: Set<string> | undefined;

// Recomputes `id`'s 'children' wait and every ancestor's, local and through peer agents, since an activity change
// below any of them changes whether it still has a busy descendant. Every count is read once, in one pass
// (tree.busyDescendantCounts). A wait it adds or clears can turn that agent waiting or idle, which is one busy agent
// more or less for each agent above it, each once: their counts move by one and they are settled again, here, so one
// change costs statements in its ancestors, not a subtree count per ancestor per flip. `id` may be a peer agent.
export function syncChildrenWaits(id: string): void {
  if (settling?.has(id)) return;
  const agents = new Map<string, Pick<db.Agent, 'id' | 'parent_id' | 'activity'>>(db.agentLinks().map((a) => [a.id, a]));
  const parents = tree.parentMap([...agents.values()]);
  const counts = tree.busyDescendantCounts(parents);
  const due = new Set([id, ...tree.ancestorsIn(parents, id)]);
  const outer = settling;
  settling = new Set([...(outer ?? []), ...due]);
  // The agents this settle turned idle, and every agent above them: the ones a tree-idle notice may now be owed for.
  // The observer leaves them to us, since announcing per flip would walk the chain once per agent in it.
  const quiet = new Set<string>();
  try {
    // The bound stops a cycle of agents that keep each other waiting, as in rebuildWaits.
    let budget = due.size * 50;
    for (const x of due) {
      if (--budget < 0) break;
      due.delete(x);
      const a = agents.get(x);
      if (!a || !syncChildrenWait(a, counts.get(x) ?? 0)) continue;
      const now = db.getAgent(x)!;
      agents.set(x, now);
      if (now.activity === a.activity || db.hasPendingPermission(x)) continue;
      const step = now.activity === 'waiting' ? 1 : -1;
      if (step < 0) quiet.add(x);
      for (const p of tree.ancestorsIn(parents, x)) {
        counts.set(p, (counts.get(p) ?? 0) + step);
        due.add(p);
        if (step < 0) quiet.add(p);
      }
    }
  } finally {
    settling = outer;
  }
  announceTreeIdleOf(quiet);
}

// On daemon start, rebuild the two waits stam derives from its own data, so a restart
// neither loses nor leaves stale ones. Called before the activity observer is installed, so
// rebuilding fires no notices; recoverTreeIdle does that after.
export function rebuildWaits(): void {
  // children: one per agent whose subtree is not quiet, from every agent's count read in one pass (S-1725), not a
  // subtree query per agent. A wait turns an idle agent waiting, which is busy to the agents above it, so the pass
  // repeats until no wait changes; the bound stops a cycle of agents that keep each other waiting.
  timed('rebuild waits: children', () => {
    for (let pass = 0; pass < 50; pass++) {
      const counts = tree.busyDescendantCounts();
      const due = new Set(counts.keys());
      for (const [id, ws] of db.listWaitsByAgent()) if (ws.some(isChildrenWait)) due.add(id);
      let changed = false;
      for (const id of due) {
        const a = db.getAgent(id);
        if (a && syncChildrenWait(a, counts.get(id) ?? 0)) changed = true;
      }
      if (!changed) break;
    }
  });
  // human: one per pending permission request; a stam human wait whose request is gone or
  // answered is cleared. Declared ones (an agent waiting on the human itself) are left.
  const pending = db.listPermissionRequests('pending');
  const ids = new Set(pending.map((r) => r.id));
  // A delegate ask (S-432) is an 'agent' wait on the reviewers, keyed by the request in its data.
  const delegateIds = new Set(pending.filter((r) => r.audience === 'delegate').map((r) => r.id));
  for (const a of db.listAgents())
    for (const w of db.listWaits(a.id)) {
      if (w.source !== 'stam') continue;
      if (w.kind === 'human' && !ids.has(w.target ?? '')) db.clearWait(w.id);
      else if (w.kind === 'agent' && /^p[0-9a-f]{6}$/.test(w.data ?? '') && !delegateIds.has(w.data!)) db.clearWait(w.id);
    }
  for (const r of pending) {
    const a = db.getAgent(r.agent_id);
    if (!a) continue;
    if (r.audience === 'delegate') {
      if (!db.listWaits(a.id).some((w) => w.data === r.id)) db.addWait({ agent_id: a.id, kind: 'agent', target: a.parent_id ?? settings().chiefOfStaff ?? null, detail: 'your parent or the chief of staff', source: 'stam', data: r.id });
    } else if (!db.listWaits(a.id).some((w) => w.source === 'stam' && w.kind === 'human' && w.target === r.id)) db.addWait({ agent_id: a.id, kind: 'human', target: r.id, detail: 'your approval', source: 'stam' });
  }
  timed('rebuild waits: settle asks', settleRequestAsks);
}

// An agent's own asks about a request settle with it (S-609): its wait_for human and its decision
// mails. Answering the request clears them at once (db.clearRequestWaits); this catches the ones
// from before that, or settled while the daemon was down, and ties an untied wait to the request it
// is about. Every start runs it, and it changes nothing the second time.
function settleRequestAsks(): void {
  for (const a of db.listAgents())
    for (const w of db.listWaits(a.id)) {
      if (w.source !== 'declared' || w.kind !== 'human') continue;
      const thread = threadOf(w);
      // A note naming only a settled request, with no thread, is refused now (waits.ts); one from before is stale.
      const r = w.target ? db.getPermissionRequest(w.target) : requestWaitedOn(a.id, w.detail ?? '', thread, w.since) ?? (thread ? undefined : settledNamed(a.id, w.detail ?? ''));
      if (!r) continue;
      if (r.status !== 'pending') db.clearWait(w.id);
      else if (!w.target) db.setWaitTarget(w.id, r.id);
    }
  const oldest = new Map<string, string>();
  for (const m of db.decisionMails()) if (!oldest.has(m.from_id)) oldest.set(m.from_id, m.created_at);
  for (const [agent, since] of oldest)
    for (const r of db.agentRequests(agent)) if (r.status !== 'pending' && r.decided_at && r.decided_at >= since) db.clearRequestDecisionMails(agent, r.id, r.decided_at);
}

function threadOf(w: db.Wait): string | null {
  try {
    return (w.data && JSON.parse(w.data).thread) || null;
  } catch {
    return null;
  }
}

function lastMessage(a: db.Agent): string {
  return (a.last_message ?? '(not reported)').replace(/\s+/g, ' ').slice(0, 600);
}

// Whether an idle agent finished a turn its parents haven't heard about yet. idle_since
// marks that turn; idle_notified holds the value a tree-idle notice was sent for, so a
// restart neither loses nor repeats one. An unresolved permission request keeps it busy,
// so its turn isn't done and no notice is owed yet.
function needsTreeIdleNotice(a: db.Agent): boolean {
  return a.lifecycle === 'active' && a.activity === 'idle' && !!a.idle_since && a.idle_notified !== a.idle_since && !db.hasPendingPermission(a.id);
}

// Tell the tree-idle parents of an idle agent, and of each idle ancestor whose turn also
// finished, once its whole subtree is non-busy; record that on the agent. Called on each
// transition to idle or errored, on a resolved permission, and once at startup, so the
// last descendant to go quiet releases every notice owed up the tree.
export function announceTreeIdle(z: db.Agent): void {
  announceTreeIdleOf([z.id, ...ancestors(z)]);
}

// announceTreeIdle for each of `ids` alone, without walking above them.
function announceTreeIdleOf(ids: Iterable<string>): void {
  for (const id of ids) {
    const a = db.getAgent(id);
    if (!a || !needsTreeIdleNotice(a) || !subtreeIdle(id)) continue;
    const text = render('child-turn-finished', { child: a.name, last: lastMessage(a) });
    const want = (parent: db.Agent) => childNoticesOf(parent) === 'tree-idle';
    const parents = db.parentsOf(a);
    const away = parents.filter((p) => !db.getAgent(p));
    // With a parent on another machine, the turn counts as told once its daemon has the
    // notice, so a failed delivery is owed again after a restart (recoverTreeIdle). While it
    // is on its way, a repeat call (a descendant's turn, say) sends nothing, local parents
    // included.
    const key = `${a.id} ${a.idle_since}`;
    if (treeIdlePending.has(key)) continue;
    for (const p of parents) if (db.getAgent(p)) tell(p, text, want);
    if (!away.length) {
      db.updateAgent(a.id, { idle_notified: a.idle_since });
      continue;
    }
    treeIdlePending.add(key);
    const since = a.idle_since;
    Promise.all(away.map((p) => deliver(p, text, want))).then((r) => {
      treeIdlePending.delete(key);
      const now = db.getAgent(a.id);
      if (now && now.idle_since === since && r.every((x) => x !== 'failed')) db.updateAgent(a.id, { idle_notified: since });
    });
  }
}

const treeIdlePending = new Set<string>();

// After a restart, walk every agent once: a subtree may have gone quiet while the daemon
// was away, and idle_notified tells us which deferred notices are still owed.
export function recoverTreeIdle(): void {
  for (const a of db.listAgents()) announceTreeIdle(a);
}

export function watchActivity(): void {
  db.onPeerBusyChange(peerBusyChanged);
  db.onActivityChange((before, after, requested) => {
    const detail = after.activity_detail ?? '';
    if (after.activity === 'blocked') {
      trouble(after, 'agent-blocked', `${after.name} is blocked`, detail);
    } else if (after.activity === 'errored') {
      trouble(after, 'agent-errored', `${after.name} errored`, detail);
    } else if (before.activity === 'working' && requested.activity === 'idle' && requested.activity_detail === 'turn finished') {
      // A turn that ended with open waits ends in 'waiting', but it is still a finished turn.
      // A parent set to "turn" hears now; "tree-idle" waits for the whole subtree below.
      const last = lastMessage(after);
      for (const p of db.parentsOf(after)) tell(p, render('child-turn-finished', { child: after.name, last }), (parent) => childNoticesOf(parent) === 'turn');
    }
    // Going idle or errored can be the last descendant a pending ancestor waited on. A
    // waiting agent goes idle when its last wait clears, so its parents hear then, once.
    // An agent a children-wait settle turned idle is announced once that settle ends (syncChildrenWaits).
    if ((after.activity === 'idle' || after.activity === 'errored') && !settling?.has(after.id)) announceTreeIdle(after);
    // Any activity change moves this agent into or out of a parent's busy subtree, and can
    // be the cause of this very 'children' wait change, so recompute upward from here.
    timed('activity change: children waits', () => syncChildrenWaits(after.id));
  });
}
