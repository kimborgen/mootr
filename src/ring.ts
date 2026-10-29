// Rings: several agents work on one topic together, often on models from different
// companies. Formats:
//   rounds  every member submits in parallel; then all read all submissions; repeat
//   fire    members submit one at a time, each seeing everything before it
//   debate  like fire, but each member argues a position and answers the others
// An optional moderator reads each completed round and either only facilitates (adds a
// note, the ring ends when all agree) or decides (ends the ring with a decision).
import { randomBytes } from 'node:crypto';
import * as db from './db.ts';
import { render } from './templates.ts';
import { queueNotice, queuedNoticeCount, truncateNotices, sendFromSystem, HUMAN } from './mail.ts';

export interface Ring {
  id: string;
  name: string;
  format: 'rounds' | 'fire' | 'debate';
  topic: string;
  members: string; // JSON array of agent ids, in turn order
  moderator_id: string | null;
  moderator_decides: number;
  created_by: string;
  round: number;
  turn: number;
  max_rounds: number;
  status: 'running' | 'moderating' | 'done';
  note: string | null;
  result: string | null;
  created_at: string;
}

interface Submission {
  round: number;
  agent_id: string;
  text: string;
  agree: number;
  verdict: Verdict | null;
}

type Verdict = 'approve' | 'request_changes';

const FORMAT_HELP = {
  rounds: 'Every member answers in parallel. After each round you all see every submission. Build on the others, and say where you disagree.',
  fire: 'Members answer one at a time. Read everything before you, then improve on it, correct it, or add what is missing.',
  debate: 'Argue a clear position and answer the strongest points of the others. Concede only when convinced.',
};

// A ring that reviews a PR (S-580): nothing else sets the stam/review status, so one party posts the
// verdict with the pr_review tool. In a moderated ring that's the moderator; otherwise the members don't
// post, and the creator, who gets the ring's result mail, does. So a ring never posts two verdicts.
// '' when the topic names no PR, or more than one: picking one would be a guess, and a wrong PR
// would get the verdict.
const PR_REF = /\b(?:PR|pull request)\s*#?(\d+)\b/gi;
export function verdictLine(topic: string, moderated: boolean): string {
  const prs = new Set([...topic.matchAll(PR_REF)].map((m) => m[1]));
  if (prs.size !== 1) return '';
  const [pr] = prs;
  const who = moderated ? 'When the moderator ends it on a verdict, the moderator runs this' : "Members don't post the verdict. When the ring ends on a verdict, its creator runs this";
  return `This ring reviews PR ${pr}. ${who} with the pr_review tool (pr ${pr}, approve or request_changes, a one-line summary, and head: the full sha of the PR's head the review checked)`;
}

// Whether a ring reviews a PR: its topic names at least one (S-4199). Its members' verdicts are
// kept and must match for it to end early even when the topic names more than one, such as a base
// PR beside the one under review, where verdictLine stays '' because which PR gets the verdict
// would be a guess.
export const reviewsPR = (topic: string): boolean => topic.match(PR_REF) !== null;

// A member's PR verdict (S-1824): the one it passed, else one its text states, so a member on an
// older ring_submit schema still counts. Approval is never read from prose ("I can’t approve
// this" must not count): only a line that is just `Verdict: approve`. Wording that asks for
// changes means request_changes. null when the ring reviews no PR or nothing states one.
export function verdictOf(topic: string, text: string, given?: string): Verdict | null {
  if (!reviewsPR(topic)) return null;
  if (given === 'approve' || given === 'request_changes') return given;
  if (given) throw new Error('verdict must be approve or request_changes');
  if (/\brequest(?:ed|ing|s)?[_ ]changes\b|\bchanges requested\b/i.test(text)) return 'request_changes';
  return text.split('\n').some((line) => /^verdict\s*:\s*approve$/i.test(line.trim())) ? 'approve' : null;
}

// Each member's verdict in a PR ring's round whose verdicts don't all match, as "A: approve,
// B: request_changes" ("no verdict" for a missing or unreadable one); '' when every member gave
// the same recognised verdict, or the ring reviews no PR. A member's agree is about its own
// verdict, so it never makes a split unanimous, and a missing verdict blocks agreement (S-1824).
export function splitLine(r: Pick<Ring, 'topic'>, subs: { agent_id: string; verdict: Verdict | null }[], name: (id: string) => string = nameOf): string {
  if (!reviewsPR(r.topic) || !subs.length) return '';
  if (subs.every((s) => s.verdict && s.verdict === subs[0].verdict)) return '';
  return subs.map((s) => `${name(s.agent_id)}: ${s.verdict ?? 'no verdict'}`).join(', ');
}

