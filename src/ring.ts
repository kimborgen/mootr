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
import { queueNotice, queuedNoticeCount, truncateNotices, sendFromStam, HUMAN } from './mail.ts';

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
export function verdictLine(topic: string, moderated: boolean): string {
  const prs = new Set([...topic.matchAll(/\b(?:PR|pull request)\s*#?(\d+)\b/gi)].map((m) => m[1]));
  if (prs.size !== 1) return '';
  const [pr] = prs;
  const who = moderated ? 'When the moderator ends it on a verdict, the moderator runs this' : "Members don't post the verdict. When the ring ends on a verdict, its creator runs this";
  return `This ring reviews PR ${pr}. ${who} with the pr_review tool (pr ${pr}, approve or request_changes, a one-line summary, and head: the full sha of the PR's head the review checked)`;
}

// A member's PR verdict (S-1824): the one it passed, else one its text states, so a member on an
// older ring_submit schema still counts. Approval is never read from prose ("I can’t approve
// this" must not count): only a line that is just `Verdict: approve`. Wording that asks for
// changes means request_changes. null when the ring reviews no PR or nothing states one.
export function verdictOf(topic: string, text: string, given?: string): Verdict | null {
  if (!verdictLine(topic, false)) return null;
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
  if (!verdictLine(r.topic, false) || !subs.length) return '';
  if (subs.every((s) => s.verdict && s.verdict === subs[0].verdict)) return '';
  return subs.map((s) => `${name(s.agent_id)}: ${s.verdict ?? 'no verdict'}`).join(', ');
}

// The mail when a ring ends (finish), with the verdict line for a PR review.
export function finishBody(r: Ring, reason: string, outcome: string): string {
  return render('ring-finished', { ring: r.name, format: r.format, round: r.round, reason, topic: r.topic, outcome, pr: verdictLine(r.topic, r.moderator_id !== null) });
}

const now = () => new Date().toISOString();
const get = (id: string) => db.open().prepare('SELECT * FROM rings WHERE id = ? OR name = ?').get(id, id) as Ring | undefined;
const members = (r: Ring): string[] => JSON.parse(r.members);
const nameOf = (id: string) => (id === HUMAN ? 'the human' : (db.getAgent(id)?.name ?? id));
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
    verdict: verdictLine(r.topic, false) ? "Give your verdict on the PR in ring_submit's verdict (approve or request_changes), or as a line of its own in your text: `Verdict: approve` or `Verdict: request_changes`. Your agree is about your own verdict: the ring ends early only when every member's verdict is the same." : '',
    history: history(r),
  }).replace(/\n{3,}/g, '\n\n');
}

function prompt(r: Ring, agentId: string): void {
  queueNotice(agentId, turnPrompt(r, agentId), { idleOnly: true, ring: true });
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

export function submit(ringRef: string, agentId: string, text: string, agree: boolean, verdict?: string): string {
  let r = get(ringRef);
  if (!r) throw new Error(`no ring ${ringRef}`);
  if (r.status !== 'running') throw new Error(`ring ${r.name} is ${r.status}`);
  const m = members(r);
  if (!m.includes(agentId)) throw new Error('you are not a member of this ring');
  if (r.format !== 'rounds' && m[r.turn % m.length] !== agentId) throw new Error(`it is ${nameOf(m[r.turn % m.length])}'s turn`);
  const v = verdictOf(r.topic, text, verdict);
  db.open()
    .prepare('INSERT OR REPLACE INTO ring_submissions (ring_id, round, agent_id, text, agree, verdict, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(r.id, r.round, agentId, text, agree ? 1 : 0, v, now());

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

function roundComplete(r: Ring): void {
  const subs = submissions(r, r.round);
  const split = splitLine(r, subs);
  const allAgree = !split && subs.length >= members(r).length && subs.every((s) => s.agree);
  if (r.moderator_id) {
    update(r, { status: 'moderating' });
    queueNotice(
      r.moderator_id,
      render('ring-moderate', {
        ring: r.name,
        ring_id: r.id,
        format: r.format,
        round: r.round,
        max_rounds: r.max_rounds,
        topic: r.topic,
        history: history(r),
        instructions: split ? `The members' verdicts don't all match (${split}), so they don't agree yet.` : allAgree ? 'All members agree to end.' : 'Not all members agree yet.',
        decide: r.moderator_decides ? ' with your decision' : ', which you should do only when the members agree or the last round is done',
        pr: verdictLine(r.topic, true),
      }),
      { idleOnly: true, ring: true },
    );
    return;
  }
  if (allAgree) return finish(r, 'all members agreed');
  if (r.round >= r.max_rounds) return finish(r, split ? `split (${split})` : 'the last round ended');
  advance(update(r, { round: r.round + 1, note: null }));
}

export function decide(ringRef: string, agentId: string, cont: boolean, text: string): string {
  const r = get(ringRef);
  if (!r) throw new Error(`no ring ${ringRef}`);
  if (r.moderator_id !== agentId) throw new Error('only the moderator decides');
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
  const outcome = decision
    ? `Moderator's decision:\n${decision}`
    : `Final submissions:\n\n${last.map((s) => `### ${nameOf(s.agent_id)}${s.verdict ? ` (${s.verdict})` : ''}\n${s.text}`).join('\n\n')}`;
  const body = finishBody(r, reason, outcome);
  update(r, { status: 'done', result: outcome });
  const to = [...new Set([r.created_by, ...members(r), ...(r.moderator_id ? [r.moderator_id] : [])])];
  sendFromStam(to, `Ring ${r.name} ended`, body).catch(() => {});
}

export function status(ringRef?: string): unknown {
  if (!ringRef) return db.open().prepare('SELECT id, name, format, status, round, max_rounds, members FROM rings ORDER BY created_at DESC LIMIT 50').all();
  const r = get(ringRef);
  if (!r) throw new Error(`no ring ${ringRef}`);
  return { ...r, members: members(r).map(nameOf), submissions: submissions(r) };
}
