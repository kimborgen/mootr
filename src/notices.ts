// Automatic notices that need no answer count as read (S-717): a GitHub relay for a PR whose
// watch_pr watch ended, an automatic notice (from stam or a local script) in or about an ITSA that
// has closed, and a notice from an agent archived a day ago all stop waiting. So an agent's unread
// count means "waiting for you", not "something happened once". It never touches a colleague's own
// mail nor a deploy-hold alert, and it skips any mail the agent has a declared wait_for on. It runs
// every ten minutes, and soon after an ITSA closes. Mail to the human is left alone: auto-archive
// (S-637) handles their inbox, and it needs their real read state.
import * as db from './db.ts';
import { find as findItsa, isClosedStatus } from './itsa.ts';
import { liveSubscriptionNotes } from './watch.ts';

// A notice from an agent archived more than this ago counts as handled, once it was pushed to the
// recipient. A test sets STAM_NOTICE_ARCHIVED_MS, so it waits on state, not on a real day.
export const ARCHIVED_MS = Number(process.env.STAM_NOTICE_ARCHIVED_MS ?? 24 * 60 * 60_000);
export const EVERY_MS = 10 * 60_000;
// A watch_pr relay: subjectFor makes the subject `[stam] N PR #<number> watch events`.
const RELAY = /^\[stam\] \d+ PR #(\d+) watch events?$/;
// The deploy watcher's sender (S-436).
const DEPLOY = 'system:deploy-watch';
// A deploy-hold alert waits on the human until the hold is removed; reading it for them would hide
// the alert (S-717 review). The watcher names its hold file in the text.
const HOLD = /deploy-hold|watcher holds/;
const ITSA_KEY = /\bS-\d+\b/;

// A wait's data JSON, treating anything malformed as empty.
function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

interface Row {
  mail_id: string;
  agent_id: string;
  from_id: string;
  subject: string;
  body: string;
  created_at: string;
  thread_id: string | null;
  notice: number | null;
  pushed_at: string | null;
  itsa_id: string | null;
  about_itsa: string | null;
}

// One pass over every unread mail in an agent's box, marking the settled notices read. Returns how
// many it read, and logs the agents it read for.
export function sweep(opts: { now?: number } = {}): number {
  const nowMs = opts.now ?? Date.now();
  const notes = liveSubscriptionNotes();
  const agents = new Map(db.listAgents().map((a) => [a.id, a]));
  const waits = db.listWaitsByAgent();
  // When each agent was archived, from its `archive` event (src/lifecycle.ts; the sender of a stale notice).
  const archivedAt = new Map<string, number>();
  for (const e of db.open().prepare("SELECT agent_id, ts FROM events WHERE type = 'archive' ORDER BY id").all() as unknown as { agent_id: string; ts: string }[]) {
    archivedAt.set(e.agent_id, Date.parse(e.ts) || 0);
  }
  // Whether a mail's ITSA reference names a closed ITSA; cached, since relays share one.
  const closedItsa = new Map<string, boolean>();
  const isClosedItsa = (ref: string | null | undefined): boolean => {
    if (!ref) return false;
    const hit = closedItsa.get(ref);
    if (hit !== undefined) return hit;
    const x = findItsa(ref);
    const closed = Boolean(x && isClosedStatus(x.status));
    closedItsa.set(ref, closed);
    return closed;
  };
  // Whether the recipient has a declared wait_for on this mail: on its sender, or on its thread
  // (named by a mail id or a thread id). Such a reply is what they are waiting for, not a notice.
  const waitedOn = (r: Row): boolean => {
    for (const w of waits.get(r.agent_id) ?? []) {
      if (w.source !== 'declared') continue;
      if (!(w.kind === 'agent' && w.target === r.from_id) && !(w.kind === 'human' && r.from_id === 'human')) continue;
      const thread = w.data ? String(safeJson(w.data).thread ?? '') : '';
      if (!thread) return true;
      const want = db.getMail(thread)?.thread_id ?? thread;
      if (r.mail_id === thread || r.thread_id === want) return true;
    }
    return false;
  };
  const rows = db
    .open()
    .prepare(
      `SELECT r.mail_id, r.agent_id, m.from_id, m.subject, m.body, m.created_at, m.thread_id, m.notice, r.pushed_at, m.itsa_id, m.about_itsa
         FROM mail_recipients r JOIN mail m ON m.id = r.mail_id
        WHERE r.read_at IS NULL AND r.agent_id <> 'human'`,
    )
    .all() as unknown as Row[];
  const settled = (r: Row): boolean => {
    if (waitedOn(r)) return false;
    // A deploy-hold alert waits on the human until the hold is removed: leave it for them.
    if (r.from_id === DEPLOY && HOLD.test(r.subject + '\n' + r.body)) return false;
    const pushed = r.pushed_at != null;
    const stale = nowMs - (Date.parse(r.created_at) || 0) >= ARCHIVED_MS;
    // A watch_pr relay whose watch has ended (merged, closed, or unwatched). The fresh merge or
    // close relay is kept until it was pushed to the agent or a day passed, so it isn't missed.
    const relay = RELAY.exec(r.subject ?? '');
    if (r.notice === 1 && relay) return !notes.has(`PR #${Number(relay[1])} watch`) && (pushed || stale);
    // An automatic notice in, or about, an ITSA that has closed: the work it reported is done.
    if (r.notice === 1 && (isClosedItsa(r.about_itsa) || isClosedItsa(r.itsa_id))) return true;
    // A deploy notice before the watcher linked its ITSA names it in the subject or body (S-717).
    if (r.from_id === DEPLOY) {
      const key = (r.subject + '\n' + r.body).match(ITSA_KEY)?.[0];
      if (key && isClosedItsa(key)) return true;
    }
    // A notice from an agent archived over a day ago, already pushed to the recipient. An agent that
    // was archived and resumed keeps its old archive event, so only one still archived counts (S-717).
    const at = archivedAt.get(r.from_id);
    return r.notice === 1 && pushed && agents.get(r.from_id)?.lifecycle === 'archived' && at !== undefined && nowMs - at >= ARCHIVED_MS;
  };
  const byAgent = new Map<string, string[]>();
  for (const r of rows) if (settled(r)) byAgent.set(r.agent_id, [...(byAgent.get(r.agent_id) ?? []), r.mail_id]);
  let total = 0;
  for (const [agentId, ids] of byAgent) {
    const n = db.markRead(agentId, ids);
    if (n) {
      total += n;
      console.log(`notices: read ${n} settled automatic notice(s) for ${agents.get(agentId)?.name ?? agentId}`);
    }
  }
  return total;
}

// Runs the pass every EVERY_MS, and once more shortly after the latest nudge (an ITSA closing).
export function start(): { nudge: () => void; run: () => void } {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    try {
      sweep();
    } catch (e) {
      console.error(`notices: ${e instanceof Error ? e.message : e}`);
    } finally {
      running = false;
    }
  };
  setInterval(run, EVERY_MS).unref?.();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const nudge = () => {
    clearTimeout(timer);
    timer = setTimeout(run, 5_000);
    timer.unref?.();
  };
  return { nudge, run };
}