// The mail when a ring ends (finish), with the verdict line for a PR review. `missing` names the members that
// never submitted: an incomplete ring has no verdict to post, so its mail names none (S-3862).
export function finishBody(r: Ring, reason: string, outcome: string, missing: string[] = []): string {
  return render('ring-finished', { ring: r.name, format: r.format, round: r.round, reason, topic: r.topic, outcome, pr: missing.length ? '' : verdictLine(r.topic, r.moderator_id !== null) });
}

const now = () => new Date().toISOString();
const get = (id: string) => db.open().prepare('SELECT * FROM rings WHERE id = ? OR name = ?').get(id, id) as Ring | undefined;
const members = (r: Ring): string[] => JSON.parse(r.members);
const nameOf = (id: string) => (id === HUMAN ? 'the human' : (db.getAgent(id)?.name ?? id));
// Whether agentId holds the seat of member id: itself, or the successor its cost_switch takeover
// records (agents.forwarded_to, through forwardTarget). Only that link counts, so an unrelated
// agent with a similar name is refused, and so is an archived successor (S-2485).
const standsFor = (id: string | null, agentId: string): boolean => id !== null && (id === agentId || db.forwardTarget(id) === agentId);
const submissions = (r: Ring, round?: number) =>
  db
    .open()
    .prepare(`SELECT round, agent_id, text, agree, verdict FROM ring_submissions WHERE ring_id = ? ${round ? 'AND round = ?' : ''} ORDER BY round, created_at`)
    .all(...(round ? [r.id, round] : [r.id])) as unknown as Submission[];

function history(r: Ring): string {
  const subs = submissions(r);
  if (!subs.length && !r.note) return 'No submissions yet.';
  const tags = (s: Submission) => [s.verdict, s.agree ? 'agrees to end' : ''].filter(Boolean).join(', ');
  const lines = subs.map((s) => `### Round ${s.round}, ${nameOf(s.agent_id)}${tags(s) ? ` (${tags(s)})` : ''}\n${s.text}`);
  const split = r.round > 1 ? splitLine(r, submissions(r, r.round - 1)) : '';
  if (split) lines.push(`### The verdicts don't all match in round ${r.round - 1}\n${split}. Read each other's findings: the ring ends early only when every member gives the same verdict.`);
  if (r.note) lines.push(`### Moderator's note\n${r.note}`);
  return `Submissions so far:\n\n${lines.join('\n\n')}`;
}

