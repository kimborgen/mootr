// Failure routing (S-3802): who picks up a PR that broke the full suite (scripts/triage-failures.mjs) or that the merge gate
// sent back unmerged while its caller is gone (pr-merge.ts). Everything goes through the stam CLI, never the DB: STAM runs one
// `stam ARGS...` and returns its stdout, or throws with its error text.
// 1. pickUp: the PR's ITSA owner when live; a gone one (archived or shut down) is woken with `stam resume` when stam can;
//    else its manager, and on up its tree, the same way. The chief of staff ends the climb: it is the fallback, never woken here.
// 2. reopen: the PR's ITSA, from a review status or done, back to in_progress (picked up by its owner) or todo, with a comment;
//    read right before and changed only from the status read (`itsa set --if-status`).
// 3. fallback: nobody in the tree picks it up, so an ITSA under the PR's ITSA (else S-1) says the PR wasn't merged, or broke the
//    suite, so no PR is wrongly thought merged. One per PR: an existing child of the same title is reused, opened again if closed.
// A lookup that errors (anything but not-found) throws: the callers route to cos then, as before.

export const COS = 'cos';
export const ROOT_ITSA = 'S-1';
const MAX_CLIMB = 8;
// The review statuses and the done one a culprit's ITSA comes back from; any other status is left as it is.
const REOPENED_FROM = new Set(['in_review', 'testing', 'needs_review', 'needs_test', 'ready_to_merge', 'merging', 'deploying', 'done']);

export type Stam = (args: string[]) => string | Promise<string>;
export interface RouteAgent {
  id: string;
  name: string;
  lifecycle: string;
  parent_id?: string | null;
}
// Why the PR needs someone: unmerged at the merge gate, or merged and breaking the full suite.
export type Failure = 'unmerged' | 'broke-suite';

export interface PickUp {
  // owner: the ITSA's owner; parent: an agent up its tree; cos: nobody picked it up.
  route: 'owner' | 'parent' | 'cos';
  to: string;
  // The agent woken to take it, by name.
  woke: string | null;
  // The owner's name, or its ref when it isn't an agent.
  owner: string | null;
}

const NOT_FOUND = /\bno (?:such )?agent\b/;
const gone = (a: RouteAgent): boolean => a.lifecycle === 'archived' || a.lifecycle === 'shut_down';

// The agent REF names, or null when stam has none (forgotten). Any other error throws.
export async function agentOf(stam: Stam, ref: string): Promise<RouteAgent | null> {
  let out: string;
  try {
    out = await stam(['show', ref]);
  } catch (e) {
    if (NOT_FOUND.test(e instanceof Error ? e.message : String(e))) return null;
    throw e;
  }
  return JSON.parse(out) as RouteAgent;
}

// Who takes the failure, starting at the agent START (the ITSA's owner, or the merge's caller with no ITSA). NOTE is the text a
// woken agent resumes with. A wake that fails is said and the climb goes on.
export async function pickUp(stam: Stam, start: string | null, note: string, say: (s: string) => void = () => {}): Promise<PickUp> {
  const first = start && start !== 'human' ? await agentOf(stam, start) : null;
  const owner = first?.name ?? start;
  let a = first;
  for (let depth = 0; a && depth < MAX_CLIMB; depth++) {
    if (a.name === COS) break;
    const route = depth === 0 ? 'owner' : 'parent';
    if (!gone(a)) return { route, to: a.name, woke: null, owner };
    try {
      await stam(['resume', a.name, note]);
      return { route, to: a.name, woke: a.name, owner };
    } catch (e) {
      say(`could not wake ${a.name}: ${e instanceof Error ? e.message : e}`);
    }
    a = a.parent_id ? await agentOf(stam, a.parent_id) : null;
  }
  return { route: 'cos', to: COS, woke: null, owner };
}

export interface ItsaView {
  key: string;
  status: string;
  owner?: string | null;
  children?: { key: string; title: string; status: string }[];
}

export const itsaOf = async (stam: Stam, key: string): Promise<ItsaView> => JSON.parse(await stam(['itsa', 'show', key])) as ItsaView;

// The closed statuses a fallback ITSA may be found in, filed for an earlier failure of the same PR and since fixed.
const CLOSED = new Set(['done', 'canceled', 'duplicate', 'wont_do']);

// Moves KEY from FROM to STATUS only if it is still in FROM (`itsa set --if-status`), then comments. False when it moved meanwhile.
async function move(stam: Stam, key: string, from: string, status: string, comment: string, system: string): Promise<boolean> {
  try {
    await stam(['itsa', 'set', key, '--status', status, '--if-status', from, '--system', system]);
  } catch (e) {
    if (/\bstatus changed\b/.test(e instanceof Error ? e.message : String(e))) return false;
    throw e;
  }
  await stam(['itsa', 'post', key, comment, '--system', system]);
  return true;
}

// Moves the ITSA KEY back to work when it sits in review (or done, unless FROMDONE is false): in_progress when its owner picked
// the failure up, else todo. It is read here, right before the change, and changed only from the status read, so a culprit that
// shares the ITSA with another, or a status someone set meanwhile, never reopens it twice or overwrites it. Returns the new
// status, or null when this call changed nothing. SYSTEM is the sender it acts as.
export async function reopen(stam: Stam, key: string, why: string, picked: PickUp, system: string, { fromDone = true } = {}): Promise<string | null> {
  const x = await itsaOf(stam, key);
  if (!REOPENED_FROM.has(x.status) || (x.status === 'done' && !fromDone)) return null;
  const status = picked.route === 'owner' ? 'in_progress' : 'todo';
  return (await move(stam, x.key, x.status, status, `Reopened (${x.status} -> ${status}): ${why}`, system)) ? status : null;
}

export const fallbackTitle = (pr: number, failure: Failure): string => (failure === 'unmerged' ? `Unmerged PR ${pr}` : `Broken PR ${pr}`);

// The fallback ITSA for PR under PARENT (the PR's ITSA, else S-1): its key, an existing child of the same title's when there is
// one, so a rerun files none twice.
export async function fallback(stam: Stam, pr: number, failure: Failure, parent: string | null, detail: string, system: string): Promise<string> {
  const under = parent ?? ROOT_ITSA;
  const title = fallbackTitle(pr, failure);
  const found = (await itsaOf(stam, under)).children?.find((c) => c.title === title);
  // One per PR: an earlier one, fixed and closed since, is opened again for this failure.
  if (found && CLOSED.has(found.status)) await move(stam, found.key, found.status, 'todo', `Reopened (${found.status} -> todo): PR #${pr} failed again. ${detail}`, system);
  if (found) return found.key;
  const summary = failure === 'unmerged'
    ? `PR #${pr} was not merged: the merge gate sent it back and nobody in its owner's tree could pick it up`
    : `PR #${pr} is merged but broke the full suite on main, and nobody in its owner's tree could pick it up`;
  const out = await stam(['itsa', 'new', title, '--parent', under, '--status', 'todo', '--summary', summary, '--body', `${summary}. It needs fixing.\n\n${detail}`, '--system', system]);
  const key = /^(S-\d+)\b/.exec(out.trim())?.[1];
  if (!key) throw new Error(`stam itsa new printed no key: ${out.trim()}`);
  return key;
}