function update(r: Ring, fields: Partial<Ring>): Ring {
  const keys = Object.keys(fields);
  db.open()
    .prepare(`UPDATE rings SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...(keys.map((k) => (fields as any)[k] ?? null) as (string | number | null)[]), r.id);
  return get(r.id)!;
}

// A member's turn prompt: the topic, the format's rules, and everything submitted so far.
export function turnPrompt(r: Ring, agentId: string): string {
  return render('ring-turn', {
    ring: r.name,
    ring_id: r.id,
    format: r.format,
    round: r.round,
    max_rounds: r.max_rounds,
    member: nameOf(agentId),
    members: members(r).map(nameOf).join(', '),
    topic: r.topic,
    instructions: FORMAT_HELP[r.format],
    pr: verdictLine(r.topic, r.moderator_id !== null),
    verdict: reviewsPR(r.topic) ? "Give your verdict on the PR in ring_submit's verdict (approve or request_changes), or as a line of its own in your text: `Verdict: approve` or `Verdict: request_changes`. Also give a line of its own, `Head: ` and the full 40-character sha of the PR head you reviewed: an approve is posted only when every member names the same head. Your agree is about your own verdict: the ring ends early only when every member's verdict is the same." : '',
    history: history(r),
  }).replace(/\n{3,}/g, '\n\n');
}

// The turn goes to the member's live successor when it was taken over (S-2485): a held
// predecessor runs nothing, so its notices would never be read.
function prompt(r: Ring, agentId: string): void {
  if (quiet) return;
  queueNotice(db.forwardTarget(agentId), turnPrompt(r, agentId), { idleOnly: true, ring: true });
}

// Prompts whoever's turn it is: every member for rounds, the next member otherwise.
function advance(r: Ring): void {
  const m = members(r);
  if (r.format === 'rounds') for (const id of m) prompt(r, id);
  else prompt(r, m[r.turn % m.length]);
}

export function createRing(input: {
  name: string;
  format: string;
  topic: string;
  members: string[];
  moderator?: string;
  moderatorDecides?: boolean;
  maxRounds?: number;
  createdBy: string;
}): Ring {
  if (!['rounds', 'fire', 'debate'].includes(input.format)) throw new Error('format must be rounds, fire, or debate');
  const ids = input.members.map((m) => {
    const a = db.getAgent(m);
    if (!a) throw new Error(`no agent ${m}`);
    return a.id;
  });
  if (ids.length < 2) throw new Error('a ring needs at least two members');
  const mod = input.moderator ? db.getAgent(input.moderator) : undefined;
  if (input.moderator && !mod) throw new Error(`no agent ${input.moderator}`);
  const id = 'r' + randomBytes(3).toString('hex');
  // The row, its joined events, and the first turn notices land together: a failure after the
  // INSERT leaves no ring, no events, and no queued notice.
  const queued = new Map(ids.concat(mod ? [mod.id] : []).map((a) => [a, queuedNoticeCount(a)]));
  try {
    return db.transaction(() => {
      db.open()
        .prepare(
          `INSERT INTO rings (id, name, format, topic, members, moderator_id, moderator_decides, created_by, max_rounds, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.name, input.format, input.topic, JSON.stringify(ids), mod?.id ?? null, input.moderatorDecides ? 1 : 0, input.createdBy, input.maxRounds ?? 3, now());
      const r = get(id)!;
      for (const a of ids) db.addEvent(a, 'ring:joined', { ring: id });
      advance(r);
      return r;
    });
  } catch (e) {
    for (const [a, n] of queued) truncateNotices(a, n);
    throw e;
  }
}

// `round` is the round the submitter's turn prompt showed, when it sends one: a prompt from an earlier round, sent after the
// ring moved on, writes nothing (S-2646). Left out, the submit goes to the ring's current round, as before.
// `seat` is the member name the text is for (S-2760). Left out, a caller with one open seat submits to it, as before; a caller
// with two or more open seats is refused, so a retry can't land under a predecessor's name. A named seat already filled this
// round is rewritten in a rounds ring, as a submit without `seat` would (S-2955): the round can't be complete then, since a
// complete round has moved on, so a rewrite never completes it or advances the turn. A fire or debate ring's turn check refuses it.
export function submit(ringRef: string, agentId: string, text: string, agree: boolean, verdict?: string, round?: number, seat?: string): string {
  // The daemon's guard as well as the MCP tool's: an older MCP process sends no text when it passes `body` (S-1919).
  if (!text.trim()) throw new Error('text is required: your findings for the ring, as a non-empty string');
  let r = get(ringRef);
  if (!r) throw new Error(`no ring ${ringRef}`);
  if (r.status !== 'running') throw new Error(`ring ${r.name} is ${r.status}`);
  if (round !== undefined && round !== r.round) throw new Error(`ring ${r.name} is on round ${r.round}, not ${round}: your turn prompt is out of date, so read the current one before you submit`);
  const m = members(r);
  // The submission is the member's, whoever holds its seat now (S-2485), so the round, the turn and the names stay the member's.
  // The agent's own seat comes first: a member can also be the successor of another member (S-2490). The seat it stands for
  // is the fallback, only when its own is already in this round or it isn't its turn (S-2646). Without a free seat, the own one.
  const seats = [agentId, ...m.filter((id) => id !== agentId && standsFor(id, agentId))].filter((id) => m.includes(id));
  if (!seats.length) throw new Error('you are not a member of this ring');
  const filled = new Set(submissions(r, r.round).map((s) => s.agent_id));
  const turnOwner = m[r.turn % m.length];
  const parallel = r.format === 'rounds';
  // The open seats are the ones that can take text now: not filled this round, and in a fire or debate ring, the turn's.
  const open = seats.filter((id) => !filled.has(id) && (parallel || turnOwner === id));
  const openSeats = `your open seats in ${r.name} are ${open.length ? open.map(nameOf).join(', ') : 'none'}`;
  let member: string;
  if (seat !== undefined) {
    const named = seats.find((id) => nameOf(id) === seat);
    if (!named) throw new Error(`you do not hold the seat ${seat}: ${openSeats}`);
    member = named;
  } else {
    if (open.length > 1) throw new Error(`you hold ${open.length} open seats, so pass seat, the member's name, for whose text this is: ${openSeats}`);
    member = open[0] ?? seats[0];
  }
  if (r.format !== 'rounds' && m[r.turn % m.length] !== member) throw new Error(`it is ${nameOf(m[r.turn % m.length])}'s turn`);
  const v = verdictOf(r.topic, text, verdict);
  db.open()
    .prepare('INSERT OR REPLACE INTO ring_submissions (ring_id, round, agent_id, text, agree, verdict, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(r.id, r.round, member, text, agree ? 1 : 0, v, now());

  if (r.format !== 'rounds') {
    r = update(r, { turn: r.turn + 1 });
    if (r.turn % m.length !== 0) {
      advance(r);
      return 'Submitted. The next member has the turn.';
    }
  } else if (submissions(r, r.round).length < m.length) {
    return 'Submitted. Waiting for the other members.';
  }
  roundComplete(r);
  return 'Submitted. The round is complete.';
}

// Whether the round's members agree, the split line when their verdicts don't all match, and the members who
// never started. Agreement needs a submission from every member the ring was created with (S-3862): a missing one
// never agrees, even when the rest of the list has submitted.
function agreement(r: Ring): { split: string; missing: string[]; allAgree: boolean } {
  const subs = submissions(r, r.round);
  const split = splitLine(r, subs);
  const missing = missingOf(r);
  const complete = !missing.length && subs.length >= members(r).length;
  return { split, missing, allAgree: !split && complete && subs.every((s) => s.agree) };
}

// The moderator's turn for the round just completed.
function moderatePrompt(r: Ring): string {
  const { split, missing, allAgree } = agreement(r);
  return render('ring-moderate', {
    ring: r.name,
    ring_id: r.id,
    format: r.format,
    round: r.round,
    max_rounds: r.max_rounds,
    topic: r.topic,
    history: history(r),
    instructions: missing.length ? `${missing.join(', ')} never submitted, so the ring is incomplete: there is no agreement and no verdict to give.` : split ? `The members' verdicts don't all match (${split}), so they don't agree yet.` : allAgree ? 'All members agree to end.' : 'Not all members agree yet.',
    decide: r.moderator_decides ? ' with your decision' : ', which you should do only when the members agree or the last round is done',
    pr: missing.length ? '' : verdictLine(r.topic, true),
  });
}

function roundComplete(r: Ring): void {
  if (r.moderator_id) {
    update(r, { status: 'moderating' });
    if (!quiet) queueNotice(db.forwardTarget(r.moderator_id), moderatePrompt(r), { idleOnly: true, ring: true });
    return;
  }
  const { split, allAgree } = agreement(r);
  if (allAgree) return finish(r, 'all members agreed');
  if (r.round >= r.max_rounds) return finish(r, split ? `split (${split})` : 'the last round ended');
  advance(update(r, { round: r.round + 1, note: null }));
}

// After a daemon restart the queued turn notices are gone (they live in memory), so each open seat
// of a running ring is prompted again from the durable ring state (S-2490): a rounds ring's members
// who haven't submitted this round, a fire or debate ring's next member, a moderated ring's
// moderator. Returns how many seats were prompted.
export function promptOpenSeats(): number {
  let n = 0;
  const rings = db.open().prepare("SELECT * FROM rings WHERE status IN ('running', 'moderating')").all() as unknown as Ring[];
  for (const r of rings) {
    if (r.status === 'moderating') {
      if (r.moderator_id) queueNotice(db.forwardTarget(r.moderator_id), moderatePrompt(r), { idleOnly: true, ring: true });
      n++;
      continue;
    }
    const m = members(r);
    const subs = submissions(r, r.round);
    const open = r.format === 'rounds' ? m.filter((id) => !subs.some((s) => s.agent_id === id)) : [m[r.turn % m.length]];
    for (const id of open) prompt(r, id);
    n += open.length;
  }
  return n;
}

// What a ring spawned from a reviewer type needs to run its type's single-reviewer fallback later
// (S-3070): the daemon records it as a `ring:fallback` event when it starts the ring, so it needs no
// column and survives a restart. `body` is the spawn-time request (brief_vars, prompt, cwd, itsa),
// so the fallback is spawned from what the caller asked for, not from the rendered topic.
export interface Fallback {
  type: string;
  body: Record<string, unknown>;
}

export function recordFallback(r: Ring, f: Fallback): void {
  db.addEvent(members(r)[0], 'ring:fallback', { ring: r.id, ...f });
}

function fallbackOf(r: Ring): Fallback | null {
  const row = db.open().prepare("SELECT data FROM events WHERE type = 'ring:fallback' AND json_extract(data, '$.ring') = ? ORDER BY id DESC LIMIT 1").get(r.id) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as Fallback) : null;
}

export interface MemberFailure {
  ring: Ring;
  // Set when no live member was left and the ring's type has a fallback: the ring is done,
  // silently, and the caller runs the single reviewer in its place.
  fallback: Fallback | null;
  // The ring's other agents (members and moderator) the fallback makes redundant.
  others: string[];
}

// While set, nothing is prompted: the restart sweep runs just before promptOpenSeats, which prompts
// every open seat from the DB, so a prompt here would be a second one (S-3070).
let quiet = false;

// Every agent this ring dropped as never started, the current one included: a fallback must differ from
// all of them, not only the last to die.
function droppedOf(r: Ring): db.Agent[] {
  const rows = db.open().prepare("SELECT DISTINCT agent_id FROM events WHERE type = 'ring:dropped' AND json_extract(data, '$.ring') = ?").all(r.id) as { agent_id: string }[];
  return rows.map((x) => db.getAgent(x.agent_id)).filter((a): a is db.Agent => Boolean(a));
}

// The members the ring was created with that never started (S-3862), by name. Written as a `ring:missing` event, so
// it survives a restart: a ring's member list shrinks when one is dropped, and the count it decides on must not.
// A ring dropped before `ring:missing` existed has only `ring:dropped`, so a dropped agent that joined the ring
// counts too; a moderator never joins, so a dead moderator still doesn't count.
function missingOf(r: Ring): string[] {
  const rows = db
    .open()
    .prepare(
      `SELECT DISTINCT agent_id FROM events WHERE type = 'ring:missing' AND json_extract(data, '$.ring') = ?
       UNION
       SELECT DISTINCT agent_id FROM events WHERE type = 'ring:dropped' AND json_extract(data, '$.ring') = ?
         AND agent_id IN (SELECT agent_id FROM events WHERE type = 'ring:joined' AND json_extract(data, '$.ring') = ?)`,
    )
    .all(r.id, r.id, r.id) as { agent_id: string }[];
  return rows.map((x) => nameOf(x.agent_id));
}

// A ring member (or its moderator) never started: its harness is gone before it ever took a turn
// (S-3070, S-3862). A ring decides only on submitted verdicts from every member it was created with, so a
// running ring that loses a member can't go on with the rest: no member's verdict stands in for the missing one,
// and no approval comes from a ring with a missing member. Such a ring is decided now: it ends on its type's
// fallback reviewer when `canFallback` allows it (the daemon refuses the dead member's own type or harness,
// which would fail the same way), with the other members and the moderator returned to be retired; else as
// incomplete, naming the missing member, with no verdict line. A dropped member is no longer a member, and a
// ring that is done takes no submission, so no member can post a second verdict. The moderator's loss alone
// leaves the members' round to decide, as in an unmoderated ring: they submitted every verdict. Idempotent: a
// ring that no longer lists the agent is skipped, which the restart sweep relies on.
export function memberFailed(agentId: string, why: string, canFallback: (fb: Fallback, dead: db.Agent[]) => boolean = (fb, dead) => dead.every((d) => d.type !== fb.type)): MemberFailure[] {
  const out: MemberFailure[] = [];
  const rings = db.open().prepare("SELECT * FROM rings WHERE status IN ('running', 'moderating')").all() as unknown as Ring[];
  for (const found of rings) {
    let r = found;
    const m = members(r);
    const i = m.indexOf(agentId);
    const name = nameOf(agentId);
    if (i < 0 && r.moderator_id !== agentId) continue;
    db.addEvent(agentId, 'ring:dropped', { ring: r.id, why });
    if (i < 0) {
      // The moderator: the ring goes on without one, so its members' round decides, as in an unmoderated ring.
      r = update(r, { moderator_id: null });
      if (r.status === 'moderating') roundComplete(update(r, { status: 'running' }));
      continue;
    }
    db.addEvent(agentId, 'ring:missing', { ring: r.id });
    const rest = m.filter((id) => id !== agentId);
    r = update(r, { members: JSON.stringify(rest) });
    const reason = `${name} never started (${why})`;
    const fb = fallbackOf(r);
    if (fb && canFallback(fb, droppedOf(r))) {
      update(r, { status: 'done', result: `${reason}, so it fell back to a single ${fb.type} reviewer` });
      out.push({ ring: get(r.id)!, fallback: fb, others: [...rest, ...(r.moderator_id ? [r.moderator_id] : [])] });
    } else {
      finish(r, `${reason}, so the ring is incomplete`);
      out.push({ ring: get(r.id)!, fallback: null, others: [] });
    }
  }
  return out;
}

// After a daemon restart (S-3070): a member marked never started whose ring was not told, because the
// restart came between the two steps. The DB holds both facts: the member's 'starting:dead' event
// and the ring's member list. Only a 'starting:dead' later than the member's join of that ring counts,
// so a member that was marked dead before and has been revived since is not dropped. A moderator has no join event, so any `starting:dead` from before the ring's creation is ignored too. Run just before
// promptOpenSeats, so it prompts nobody itself.
export function sweepDeadMembers(canFallback?: Parameters<typeof memberFailed>[2]): MemberFailure[] {
  const out: MemberFailure[] = [];
  const rings = db.open().prepare("SELECT * FROM rings WHERE status IN ('running', 'moderating')").all() as unknown as Ring[];
  const died = db.open().prepare("SELECT 1 FROM events WHERE agent_id = ? AND type = 'starting:dead' AND id > COALESCE((SELECT MAX(id) FROM events WHERE agent_id = ? AND type = 'ring:joined' AND json_extract(data, '$.ring') = ?), 0) AND ts >= ? AND NOT EXISTS (SELECT 1 FROM events r WHERE r.agent_id = ? AND r.type = 'resume' AND r.id > events.id) LIMIT 1");
  quiet = true;
  try {
    for (const r of rings) {
      for (const id of [...members(r), ...(r.moderator_id ? [r.moderator_id] : [])]) {
        const a = db.getAgent(id);
        if (a && a.lifecycle !== 'active' && !a.forwarded_to && died.get(id, id, r.id, r.created_at, id)) out.push(...memberFailed(id, 'never started: no harness process', canFallback));
      }
    }
  } finally {
    quiet = false;
  }
  return out;
}

// The one PR a ring's topic targets, or null. A topic naming one PR targets it. A topic naming several (a base PR beside the one under
// review) targets the one that a "review PR N" phrase names, when exactly one does; the other mentions are context, not targets.
const targetOf = (topic: string): string | null => {
  const named = [...new Set([...topic.matchAll(PR_REF)].map((m) => m[1]))];
  if (named.length <= 1) return named[0] ?? null;
  const asked = [...new Set([...topic.matchAll(/\breview(?:s|ed|ing)?\s+(?:of\s+)?(?:PR|pull request)\s*#?(\d+)\b/gi)].map((m) => m[1]))];
  return asked.length === 1 ? asked[0] : null;
};

// Whether agent `a` is the ring's creator or its moderator (a cost_switch successor counts, as standsFor).
const runsRing = (r: Ring, a: string): boolean => standsFor(r.created_by, a) || standsFor(r.moderator_id, a);

// The head a member's text names on a line of its own (`Head: FULL_SHA`), or null.
// Markdown emphasis or code around the label or the sha (`**Head:** `abc...``) is allowed.
const headOf = (text: string): string | null => text.split('\n').map((l) => l.match(/^[\s*_`]*head[\s*_`]*:[\s*_`]*([0-9a-f]{40})[\s*_`]*$/i)?.[1].toLowerCase() ?? null).find(Boolean) ?? null;

// S-3874: why a pr_review `approve` of PR `pr` at `head` is refused for agent `agentId` because of the rings on that PR; null when none
// applies. Only the latest ring on the PR speaks for it: its creator or moderator may approve when it ended with every member agreeing
// on approve and every member naming, on a `Head: FULL_SHA` line of their last-round text, one full head that `head` resolves to (a
// prefix of it, at least 7 characters). A caller who ran only an older ring on the PR is refused. Only approve is gated:
// request_changes is always allowed. Throws on a lookup error; the caller fails closed.
export function approveRefusal(agentId: string, pr: string, head: string): string | null {
  const rows = (db.open().prepare('SELECT * FROM rings ORDER BY created_at DESC, rowid DESC').all() as unknown as Ring[]).filter((r) => targetOf(r.topic) === pr);
  const inRunning = rows.find((r) => r.status !== 'done' && members(r).some((m) => standsFor(m, agentId)));
  if (inRunning) return `${nameOf(agentId)} is a member of ring ${inRunning.name}, still running on PR ${pr}: members don't post the verdict. Send your findings with ring_submit; the ring's creator or moderator posts it when the ring ends`;
  if (!rows.some((r) => runsRing(r, agentId))) return null;
  const latest = rows[0];
  if (!runsRing(latest, agentId)) return `ring ${latest.name} is the latest on PR ${pr}, and ${nameOf(agentId)} didn't create or moderate it; the older ring's verdict is superseded`;
  if (latest.status !== 'done') return `ring ${latest.name} on PR ${pr} hasn't ended: wait for its end mail before posting an approve`;
  if (missingOf(latest).length) return `ring ${latest.name} on PR ${pr} ended incomplete (${missingOf(latest).join(', ')} never submitted), so it reached no approval; start a new ring`;
  const last = submissions(latest, latest.round);
  const verdicts = new Set(last.map((s) => s.verdict));
  if (last.length < members(latest).length || !last.every((s) => s.agree) || verdicts.size !== 1 || !verdicts.has('approve')) {
    return `ring ${latest.name} on PR ${pr} did not end with every member agreeing on approve (${last.map((s) => `${nameOf(s.agent_id)}: ${s.verdict ?? 'no verdict'}${s.agree ? '' : ', not agreed'}`).join('; ') || 'no submissions'}); start a new ring or post request_changes`;
  }
  const heads = new Set(last.map((s) => headOf(s.text)));
  const [reviewed] = heads;
  if (heads.size !== 1 || !reviewed) return `ring ${latest.name} on PR ${pr}: every member must name the same full head on a "Head: SHA" line of its text (got ${[...heads].map((h) => h?.slice(0, 12) ?? 'none').join(', ')}); start a new ring`;
  if (head.length < 7 || !reviewed.startsWith(head.toLowerCase())) return `ring ${latest.name} on PR ${pr} reviewed head ${reviewed.slice(0, 12)}, not ${head.slice(0, 12)}: start a new ring on this head`;
  return null;
}

export function decide(ringRef: string, agentId: string, cont: boolean, text: string): string {
  const r = get(ringRef);
  if (!r) throw new Error(`no ring ${ringRef}`);
  if (!standsFor(r.moderator_id, agentId)) throw new Error('only the moderator decides');
  if (r.status !== 'moderating') throw new Error(`ring ${r.name} is ${r.status}, not waiting for you`);
  if (!cont || r.round >= r.max_rounds) {
    const split = splitLine(r, submissions(r, r.round));
    const reason = cont ? 'the last round ended' : 'the moderator ended it';
    finish(r, split ? `split (${split}); ${reason}` : reason, r.moderator_decides ? text : undefined);
    return 'The ring has ended.';
  }
  advance(update(r, { status: 'running', round: r.round + 1, note: text }));
  return 'The next round has started.';
}

function finish(r: Ring, reason: string, decision?: string): void {
  const last = submissions(r).filter((s) => s.round === r.round);
  const missing = missingOf(r);
  // An incomplete ring says so first, so no submission below reads as an agreed verdict (S-3862).
  const notice = missing.length ? `Incomplete: ${missing.join(', ')} never submitted, so the ring reached no agreement and no approval. Do not approve from the submissions below.\n\n` : '';
  const outcome = notice + (decision
    ? `Moderator's decision:\n${decision}`
    : `Final submissions:\n\n${last.map((s) => `### ${nameOf(s.agent_id)}${s.verdict ? ` (${s.verdict})` : ''}\n${s.text}`).join('\n\n')}`);
  const body = finishBody(r, reason, outcome, missing);
  update(r, { status: 'done', result: outcome });
  const to = [...new Set([r.created_by, ...members(r), ...(r.moderator_id ? [r.moderator_id] : [])])];
  sendFromSystem('ring', to, `Ring ${r.name} ended`, body).catch(() => {});
}

export function status(ringRef?: string): unknown {
  if (!ringRef) return db.open().prepare('SELECT id, name, format, status, round, max_rounds, members FROM rings ORDER BY created_at DESC LIMIT 50').all();
  const r = get(ringRef);
  if (!r) throw new Error(`no ring ${ringRef}`);
  return { ...r, members: members(r).map(nameOf), submissions: submissions(r) };
}
