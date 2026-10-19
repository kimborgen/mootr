import { warmLessons, cachedLessons } from './retro-lessons.ts';
import { workspacePrompt } from './workspace-prompt.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync, readFileSync, writeFileSync, renameSync, readdirSync, mkdirSync, createReadStream } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { freemem, homedir, loadavg, uptime } from 'node:os';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';
import { encodeBody, sendCompressed } from './compress.ts';
import { dedupByClientId } from './client-dedup.ts';
import pty from 'node-pty';
import { takeDaemonLock } from './daemon-lock.ts';
import { LIVE_HOME, MACHINE, PORT, RELEASE, ROOT, STAM_HOME, TMUX_SOCKET, agentDir, ensureToken, ensurePeerToken } from './config.ts';
import * as db from './db.ts';
import { hashToken, mintAgentToken, serverTokenHash } from './agent-token.ts';
import * as tmux from './tmux.ts';
import { clientCache } from './tmux-clients.ts';
import { createStatuslineGate } from './statusline-gate.ts';
import { adapters } from './adapters/index.ts';
import * as mail from './mail.ts';
import { lookingAtNote, tellAnywhere } from './mail.ts';
import * as usageScope from './usage-scope.ts';
import { parseAgentFilter } from './agent-class.ts';
import * as visibility from './mail-visibility.ts';
import { AttachRefused, attachToMail, linkedThreadsFor } from './mail-itsas.ts';
import { grantCitedThreads, isAssistant, mayReadWholeThread } from './mail-visibility.ts';
import { normalizeMailInput } from './mail-input.ts';
import { addStream, hasStream } from './push.ts';
import * as events from './events.ts';
import { render, humanMailPrompt, listTemplates, saveTemplate, resetTemplate } from './templates.ts';
import * as lifecycle from './lifecycle.ts';
import * as permissionModes from './permission-modes.ts';
import { admit, admitSpawn, accountHeld } from './admission.ts';
import { developerCapRefusal, isDeveloperSpawn, reserveSlot, releaseSlot, slotHolders, enqueueWaiter, dropWaiter, saveQueueFile, loadQueueFile, grantSlots, queuedWaiters, restoreQueue, roomRefusal, hostReadingFrom, cancelState, mayCancelWaiter, findDuplicate, spawnerKey, URGENT_REASONS, type HostReading, type UrgentReason, type Waiter } from './developer-cap.ts';
import * as blockers from './blockers.ts';
import * as context from './context.ts';
import * as cacheCold from './cache-cold.ts';
import * as permissions from './permissions.ts';
import * as webpush from './webpush.ts';
import * as withdraw from './withdraw.ts';
import * as org from './org.ts';
import * as ring from './ring.ts';
import * as itsa from './itsa.ts';
import * as itsaQueue from './itsa-queue.ts';
import * as layout from './layout.ts';
import type { LayoutOp } from './layout-ops.ts';
import * as itsaOwners from './itsa-owners.ts';
import * as steps from './steps.ts';
import * as requirements from './requirements.ts';
import * as reqCheck from './req-check.ts';
import * as reqApproval from './req-approval.ts';
import { itsaPrompt } from './itsa-owners.ts';
import { closeNodeOf, loadProcesses, processCounts, stageGuard } from './process.ts';
import { RUNNER_ACTOR, agentRunner, spawnOnMachine, answerListener, dispatchProcessEvent, humanAsker, runDetached, scriptRunner, stageEntryListener, startListener, startTriggers, verdictListener, verdictTriggers } from './process-run.ts';
import * as retroDigest from './retro-digest.ts';
import { syncTreeCheck } from './tree-check.ts';
import * as retroLoop from './retro-loop.ts';
import * as processProposal from './process-proposal.ts';
import * as itsaHuman from './itsa-human.ts';
import * as autoArchive from './auto-archive.ts';
import type { HumanWait } from './auto-archive.ts';
import * as notices from './notices.ts';
import * as prOpen from './pr-open.ts';
import * as prReview from './pr-review.ts';
import * as prSync from './pr-sync.ts';
import * as branchScope from './branch-scope.ts';
import * as decisionMail from './decision-mail.ts';
import * as search from './search.ts';
import * as watch from './watch.ts';
import * as githubSource from './sources/github.ts';
import * as linearSource from './sources/linear.ts';
import * as waits from './waits.ts';
import * as workspaceShare from './workspace-share.ts';
import * as janitor from './janitor.ts';
import { orphanSweepAllowed, sweepOrphanDaemons, sweepOrphanProcs } from './orphan-procs.ts';
import * as machines from './machines.ts';
import * as peerSpend from './peer-spend.ts';
import * as usage from './usage.ts';
import * as usageDrill from './usage-drill.ts';
import { issueCosts, itsaCost } from './issue-costs.ts';
import { costDisplay } from './cost-display.ts';
import { agentRaw, displayCtx, toCost, withOwnCost } from './agent-costs.ts';
import { activityStatsCached, measuredEffort, type By } from './activity-stats.ts';
import * as activitySummaryMod from './activity-summary.ts';
import * as credits from './credits.ts';
import * as voice from './voice.ts';
import * as costNotices from './cost-notices.ts';
import * as allocations from './allocations.ts';
import * as costPause from './cost-pause.ts';
import * as costSwitch from './cost-switch.ts';
import * as costFallback from './cost-fallback.ts';
import * as costProbes from './cost-probes.ts';
import * as mcpAuth from './mcp-auth.ts';
import * as localHuman from './local-human.ts';
import { issueTicket, redeemTicket, TICKET_KINDS, type TicketKind } from './ticket.ts';
import { countStatements, failLaunch, itsaGate, testHooksAllowed } from './test-hooks.ts';
import { ignoredTestOnlyEnv, testHome, testOnlyEnv } from './test-env.ts';
import { pickLooks } from './banner-stagger.ts';
import { parseMcpConfig, testServer } from './mcp-config.ts';
import { scanHarnesses } from './mcp-import.ts';
import { browseRegistry, remoteAuth } from './mcp-registry.ts';
import * as rules from './rules.ts';
import * as budgets from './budgets.ts';
import { instructionsPrompt, GLOBAL_INSTRUCTIONS, skillInfos, relinkSkills } from './instructions.ts';
import { importSkill, updateSkill, checkUpdate, recoverImports, ImportError } from './skill-import.ts';
import { summaryFor, textHash } from './block-summaries.ts';
import { agentInstructionParts } from './agent-instructions.ts';
import { matchActing, opencodeNamesAgent } from './agent-routes.ts';
import { agentInventory, typeInventory, withSummaries, composerCatalog } from './inventory.ts';
import { cleanTitle, cleanSummary, mailTitlesShown } from './mail-title.ts';
import { defaultGithubRepo } from './github-repo.ts';
import { ensureSettings, settings, setSetting, costProblem, patchSettings, redactSettingsText, writeSettingsText, isSettingsHome, effectiveSettingsText, LOCAL_KEYS, splitSettingsPatch, patchLocalKeys, patchSharedSettings, peerShared } from './settings.ts';
import { peerUiOrigins, peerUiRoute, peerUiHumanRoute, peerServeOrigin } from './web-origins.ts';
import { agentIpCache } from './agent-ips.ts';
import { sharedPayload, homeChanged, syncState, syncShared, watchHomeChanges, startSettingsSync, sharedFilesChanged } from './settings-sync.ts';
import { noteInvalid } from './accounts.ts';
import { cachedLoadOf } from './agent-load.ts';
import { growthSweep } from './standing-growth.ts';
import { cleanupWorkspace, depsReport, prOpenDepsRelink, deployCheckout, createWorkspaceFetched, createPersonalWorkspace, personalWorkspaceName, personalWorkspacePath, spawnWorkspaceRefusal, spawnWorkspaceSpec, type WorkspaceSpec } from './workspace.ts';
import { registry, capabilitiesFor, preset } from './registry.ts';
import { tinyModels } from './tiny-models.ts';
import { toolSummaries, readCalls, ID_CHARS } from './tool-summaries.ts';
import { toolNames, readNames } from './tool-names.ts';
import { openRouterModels, harnessModels } from './model-catalog.ts';
import { freeFallback } from './reviewer-chain.ts';
import { agentType, agentTypes, NAME_RE, renderBrief, saveType, removeType, type AgentType } from './agent-types.ts';
import { toolCatalog } from './mcp.ts';
import { announceToolChanges } from './tool-changes.ts';
import * as files from './files.ts';
import * as diff from './diff.ts';
import * as decl from './decl.ts';
import { peers, peersReachable, peerByName, peerCall, peerRaw, peerStream, findAgentPeer, fanOut, ensureUp, ensureCurrent, AmbiguousAgentError, ambiguousRefusal, refuseAmbiguousId, type Via, type Peer } from './peers.ts';
import { searchMail } from './mail-search.ts';
import { backfill } from './vectors.ts';
import './itsa-vectors.ts';
import './agent-vectors.ts';
import { indexTurnsSoon } from './turn-vectors.ts';
import * as suggest from './suggest.ts';
import * as suggestRescore from './suggest-rescore.ts';
import { searchItsas } from './itsa-search.ts';
import { whenInstalled } from './embed.ts';
import WebSocket from 'ws';
import * as agentView from './agent-view.ts';
import * as viewPrompt from './view-prompt.ts';
import { timed, startStallWatch, stalls } from './stall.ts';
import * as activity from './activity.ts';
import * as activityClassify from './activity-classify.ts';

// Returned by a route that has written its own response, such as an event stream.
const HANDLED = Symbol('handled');

class HttpError extends Error {
  status: number;
  // More fields for the error's JSON body, next to `error`.
  extra?: Record<string, unknown>;
  constructor(status: number, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

// Saves files from the web UI's prompt input under STAM_HOME/uploads/OWNER/ and names
// them at the end of the message, where the agent can read them.
function withUploads(text: string, files: unknown, owner: string, shell = false): string {
  if (!Array.isArray(files) || !files.length) return text;
  const dir = join(STAM_HOME, 'uploads', owner, new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const paths = files.map((f: any, i: number) => {
    const p = join(dir, `${i + 1}-${basename(String(f.name || 'file')).replace(/[^\w.-]+/g, '_')}`);
    writeFileSync(p, Buffer.from(String(f.content_b64 ?? ''), 'base64'));
    return p;
  });
  // In a shell the paths join the command line, as a file dropped on a terminal does.
  if (shell) return [text, ...paths.map((p) => `'${p.replace(/'/g, `'\\''`)}'`)].filter(Boolean).join(' ');
  return `${text}\n\n${paths.length > 1 ? 'Attached files' : 'Attached file'}:\n${paths.map((p) => `- ${p}`).join('\n')}`.trim();
}

// A mailbox owner: an agent, or the human.
function mailboxId(ref: string): string {
  return ref === mail.HUMAN ? mail.HUMAN : mustAgent(ref).id;
}

// Like mailboxId, for reads a peer may get about an agent it doesn't own.
function boxRef(ref: string): string {
  return ref === mail.HUMAN ? mail.HUMAN : (db.getAgent(ref)?.id ?? ref);
}

function mustAgent(ref: string): db.Agent {
  const a = db.getAgent(ref);
  if (!a) throw new HttpError(404, `no agent ${ref}`);
  return a;
}

// The agent view's errors as HTTP errors.
async function viewCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof agentView.ViewError) throw new HttpError(e.status, e.message);
    throw e;
  }
}

// The routes that act as an agent (S-242): an agent's own token may act as itself, as an ancestor
// of it (its parent or further up), or as the chief of staff or the assistant, and as no one else.
// The harness's own hook and statusline reports are self-only: no parent, chief of staff or
// assistant sends them for another agent. The shared token, the owner and peers pass; actor() has
// already checked their claims. An agent on another machine isn't in this daemon's database, so
// it is not refused here: the request forwards, and its own daemon enforces the rule (S-239).
function mayActAs(caller: Caller, id: string, selfOnly = false): void {
  // The OpenCode server's token acts only as an OpenCode agent on this daemon (S-240).
  if (caller.kind === 'opencode') {
    if (db.getAgent(id)?.harness === 'opencode') return;
    throw new HttpError(403, `the OpenCode server can't act as ${id}`);
  }
  if (caller.kind !== 'agent') return;
  const me = caller.agent ?? '';
  const target = db.getAgent(id);
  if ((target?.id ?? id) === me) return;
  if (selfOnly) throw new HttpError(403, `agent ${db.getAgent(me)?.name ?? me} can't act as ${id}`);
  if (!target && id !== mail.HUMAN) return;
  if (target && org.ancestors(target).has(me)) return;
  // A peer's forwarded request names its boss (S-239): the chief of staff or assistant over there.
  if (caller.boss || org.chiefOfStaff()?.id === me || isAssistant(me)) return;
  throw new HttpError(403, `agent ${db.getAgent(me)?.name ?? me} can't act as ${id}`);
}

// Reads and actions that are the human's and the daemon's, not an agent's (S-587): the agent's own token, or
// the OpenCode server's, is refused. The shared token, the owner and peers pass; a peer's forwarded agent
// request arrives as an agent, so the ITSA home refuses it too.
function notAgentToken(caller: Caller, what: string): void {
  if (caller.kind === 'agent' || caller.kind === 'opencode') throw new HttpError(403, `an agent's token can't ${what}`);
}

// The agent whose cost data is scoped for this request (S-593): an agent's token, or the OpenCode server
// naming its agent with `as`. Undefined for the user, the CLI and the bosses (chief of staff, assistant, a
// boss-flagged peer), who read everything. A peer's agent unknown here sees only itself.
function usageViewer(caller: Caller, url: URL): string | undefined {
  if (caller.kind !== 'agent' && caller.kind !== 'opencode') return undefined;
  const me = caller.kind === 'agent' ? caller.agent ?? '' : url.searchParams.get('as') ?? '';
  if (caller.boss || (me && (org.chiefOfStaff()?.id === me || isAssistant(me)))) return undefined;
  return me;
}

// GET /api/activity?by=summary (S-1009): an agent's token reads only its own and its ancestors' trees,
// and the ITSAs it belongs to, as the usage drill does.
async function activityRoute(url: URL, caller: Caller): Promise<unknown> {
  const viewer = usageViewer(caller, url);
  const raw = url.searchParams.get('scope');
  const days = url.searchParams.get('days');
  try {
    // Visibility is judged inside the summary, on the graph of every machine (S-1079).
    const summary = await activitySummaryMod.activitySummary({ days: days == null ? undefined : Number(days), scope: raw, viewer, agents: url.searchParams.get('agents') });
    // The Settings cost unit (cost.display.mode), so activity_info can price its compact answer (S-1080).
    return { ...summary, display_mode: costDisplay().mode };
  } catch (e) {
    if (e instanceof activitySummaryMod.ScopeError) throw new HttpError(e.status, e.message);
    throw e;
  }
}

// Who may read an ITSA's mail threads (S-262, S-269, S-480): an agent's token, or the OpenCode server's
// naming its agent with `as`, only as one the ITSA belongs to (mail-visibility.ts): its owner or a
// participant, the owner of an ancestor ITSA, the chief of staff, or the assistant. The shared token, the owner and peers keep their reads. A
// peer's forwarded request was checked on the ITSA's home, so it passes (`local`).
function mayReadItsaThreads(caller: Caller, itsaId: string, as: string | null): void {
  if (caller.kind !== 'agent' && caller.kind !== 'opencode') return;
  const me = caller.kind === 'agent' ? caller.agent ?? '' : as ?? '';
  if (!me) throw new HttpError(403, 'the OpenCode server must name the agent that reads the threads');
  if (caller.boss || visibility.mayReadItsaThreads(me, itsaId)) return;
  throw new HttpError(403, visibility.itsaRefusal(me, itsaId, 'read the threads of'));
}

// An agent's post to or change of an ITSA (S-480), from its own token, the OpenCode server, or a peer
// forwarding for it: only those the ITSA belongs to (mail-visibility.ts), and a 403 names them, so the
// agent knows whom to ask to add it as a participant. The human, the shared token, and a peer's own
// call go through; so does the daemon, which calls itsa.ts directly.
function mayActOnItsa(caller: Caller, by: string, ref: string, act: 'post' | 'edit'): void {
  if ((caller.kind !== 'agent' && caller.kind !== 'opencode') || caller.boss) return;
  const id = itsa.must(ref).id;
  if (act === 'post' ? visibility.mayPostItsa(by, id) : visibility.mayEditItsa(by, id)) return;
  throw new HttpError(403, visibility.itsaRefusal(by, id, act === 'post' ? 'post to' : 'change'));
}

// The thread a mail id belongs to, here or on a peer; an id no daemon holds is taken as a thread id (S-448).
async function threadOfMail(id: string, box: string | undefined, via?: Via): Promise<string> {
  const x = db.getMail(id);
  if (x) return x.thread_id ?? x.id;
  return (await fanOut<{ thread_id: string }>(withBox(`/api/mail/${id}/thread`, box), via))[0]?.thread_id ?? id;
}

// Who may create or clear an agent's waits: the agent itself, one of its parents, the human
// (no `by`, as the CLI and web UI send), or the assistant acting for the human. Same shape
// as the agent-control check, so an agent can't make another agent wait or clear its waits.
function mayManageWaits(a: db.Agent, by: unknown, human = true, local = false): void {
  if (!by && strictRefuses('waits with no by', !human && !local)) throw new HttpError(403, 'only the human, or an agent naming itself (by), manages waits');
  if (!by || isAssistant(by)) return;
  if (by === a.id || db.parentsOf(a).includes(String(by))) return;
  throw new HttpError(403, `${by} may manage only its own waits or its children's`);
}

// Who acts on an ITSA: an agent naming itself with `by`, or the human. The ref is kept as
// given; itsa.person resolves it, locally or on a peer, so an agent on another machine acts.
// Only a human request (x-stam-human) may name the human as `by` (itsa.requestActor).
// The local scripts that may send as a system sender with the shared token under auth.humanStrict:
// the deploy watcher (scripts/deploy-on-merge.mjs, S-474) and the full suite's failure triage (scripts/triage-failures.mjs, S-1074).
const SYSTEM_SENDERS = ['deploy-watch', 'full-suite'];
// Bodies of requests the shared token sends as an allowed system sender (set in the handler).
const systemBodies = new WeakSet<object>();
function itsaActor(body: any, human: boolean): string {
  // `as_system` names a local script (the deploy watcher, S-474): only the human's CLI may send as one.
  // It's not `system`: on a link route that field is the link's kind (github, branch, ...).
  if (body?.as_system !== undefined) {
    if (!human && !(body && systemBodies.has(body))) throw new HttpError(403, 'only the human sends an ITSA action as a system sender');
    try {
      return itsa.systemActor(body.as_system);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : String(e));
    }
  }
  let actor: string | null;
  try {
    actor = itsa.requestActor(body?.by, human);
  } catch (e) {
    throw new HttpError(403, e instanceof Error ? e.message : String(e));
  }
  if (actor) return actor;
  throw new HttpError(403, 'an ITSA action needs an agent (by) or the human');
}

// itsa.ts throws plain Errors; map a missing ITSA or link to 404 and the rest to 400.
async function itsaRoute<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof itsa.ForbiddenError) throw new HttpError(403, msg);
    throw new HttpError(/^no ITSA |^no link |^no field /.test(msg) ? 404 : /^status changed/.test(msg) ? 409 : 400, msg);
  }
}

// The verdict relay's errors (S-1061): a refusal, a moved head, a bad argument, or a failed script each keep their status.
async function reviewRoute<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e instanceof prReview.ReviewError) throw new HttpError(e.status, e.message);
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
}

// The process designer's files (S-869, step 2): `processes/*.yaml` in this release's repo root,
// read the way templates/ is (src/templates.ts). The parse is cached while every file's mtime
// and size hold and the registry's agent types are unchanged; a process file changes rarely.
let processesCache: { stamp: string; loaded: ReturnType<typeof loadProcesses> } | undefined;

function processesHere(): ReturnType<typeof loadProcesses> {
  const types = Object.keys(agentTypes()).sort();
  const dir = join(ROOT, 'processes');
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort();
  const stamp = [...types, ...files.map((f) => {
    const s = statSync(join(dir, f));
    return `${f}:${s.mtimeMs}:${s.size}`;
  })].join('|');
  if (processesCache?.stamp !== stamp) processesCache = { stamp, loaded: loadProcesses(dir, { knownTypes: new Set(types) }) };
  return processesCache.loaded;
}

// GET /api/processes: what the designer draws, with the live count of open ITSAs at each node
// that names statuses. The ITSAs live on the ITSA home daemon, and a peer proxies this path
// there before the routes run, as it does for /api/itsas, so this runs where they are. The
// counts are computed per request; only the parse is cached.
async function processRoute(): Promise<{ processes: unknown[]; errors: unknown[]; types: string[] }> {
  const { processes, errors } = processesHere();
  const itsas = (await itsa.list({})).map((x) => ({
    key: x.key,
    id: x.id,
    title: x.title,
    status: x.status,
    kind: x.kind,
    stage: typeof x.fields?.stage === 'string' ? x.fields.stage : null,
    owner: x.owner ? db.getAgent(x.owner)?.name ?? x.owner : null,
  }));
  const counts = processCounts(processes, itsas);
  // `types`: the registry's agent types, which the editor checks a lane's `type` and `fallback` against.
  // `source`: each file's text, which the editor diffs against and patches (comments and alignment kept).
  const source = (id: string): string | undefined => {
    try {
      return readFileSync(join(ROOT, 'processes', `${id}.yaml`), 'utf8');
    } catch {
      return undefined;
    }
  };
  return { processes: processes.map((p) => ({ ...p, counts: counts[p.id] ?? {}, source: source(p.id) })), errors, types: Object.keys(agentTypes()).sort() };
}

// A peer's report about an agent it holds (itsa-owners.ts guardPeerReport): 403 is final, 503 is retried.
async function holderRoute<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof itsaOwners.HolderRefusal) throw new HttpError(e.status, e.message);
    throw e;
  }
}

// Same for decision steps: an unknown step is 404, a bad input 400.
async function stepRoute<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new HttpError(/^no step /.test(msg) ? 404 : 400, msg);
  }
}

// Same for requirements (src/requirements.ts): an unknown requirement or link is 404, a
// refusal 403, requirements turned off 404, a bad input 400.
async function reqRoute<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof requirements.ForbiddenError) throw new HttpError(403, msg);
    if (e instanceof requirements.RequirementsOffError) throw new HttpError(404, msg);
    throw new HttpError(/^no requirement |^no link /.test(msg) ? 404 : 400, msg);
  }
}

// The slot queue (S-2053). A developer spawn at the cap waits here and starts when it reaches the head
// and a slot is free; the reply gives its place and the holders, and the caller gets a notice when it
// starts or fails. `urgent` (a reason) puts it ahead of the normal spawns.
// `by` is the caller the queue keys the spawn by (S-2134): an agent's own id, so an agent can't queue as another; else the `by` the request names.
function queueSpawn(body: any, name: string, reason: string | null = null, by?: string): Record<string, unknown> {
  let urgent: UrgentReason | undefined;
  if (body.urgent !== undefined && body.urgent !== null && body.urgent !== false) {
    if (!URGENT_REASONS.includes(body.urgent)) throw new HttpError(400, `urgent takes a reason: ${URGENT_REASONS.join(', ')}`);
    urgent = body.urgent;
  }
  if (queuedWaiters().some((w) => w.name === name)) throw new HttpError(409, `name ${name} is taken`);
  const owner = by ?? (body.by ? String(body.by) : undefined);
  const waiter = { name, body: { ...body, name, ...(owner ? { by: owner } : {}) }, by: owner, urgent, at: Date.now() };
  const place = enqueueWaiter(waiter);
  try {
    saveSlotQueue();
  } catch (e) {
    dropWaiter(name);
    throw new HttpError(503, `can't save the slot queue, so the spawn isn't queued: ${e instanceof Error ? e.message : e}`);
  }
  const holders = slotHolders(db.listAgents(), agentTypes(), MACHINE);
  pumpSlotQueue();
  return { queued: true, name, place, queue_length: queuedWaiters().length, urgent: urgent ?? null, reason, holders, cap: settings().developerCap, machine: MACHINE };
}

// The queue is saved after every change and read back at start, so a restart or deploy during a wait
// loses no accepted request. A granted waiter stays in the file until its spawn ends.
const SLOT_QUEUE_FILE = join(STAM_HOME, 'slot-queue.json');
const launching = new Set<Waiter>();
function saveSlotQueue(waiting: readonly Waiter[] = queuedWaiters()): void {
  saveQueueFile(SLOT_QUEUE_FILE, [...launching, ...waiting]);
}

// Cancels a queued developer spawn by name (S-2134). Its caller, the caller's ancestors, and the boss may cancel it;
// a spawn already granted a slot is refused, since its agent is starting. The file is saved without it before it
// leaves memory, so a failed save leaves it queued.
function cancelQueuedSpawn(name: string, caller: Caller): Record<string, unknown> {
  const state = cancelState(name, queuedWaiters(), [...launching].map((w) => w.name));
  if (state === 'unknown') throw new HttpError(404, `no queued spawn named ${name}`);
  if (state === 'launching') throw new HttpError(409, `${name} already got a developer slot and is starting, so it can't be cancelled`);
  const w = queuedWaiters().find((x) => x.name === name)!;
  const owner = w.by ? db.getAgent(w.by) : undefined;
  const me = caller.kind === 'agent' ? caller.agent : undefined;
  const boss = caller.kind !== 'agent' && caller.kind !== 'opencode' ? true : caller.boss === true || org.chiefOfStaff()?.id === me || (me !== undefined && isAssistant(me));
  if (!mayCancelWaiter(owner?.id, me, boss, owner ? org.ancestors(owner) : new Set())) throw new HttpError(403, `${me ? db.getAgent(me)?.name ?? me : 'this caller'} can't cancel ${name}: only its caller, the caller's parents, and the chief of staff may`);
  removeQueued(w);
  if (w.by && w.by !== me) tellWaiter(w, `Your queued spawn ${name} was cancelled.`);
  return { cancelled: true, name, machine: MACHINE };
}

// Takes a waiter out of the queue: the saved file goes first, so a failed save leaves it queued and refuses the change.
function removeQueued(w: Waiter): void {
  try {
    saveSlotQueue(queuedWaiters().filter((x) => x !== w));
  } catch (e) {
    throw new HttpError(503, `can't save the slot queue, so ${w.name} stays queued: ${e instanceof Error ? e.message : e}`);
  }
  dropWaiter(w.name);
}

// A peer's spawn named `name` from `by` started here (S-2134), so this machine's queued spawn of the same name from
// the same caller would start a duplicate: it is dropped. Only a peer or the human may ask, never an agent.
function dropQueuedDuplicate(name: string, by: unknown, caller: Caller): Record<string, unknown> {
  if (caller.kind === 'agent' || caller.kind === 'opencode') throw new HttpError(403, 'only a peer drops a queued duplicate');
  const w = by ? findDuplicate(queuedWaiters(), name, String(by)) : undefined;
  if (!w) return { dropped: false };
  if (cancelState(name, queuedWaiters(), [...launching].map((x) => x.name)) === 'launching') return { dropped: false, launching: true };
  removeQueued(w);
  tellWaiter(w, `Your queued spawn ${name} was dropped: ${name} started on another machine from the same caller.`);
  return { dropped: true };
}

// After a spawn of `name` from `by` starts here, the peers drop their queued duplicates (S-2134). A daemon-to-daemon
// call (no caller's via), so the peer sees a peer, not the agent. Fire and forget: a peer that can't be reached keeps
// its waiter, and the outcome is logged, so the spawn's reply doesn't wait for it.
function dropQueuedDuplicates(name: string, by: string): void {
  for (const p of peers())
    peerCall(p, 'POST', `/api/slot-queue/${encodeURIComponent(name)}/duplicate`, { caller: by }, 8000)
      .then((r) => {
        if (r.status === 200 && r.data?.dropped) console.log(`slot queue: ${p.name} dropped its queued duplicate ${name} from ${by}`);
      })
      .catch((e) => console.error(`slot queue: ${p.name} duplicate check for ${name}: ${e instanceof Error ? e.message : e}`));
}
// A save that fails is logged where nobody has been told yet; enqueue refuses instead.
const saveSlotQueueLogged = (): void => {
  try {
    saveSlotQueue();
  } catch (e) {
    console.error(`slot queue: save: ${e instanceof Error ? e.message : e}`);
  }
};
function restoreSlotQueue(): void {
  try {
    const { waiting, started } = loadQueueFile(SLOT_QUEUE_FILE, (name) => Boolean(db.getAgent(name)));
    restoreQueue(waiting);
    // Its agent row exists: the launch got that far before the restart, so it isn't queued again.
    for (const w of started) tellWaiter(w, `Your queued spawn ${w.name} got a developer slot and started before a daemon restart; check it with find_agents.`);
  } catch (e) {
    // An unreadable file is moved aside, not emptied, and the queue starts empty.
    console.error(`slot queue: restore: ${e instanceof Error ? e.message : e}; moved to ${SLOT_QUEUE_FILE}.bad`);
    try {
      renameSync(SLOT_QUEUE_FILE, `${SLOT_QUEUE_FILE}.bad`);
    } catch {
      // Nothing to move.
    }
  }
}

// A waiter whose caller is archived is dead; one whose caller runs elsewhere can't be checked.
const waiterAlive = (w: Waiter): boolean => {
  const caller = w.by ? db.getAgent(w.by) : undefined;
  return !caller || caller.lifecycle !== 'archived';
};
// The caller here or on a peer; an archived caller hears nothing.
const tellWaiter = (w: Waiter, text: string): void => {
  if (w.by) void tellAnywhere(w.by, text, (a) => a.lifecycle !== 'archived').catch(() => {});
};

async function launchWaiter(w: Waiter): Promise<void> {
  try {
    // The slot is reserved since the grant; a caller archived since then gets no agent.
    if (!waiterAlive(w)) return;
    const a = await spawnAgent(w.body, false, undefined, { granted: true });
    tellWaiter(w, `Your queued spawn ${w.name} got a developer slot and started (${a.id}).`);
    if (w.by) dropQueuedDuplicates(w.name, w.by);
  } catch (e) {
    tellWaiter(w, `Your queued spawn ${w.name} got a developer slot but failed to start: ${e instanceof Error ? e.message : e}`);
  } finally {
    releaseSlot(w.name);
    launching.delete(w);
    saveSlotQueueLogged();
  }
}

// The load and free memory the queue's guard reads (S-2120): the sampler's latest sample while it is fresh
// (STAM_PROC_DIR can seed it for tests), else the os module's.
function hostReading(): HostReading {
  return hostReadingFrom(machines.latestSample(), Date.now(), 2 * machines.SAMPLE_MS, () => ({ load1: loadavg()[0], freeBytes: freemem() }));
}

// Each launch runs on its own, so a slow workspace never holds the next sweep for dead waiters.
function pumpSlotQueue(): void {
  const before = queuedWaiters().length;
  const { granted, dropped } = grantSlots(db.listAgents(), agentTypes(), settings().developerCap, MACHINE, waiterAlive, hostReading());
  for (const w of dropped) tellWaiter(w, `Your queued spawn ${w.name} was dropped from the developer slot queue because its caller was archived.`);
  // The whole batch is in the saved snapshot before the first launch starts.
  for (const w of granted) launching.add(w);
  if (granted.length || queuedWaiters().length !== before) saveSlotQueueLogged();
  for (const w of granted) void launchWaiter(w);
}

const NAMES = 'otter heron lynx wren fox badger hare kestrel marten finch puffin raven seal stoat swift vole crane ibis lark newt orca owl pika robin tern yak'.split(' ');

function freeName(): string {
  const taken = new Set([...db.listAgents().map((a) => a.name), ...queuedWaiters().map((w) => w.name)]);
  for (const n of NAMES) if (!taken.has(n)) return n;
  for (let i = 2; ; i++) for (const n of NAMES) if (!taken.has(`${n}-${i}`)) return `${n}-${i}`;
}

// `onCreated` gets the new agent's id as soon as its row exists, so a caller whose spawn then fails
// knows exactly which agent is its own to clean up.
// `opts.queue`: a developer spawn at the cap waits in the slot queue (S-2053) and throws QueuedSpawn
// instead of failing; only the spawn route asks for it. `opts.granted`: the queue already reserved
// this spawn's slot, so the cap isn't checked again.
class QueuedSpawn extends Error {
  reply: Record<string, unknown>;
  constructor(reply: Record<string, unknown>) {
    super('queued');
    this.reply = reply;
  }
}

async function spawnAgent(body: any, human = false, onCreated?: (id: string) => void, opts: { queue?: boolean; granted?: boolean; by?: string } = {}): Promise<db.Agent> {
  const slot: { name?: string; queue?: boolean; granted?: boolean; by?: string; cos?: boolean } = { queue: opts.queue, granted: opts.granted, by: opts.by };
  try {
    return await spawnAgentIn(body, human, onCreated, slot);
  } finally {
    if (slot.name) releaseSlot(slot.name);
    if (slot.cos) cosSpawning = false;
  }
}

// A cos spawn in flight: held from the check to the end of the spawn, so two at once can't both pass it.
let cosSpawning = false;

async function spawnAgentIn(body: any, human: boolean, onCreated: ((id: string) => void) | undefined, slot: { name?: string; queue?: boolean; granted?: boolean; by?: string; cos?: boolean }): Promise<db.Agent> {
  const original = body;
  // An agent type sets the preset, role, visibility, child notices, and brief; anything
  // given explicitly wins. Without a type and with no input at all, the agent gets the
  // defaults in settings.spawnDefaults and a free name.
  let type: AgentType | undefined;
  if (body.type) {
    try {
      type = agentType(String(body.type));
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : String(e));
    }
  }
  const d = settings().spawnDefaults;
  if (!type && !body.preset && !body.harness && !body.model && d.preset) body = { ...body, preset: d.preset };
  if (!body.cwd && d.cwd) body = { ...body, cwd: d.cwd.replace(/^~(?=$|\/)/, homedir()) };
  const name = String(body.name ?? '').trim() || freeName();
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) throw new HttpError(400, 'name must be lowercase letters, digits, and dashes');
  if (db.getAgent(name)) throw new HttpError(409, `name ${name} is taken`);
  // A reviewer type asked for alone runs on its own target, or on the first free type of its
  // fallback chain when its account is held (S-412). The agent then becomes that fallback type.
  let reviewerFallback: { from: string; target: string; reason: string } | null = null;
  // Even an explicit harness, model, or preset doesn't make a ring type spawnable.
  if (type?.review?.ring) throw new HttpError(400, 'a ring reviewer type takes no harness, model, or preset, and is spawned as a ring through POST /api/agents');
  if (type?.review && !body.preset && !body.harness && !body.model) {
    const held = accountHeld(type);
    if (held) {
      const fb = freeFallback(String(body.type), held.account);
      if (fb.type) {
        const t = fb.target!;
        reviewerFallback = { from: String(body.type), target: `${fb.type}: ${t.harness}${t.model ? ` ${t.model}` : ''}${t.effort ? ` (${t.effort})` : ''}`, reason: held.reason };
        type = agentType(fb.type);
        body = { ...body, type: fb.type };
      }
    }
  }
  if (body.preset) {
    let p;
    try {
      p = preset(String(body.preset));
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : String(e));
    }
    body = { ...body, harness: body.harness ?? p.harness, model: body.model ?? p.model, effort: body.effort ?? p.effort };
  }
  // The type's model and effort only fit its own harness.
  if (type && (!body.harness || body.harness === type.harness)) body = { ...body, harness: type.harness, model: body.model ?? type.model, effort: body.effort ?? type.effort };
  if (type) body = { ...body, role: body.role || body.type, visibility: body.visibility ?? type.visibility, child_notices: body.child_notices ?? type.child_notices };
  const boss = human || isAssistant(body.by);
  // The cos type makes its agent the chief of staff, so only the human and the assistant spawn it, and only one runs.
  const isCos = Boolean(type) && String(body.type) === 'cos';
  if (isCos) {
    if (!boss) throw new HttpError(403, 'only the human and the assistant spawn a chief of staff');
    const current = org.chiefOfStaff();
    if (current) throw new HttpError(409, `${current.name} is already the chief of staff`);
    if (cosSpawning) throw new HttpError(409, 'a chief of staff is already starting');
    cosSpawning = true;
    slot.cos = true;
  }
  const harness = String(body.harness ?? 'claude');
  if (!adapters[harness]) throw new HttpError(400, `unknown harness ${harness}`);
  // The parent, here or on another machine (ids are unique across machines). Resolved
  // before any workspace exists, so a parent nobody has leaves no worktree behind.
  const parentRef = body.by && !boss ? String(body.by) : body.parent ? String(body.parent) : undefined;
  const parent = parentRef ? (db.getAgent(parentRef) ?? (await findAgentPeer(parentRef))?.agent) : undefined;
  if (parentRef && !parent) throw new HttpError(404, `no agent ${parentRef}`);
  const parentId = parent?.id ?? null;
  // The admission gate for a new agent: an account-wide cost blocker refuses the spawn,
  // before any workspace exists. Only the human may force it.
  let override;
  try {
    override = admitSpawn({ name, harness, model: body.model ? String(body.model) : null, by: body.by ? String(body.by) : undefined, human, force: Boolean(body.force) });
  } catch (e) {
    throw new HttpError(409, e instanceof Error ? e.message : String(e));
  }
  // `itsa`: the new agent owns this ITSA and its first prompt says so. A reviewer type only takes part
  // in it, and the owner stays (S-501).
  // A ring's members and moderator are marked `itsa_participant`, whatever their type.
  const reviewerSpawn = Boolean(type?.review) || body.itsa_participant === true;
  let owned: Awaited<ReturnType<typeof itsaOwners.ownerBlock>> | undefined;
  // The agent asking (its `by`, or the parent a ring names), which may give the new agent only an ITSA
  // it may change (S-480); the human and a daemon's own spawn may give any.
  const askerRef = human ? undefined : body.by ? String(body.by) : parentId ?? undefined;
  const asker = askerRef ? (db.getAgent(askerRef)?.id ?? askerRef) : undefined;
  const ownerVia: Via | undefined = asker ? { agent: asker, boss: org.chiefOfStaff()?.id === asker || isAssistant(asker) } : undefined;
  if (body.itsa) {
    try {
      await itsaGate.pass();
      owned = await itsaOwners.ownerBlock(String(body.itsa), reviewerSpawn);
      itsaOwners.mayAssign(owned.id, ownerVia);
    } catch (e) {
      throw new HttpError(e instanceof itsa.ForbiddenError ? 403 : 400, e instanceof Error ? e.message : String(e));
    }
  }
  const base = resolve(String(body.cwd ?? process.cwd()));
  if (!existsSync(base) || !statSync(base).isDirectory()) throw new HttpError(400, `no directory ${base}`);

  // A personal workspace (S-894): a folder the agent keeps across archive, separate from the
  // working directory below. Its name is checked before any worktree exists, so a bad name
  // leaves nothing behind; the folder itself is made after the workspace is settled.
  let personalName: string | null = null;
  if (body.workspace !== undefined && body.workspace !== null && body.workspace !== false) {
    try {
      personalName = personalWorkspaceName(body.workspace === true ? true : String(body.workspace), name);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : String(e));
    }
    // One folder, one live holder: `workspace_share` is the sanctioned way to share it later.
    const holder = db.listAgents().find((x) => x.personal_workspace === personalWorkspacePath(personalName!) && x.lifecycle !== 'archived');
    if (holder) throw new HttpError(409, `workspace ${personalName} is held by ${holder.name}`);
  }

  // Workspace: an existing directory by default, or a worktree, a script, or instructions. A type
  // may default to a worktree (S-627: developer), and a developer that ends up working in the live
  // deploy checkout is refused here, on the machine that starts the agent, forwarded or not.
  let spec: WorkspaceSpec;
  try {
    spec = spawnWorkspaceSpec(body, type, base);
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
  // The developer slot cap (S-2008), checked before any worktree exists so a refusal leaves nothing
  // behind. The check and the reservation run with no await between them.
  // A spawn behind others in the queue waits too, even with a slot free, so it can't jump them.
  const capRefusal = slot.granted ? null : developerCapRefusal(db.listAgents(), agentTypes(), type, spec.kind === 'worktree', settings().developerCap, MACHINE);
  const behindQueue = !slot.granted && queuedWaiters().length > 0 && isDeveloperSpawn(type, spec.kind === 'worktree') && settings().developerCap > 0;
  // A developer spawn also waits on a host without room (S-2120), with free slots or not: the load guard.
  const roomWait = !slot.granted && isDeveloperSpawn(type, spec.kind === 'worktree') ? roomRefusal(hostReading()) : null;
  if ((capRefusal || behindQueue || roomWait) && !human) {
    if (!slot.queue) throw new HttpError(409, capRefusal ?? roomWait ?? `developer spawns are queued on ${MACHINE}; ${queuedWaiters().length} waiting`);
    throw new QueuedSpawn(queueSpawn(original, name, roomWait, slot.by));
  }
  // Held until the spawn ends, so a second spawn in the same seconds counts this one.
  if (isDeveloperSpawn(type, spec.kind === 'worktree')) {
    reserveSlot(name);
    slot.name = name;
  }
  let ws;
  try {
    ws = await createWorkspaceFetched(spec, name);
  } catch (e) {
    throw new HttpError(400, `workspace: ${e instanceof Error ? e.message : e}`);
  }
  // The refusal reads the resolved cwd, so a workspace script that printed the checkout is caught
  // too (S-627). Nothing is left behind: the kinds that can be refused own no worktree yet.
  const refused = spawnWorkspaceRefusal(type, ws);
  if (refused) {
    cleanupWorkspace(ws, true);
    throw new HttpError(400, refused);
  }
  // The personal workspace folder, made 0700 when it is missing and kept when it exists: a
  // respawned specialist adopts the folder of an archived one. A failure undoes the worktree.
  let personalWorkspace: string | null = null;
  if (personalName) {
    try {
      personalWorkspace = createPersonalWorkspace(personalName);
    } catch (e) {
      cleanupWorkspace(ws, true);
      throw new HttpError(400, `workspace: ${e instanceof Error ? e.message : e}`);
    }
  }
  let prompt = body.prompt ? String(body.prompt) : undefined;
  if (type) {
    const vars = Object.fromEntries(Object.entries(body.brief_vars && typeof body.brief_vars === 'object' ? body.brief_vars : {}).map(([k, v]) => [k, String(v)]));
    prompt = renderBrief(type, { ...vars, task: prompt ?? '', name, type: String(body.type), parent: parent?.name ?? mail.HUMAN, cwd: ws.cwd, branch: ws.worktree?.branch ?? '' });
  }
  if (ws.worktree?.base && prompt) prompt = `Your branch is cut from ${ws.worktree.base}, so your PR stacks on it.\n\n${prompt}`;
  if (ws.baseUsed?.defaulted && ws.baseUsed.fetch === 'failed' && prompt) prompt = `Your branch is cut from ${ws.baseUsed.ref} at ${ws.baseUsed.sha.slice(0, 8)} because fetching origin failed (${ws.baseUsed.error ?? 'unknown error'}), so it may be stale: run \`git fetch origin\` and rebase on origin/main before you start.\n\n${prompt}`;
  if (reviewerFallback && prompt) prompt = `Note: you are the fallback for the reviewer type ${reviewerFallback.from}, because its account is held (${reviewerFallback.reason}), so you run as ${reviewerFallback.target}.\n\n${prompt}`;
  if (prompt && ws.deps?.length) prompt = `${depsReport(ws.deps)}\n\n${prompt}`;
  if (owned) prompt = [owned.block, prompt].filter(Boolean).join('\n\n');
  if (spec.kind === 'instructions') prompt = [render('workspace-instructions', { text: spec.text }), prompt].filter(Boolean).join('\n\n');

  const agent = db.createAgent({
    id: db.newAgentId(),
    name,
    role: String(body.role ?? ''),
    machine: MACHINE,
    harness,
    // Any model string passes through to the harness, registered or not.
    model: body.model ? String(body.model) : null,
    effort: body.effort ? String(body.effort) : null,
    cwd: ws.cwd,
    // An agent spawns its own children; the human and the assistant place agents anywhere.
    parent_id: parentId,
    session_id: randomUUID(),
  });
  onCreated?.(agent.id);
  // Threads the brief cites open to the agent when its spawner may read them whole; a spawn with no spawner and no parent, the human's, opens any (S-1107).
  if (body.prompt) grantCitedThreads(String(body.prompt), body.by ? db.getAgent(String(body.by))?.id ?? String(body.by) : parentId ?? undefined, agent.id);
  // The mode comes from Settings › permission modes (S-1967), for an agent's children too. Only the
  // human picks another one for an agent (see `fromHuman`), which then stays; an agent's pick is ignored.
  const fromSettings = permissionModes.effectiveMode(harness, type ? String(body.type) : null);
  const picked = human && permissionModes.isMode(body.permission_mode) && body.permission_mode !== fromSettings ? body.permission_mode : null;
  const permission_mode = picked ?? fromSettings;
  const permission_source = picked ? 'manual' : 'settings';
  if (boss && (body.chief_of_staff || isCos)) setSetting('chiefOfStaff', name);
  const visibility = body.visibility && typeof body.visibility === 'object' ? JSON.stringify(body.visibility) : null;
  const kind = human && body.kind === 'assistant' ? 'assistant' : null;
  // How much the new agent hears about its own children; its preference, defaulted.
  const child_notices = ['turn', 'tree-idle', 'none'].includes(body.child_notices) ? String(body.child_notices) : settings().childNotices;
  db.updateAgent(agent.id, { workspace: JSON.stringify(ws), personal_workspace: personalWorkspace, standing: body.standing === true || (body.standing === undefined && type?.standing === true) ? 1 : 0, capabilities: JSON.stringify(capabilitiesFor(harness, agent.model)), permission_mode, permission_source, visibility, child_notices, kind, type: type ? String(body.type) : null, first_prompt: prompt ?? null });
  // S-759: the first prompt is stored now; the delivery marker (lifecycle.startHarness) says it
  // went in. A daemon restart in between leaves the agent 'starting' with no marker, so the
  // first reconcile pass re-delivers the prompt instead of waiting for the starting timeout.
  if (prompt) db.addEvent(agent.id, 'first-prompt:pending');
  // The worktree's dependencies (S-1044): linked from the deps cache, or warming in the
  // background. Logged as an agent event so the spawn is visible in the timeline; a warm logs
  // `deps:linked` (or `deps:failed`) when the fill finishes, so a brief can say to wait for it.
  if (ws.baseUsed) db.addEvent(agent.id, 'workspace:base', ws.baseUsed);
  for (const d of ws.deps ?? []) {
    db.addEvent(agent.id, d.event, { dir: d.dir, key: d.key });
    if (d.event === 'deps:warming' && d.warm) {
      d.warm()
        .then((r) => db.addEvent(agent.id, r.linked ? 'deps:linked' : 'deps:failed', { dir: d.dir, key: r.key }))
        .catch((e) => db.addEvent(agent.id, 'deps:failed', { dir: d.dir, key: d.key, error: e instanceof Error ? e.message : String(e) }));
    }
  }
  const actor = body.by ? String(body.by) : human ? mail.HUMAN : agent.id;
  let assigned = false;
  try {
    if (reviewerFallback) db.addEvent(agent.id, 'reviewer:fallback', reviewerFallback);
    if (override) {
      db.addEvent(agent.id, 'cost:override', { kind: 'spawn', account: override.account, held: override.reason });
      // Forced onto a blocked account, it carries the account's rule blockers from the start:
      // it launches held, and its first prompt waits as a notice until they clear.
      db.updateAgent(agent.id, { lifecycle: 'paused' });
      await rules.attachSpawn(db.getAgent(agent.id)!);
      await budgets.attachSpawn(db.getAgent(agent.id)!);
      if (lifecycle.isHeld(db.getAgent(agent.id)!) && prompt) {
        mail.queueNotice(agent.id, prompt, { idleOnly: true });
        prompt = undefined;
      }
      if (!lifecycle.isHeld(db.getAgent(agent.id)!)) db.updateAgent(agent.id, { lifecycle: 'active' });
    }
    // A tree paused for cost holds a new agent spawned into it too; its first prompt waits
    // as a notice until the pause clears.
    await costPause.attachSpawn(db.getAgent(agent.id)!);
    if (lifecycle.isHeld(db.getAgent(agent.id)!) && prompt) {
      mail.queueNotice(agent.id, prompt, { idleOnly: true });
      prompt = undefined;
    }
    if (owned) {
      // As the agent asking, when there is one: the home checks the assignment's `by` against its via.
      owned.owner = await itsaOwners.attachSpawned(owned.id, agent.id, reviewerSpawn, owned.owner, ownerVia?.agent ?? actor, ownerVia);
      assigned = !reviewerSpawn;
    } else if (parentId && settings().itsa.required) {
      // A spawn with no `itsa` joins its parent's open ITSA as a participant (step 10). Fire
      // it off without awaiting, so a slow or unreachable home never holds the spawn (the CLI
      // has a 10 s deadline; a home call waits up to 8 s). A failure is logged only. The
      // prompt may miss the participation line on this first start and show it on the next.
      void itsaOwners
        .joinParentItsa(agent.id, parentId, actor)
        .catch((e) => console.error(`ITSA: ${name} couldn't join its parent's ITSA: ${e instanceof Error ? e.message : e}`));
    }
    await lifecycle.startHarness(db.getAgent(agent.id)!, prompt, false, 'spawn');
  } catch (e) {
    db.updateAgent(agent.id, { lifecycle: 'shut_down', activity: 'errored', activity_detail: `launch failed: ${e instanceof Error ? e.message : e}` });
    // The agent never ran: give the ITSA back to its previous owner, if it is still the agent's.
    if (owned && assigned && !reviewerSpawn) await itsaOwners.restoreOwner(owned.id, agent.id, owned.owner, actor).catch((err) => console.error(`ITSA ${owned!.key}: couldn't restore its owner: ${err.message}`));
    throw e instanceof itsa.ForbiddenError ? new HttpError(403, e.message) : e;
  }
  // A new agent is busy (starting), so its parents now wait on children.
  org.syncChildrenWaits(agent.id);
  steps.emit('agent-spawned', steps.spawnSubject(db.getAgent(agent.id)!, body.by ? String(body.by) : human ? mail.HUMAN : null));
  return db.getAgent(agent.id)!;
}

// Starts a ring. New members are spawned: each `spawn` entry is { type } or { preset } or
// { harness, model }, named NAME-1, NAME-2, ...; `moderator` is an existing agent, or { type }
// (or { preset, ... }), spawned as NAME-mod. A type goes through the normal spawn path, so a
// reviewer type follows its fallback chain. If anything fails, the agents spawned for the ring
// are stopped and archived, so nothing is left running.
async function startRing(
  body: any,
  createdBy: string,
  human: boolean,
): Promise<{ ring: ring.Ring; members: db.Agent[]; moderator: db.Agent | null }> {
  const spawned: db.Agent[] = [];
  const parent = createdBy === mail.HUMAN ? undefined : createdBy;
  const spawnFor = async (s: any, name: string, what: string) => {
    // A name that is already taken is refused before anything is created, and that agent is
    // never ours to touch.
    if (db.getAgent(name)) throw new HttpError(409, `name ${name} is taken`);
    // Only the agent this spawn itself created is discarded, by the id spawnAgent reports; a
    // name lookup would find whoever holds the name by then.
    let created: string | undefined;
    try {
      // A member spawns as the ring's creator asked, checked as that creator (S-480): a `by` inside the
      // member's spec is no identity resolveActors checked, so the creator's replaces it.
      const a = await spawnAgent({ ...s, by: parent, self: undefined, from: undefined, name, role: `${what} of ring ${body.name}: ${body.topic}`.slice(0, 300), cwd: body.cwd, parent }, human, (id) => (created = id));
      spawned.push(a);
      return a;
    } catch (e) {
      // A launch that failed after the agent's row was created leaves it behind: discard it too.
      const left = created ? db.getAgent(created) : undefined;
      if (left) spawned.push(left);
      throw e;
    }
  };
  try {
    const names: string[] = [...(body.members ?? [])];
    let n = 0;
    for (const s of body.spawn ?? []) {
      const name = `${body.name}-${++n}`;
      await spawnFor(s, name, 'Member');
      names.push(name);
    }
    let moderator: string | undefined;
    if (body.moderator && typeof body.moderator === 'object') {
      moderator = (await spawnFor(body.moderator, `${body.name}-mod`, 'Moderator')).name;
    } else if (body.moderator) moderator = String(body.moderator);
    let r: ring.Ring;
    try {
      r = ring.createRing({ name: String(body.name), format: body.format, topic: body.topic, members: names, moderator, moderatorDecides: Boolean(body.moderator_decides), maxRounds: body.max_rounds ? Number(body.max_rounds) : undefined, createdBy });
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : String(e));
    }
    const all = JSON.parse(r.members).map((id: string) => db.getAgent(id)!);
    return { ring: r, members: all, moderator: r.moderator_id ? db.getAgent(r.moderator_id)! : null };
  } catch (e) {
    await discardAgents(spawned);
    throw e;
  }
}

// Stops and archives agents spawned for something that then failed. Errors are logged only.
async function discardAgents(list: db.Agent[]): Promise<void> {
  for (const a of list) {
    try {
      await lifecycle.shutdown(db.getAgent(a.id)!, true);
      await lifecycle.archive(db.getAgent(a.id)!, true);
    } catch (e) {
      console.error(`ring: couldn't archive ${a.name}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

// `spawn_agent type: <ring reviewer type>`: a ring of the type's member types, named NAME-1,
// NAME-2, ..., with a moderator NAME-mod when the type has one. The task is the topic. If a
// member can't start even after its own fallback chain, the type's `review.fallback` runs as a
// single reviewer with the same task, and `warning` says why; with no fallback it is refused.
async function spawnRingType(body: any, human: boolean): Promise<any> {
  const typeName = String(body.type);
  const type = agentType(typeName);
  const cfg = type.review!.ring!;
  const name = String(body.name ?? '').trim() || freeName();
  if (!NAME_RE.test(name)) throw new HttpError(400, 'name must be lowercase letters, digits, and dashes');
  if (db.getAgent(name)) throw new HttpError(409, `name ${name} is taken`);
  // The creator may live on another machine: resolved as a spawn's parent is.
  let creator: db.Agent | undefined;
  if (body.by && !isAssistant(body.by)) {
    creator = db.getAgent(String(body.by)) ?? (await findAgentPeer(String(body.by)))?.agent;
    if (!creator) throw new HttpError(404, `no agent ${body.by}`);
  }
  const createdBy = creator ? creator.id : human || isAssistant(body.by) ? mail.HUMAN : undefined;
  if (!createdBy) throw new HttpError(403, 'a ring needs a creator');
  const vars = Object.fromEntries(Object.entries(body.brief_vars && typeof body.brief_vars === 'object' ? body.brief_vars : {}).map(([k, v]) => [k, String(v)]));
  const cwd = body.cwd ?? process.cwd();
  const topic = renderBrief(type, { ...vars, task: body.prompt ? String(body.prompt) : '', name, type: typeName, parent: creator ? creator.name : mail.HUMAN, cwd, branch: '' });
  if (!topic) throw new HttpError(400, `${typeName} is a ring: give a prompt, the topic of the review`);
  // The ITSA a ring is spawned for: every member and the moderator join it as participants (S-501).
  const ringItsa = body.itsa ? { itsa: String(body.itsa), itsa_participant: true } : {};
  try {
    const r = await startRing(
      {
        name,
        topic,
        cwd,
        format: cfg.format,
        max_rounds: cfg.maxRounds,
        spawn: cfg.members.map((t) => ({ type: t, ...ringItsa })),
        moderator: cfg.moderator ? { type: cfg.moderator.type, ...ringItsa } : undefined,
        moderator_decides: cfg.moderator?.decides,
      },
      createdBy,
      human,
    );
    const view = (a: db.Agent) => ({ id: a.id, name: a.name, type: a.type });
    return { ...r.ring, kind: 'ring', ring: { id: r.ring.id, name: r.ring.name, format: r.ring.format, max_rounds: r.ring.max_rounds }, members: r.members.map(view), moderator: r.moderator ? view(r.moderator) : null, cwd: resolve(String(cwd)) };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    const fb = type.review!.fallback;
    if (!fb) throw new HttpError(e instanceof HttpError ? e.status : 409, `can't start ring ${name}: ${why}. ${typeName} has no fallback reviewer type.`);
    const a = await spawnAgent({ ...body, name, type: fb }, human);
    return { ...a, view: agentView.capabilities(a), warning: `ring ${typeName} didn't start (${why}), so ${name} is a single ${fb} reviewer (type ${a.type}) with the same task` };
  }
}

// --- The executive assistant -----------------------------------------------------------
// One agent, marked kind 'assistant', started from settings.assistant when first needed.
function assistantAgent(): db.Agent | undefined {
  return db.listAgents().filter((a) => a.kind === 'assistant' && a.lifecycle !== 'archived').at(-1);
}

async function startAssistant(prompt?: string): Promise<db.Agent> {
  const c = settings().assistant;
  let name = 'assistant';
  for (let i = 2; db.getAgent(name); i++) name = `assistant-${i}`;
  // Its own folder by default: it manages stam rather than a project.
  const cwd = c.cwd ? String(c.cwd).replace(/^~(?=$|\/)/, homedir()) : join(STAM_HOME, 'assistant');
  mkdirSync(cwd, { recursive: true });
  return spawnAgent({ name, harness: c.harness, model: c.model, effort: c.effort, cwd, role: 'Executive assistant', kind: 'assistant', prompt }, true);
}

// --- The chief of staff, from the cos type -------------------------------------------------
// Starts one when none is active; spawning type `cos` sets settings.chiefOfStaff.
let cosStart: Promise<db.Agent> | null = null;
function startCos(): Promise<db.Agent> {
  // Concurrent starts share one spawn.
  cosStart ??= startCosOnce().finally(() => (cosStart = null));
  return cosStart;
}

async function startCosOnce(): Promise<db.Agent> {
  const current = org.chiefOfStaff();
  if (current) return current;
  let name = 'cos';
  for (let i = 2; db.getAgent(name); i++) name = `cos-${i}`;
  // Its own folder, like the assistant's: it manages stam rather than a project.
  const cwd = join(STAM_HOME, 'cos');
  mkdirSync(cwd, { recursive: true });
  return spawnAgent({ name, type: 'cos', cwd, role: 'Chief of staff' }, true);
}

// Makes sure the assistant runs, and gives it `prompt` as the human's message.
async function messageAssistant(prompt?: string): Promise<db.Agent> {
  const a = assistantAgent();
  if (!a) return startAssistant(prompt);
  if (a.lifecycle === 'shut_down') {
    await lifecycle.resume(a, prompt ?? '');
    return db.getAgent(a.id)!;
  }
  if (prompt) {
    admit(a, 'human');
    if (tmux.capturePane(a.id).includes('-- NORMAL --')) tmux.sendKeys(a.id, 'i');
    await tmux.pasteText(a.id, prompt);
    db.addEvent(a.id, 'human:prompt', { chars: prompt.length, via: 'assistant' });
  }
  return a;
}

function configPath(which: string): string {
  return which === 'instructions' ? GLOBAL_INSTRUCTIONS : join(STAM_HOME, which === 'settings' ? 'settings.json' : 'registry.json');
}

function readConfigFile(which: string): string {
  // A non-home daemon with the home's copy cached shows that copy (S-387).
  const shared = which === 'settings' ? null : peerShared();
  if (which === 'instructions' && shared?.instructions !== undefined) return shared.instructions;
  if (which === 'registry' && shared?.registry) return JSON.stringify(shared.registry, null, 2) + '\n';
  try {
    return readFileSync(configPath(which), 'utf8');
  } catch {
    // No user registry yet: start from an empty override file.
    return which === 'registry' ? '{\n  "presets": {},\n  "models": {},\n  "harnesses": {}\n}\n' : which === 'instructions' ? '' : '{}\n';
  }
}

export async function control(a: db.Agent, action: string, body: any): Promise<string> {
  try {
    switch (action) {
      case 'pause':
      case 'unpause': {
        // The human or a manager pausing or unpausing the agent counts as acting on its cost
        // notices, so their fallbacks don't run (cost-fallback.ts).
        const by = body.by ?? 'human';
        const byId = by === 'human' ? by : (db.getAgent(by)?.id ?? by);
        if (costFallback.isManagerOf(a.id, byId)) costFallback.ackAgent(a.id, byId, action);
        if (action === 'pause') return await lifecycle.pause(a, by);
        return await lifecycle.unpause(a, { by, force: Boolean(body.force) });
      }
      case 'shutdown':
        return await lifecycle.shutdown(a, Boolean(body.now));
      case 'archive': {
        // An omitted discard keeps force's implication; an explicit false forbids it (S-1043 review).
        const discard = body.discard === undefined ? undefined : Boolean(body.discard);
        return await lifecycle.archiveCascade(a, Boolean(body.force), discard, async (parents, fallback) =>
          Promise.all(peers().map(async (p) => {
            try {
              const r = await peerCall(p, 'POST', '/api/archive-children', { parents, fallback }, 30_000);
              return r.status === 200 ? { machine: p.name, report: r.data as lifecycle.CascadeReport } : { machine: p.name, error: `status ${r.status}` };
            } catch (e) {
              return { machine: p.name, error: e instanceof Error ? e.message : String(e) };
            }
          })));
      }
      case 'resume':
        return await lifecycle.resume(a, String(body.note ?? ''));
      case 'restart':
        return await lifecycle.restart(a, String(body.reason ?? 'requested'));
      case 'adopt': {
        const parent = body.by ?? body.parent;
        if (body.remoteParent && parent) {
          // The adopting chief of staff runs on another machine, so only its id is stored here.
          db.addParent(a.id, String(parent));
          db.addEvent(a.id, 'adopted', { by: parent });
          return `${parent} is now a parent of ${a.name}`;
        }
        if (!parent || !db.getAgent(parent)) throw new Error('adopt needs the adopting agent');
        db.addParent(a.id, db.getAgent(parent)!.id);
        db.addEvent(a.id, 'adopted', { by: parent });
        // The adopting parent now has a descendant to wait on, if it is busy.
        org.syncChildrenWaits(a.id);
        return `${db.getAgent(parent)!.name} is now a parent of ${a.name}`;
      }
      case 'set-visibility': {
        if (!body.visibility || typeof body.visibility !== 'object') throw new Error('set-visibility needs a visibility object');
        db.updateAgent(a.id, { visibility: JSON.stringify(body.visibility) });
        return `visibility set; it applies to mail now and to its system prompt at its next restart`;
      }
      case 'set-child-notices': {
        const v = String(body.child_notices ?? '');
        if (!['turn', 'tree-idle', 'none'].includes(v)) throw new Error('child notices must be turn, tree-idle, or none');
        db.updateAgent(a.id, { child_notices: v });
        db.addEvent(a.id, 'child-notices', { value: v });
        return `child notices set to ${v}; it applies now and to ${a.name}'s prompt at its next restart`;
      }
      case 'compact': {
        const prompt = body.prompt ? render('compacted-self', { history: context.historyOf(a), prompt: String(body.prompt), lessons: await warmLessons(a), workspace: workspacePrompt(a) }) : undefined;
        return await lifecycle.requestCompaction(a, { instructions: body.instructions ? String(body.instructions) : undefined, prompt, reason: body.by ? 'requested by the agent' : 'requested' });
      }
      case 'reconnect-mcp':
        // A prune capping pinned releases (S-756) asks this way: reload the MCP server where the
        // harness supports one and at its next idle. A harness without a reload (Claude Code) is
        // left alone: never restart an agent to free a release.
        if (body.whenIdle) {
          await lifecycle.reconnectMcpWhenIdle([a.id]);
          return 'reconnect requested';
        }
        if (await adapters[a.harness]?.reconnectMcp?.(a)) return 'reconnected';
        return await lifecycle.restart(a, 'reconnect MCP servers');
      // The rest are for the human and the assistant.
      case 'set-parent': {
        const parents = [body.parent ?? []].flat().filter((p: unknown) => p && p !== 'none').map((p: unknown) => mustAgent(String(p)).id);
        if (parents.includes(a.id)) throw new Error(`${a.name} can't be its own parent`);
        const before = db.parentsOf(a);
        db.setParents(a.id, parents);
        db.addEvent(a.id, 'parents', { parents, by: body.by ?? 'human' });
        // Children waits follow the new tree; a former parent may have lost its last busy
        // descendant.
        org.syncChildrenWaits(a.id);
        for (const p of before) org.syncChildrenWaits(p);
        return parents.length ? `${a.name} now reports to ${parents.map((p: string) => db.getAgent(p)!.name).join(', ')}` : `${a.name} is now top-level`;
      }
      case 'rename': {
        const name = String(body.name ?? '').trim();
        if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) throw new Error('name must be lowercase letters, digits, and dashes');
        if (db.getAgent(name)) throw new Error(`name ${name} is taken`);
        db.updateAgent(a.id, { name });
        if (settings().chiefOfStaff === a.name) setSetting('chiefOfStaff', name);
        db.addEvent(a.id, 'renamed', { from: a.name, to: name });
        if (a.lifecycle === 'active' || a.lifecycle === 'paused') mail.queueNotice(a.id, `[stam] You were renamed from ${a.name} to ${name}; your id ${a.id} stays.`, { idleOnly: true });
        return `${a.name} is now ${name}`;
      }
      case 'chief-of-staff':
        setSetting('chiefOfStaff', a.name);
        return `${a.name} is the chief of staff; it takes the role in its prompt at its next restart`;
      case 'kill':
        await lifecycle.shutdown(a, true);
        return 'stopped';
      case 'forget':
        return forget(a);
    }
  } catch (e) {
    throw new HttpError(409, e instanceof Error ? e.message : String(e));
  }
  throw new HttpError(404, `no action ${action}`);
}

// The human's own pick for one agent stays over the settings; 'settings' makes it follow them
// again (S-1967). A running agent restarts in place, its session kept, once its step ends. A launch
// that fails, now or at the step's end, puts the old mode and source back and logs
// permission-mode:failed (permissionModes.switchFailed), so a settings agent shows on the stale list
// for a retry; `relaunch` retries by resuming the agent a failed switch left shut down.
async function setPermissionMode(a: db.Agent, m: unknown, by: string, source: 'manual' | 'settings' = 'manual', relaunch = false): Promise<string> {
  if (m === 'settings') source = 'settings';
  const mode = source === 'settings' ? permissionModes.effectiveMode(a.harness, a.type) : permissionModes.isMode(m) ? m : 'auto';
  const undo: permissionModes.SwitchUndo = { mode, source, by, kept: { permission_mode: a.permission_mode, permission_source: a.permission_source } };
  db.updateAgent(a.id, { permission_mode: mode, permission_source: source });
  db.addEvent(a.id, 'permission-mode', { mode, source, by });
  const reason = `permission mode changed to ${mode}`;
  if (relaunch && a.lifecycle === 'shut_down') {
    try {
      return await lifecycle.resume(db.getAgent(a.id)!, reason);
    } catch (e) {
      permissionModes.switchFailed(a.id, undo, e);
      throw e;
    }
  }
  if (mode === undo.kept.permission_mode || (a.lifecycle !== 'active' && a.lifecycle !== 'paused')) return 'set';
  return lifecycle.restart(db.getAgent(a.id)!, reason, undo);
}

// Switches the running agents that follow the settings to the mode the settings now give them
// (S-1967). An OpenCode agent keeps its session's rules, so it is left for its next session.
async function applyPermissionModes(by: string): Promise<{ applied: { name: string; mode: string; result: string }[]; skipped: { name: string; reason: string }[] }> {
  const stale = permissionModes.staleAgents();
  const skipped = stale.filter((s) => !s.inPlace).map((s) => ({ name: s.name, reason: `${s.harness} keeps a session's permission rules; it starts in ${s.want} at its next new session` }));
  const results = await Promise.allSettled(
    stale.filter((s) => s.inPlace).map(async (s) => {
      const a = db.getAgent(s.id)!;
      const result = await setPermissionMode(a, s.want, by, 'settings', s.failed !== null);
      db.addEvent(a.id, 'permission-mode:applied', { from: s.mode, mode: s.want, by });
      return { name: s.name, mode: s.want, result };
    }),
  );
  const applied: { name: string; mode: string; result: string }[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') applied.push(r.value);
    else skipped.push({ name: stale.filter((s) => s.inPlace)[i].name, reason: r.reason instanceof Error ? r.reason.message : String(r.reason) });
  });
  return { applied, skipped };
}

async function forget(a: db.Agent): Promise<string> {
  if (a.lifecycle === 'active' || a.lifecycle === 'paused') throw new HttpError(409, `${a.name} is running; shut it down first`);
  const parents = db.parentsOf(a).map((p) => db.getAgent(p)).filter((p): p is db.Agent => !!p);
  // Its ITSAs must be unowned first. If the ITSA home can't be told, keep the agent, so the
  // unown can still be retried or the forget repeated.
  if (itsaOwners.hasPendingUnown(a.id)) throw new HttpError(409, `${a.name} still has an unown waiting for the ITSA home; forget it after the home answers`);
  try {
    await itsaOwners.unownAgent(a, 'forgotten');
  } catch (e) {
    throw new HttpError(409, `can't forget ${a.name}: its ITSAs can't be unowned yet (${e instanceof Error ? e.message : e}); try again when the ITSA home answers`);
  }
  tmux.killSession(a.id);
  db.forgetAgent(a.id);
  lifecycle.restForget(a.id);
  // Its pending permission requests are withdrawn and it is gone from the tree, so a
  // parent's children wait changes and a deferred tree-idle notice above may be owed.
  for (const p of parents) {
    org.syncChildrenWaits(p.id);
    org.announceTreeIdle(p);
  }
  return `forgot ${a.name}`;
}

// For agents stam didn't spawn: they join the registry from their own MCP connection.
function registerAgent(body: any): db.Agent {
  const name = String(body.name ?? '').trim();
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) throw new HttpError(400, 'name must be lowercase letters, digits, and dashes');
  if (db.getAgent(name)) throw new HttpError(409, `name ${name} is taken`);
  const agent = db.createAgent({
    id: db.newAgentId(),
    name,
    role: String(body.role ?? ''),
    machine: MACHINE,
    harness: String(body.harness ?? 'external'),
    model: body.model ? String(body.model) : null,
    effort: null,
    cwd: String(body.cwd ?? ''),
    parent_id: null,
    session_id: null,
  });
  db.updateAgent(agent.id, { activity: 'unknown', child_notices: settings().childNotices });
  db.addEvent(agent.id, 'register');
  return db.getAgent(agent.id)!;
}

function onHook(harness: string, agentId: string, payload: any): { stdout?: string } {
  const agent = mustAgent(agentId);
  const adapter = adapters[harness] ?? adapters[agent.harness];
  if (!adapter.onHook) throw new HttpError(400, `${adapter.name} doesn't use hooks`);
  const ev = payload.hook_event_name;
  const r = timed(`hook ${ev}: adapter`, () => adapter.onHook!(agent, payload));
  const fields: Partial<db.Agent> = {};
  if (r.activity) fields.activity = r.activity;
  if (r.detail !== undefined) fields.activity_detail = r.detail;
  if (r.session_id) fields.session_id = r.session_id;
  if (r.transcript_path) fields.transcript_path = r.transcript_path;
  if (r.last_message) fields.last_message = String(r.last_message).slice(0, 4000);
  // The rest clock follows which turns act (S-2158); agent still holds the idle_since from before this hook.
  if (ev === 'UserPromptSubmit' && r.activity === 'working') lifecycle.restTurnStarted(agent.id, agent.idle_since);
  if (ev === 'PreToolUse' && typeof payload.tool_name === 'string') lifecycle.restToolUsed(agent.id, payload.tool_name);
  timed(`hook ${ev}: update agent`, () => db.updateAgent(agent.id, fields));
  timed(`hook ${ev}: add event`, () => db.addEvent(agent.id, `hook:${ev}`, r.activity ? { activity: r.activity, detail: r.detail } : undefined));
  // A dialog that blocks the agent becomes a permission request; any other activity, or a
  // new harness session, means it's gone.
  if (r.dialog) permissions.dialogShown(db.getAgent(agent.id)!, r.dialog.action, r.dialog.details, r.dialog.replaces).catch((e) => db.addEvent(agent.id, 'permission-error', String(e)));
  else if ((r.activity && r.activity !== 'blocked') || r.session_id) timed(`hook ${ev}: dialog closed`, () => permissions.dialogClosed(agent));
  // The prompt a typed suggestion submitted is checked against its text (S-422).
  if (payload.hook_event_name === 'UserPromptSubmit' && typeof payload.prompt === 'string') permissions.promptSubmitted(agent.id, payload.prompt);
  // A suggestion the human approved while the agent was busy is typed at its next idle or wait (S-422).
  if (r.activity === 'idle' || r.activity === 'waiting') permissions.typeHeldInput(agent.id).catch((e) => db.addEvent(agent.id, 'permission-error', String(e)));
  if (r.afterTool) {
    const notice = timed(`hook ${ev}: in-turn notice`, () => mail.inTurnNotice(agent.id));
    if (notice) {
      db.addEvent(agent.id, 'mail:notice');
      return { stdout: adapter.inTurnNotice?.(notice) ?? notice };
    }
  }
  if (r.turnEnded) {
    timed(`hook ${ev}: schedule push`, () => mail.schedulePush(agent.id));
    timed(`hook ${ev}: on idle`, () => lifecycle.onIdle(agent.id)).catch((e) => db.addEvent(agent.id, 'pending-error', String(e)));
    // The turn's items for the per-agent timeline (S-210), read after the hook answers.
    timed(`hook ${ev}: ingest soon`, () => activity.ingestSoon(agent.id));
    // The finished turn's vector (S-1460), on the daemon that owns the agent.
    timed(`hook ${ev}: index turns`, () => indexTurnsSoon(agent.id));
  }
  return { stdout: r.stdout };
}

// Dismisses known harness menus over idle agents (settings.banners), since a menu
// captures input and can hold back pushed mail.
// S-349: one tmux call per tick (tmux.snapshot) finds the agents' terminals, and a menu
// only shows with new output or another pane coming to the front, so a pane is captured
// (without blocking) when its window had output since the last look, its active pane changed,
// or BANNER_RELOOK_MS passed. Output in the second of a look counts as new, as
// #{window_activity} is in seconds. A look counts only once the agent's screen was checked
// against the banners while it could show one, and is forgotten when the agent can't (it
// works, or stops) or the banners settings change. Keys go to the captured pane only while it
// is still in the agent's session on the same server, under the same harness and banners.
const BANNER_RELOOK_MS = 2 * 60_000;
const bannerLooks = new Map<string, { pane: string; activity: number; at: number }>();
const bannerCapturing = new Set<string>();
let bannerRules = '';
const canShowBanner = (a: db.Agent) => (a.lifecycle === 'active' || a.lifecycle === 'paused') && (a.activity === 'idle' || a.activity === 'waiting');

export function dismissBanners(snap: tmux.Snapshot | null): void {
  const banners = settings().banners;
  if (JSON.stringify(banners) !== bannerRules) {
    bannerRules = JSON.stringify(banners);
    bannerLooks.clear();
  }
  const agents = db.listLiveAgents().filter((a) => canShowBanner(a) && banners.some((b) => b.harness === a.harness));
  const eligible = new Set(agents.map((a) => a.id));
  for (const id of bannerLooks.keys()) if (!eligible.has(id)) bannerLooks.delete(id);
  if (!agents.length) return;
  if (!snap) return;
  // The panes due a look this tick, oldest look first; at most BANNER_CAPTURES_PER_TICK are captured, so a tick
  // never captures every pane at once (banner-stagger.ts). The rest are due on the next tick.
  const due: { a: db.Agent; pane: string; activity: number; at: number }[] = [];
  for (const a of agents) {
    const pane = snap.pane.get(a.id);
    if (snap.dead.get(a.id) !== false || !pane || bannerCapturing.has(a.id)) continue;
    const activity = snap.activity.get(a.id)!;
    const last = bannerLooks.get(a.id);
    const now = Date.now();
    if (last && last.pane === pane && activity === last.activity && activity < Math.floor(last.at / 1000) && now - last.at < BANNER_RELOOK_MS) continue;
    due.push({ a, pane, activity, at: last?.at ?? 0 });
  }
  for (const { a, pane, activity } of pickLooks(due)) {
    const owner = `${snap.server}\t${a.id}`;
    const rules = bannerRules;
    const now = Date.now();
    bannerCapturing.add(a.id);
    tmux
      .capturePaneAsync(pane)
      .then(async (screen) => {
        // S-2125: the tmux calls are async; the synchronous parts around them are labelled banners.
        // The agent as it is now, if it can still show a banner under the same harness and rules.
        const current = () => {
          const cur = db.getAgent(a.id);
          return cur && canShowBanner(cur) && cur.harness === a.harness && JSON.stringify(settings().banners) === rules ? cur : null;
        };
        const hits = timed('banners screen', () => {
          const cur = current();
          if (!cur) return null;
          bannerLooks.set(a.id, { pane, activity, at: now });
          return banners.filter((b) => b.harness === cur.harness && new RegExp(b.match).test(screen));
        });
        for (const b of hits ?? []) {
          if ((await tmux.paneOwnerAsync(pane)) !== owner) return;
          // The owner lookup took a turn of the event loop: the agent may have started working or changed since.
          if (!timed('banners recheck', current)) return;
          await tmux.sendKeysToPaneAsync(pane, ...b.keys);
          timed('banners dismissed', () => {
            db.addEvent(a.id, 'banner:dismissed', { match: b.match });
            mail.schedulePush(a.id);
          });
        }
      })
      .catch(() => {})
      .finally(() => bannerCapturing.delete(a.id));
  }
}

// A 'working' agent whose harness sits at its prompt and has sent no hook for
// settings.staleWorkingMinutes missed its end-of-turn hook, e.g. while the daemon restarted
// (S-188). Mail and notices reach only idle agents, so it ends the turn as Stop would.
export function reconcileStaleWorking(): void {
  const limit = settings().staleWorkingMinutes * 60_000;
  for (const a of db.listLiveAgents()) {
    if (a.lifecycle !== 'active' || a.activity !== 'working') continue;
    const adapter = adapters[a.harness];
    if (!adapter?.atPrompt) continue;
    const last = db.lastHookAt(a.id) ?? a.updated_at;
    if (Date.now() - Date.parse(last) < limit || !adapter.atPrompt(a)) continue;
    db.addEvent(a.id, 'activity:reconciled', { last_hook: last });
    db.updateAgent(a.id, { activity: 'idle', activity_detail: 'turn finished' });
    mail.schedulePush(a.id);
    lifecycle.onIdle(a.id).catch((e) => db.addEvent(a.id, 'pending-error', String(e)));
  }
}

// The tmux server reconcile last saw (tmux.serverId). runDaemon sets it before the
// adapters start, since the OpenCode adapter starts a server of its own.
let tmuxServer: string | null = null;
let reconciled = false;
// S-2125: agents whose tmux-server loss reconcile saw but held back, since they changed after the snapshot began.
const lossDeferred = new Set<string>();
// S-1393: when the idle shut-down archive sweep last ran. Reconcile ticks every 5 s; the sweep
// asks git and the home, so it runs every 10 minutes.
let idleShutdownSweptAt = 0;
const IDLE_SHUTDOWN_SWEEP_MS = 10 * 60_000;

// An active agent whose harness process is gone has shut down, whether it exited,
// crashed, or the daemon was away when it happened. When the whole tmux server went
// down with it (a reboot, or the server crashing) rather than one harness exiting,
// the agent didn't choose to stop, so it comes back with its conversation.
// S-273: the agents whose running compaction already has its reconcile:held event (one per compaction).
const held = new Set<string>();
let statementStop: (() => number) | null = null;
// Test-only (POST /api/test/read-hold): the agents whose read_mail route waits for a release.
const readHolds = new Map<string, { gate: Promise<void>; release: () => void }>();

// S-384: an agent whose harness ended its session (SessionEnd) and that, after
// STAM_SESSION_END_MS (a minute), still has no new session and no MCP stream to push to.
const SESSION_END_MS = Number(process.env.STAM_SESSION_END_MS) || 60_000;
function sessionEndedLong(a: db.Agent): boolean {
  if (a.activity !== 'unknown' || a.activity_detail !== db.SESSION_ENDED || hasStream(a.id)) return false;
  return Date.now() - Date.parse(db.lastHookAt(a.id) ?? a.updated_at) >= SESSION_END_MS;
}

export function reconcile(snap: tmux.Snapshot | null = tmux.snapshot()): void {
  // One tmux call for every agent's session (S-345), rather than a spawn or two per agent; the
  // loops pass the shared async snapshot (S-2125), and the start-up pass takes its own.
  // A call that failed without saying the server is gone tells nothing, so the tick changes
  // nothing (and the next one counts as the first) rather than taking every agent for lost.
  if (!snap) {
    console.error('reconcile: tmux list-panes failed; skipped this tick');
    return;
  }
  const { server, dead } = snap;
  // S-2125: the snapshot is from when its tmux call started, and a shared one may be applied a moment later.
  // An agent changed since (resumed, relaunched) may have a session the snapshot doesn't show, so it isn't
  // taken for exited or lost on it; the next tick, with a fresh snapshot, decides. updated_at is in ms.
  const asOf = tmux.snapshotStartedAt(snap) ?? Infinity;
  const first = !reconciled;
  reconciled = true;
  // No server at daemon start, or a different server (or none) than last time.
  const serverLost = server !== tmuxServer || (first && server === null);
  tmuxServer = server;
  // Found at daemon start, within five minutes of boot: the server went with the machine.
  const reason = first && uptime() < process.uptime() + 300 ? 'this machine restarted' : "stam's tmux server stopped";
  let lost = false;
  const now = Date.now();
  // S-2128: archived agents are skipped below, so only live rows are read.
  for (const a of db.listLiveAgents()) {
    // Registered agents (no workspace) run outside stam, so there is no terminal to check.
    if (!a.workspace) continue;
    // An archived agent has no terminal left to check, so reconcile makes no tmux call for it.
    if (a.lifecycle === 'archived') continue;
    // A lost server is seen once, on the tick it changes, so an agent held back here keeps its loss in lossDeferred
    // until a snapshot from after its change decides it (or shows its session).
    if (dead.get(a.id) !== false && Date.parse(a.updated_at) >= asOf) {
      if (serverLost) lossDeferred.add(a.id);
      continue;
    }
    const lostHere = serverLost || lossDeferred.delete(a.id);
    if (a.activity === 'starting') {
      // S-759: a first prompt this restart cut off before delivery is re-delivered now, not
      // waited on; the marker tells it from a launch that already got its prompt in.
      if (first && lifecycle.firstPromptLost(a)) {
        lifecycle.recoverFirstPrompt(a).catch((e) => db.addEvent(a.id, 'pending-error', String(e)));
        continue;
      }
      // S-578 review: a starting agent's dead-harness path is handled only here, past its
      // configured deadline. A pending archive is no longer held back by that: runDueArchives
      // archives it once its own final-round deadline passes (S-1043), even while starting.
      // Past the deadline, it is dead unless its harness still runs a turn with no pane.
      if (lifecycle.startingStuck(a, dead.get(a.id) === false, now)) {
        lifecycle.markStartingDead(a).catch((e) => db.addEvent(a.id, 'pending-error', String(e)));
      }
      continue;
    }
    // S-273: a compaction takes the harness down on purpose, and may take the tmux server with it; it isn't an exit or a lost server.
    if (lifecycle.compactionRunning(a.id)) {
      // S-273: one event on the first tick a compaction is held, so a test can wait for a tick that ran during it.
      if (!held.has(a.id)) {
        held.add(a.id);
        db.addEvent(a.id, 'reconcile:held');
      }
      continue;
    }
    held.delete(a.id);
    // S-578: the harness is gone, so a pending stop has no step to wait for; run it before the
    // exit and lost-server checks below read the downed harness as an exit. S-1043: an archive
    // whose final-round deadline passed is left to runDueArchives, so the two don't race.
    if (dead.get(a.id) !== false && lifecycle.pendingStop(a)) {
      if (!lifecycle.pendingStopDue(a)) lifecycle.runPendingOnDead(a).catch((e) => db.addEvent(a.id, 'pending-error', String(e)));
      continue;
    }
    // S-358: on the first pass, a compaction the daemon's restart cut short is finished and resumed,
    // before the lost-server and exit checks, which would read the downed harness as lost or exited.
    if (first && a.lifecycle === 'active' && dead.get(a.id) !== false && lifecycle.compactionExit(a)) {
      lost = true;
      continue;
    }
    if (lostHere && !dead.has(a.id)) {
      if (a.lifecycle === 'active') {
        lifecycle.markLost(a, reason);
        lost = true;
      } else if (a.lifecycle === 'paused' && !a.activity_detail?.endsWith('unpause to resume')) {
        // Paused agents stay paused; unpausing resumes them (lifecycle.unpause).
        db.updateAgent(a.id, { activity: 'unknown', activity_detail: `${reason}; unpause to resume` });
        db.addEvent(a.id, 'tmux-lost', { reason, resume: false });
      }
      continue;
    }
    if (a.lifecycle === 'active' && dead.get(a.id) !== false) {
      lifecycle.harnessExited(a.id);
      if (lifecycle.contextExit(a)) lost = true;
      else {
        db.updateAgent(a.id, { lifecycle: 'shut_down', activity: 'unknown', activity_detail: 'harness exited' });
        db.addEvent(a.id, 'exited');
      }
    } else if (a.lifecycle === 'active' && sessionEndedLong(a)) {
      // S-384: the harness ended its session but its pane lives on (a copy of it ran elsewhere, or
      // it hangs on its way out), so no mail or notice can reach it; it shuts down like an exit.
      tmux.killSession(a.id);
      lifecycle.harnessExited(a.id);
      if (lifecycle.contextExit(a)) lost = true;
      else {
        db.updateAgent(a.id, { lifecycle: 'shut_down', activity: 'unknown', activity_detail: 'harness ended its session' });
        db.addEvent(a.id, 'exited', { reason: db.SESSION_ENDED });
        mail.tellStopped(a, `${a.name}'s harness ended its session without exiting, so stam shut it down.`);
      }
    }
  }
  // The first pass also picks up agents marked lost before a daemon restart.
  if (lost || first) lifecycle.recoverLost().catch((e) => console.error(`resuming agents failed: ${e.message}`));
  // S-1043: an archive whose final-round deadline passed runs now, whatever its turn is doing.
  lifecycle.runDueArchives().catch((e) => console.error(`pending archive sweep failed: ${e.message}`));
  // S-1393: shut-down agents left past settings.archive.idleShutdownHours with nothing they owe.
  if (Date.now() - idleShutdownSweptAt >= IDLE_SHUTDOWN_SWEEP_MS) {
    idleShutdownSweptAt = Date.now();
    lifecycle.archiveIdleShutdowns().catch((e) => console.error(`idle shut-down sweep failed: ${e.message}`));
  }
  // A switch whose soft stop a restart cut short goes on at its deadline.
  if (first) costSwitch.resumeSwitches();
}

// The loops' ticks: the shared async snapshot (S-2125), then the synchronous work under its label.
export async function reconcileTick(): Promise<void> {
  const snap = await tmux.sharedSnapshot();
  timed('reconcile', () => reconcile(snap));
}
export async function bannersTick(): Promise<void> {
  const snap = await tmux.sharedSnapshot();
  timed('banners', () => dismissBanners(snap));
}

// Addresses to listen on: localhost, plus this machine's Tailscale address so the
// web UI works from a phone. STAM_BIND (comma-separated) overrides.
export function bindAddresses(): string[] {
  if (process.env.STAM_BIND) return process.env.STAM_BIND.split(',');
  const addrs = ['127.0.0.1'];
  try {
    const ts = execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8', timeout: 2000 }).trim().split('\n')[0];
    if (ts) addrs.push(ts);
  } catch {}
  return addrs;
}

// A browser terminal: a PTY running `tmux attach` for one agent, relayed over a WebSocket.
// Messages starting with a NUL byte are control messages, such as a resize.
//
// A tmux window has one size, so all viewers of an agent share it: the viewer that last
// opened, resized, or typed sets it ({claim: true}), and the daemon resizes every viewer's
// PTY to match and sends them {size}, so each shows the same screen, scaled to fit.
// Viewers of different sizes would otherwise fight over the window and see each other's
// layout, padded with dots or wrapped.
const viewers = new Map<string, { size: [number, number]; ptys: Set<{ ws: import('ws').WebSocket; pty: import('node-pty').IPty }> }>();
// A statusline refresh asks whether a tmux client is attached; the answer is cached for a few seconds (tmux-clients.ts, S-1025).
const tmuxClientsOpen = clientCache(tmux.hasClients, 5_000);
// Processes one status-line report: the context size, then the usage tables (S-2126: reached through statuslineGate).
const statuslineGate = createStatuslineGate((slot, body) => {
  const [harness, id] = slot.split('/') as [string, string];
  const a = db.getAgent(id);
  if (!a) return;
  const f = adapters[harness]?.onStatusLine?.(a, body as Record<string, any>) ?? {};
  if (f.context_tokens !== undefined || f.context_window !== undefined) db.updateAgent(a.id, { context_tokens: f.context_tokens, context_window: f.context_window });
  // Stores the windows before the cost, so the paid estimate uses this refresh's windows.
  usage.reportStatusline(a, f);
  if (f.context_tokens !== undefined) context.onContext(a.id, f.context_tokens);
  if (f.session) cacheCold.onCacheTurn(a.id, f.session);
  if (f.cacheTtl) cacheCold.onCacheTtl(a.id, f.cacheTtl);
});

function attachTerminal(ws: import('ws').WebSocket, agentId: string, cols: number, rows: number): void {
  let group = viewers.get(agentId);
  const first = !group;
  if (!group) {
    viewers.set(agentId, (group = { size: [cols || 100, rows || 30], ptys: new Set() }));
    // The viewers set the window's size, not the clients of `stam attach`.
    tmux.setWindowSize(agentId, 'manual');
  }
  const g = group;
  const term = pty.spawn('tmux', ['-L', TMUX_SOCKET, 'attach-session', '-t', `=${agentId}`], {
    name: 'xterm-256color',
    cols: g.size[0],
    rows: g.size[1],
    env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
  });
  const me = { ws, pty: term };
  g.ptys.add(me);
  const setSize = (c: number, r: number) => {
    g.size = [c, r];
    tmux.resizeWindow(agentId, c, r);
    for (const v of g.ptys) {
      v.pty.resize(c, r);
      if (v.ws.readyState === v.ws.OPEN) v.ws.send('\x00' + JSON.stringify({ size: [c, r] }));
    }
  };
  // A new viewer takes over the size, as typing in it would.
  // The first viewer sizes the window even with no size (0x0 uses the default), so the
  // window never keeps the size it had before the web took it.
  if (first) setSize(g.size[0], g.size[1]);
  else if (cols > 0 && rows > 0) setSize(cols, rows);
  else ws.send('\x00' + JSON.stringify({ size: g.size }));
  term.onData((d) => ws.readyState === ws.OPEN && ws.send(d));
  term.onExit(() => ws.close());
  ws.on('message', (raw) => {
    const msg = raw.toString();
    if (msg.startsWith('\x00')) {
      try {
        const { cols, rows } = JSON.parse(msg.slice(1));
        if (cols > 0 && rows > 0 && (cols !== g.size[0] || rows !== g.size[1])) setSize(cols, rows);
      } catch {}
    } else term.write(msg);
  });
  ws.on('close', () => {
    term.kill();
    g.ptys.delete(me);
    if (!g.ptys.size) {
      viewers.delete(agentId);
      // No web viewer left: the window fits its clients again, as tmux does.
      tmux.setWindowSize(agentId, 'latest');
    }
  });
}

// The Tailscale login of this machine's owner. Requests that `tailscale serve` relays
// from the owner's own devices carry it in Tailscale-User-Login, so the web UI needs no
// token there. Local processes could set that header too, but they can read the token
// anyway, so it grants nothing new.
function tailscaleOwner(): string | undefined {
  try {
    const s = JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 3000 }));
    return s.User?.[String(s.Self?.UserID)]?.LoginName;
  } catch {
    return undefined;
  }
}

// The human, as surely as one Unix user allows. Agents hold the token and can send any
// header to 127.0.0.1, so the token, x-stam-human, and a Tailscale-User-Login header prove
// nothing alone. tailscaled runs as root: a loopback connection whose socket root owns came
// through `tailscale serve`, which sets Tailscale-User-Login and X-Forwarded-For itself.
// The login must be the owner's, and the client must not be this machine or a peer machine,
// where agents run (they too could go through serve as the owner). Linux only (/proc/net/tcp);
// elsewhere it fails closed. Test daemons set STAM_TEST_HUMAN_KEY to stand in for serve.
const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
function socketUid(req: IncomingMessage): number | undefined {
  const hex = (n?: number) => (n ?? 0).toString(16).toUpperCase().padStart(4, '0');
  const [remote, local] = [hex(req.socket.remotePort), hex(req.socket.localPort)];
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = '';
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c.length > 7 && c[1].endsWith(':' + remote) && c[2].endsWith(':' + local)) return Number(c[7]);
    }
  }
  return undefined;
}

const agentIps = agentIpCache(
  async () => (await execFileAsync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 3000 })).stdout,
  () => peers().flatMap((p) => [p.name.toLowerCase(), new URL(p.url).hostname.toLowerCase().split('.')[0]]),
);
const agentMachineIps = agentIps.get;

// The caller of a request, from callerOf: the shared token, an agent's own token, the owner's
// Tailscale login, or no credential (a media link or the OAuth callback, which carry their own proof).
// `opencode` is the OpenCode server's token (S-240): it names an OpenCode agent on this daemon, never
// the human, and nothing defaults.
type Caller = { kind: 'shared' | 'peer' | 'agent' | 'opencode' | 'owner' | 'none'; agent?: string; boss?: boolean; assistant?: boolean; scope?: 'tree' | 'foreign' | 'none'; // legacy: the forwarded agent came with the shared token (legacyPeerToken), not a peer's token (S-1061)
  legacy?: boolean };

// The identity a request acts as (S-238), for every route that takes one: body by, from, self,
// and the as and by query params. An agent's own token acts as that agent: no claim is the agent,
// and a claim of itself (by id or name) is the agent too; any other claim is a 403. A shared-token
// or owner request keeps its claim as given, except that with settings.auth.sharedTokenClaims off a
// shared-token request may not claim an agent (the human's `human`, or none, still works).
function actor(caller: Caller, claimed: unknown): string | undefined {
  const claim = claimed === undefined || claimed === null || claimed === '' ? undefined : String(claimed);
  if (caller.kind === 'agent') {
    if (!claim) return caller.agent;
    // The agent may be on another machine, so it isn't always in this database (S-239).
    if (claim === caller.agent || db.getAgent(claim)?.id === caller.agent) return caller.agent;
    throw new HttpError(403, `agent ${db.getAgent(caller.agent ?? '')?.name ?? caller.agent} can't act as ${claim}`);
  }
  if (caller.kind === 'opencode') {
    const agent = claim === undefined ? undefined : db.getAgent(claim);
    if (agent?.harness !== 'opencode') throw new HttpError(403, `the OpenCode server can't act as ${claim ?? 'no one'}`);
    return agent.id;
  }
  if (caller.kind === 'shared' && claim && claim !== mail.HUMAN) {
    if (!settings().auth.sharedTokenClaims) throw new HttpError(403, `the shared token can't act as ${claim}: settings.auth.sharedTokenClaims is off`);
    // An agent with its own token (every launch mints one) must use it; the shared token may name only
    // an agent without one, such as one from before per-agent tokens (S-545).
    if (db.getAgent(claim)?.token_hash || db.findPeerAgent(claim)) throw new HttpError(403, `the shared token can't act as ${claim}: it has its own token`);
  }
  return claim;
}

// Applies actor() to a request's identity fields in place, so each handler sees the identity
// it may act as. A peer's request is trusted as it is, unless it names the agent it acts for (S-239).
function resolveActors(caller: Caller, body: any, url: URL, method = ''): void {
  // The OpenCode server's write names its agent in the body, and nothing defaults (S-240). Routes
  // that name the agent in the path, checked by mayActAs, and the harness's hook and statusline
  // reports, are exempt. So are a tool check and a permission request, which name their agent as
  // `agent` and are checked by actor() in their routes (S-233 review).
  if (caller.kind === 'opencode' && body && typeof body === 'object' && !Array.isArray(body) && !['by', 'from', 'self'].some((k) => body[k] !== undefined)) {
    const pathNamesAgent = opencodeNamesAgent(method, url.pathname) || /^\/api\/(hook|statusline)\//.test(url.pathname);
    const bodyNamesAgent = method === 'POST' && /^\/api\/(steps\/check|permissions)$/.test(url.pathname);
    if (!pathNamesAgent && !bodyNamesAgent) throw new HttpError(403, "the OpenCode server's request must name its agent (by, from, or self)");
  }
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const k of ['by', 'from', 'self'] as const) {
      if (body[k] === undefined && caller.kind !== 'agent') continue;
      const v = actor(caller, body[k]);
      if (v !== undefined) body[k] = v;
    }
    // The OpenCode server names its agent once, in any of the three; like an agent's own token, all
    // three are then that agent (S-480). A route never reads a missing `by` from it as the human's, or
    // falls back to another field, such as a spawn's `parent`, to decide whom to check.
    const named = caller.kind === 'opencode' ? (body.by ?? body.from ?? body.self) : undefined;
    if (named !== undefined) for (const k of ['by', 'from', 'self'] as const) body[k] ??= named;
  }
  // The as query names the viewer. The by query is a grouping on some routes, so each route that
  // reads it as an actor checks it (GET /api/subscriptions).
  if (url.searchParams.has('as')) url.searchParams.set('as', actor(caller, url.searchParams.get('as')) ?? '');
}

// The identity a request forwarded to a peer carries (S-239): the agent whose token the request
// came with, and whether it is this daemon's chief of staff or assistant. None for the human, the
// shared token or an owner, and for a daemon's own calls, which the peer checks as they are.
function viaFor(agent: string): Via {
  return { agent, boss: org.chiefOfStaff()?.id === agent || isAssistant(agent), assistant: isAssistant(agent) };
}
function viaOf(caller: Caller): Via | undefined {
  if (caller.kind !== 'agent' || !caller.agent) return undefined;
  return { ...viaFor(caller.agent), scope: caller.scope };
}

// A spawn on a peer machine: the peer is started if it is stopped, deployed to this release (a failed deploy is a warning), and
// the new agent is remembered here. Used for a spawn relayed from a request and for the process runner's.
async function spawnOnPeer(peer: Peer, body: any, human: boolean, via: Via | undefined): Promise<{ status: number; data: any; warning?: string }> {
  await ensureUp(peer).catch((e) => { throw new HttpError(503, e instanceof Error ? e.message : String(e)); });
  const warning = await ensureCurrent(peer);
  const r = await peerCall(peer, 'POST', '/api/agents', body, 660_000, human, via);
  if (r.status < 300 && r.data?.id && r.data.kind !== 'ring' && r.data.machine !== MACHINE) db.rememberPeerAgent(r.data);
  // A ring spawned on a peer has no machine: its members and moderator are the agents to remember.
  if (r.status < 300 && r.data?.kind === 'ring') {
    for (const a of [...(r.data.members ?? []), r.data.moderator]) if (a?.id && a.name) db.rememberPeerAgent({ id: a.id, name: a.name, machine: peer.name });
  }
  return { ...r, warning };
}

// The identity a mail read as `box` (viewerBox) carries to a peer, and its path with the box (S-467).
// The OpenCode server has no agent of its own, so the peer checks the OpenCode agent it named; with
// no via the peer would answer as for a daemon. The box rides along, so a parent reading a child's
// box, or the shared token naming one, is checked as that box there too.
function viaBox(caller: Caller, box: string | undefined): Via | undefined {
  if (caller.kind === 'opencode' && box) return { agent: box, boss: org.chiefOfStaff()?.id === box || isAssistant(box) };
  return viaOf(caller);
}
function withBox(path: string, box: string | undefined): string {
  return box ? `${path}?box=${encodeURIComponent(box)}` : path;
}

// The unanswered decision mails across the daemons (S-352): a storage agent's mail is stored there,
// so the peers' lists join this one, deduplicated by mail id. A mail about an ITSA in a human status
// is left out, on any home: each home reports its own waiting ITSAs. A peer's own request gets its
// local list only, and the asking daemon does the filtering.
async function decisionMailsAll(local: boolean, via?: Via): Promise<decisionMail.DecisionMail[]> {
  const mine = decisionMail.localDecisionMails();
  if (local) return mine;
  const theirs = await fanOut<decisionMail.DecisionMail>('/api/mail/decisions', via);
  const held = new Set([...itsaHuman.waitingIds(), ...(await fanOut<{ id: string }>('/api/itsas/attention', via)).map((x) => x.id)]);
  const all = new Map<string, decisionMail.DecisionMail>();
  for (const m of [...mine, ...theirs]) all.set(m.mail_id, m);
  return decisionMail.withoutHeld([...all.values()], held).sort((a, b) => a.created_at.localeCompare(b.created_at));
}

// A mailbox's threads as its list shows them, merged from every daemon and split by this daemon's
// archive state. Every source is asked for the page plus the mailbox's archived threads, so
// filtering by archive can't leave the page short of matches. `via` is how peers check the box
// is read as; `viaDecisions` how they check the decision list (the human's mailbox only).
async function mailboxThreads(box: string, limit: number, via?: Via, viaDecisions?: Via, withId?: string): Promise<{ active: { thread_id: string; mails: db.ThreadMail[] }[]; archived: { thread_id: string; mails: db.ThreadMail[] }[]; deferred: { thread_id: string; mails: db.ThreadMail[] }[] }> {
  const cap = limit + db.archivedCount(box) + db.deferredCount(box);
  const merged = new Map<string, db.ThreadMail[]>();
  const withQ = withId ? `&with=${encodeURIComponent(withId)}` : '';
  for (const t of [...db.threads(box, cap, withId), ...(await fanOut<ReturnType<typeof db.threads>[number]>(`/api/agents/${box}/threads?limit=${cap}${withQ}`, via))])
    merged.set(t.thread_id, [...(merged.get(t.thread_id) ?? []), ...t.mails]);
  // A thread's place is its newest message the mailbox sent or received: mail between others
  // in it doesn't move it up (S-542).
  const last = (ms: db.ThreadMail[]) => (ms.findLast((x) => x.from_id === box || x.recipients.some((r) => r.id === box)) ?? ms.at(-1)!).created_at;
  const all = [...merged]
    .map(([thread_id, ms]) => ({ thread_id, mails: db.foldMails(ms).sort((a, b) => a.created_at.localeCompare(b.created_at)) }))
    .sort((a, b) => last(b.mails).localeCompare(last(a.mails)));
  const keep = box === mail.HUMAN ? new Set([...itsaHuman.askThreadIds(), ...(await decisionThreads(false, viaDecisions))]) : undefined;
  const { active, archived } = db.splitArchived(box, all, keep);
  // An ask or a decision can be deferred too (S-1068), so `keep` (which holds them in the inbox) doesn't apply.
  const { rest, deferred } = db.splitDeferred(box, active);
  return { active: rest, archived, deferred };
}

// Where the auto-archive pass (S-637) reads the human's inbox and its open decisions, and how it
// archives a thread on the peers, whose archive state is their own.
function autoArchiveSources(): autoArchive.Sources {
  return {
    inbox: (limit = 200) => mailboxThreads(mail.HUMAN, limit),
    openDecisions: async () => new Set((await decisionMailsAll(false)).map((m) => m.mail_id)),
    humanWaits: async () => [...waits.openHumanWaits(), ...(await fanOut<HumanWait>('/api/mail/human-waits'))],
    tellPeers: async (thread_id, ids, human_ids) => {
      await Promise.all(peers().map((p) => peerCall(p, 'POST', '/api/mail/archive-resolved', { thread_id, ids, human_ids })));
    },
    peersReachable: () => peersReachable(),
  };
}

// The threads with an unanswered decision mail, which archive can't hide.
async function decisionThreads(local: boolean, via?: Via): Promise<Set<string>> {
  return new Set((await decisionMailsAll(local, via)).map((m) => m.thread_id));
}

// The mailbox a mail read looks at, named by its box query (S-259). An agent reads its own box by
// default, and any box it names must pass mayActAs: itself, an ancestor, the chief of staff or the
// assistant, and never another agent or the human. The OpenCode server names an OpenCode agent, and
// nothing defaults. The shared token, the owner and peers keep the box they are given.
async function viewerBox(caller: Caller, raw: string | null): Promise<string | undefined> {
  if (caller.kind !== 'agent' && caller.kind !== 'opencode') return raw || undefined;
  if (!raw) {
    if (caller.kind === 'opencode') throw new HttpError(403, "the OpenCode server must name the box it reads");
    return caller.agent;
  }
  const id = raw === mail.HUMAN ? mail.HUMAN : (db.getAgent(raw)?.id ?? raw);
  // A box on another machine is authorized before any local read (S-263): the local copy of its mail
  // isn't read for a caller the peer would refuse.
  if (id !== mail.HUMAN && !db.getAgent(id)) await mayActAsRemote(caller, id);
  else mayActAs(caller, id);
  return id;
}

// Whether a viewer may see a mail (S-359, S-388): the viewer may act for its box (viewerBox), and
// the box sees the mail by the rules of mail-visibility.ts. A boss forwarded by a peer, and a daemon
// or the human (no box), see any mail.
async function mayReadMail(caller: Caller, x: db.Mail, url: URL): Promise<boolean> {
  const box = await viewerBox(caller, url.searchParams.get('box'));
  if (!box || caller.boss || org.chiefOfStaff()?.id === box || isAssistant(box)) return true;
  return visibility.mayReadMail(boxRef(box), x, readerOf(caller, box));
}

// The agent a mail read is checked as, for an ITSA's thread (S-480): the agent whose token asks (or
// that a peer forwards for), not a box it may act for; the OpenCode server reads as the box it names.
function readerOf(caller: Caller, box: string): string {
  return caller.kind === 'agent' && caller.agent ? boxRef(caller.agent) : boxRef(box);
}

// A box on another machine (S-263). Allowed for the caller itself, the chief of staff or assistant
// (here, or forwarded by a peer as its boss); otherwise only for a parent of the box, which the box's
// own daemon confirms with a probe of its inbox. Anything else, or a peer that can't be reached, is a
// 403, and nothing is read here first. The OpenCode server names only its own local agents.
async function mayActAsRemote(caller: Caller, id: string): Promise<void> {
  const refuse = () => new HttpError(403, `${caller.kind === 'agent' ? (db.getAgent(caller.agent ?? '')?.name ?? caller.agent) : 'the OpenCode server'} can't act as ${id}`);
  if (caller.kind !== 'agent') throw refuse();
  const me = caller.agent ?? '';
  if (id === me || caller.boss || org.chiefOfStaff()?.id === me || isAssistant(me)) return;
  const found = await findAgentPeer(id).catch(() => undefined);
  if (!found) throw refuse();
  const r = await peerCall(found.peer, 'GET', `/api/agents/${encodeURIComponent(id)}/inbox?limit=0`, undefined, 8000, false, viaOf(caller)).catch(() => undefined);
  if (r?.status !== 200) throw refuse();
}

// The test key stands in for serve only in a test home (S-634, src/test-env.ts): STAM_HOME must hold the
// `.stam-test-home` marker with test/lib.sh's `owner` file beside it. Every other home, the live one
// included, ignores it, so a key left in the live daemon's environment proves nothing.
const trustedMemo = new WeakMap<IncomingMessage, boolean>();
function trustedHuman(req: IncomingMessage, owner: string | undefined): boolean {
  let v = trustedMemo.get(req);
  if (v === undefined) trustedMemo.set(req, (v = trustedHumanCheck(req, owner)));
  return v;
}
function trustedHumanCheck(req: IncomingMessage, owner: string | undefined): boolean {
  return untrustedWhy(req, owner) === undefined;
}
// Why a request is not trustedHuman, or undefined when it is: the first check that fails, with no secret in it.
function untrustedWhy(req: IncomingMessage, owner: string | undefined): string | undefined {
  const key = testOnlyEnv('STAM_TEST_HUMAN_KEY');
  if (key && req.headers['x-stam-test-human'] === key) return undefined;
  // A local human session (S-613): only with auth.localHuman on, and only on a direct loopback connection.
  if (!settings().auth.localHuman) localHuman.endAll();
  else if (localDirect(req) && localHuman.sessionLive(localHuman.sessionToken(req.method, req.url, req.headers.authorization))) return undefined;
  const login = req.headers['tailscale-user-login'];
  if (!owner) return 'no owner configured';
  if (login === undefined) return 'login: no tailscale-user-login header';
  if (login !== owner) return 'login: tailscale-user-login is not the owner';
  const remote = req.socket.remoteAddress ?? '';
  if (!LOOPBACK.includes(remote)) return `loopback: connection from ${remote}, not loopback`;
  const uid = socketUid(req);
  if (uid !== 0) return `socket uid: ${uid ?? 'unknown'}, not root (tailscaled)`;
  const client = String(req.headers['x-forwarded-for'] ?? '').split(',').pop()?.trim() ?? '';
  if (!client) return 'client IP: no x-forwarded-for';
  const ips = agentMachineIps();
  if (ips.size === 0) return 'client IP: the agent machine IPs are not known yet';
  if (ips.has(client)) return `client IP: ${client} is an agent machine`;
  if (client.startsWith('127.') || client === '::1') return `client IP: ${client} is loopback`;
  return undefined;
}
// A token-less request from a browser that was refused (S-426): invisible otherwise. Logged once a minute per reason.
function logDirectRefused(req: IncomingMessage, owner: string | undefined, reason?: string): void {
  const why = reason ?? untrustedWhy(req, owner) ?? 'trusted';
  const key = `direct refused ${req.method} ${why.split(':')[0]}`;
  const now = Date.now();
  if (now - (wouldRefuseLogged.get(key) ?? 0) < 60_000) return;
  wouldRefuseLogged.set(key, now);
  console.log(`direct request refused: ${req.method} ${(req.url ?? '').replace(/\?.*/, '').replace(/\/(permissions|agents)\/[^/]+/, '/$1/:id')} origin=${req.headers.origin ?? '-'}: ${why}`);
}

// A connection from a browser on this machine (S-613): loopback, not through tailscale serve (a root-owned
// socket), and not a peer's relay. A session token is never accepted from a peer or relayed. Any local process
// holding a live token passes, agents included once they've read it from the browser's profile: that is the
// residual risk S-613 accepts, not something this check stops.
function localDirect(req: IncomingMessage): boolean {
  if (!LOOPBACK.includes(req.socket.remoteAddress ?? '') || req.headers['x-stam-local'] !== undefined || req.headers['x-stam-agent'] !== undefined) return false;
  const uid = socketUid(req);
  return uid !== undefined && uid !== 0;
}

// How the human proves themselves, for a refusal: tailscale serve, and local login when it is on (S-613).
function humanWays(on = "stam's Tailscale address"): string {
  return `through ${on} (tailscale serve)${settings().auth.localHuman ? ` or stam's login page at http://127.0.0.1:${PORT}/` : ''}`;
}

// auth.humanStrict (S-543). auth.legacyPeerToken no longer gates it: the shared token never passes as a peer (S-1064).
function strictOn(): boolean {
  return settings().auth.humanStrict;
}
// A refusal that only strict makes (S-543). Whether or not strict is on, it is logged once a minute per
// `what`; it returns true, to refuse, only with strict in effect.
function strictRefuses(what: string, cond: boolean): boolean {
  if (!cond) return false;
  const now = Date.now();
  if (now - (wouldRefuseLogged.get(what) ?? 0) >= 60_000) {
    wouldRefuseLogged.set(what, now);
    console.log(`auth.humanStrict ${strictOn() ? 'refuses' : 'would refuse'}: ${what}`);
  }
  return strictOn();
}
const wouldRefuseLogged = new Map<string, number>();
// A request from a peer's own daemon, acting for itself: the peer token (or, while allowed, the shared token
// with x-stam-local) and no agent named. A forwarded agent (x-stam-agent) is an agent, and the OpenCode server
// is never a peer, so neither gets a peer's exemption from strict (S-543, S-544).
const peerOwn = (local: boolean, caller: Caller): boolean => local && caller.kind === 'shared';
// A write with no `by` that is neither the human's nor a peer's own.
const unattributed = (human: boolean, local: boolean, caller: Caller): boolean => !human && !peerOwn(local, caller) && caller.kind !== 'agent';
function logWouldRefuse(req: IncomingMessage, pathname: string, kind: string): void {
  const pattern = pathname.replace(/\/[0-9a-f]{6,}(?=\/|$)|\/S-\d+/g, '/:id');
  const key = `${req.method} ${pattern}`;
  const now = Date.now();
  if (now - (wouldRefuseLogged.get(key) ?? 0) < 60_000) return;
  wouldRefuseLogged.set(key, now);
  console.log(`auth.humanStrict ${strictOn() ? 'refuses' : 'would refuse'}: ${key} as human from a ${kind} caller (not trustedHuman)`);
}

// A peer's 409 naming a machine and origin is the peer's own refusal; only this daemon names an origin (S-544),
// so a peer can't send the page somewhere else. Other bodies pass as they are.
function ownRefusal(status: number, data: any): any {
  if (status !== 409 || !data || typeof data !== 'object' || data.refusal !== 'human-on-machine') return data;
  const { refusal: _r, machine: _m, origin: _o, ...rest } = data;
  return rest;
}

// Whether a relay to a peer carries `human` (S-544). The human is only trustedHuman on the daemon the
// browser reaches, so under auth.humanStrict no relay carries it: a human write is answered 409 naming
// the machine and its serve origin (for the web to send there directly), and a human read goes on as
// an ordinary local call. Off, the relay carries it as before and the daemon logs it.
// `acts` is false when the call names an agent (`by`): it is that agent's, not the human's.
function relayHuman(peer: Peer, human: boolean, write: boolean, what: string, acts = true): boolean {
  if (!human) return false;
  if (!strictOn()) {
    if (acts) logRelay(peer.name, what);
    return true;
  }
  if (write && acts) throw new HttpError(409, `${what} on ${peer.name} is the human's; do it from stam's web UI on ${peer.name}`, { refusal: 'human-on-machine', machine: peer.name, origin: peerServeOrigin(peer.url) });
  return false;
}
function logRelay(peer: string, what: string): void {
  const key = `relay ${peer} ${what}`;
  const now = Date.now();
  if (now - (wouldRefuseLogged.get(key) ?? 0) < 60_000) return;
  wouldRefuseLogged.set(key, now);
  console.log(`auth.humanStrict would refuse: relaying ${what} to ${peer} as the human`);
}

// One janitor pass: sweep test leftovers whose owner is gone and log what it did. Runs on
// the daemon's interval and on POST /api/janitor, which `stam janitor` and the test use.
// Sweeps run one at a time: a sweep that comes in while another runs waits for it, so two never
// stop the same server or log the same leftovers twice. Each keeps its own dry-run and folders.
let janitorQueue: Promise<unknown> = Promise.resolve();
function janitorSweep(dryRun = false, only?: string[]) {
  const sweep = async () => {
    const agents = db.listAgents();
    const activeAgents = new Set(agents.filter((a) => a.lifecycle === 'active').map((a) => a.id));
    const knownAgents = new Set(agents.map((a) => a.id));
    const r = await janitor.sweep({ dryRun, only, activeAgents, knownAgents });
    if (r.actions.length && !dryRun) {
      console.log(`janitor: cleaned ${r.actions.length} leftover(s)`);
      db.addEvent('human', 'janitor', { actions: r.actions });
    }
    // Orphaned test helpers (S-907): the dirs of agents that are still active are kept.
    const liveDirs = agents.filter((a) => a.lifecycle === 'active').map((a) => a.cwd).filter(Boolean);
    const orphans = orphanSweepAllowed(only, testHome(STAM_HOME)) ? await sweepOrphanProcs(liveDirs, dryRun).catch(() => []) : [];
    if (orphans.length && !dryRun) {
      console.log(`janitor: stopped ${orphans.length} orphaned test helper(s)`);
      db.addEvent('human', 'janitor', { orphan_procs: orphans });
    }
    const leaked = orphanSweepAllowed(only, testHome(STAM_HOME)) ? await sweepOrphanDaemons(dryRun).catch(() => []) : [];
    if (leaked.length && !dryRun) {
      console.log(`janitor: stopped ${leaked.length} leaked test daemon(s): ${leaked.map((l) => l.pid).join(' ')}`);
      db.addEvent('human', 'janitor', { orphan_daemons: leaked });
    }
    return { ...r, orphans: [...orphans, ...leaked] };
  };
  const run = janitorQueue.then(sweep);
  janitorQueue = run.catch(() => {});
  return run;
}

// The web UI's one canonical origin, for an MCP OAuth redirect. It is never taken from the
// request (Origin, Host, and x-forwarded-proto are all forgeable): STAM_WEB_ORIGIN names it
// for tests, `tailscale serve` gives the tailnet url, and 127.0.0.1 is the last resort.
// Discovery runs in the background (discoverWebOrigin), so a request only reads its last result.
let webBase: string | undefined;
let webServed = false;
let webDiscovering: Promise<void> | undefined;
const WEB_RETRY_MS = Number(process.env.STAM_WEB_RETRY_MS) || 60_000;
const execFileAsync = promisify(execFile);
// Asks for the canonical origin and stores the answer. Runs once at boot and again every WEB_RETRY_MS
// until a serve is found; a run that is still going is joined, never started twice.
function discoverWebOrigin(): Promise<void> {
  webDiscovering ??= (async () => {
    const env = process.env.STAM_WEB_ORIGIN;
    if (env && /^https?:\/\/[^/]+$/.test(env)) {
      webServed = true;
      webBase = trimSlash(env);
      return;
    }
    let found = '';
    try {
      const { stdout } = await execFileAsync('tailscale', ['serve', 'status', '--json'], { encoding: 'utf8', timeout: 3000 });
      const s = JSON.parse(stdout);
      for (const h of Object.keys(s.Web ?? {}))
        if (JSON.stringify(s.Web[h]).includes(`127.0.0.1:${PORT}`)) {
          found = `https://${h.replace(/:443$/, '')}`;
          break;
        }
    } catch {}
    webServed = Boolean(found);
    webBase = found || `http://127.0.0.1:${PORT}`;
  })().finally(() => {
    webDiscovering = undefined;
  });
  return webDiscovering;
}
// The canonical origin as the last discovery left it. A pure read: it never spawns tailscale, so a slow
// or missing tailscale can't hold up a request. Before the first discovery it is the 127.0.0.1 fallback.
function canonicalWebOrigin(): string {
  return webBase ?? `http://127.0.0.1:${PORT}`;
}
// The web origin a peer's UI can reach this daemon at (S-414): the canonical one, unless that is only
// the 127.0.0.1 fallback, which means nothing on another machine.
function publishedWebOrigin(): string | undefined {
  const o = canonicalWebOrigin();
  return webServed ? o : undefined;
}
// The requests a peer's UI sent here (S-414), for routes that treat them as shared-only.
const peerUiRequests = new WeakSet<IncomingMessage>();
// The origins of the configured peers' UIs (src/web-origins.ts), which may write shared settings here.
const peerOrigins = () => peerUiOrigins(peers().map((p) => p.url));
// The hosts this daemon's own page is served at: the canonical origin's, and its port on loopback and
// on each address it binds. A browser can't forge Host or Origin, but DNS rebinding can point any name
// here, so a token-less request must name one of these (S-414 review).
// Only the loopback and bound hosts are kept: the canonical one is read from the last background
// discovery, so a `tailscale serve` found after boot (discoverWebOrigin retries while it has none) is
// let in without a restart, and a failed discovery never refuses the human's page for good.
let bindHosts: Set<string> | undefined;
function ownHosts(): Set<string> {
  bindHosts ??= new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`, ...bindAddresses().map((a) => `${a}:${PORT}`)]);
  const hosts = new Set(bindHosts);
  try {
    hosts.add(new URL(canonicalWebOrigin()).host.toLowerCase());
  } catch {}
  return hosts;
}
const ownHost = (req: IncomingMessage) => ownHosts().has(String(req.headers.host ?? '').toLowerCase());
// Whether a browser's Origin is this daemon's own page: the canonical origin, or one of its own hosts.
function sameOrigin(_req: IncomingMessage, origin: string): boolean {
  if (origin === canonicalWebOrigin().toLowerCase()) return true;
  try {
    return ownHosts().has(new URL(origin).host);
  } catch {
    return false;
  }
}

const trimSlash = (u: string) => u.replace(/\/+$/, '');

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
function sendHtml(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>mootr</title><p>${escapeHtml(text)}</p>\n`);
}

// Layout routes: a stale base or a non-empty replace is a 409 carrying the current layout; an
// invalid op is a 400 and changes nothing.
function layoutRoute(res: ServerResponse, change: () => unknown): typeof HANDLED {
  try {
    return change() as any;
  } catch (e) {
    if (e instanceof layout.LayoutConflict) {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message, layout: e.layout }));
      return HANDLED;
    }
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
}

export async function runDaemon(): Promise<void> {
  // Before anything touches the home (S-346): a second daemon on it would boot against the live state.
  const holder = await takeDaemonLock(STAM_HOME);
  if (holder !== undefined) {
    console.error(`another stam daemon${holder ? ` (pid ${holder})` : ''} runs on ${STAM_HOME}; exiting`);
    process.exit(1);
  }
  const token = ensureToken();
  const peerToken = ensurePeerToken();
  // A terminal socket's ?token= (S-543): a peer's terminal relay sends the peer token. The shared token opens one
  // too, except with auth.humanStrict in effect.
  // Under strict neither token opens a terminal socket: a peer's terminal is never relayed with the peer token (S-544), so only the human's proof does (S-638).
  const tokenAuth = (t: string | null): boolean => (t === peerToken && !strictRefuses('terminal socket opened with the peer token', true)) || (t === token && !strictOn());
  const tokenOk = (t: string | null): boolean => (t === token && strictRefuses('terminal socket opened with ?token=', true), tokenAuth(t));
  const owner = tailscaleOwner();
  // Routes that reach the human's devices accept only the human as trustedHuman proves it.
  const humanOnly = (req: IncomingMessage, what: string) => {
    if (!trustedHuman(req, owner)) throw new HttpError(403, `only the human can ${what}, ${humanWays()}`);
  };
  // Local human login and logout (S-613), before any credential check: the page has none yet. A code works
  // only from stam's own page on this machine (loopback, own host, same origin, JSON), so a page on another
  // port or site can't spend one. The page posts its secret; root vouched for the secret's name. Every
  // login and refusal is logged.
  const localHumanRoute = async (req: IncomingMessage, path: string): Promise<unknown> => {
    const on = settings().auth.localHuman;
    // The folder the page names in its command (the daemon's user's), so the page needs no other lookup.
    if (req.method === 'GET' && path === '/api/human/login') return on ? { enabled: true, dir: localHuman.userDir() } : { enabled: false };
    if (req.method !== 'POST') throw new HttpError(405, `no route ${req.method} ${path}`);
    if (!on) throw new HttpError(404, 'local human login is off (settings auth.localHuman)');
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin.toLowerCase() : '';
    const site = req.headers['sec-fetch-site'];
    const refuse = (why: string) => {
      console.warn(`local human ${path.endsWith('login') ? 'login' : 'logout'} refused: ${why}`);
      return new HttpError(403, why);
    };
    if (!localDirect(req)) throw refuse(`log in from a browser on this machine, at http://127.0.0.1:${PORT}/`);
    if (!ownHost(req) || !origin || !sameOrigin(req, origin) || (site !== undefined && site !== 'same-origin')) throw refuse("log in from stam's own page");
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'the request must be JSON');
    if (path === '/api/human/logout') return { ended: localHuman.endSession(localHuman.sessionToken(req.method, req.url, req.headers.authorization)) };
    const body = await readJson(req);
    const why = localHuman.redeemCode(body && typeof body === 'object' ? (body as { secret?: unknown }).secret : undefined);
    if (why) throw refuse(why);
    console.log('local human login: a session started');
    return localHuman.startSession();
  };
  // The chief of staff's or the assistant's write of the settings becomes an ask to the human (S-362);
  // any other caller is refused as before.
  const mayAskSettings = (caller: Caller): db.Agent => {
    const me = caller.kind === 'agent' ? db.getAgent(caller.agent ?? '') : undefined;
    if (!me || !(org.chiefOfStaff()?.id === me.id || isAssistant(me.id)))
      throw new HttpError(403, `only the human can change stam's settings, ${humanWays()}. The chief of staff and the assistant can ask instead: the MCP tool settings_ask (PATCH /api/config/settings {patch}) sends the human an approval that applies the patch itself; any other agent asks its chief of staff`);
    return me;
  };
  const askSettingsChange = async (res: ServerResponse, caller: Caller, change: permissions.SettingsChange) => {
    const me = mayAskSettings(caller);
    if (change.kind !== 'patch' && change.text.length > 256 * 1024) throw new HttpError(400, 'the settings text is over 256 KB');
    const r = await permissions.requestSettingsChange(me, change);
    if ('error' in r) throw new HttpError(400, r.error);
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ requested: r.request.id }));
    return HANDLED;
  };
  // A settings change on a non-home daemon (S-398) may change only its local keys: shared settings
  // are edited on the home alone. One that touches a shared key is a 409 naming the home, and nothing
  // of it is written, so a mixed change is all or nothing. Returns the local part to write.
  const peerLocalOnly = (patch: Record<string, unknown>, fill = false): Record<string, any> => {
    const { local, shared } = splitSettingsPatch(patch, fill);
    const keys = Object.keys(shared);
    if (keys.length) {
      const home = settings().home;
      throw new HttpError(409, `shared settings live on ${home}; change them there (${keys.join(', ')})`, { home, shared: keys });
    }
    return local;
  };
  // The registry, agent types, and instructions for all agents live on the settings home too (S-387):
  // a non-home daemon refuses to change them, with a 409 naming the home, and writes nothing.
  const homeOnly = (what: string): void => {
    if (isSettingsHome()) return;
    const home = settings().home;
    throw new HttpError(409, `${what} live on ${home}; change them there`, { home });
  };
  const unredacted = (change: permissions.SettingsChange): Record<string, unknown> => {
    try {
      return permissions.unredactedChange(change, effectiveSettingsText());
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : String(e));
    }
  };
  // Who a request is from (S-237). A Bearer token that is an agent's own names that agent; the
  // shared token is the human's and the CLI's, as before. `none` is a request with no credential.
  const callerOf = (req: IncomingMessage): Caller => {
    const auth = req.headers.authorization ?? '';
    if (auth === `Bearer ${peerToken}`) return { kind: 'peer' };
    if (auth === `Bearer ${token}`) return { kind: 'shared' };
    const agent = auth.startsWith('Bearer ') ? db.agentByTokenHash(hashToken(auth.slice(7)))?.id : undefined;
    if (agent) return { kind: 'agent', agent };
    if (auth.startsWith('Bearer ') && serverTokenHash() === hashToken(auth.slice(7))) return { kind: 'opencode' };
    // trustedHuman covers tailscale serve and the test key (S-414); a bare tailscale-user-login header proves nothing (S-541).
    return { kind: trustedHuman(req, owner) ? 'owner' : 'none' };
  };
  db.open();
  // The system view's stream (S-456): `agent.changed` is coalesced in events.ts and flushed
  // on a timer, so the current state, cost, and unread count are read here, once per flush.
  events.setAgentSnapshot((id) => {
    const a = db.getAgent(id);
    if (!a) return undefined;
    return { state: a.lifecycle, activity: a.activity, context_tokens: a.context_tokens, cost_usd: db.agentCost(id), unread: db.unreadCount(id) };
  });
  startStallWatch(settings().debug.stallMs);
  tmuxServer = tmux.serverId();
  for (const a of Object.values(adapters)) a.start?.().catch((e) => console.error(`${a.name} adapter failed to start: ${e.message}`));
  ensureSettings();
  // Rebuild waits stam derives from its own data before observers are installed, so a
  // restart neither loses nor leaves stale ones and no notice fires for rebuilding.
  timed('rebuild waits', org.rebuildWaits);
  org.watchActivity();
  itsaOwners.watchOwnerStops();
  steps.watch();
  reqCheck.watch();
  reqApproval.watch();
  // ITSAs linked to a GitHub PR or issue (or a Linear issue) hear about it in their thread:
  // register the reconciliation, then give links that predate it theirs (src/watch.ts).
  watch.watchItsa();
  watch.syncItsaSubscriptions();
  itsaHuman.watchHumanStatuses();
  // The human's threads that someone else resolved are archived for them (S-637): every 10 minutes,
  // and soon after an ITSA closes, a request settles, or mail to or from the human moves.
  const autoArch = autoArchive.start(autoArchiveSources());
  // Automatic notices whose answer is settled count as read (S-717): every ten minutes, and soon
  // after an ITSA closes, so an agent's unread count means "waiting for you".
  const noticesSweep = notices.start();
  itsa.onChange((c) => {
    if (c.type === 'status' && itsa.isClosedStatus(c.itsa.status)) {
      autoArch.nudge();
      noticesSweep.nudge();
    }
  });
  db.onAgentMail((agents) => {
    if (agents.includes(mail.HUMAN)) autoArch.nudge();
    // A relay just arrived (or a watch ended): settle its read state soon.
    noticesSweep.nudge();
  });
  db.onRequestSettled(() => autoArch.nudge());
  // The retro loop (S-206): a steward after each digest, the approval gate on proposals, and the
  // answered retro items closed with them. See src/retro-loop.ts.
  retroLoop.watchProposals();
  processProposal.watchProcessProposals();
  // A `stage` move (S-924) the process edges don't allow is refused, as a proposal the human hasn't approved is.
  itsa.guardChange(stageGuard(() => processesHere().processes), { fields: true });
  // Closing an ITSA sets its stage to its process's end node (S-1398), and the ITSAs closed before that are fixed once.
  const closeNodeOfKind = (kind: string | null): string | null => {
    try {
      const p = processesHere().processes.find((q) => q.appliesTo?.kind?.includes(kind ?? ''));
      return p ? closeNodeOf(p) : null;
    } catch {
      return null;
    }
  };
  itsa.setCloseStage(closeNodeOfKind);
  // ITSAs live on the home daemon only (other daemons proxy there and keep no copy), so only the home fixes them and records it.
  if (!settings().itsa.home || settings().itsa.home === MACHINE) {
    try {
      const fixed = itsa.backfillClosedStage(closeNodeOfKind, processesHere().processes.flatMap((p) => p.appliesTo?.kind ?? []));
      if (fixed !== null) console.error(`closed-stage-done migration: set stage done on ${fixed} closed ITSA(s)`);
    } catch (e) {
      console.error(`closed-stage-done migration failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  // An ITSA changes on its home daemon only.
  const runMode = () => (settings().itsa.home === MACHINE || !settings().itsa.home ? settings().process.run : 'off');
  // settings.itsa.prOpen.github, else the prOpen checkout's origin; '' matches no PR when neither is set.
  const prRepo = () => defaultGithubRepo() ?? '';
  // Entering a script, human or end node (S-946): a record and a log line per entry. With process.run `on`, a script node
  // runs (S-949, merge-pr.mjs): detached from the daemon, its output in STAM_HOME/process-run/, only on the ITSA home where gh is.
  const runScript = scriptRunner({
    checkout: deployCheckout,
    host: () => (settings().itsa.home || MACHINE) === MACHINE,
    spawn: (script, args, checkout) => runDetached({ node: process.execPath, script, args, cwd: checkout, logDir: join(STAM_HOME, 'process-run') }),
    ownerOf: (id) => itsa.find(id)?.owner ?? null,
    setStage: (id, stage) => itsa.set(id, { fields: { stage } }, RUNNER_ACTOR),
    mailOwner: (owner, subject, body) => mail.sendFromStam([owner], subject, body),
    log: (line) => console.error(line),
  });
  // Agent nodes (S-1038): a spawn through the daemon's own path, or a mail to the standing lane's agent.
  const agentRun = agentRunner({
    spawn: async (i) => {
      const body = { type: i.type, itsa: i.itsa, prompt: i.prompt, parent: i.parent ?? undefined };
      if (!i.machine || i.machine === MACHINE) return (await spawnAgent(body)).name;
      // Another machine: the relay a spawn there takes, as the parent the process named.
      return spawnOnMachine({ peerOf: peerByName, agentId: (ref) => db.getAgent(ref)?.id, viaFor, spawnOnPeer }, i.machine, body);
    },
    mail: (to, subject, body) => mail.sendFromStam([to], subject, body),
    nameOf: (agent) => db.getAgent(agent)?.name ?? agent,
    working: async (machine) => {
      const isWorking = (a: { lifecycle: string; activity: string }) => a.lifecycle === 'active' && a.activity === 'working';
      if (!machine || machine === MACHINE) return db.listAgents().filter((a) => a.machine === MACHINE && isWorking(a)).length;
      // A peer's own agents, from its list; unreadable is a refusal.
      const peer = peerByName(machine);
      if (!peer) throw new Error(`no peer machine ${machine}`);
      const r = await peerCall(peer, 'GET', '/api/agents', undefined, 8000, false);
      if (r.status >= 300 || !Array.isArray(r.data)) throw new Error(`${peer.name} gave no agent list (${r.status})`);
      return r.data.filter((a: any) => a.machine === peer.name && isWorking(a)).length;
    },
    maxSpawnsPerHour: () => settings().process.maxSpawnsPerHour,
    spawnsLastHour: () => (db.open().prepare("SELECT COUNT(*) AS n FROM itsa_events WHERE type = 'process-spawn' AND ts > ?").get(new Date(Date.now() - 3_600_000).toISOString()) as { n: number }).n,
    entryOf: (id) => String((db.open().prepare("SELECT MAX(id) AS n FROM itsa_events WHERE itsa_id = ? AND type = 'fields'").get(itsa.find(id)?.id ?? id) as { n: number | null }).n ?? 0),
    claimed: (id, node, entry) =>
      !!db.open().prepare("SELECT 1 FROM itsa_events WHERE itsa_id = ? AND type IN ('process-spawn', 'process-mail') AND json_extract(data, '$.node') = ? AND json_extract(data, '$.entry') = ?").get(itsa.find(id)?.id ?? id, node, entry),
    claim: (id, kind, node, entry, text) => itsa.addEvent(id, null, kind === 'spawn' ? 'process-spawn' : 'process-mail', { node, entry, text }),
    note: (id, text) => itsa.addEvent(id, null, 'process-run', { text }),
    log: (line) => console.error(line),
  });
  const onStage = stageEntryListener({
    mode: runMode,
    processesOf: () => processesHere().processes,
    linksOf: (id) => itsa.links(id),
    repo: prRepo,
    agentOf: (id) => {
      const x = itsa.find(id);
      if (!x) return undefined;
      const live = (ref: string | null | undefined) => {
        const a = ref ? db.getAgent(ref) : undefined;
        return a !== undefined && db.isLive(a) ? a : undefined;
      };
      const cos = org.chiefOfStaff();
      return {
        id: x.id,
        key: x.key,
        ownerLive: !!live(x.owner),
        parentOwner: (x.parent_id ? itsa.find(x.parent_id)?.owner : null) ?? null,
        cos: cos?.id ?? null,
        // A live reviewer on this ITSA or its parent ITSA (a reviewer of the parent covers its children).
        reviewerLive: [...itsa.participants(x.id), ...(x.parent_id ? itsa.participants(x.parent_id) : [])].some((p) => (() => { const a = live(p); return !!a && costFallback.isReviewer(a); })()),
        typeKnown: (t) => t in agentTypes(),
        isReviewerType: (t) => !!agentTypes()[t]?.review,
      };
    },
    record: (id, text) => itsa.addEvent(id, null, 'process-run', { text }),
    run: runScript,
    agent: agentRun,
    ask: humanAsker({
      statusOf: (id) => itsa.find(id)?.status ?? null,
      isHumanStatus: (status) => !!itsa.statusOf(status)?.human,
      mayAsk: async (actor) => !actor || itsa.isSystem(actor) || actor === mail.HUMAN || !(await mail.humanMailBlock(actor)),
      latestComment: (id) => {
        const x = itsa.find(id);
        const m = x?.thread_id ? db.threadMail(x.thread_id).findLast((k) => (k.kind === 'comment' || k.kind === 'update') && !k.from_id.startsWith('system:')) : undefined;
        return m?.body ?? null;
      },
      post: (id, body) => itsa.post(id, { by: RUNNER_ACTOR, body, agents_only: true }),
      setStatus: (id, status) => itsa.set(id, { status }, RUNNER_ACTOR),
      log: (line) => console.error(line),
    }),
    log: (line) => console.error(line),
  });
  // The human's answer moves the stage out of a human node (S-950).
  const onAnswer = answerListener({
    mode: runMode,
    processesOf: () => processesHere().processes,
    stageOf: (id) => {
      const stage = itsa.get(id).fields?.stage;
      return typeof stage === 'string' ? stage : null;
    },
    isHumanStatus: (status) => !!itsa.statusOf(status)?.human,
    record: (id, text) => itsa.addEvent(id, null, 'process-run', { text }),
    moveStage: (id, stage) => itsa.set(id, { fields: { stage } }, RUNNER_ACTOR),
    log: (line) => console.error(line),
    human: mail.HUMAN,
  });
  itsa.onChange((c) => {
    if (c.type === 'status') onAnswer({ itsa: { id: c.itsa.id, kind: c.itsa.kind }, actor: c.actor, from: c.from, to: c.to });
  });
  // Start nodes (S-947): each stored-event trigger is an event subscription made by stam, reconciled here
  // and whenever the process files change; a matching event goes through process.run.
  // Evidence (S-948): a `stam/review` verdict on a PR's current head evaluates the verdict gateway.
  const onStart = startListener({
    mode: runMode,
    processesOf: () => processesHere().processes,
    cos: () => org.chiefOfStaff()?.id ?? null,
    create: (input) => itsa.create(input),
    log: (line) => console.error(line),
  });
  const onVerdict = verdictListener({
    mode: runMode,
    processesOf: () => processesHere().processes,
    itsasOfPr: (n) =>
      itsa.openItsasByLink('github', `https://github.com/${prRepo()}/pull/${n}`).map((x) => {
        const stage = itsa.get(x.id).fields?.stage;
        return { id: x.id, kind: x.kind, stage: typeof stage === 'string' ? stage : null };
      }),
    record: (id, text) => itsa.addEvent(id, null, 'process-run', { text }),
    moveStage: (id, stage) => itsa.set(id, { fields: { stage } }, RUNNER_ACTOR),
    log: (line) => console.error(line),
  });
  watch.onProcessStart((subscriberId, ev) => dispatchProcessEvent(processesHere().processes, subscriberId, ev, { start: onStart, verdict: onVerdict }));
  // Compared with the rows in the database each time, so one a person removed comes back.
  const syncStarts = () => {
    try {
      const { processes } = processesHere();
      watch.syncProcessSubscriptions([...startTriggers(processes), ...verdictTriggers(processes, prRepo())]);
    } catch (e) {
      console.error(`process-run: start subscriptions: ${e instanceof Error ? e.message : e}`);
    }
  };
  syncStarts();
  setInterval(syncStarts, 30_000).unref();
  itsa.onChange((c) => {
    if (c.type === 'fields' && 'stage' in c.to) onStage({ itsa: { id: c.itsa.id, kind: c.itsa.kind }, from: c.from.stage, to: c.to.stage, actor: c.actor });
  });
  retroDigest.onDigest((label, text) => {
    retroLoop
      .afterDigest(label, text, (body) => spawnAgent(body))
      .then((r) => r.spawned || console.error(`retro loop: no steward: ${r.reason}`))
      .catch((e) => console.error(`retro loop: ${e instanceof Error ? e.message : e}`));
  });
  org.recoverTreeIdle();
  recoverImports();
  timed('reconcile', reconcile);
  // A deploy that changed stam's MCP tools: running agents hear of it and reload (S-178).
  announceToolChanges().catch((e) => console.error(`mcp tools: ${e instanceof Error ? e.message : e}`));
  setInterval(() => void reconcileTick().catch((e) => console.error(`reconcile: ${e instanceof Error ? e.message : e}`)), 5000);
  // A freed slot goes to the head of the developer slot queue (S-2053).
  restoreSlotQueue();
  setInterval(pumpSlotQueue, 2000);
  // Suggested input past its expiry, and held approvals to type (S-422).
  if (ignoredTestOnlyEnv('STAM_TEST_HUMAN_KEY')) console.warn('STAM_TEST_HUMAN_KEY is set outside a test home and is ignored: only tailscale serve proves the human here');
  setInterval(() => void permissions.retryHeldInputs().catch((e) => console.error(`suggested input: ${e instanceof Error ? e.message : e}`)), 5000);
  // Harness dialogs nobody answered in time go to the human (S-589).
  setInterval(() => void permissions.escalateStaleDialogs().catch((e) => console.error(`dialog timeout: ${e instanceof Error ? e.message : e}`)), 5000);
  // The model classifier for activity items the rules leave NULL (S-214); off unless settings say so.
  activityClassify.startClassifier();
  // The activity summary's digests (S-1009), built in slices after the start-up ingest has begun.
  setTimeout(() => void activitySummaryMod.warmSummary(), 30_000).unref();
  setInterval(() => void bannersTick().catch(() => {}), 3000);
  setInterval(() => {
    try {
      timed('stale working', reconcileStaleWorking);
    } catch {}
  }, 10_000);
  setInterval(() => timed('context idle sweep', context.idleSweep), 60_000);
  lifecycle.startRestWaking();
  setInterval(() => timed('standing rest sweep', lifecycle.restSweep), 60_000);
  setInterval(() => timed('standing growth sweep', () => void growthSweep().catch((e) => console.error('standing growth sweep:', e))), 60_000);
  // On the ITSA home: GitHub PR heads follow storage's branches (S-667). A config that
  // prOpenConfig refuses (a fresh install with no repo) skips the tick, logged once per
  // message, and never throws out of the timer, which would kill the daemon (S-2140).
  let prSyncConfigError = '';
  setInterval(() => {
    if ((settings().itsa.home ?? MACHINE) !== MACHINE) return;
    let cfg: ReturnType<typeof prOpen.prOpenConfig>;
    try {
      cfg = prOpen.prOpenConfig();
      prSyncConfigError = '';
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== prSyncConfigError) console.error(`pr-sync: skipped: ${msg}`);
      prSyncConfigError = msg;
      return;
    }
    prSync.syncTick(cfg)?.catch((e) => console.error(`pr-sync: ${e instanceof Error ? e.message : e}`));
  }, 60_000);
  // Declared-wait timeouts and wake_me timers, fired from `until`. Its first tick also
  // catches up on what came due while the daemon was down (once, not per missed tick).
  waits.startScheduler();
  // What agents did while the daemon was down, into the activity timeline (S-210).
  activity.ingestAllSoon();
  // Test leftovers (throwaway daemons, tmux servers, systemd units) whose owner is gone,
  // swept every ten minutes; see janitor.ts. It never touches the live daemon or a test
  // whose script is still running.
  const janitorTick = () => janitorSweep().catch((e) => console.error(`janitor: ${e instanceof Error ? e.message : e}`));
  setInterval(() => timed('janitor', janitorTick), 10 * 60_000);
  // A peer's busy agents stay counted only while their flag is fresh (S-1652): every 2 minutes, list each reachable
  // peer's agents and remember them, which rewrites the flag of a busy one (so no open UI is needed), and tell the
  // parents of a flag that has just gone stale (an unreachable peer, or an agent gone). One run at a time (S-1351).
  let peerBusyRunning = false;
  const peerBusyTick = async () => {
    if (peerBusyRunning) return;
    peerBusyRunning = true;
    try {
      for (const a of await fanOut<db.Agent>('/api/agents')) if (a.machine !== MACHINE && a.id) db.rememberPeerAgent(a);
      for (const id of db.expiredPeerBusy()) org.peerBusyChanged(id);
    } catch (e) {
      console.error(`peer busy sweep: ${e instanceof Error ? e.message : e}`);
    } finally {
      peerBusyRunning = false;
    }
  };
  setInterval(() => timed('peer busy sweep', () => void peerBusyTick()), 2 * 60_000).unref();
  // The retro digest to the Retros owner, or the chief of staff (S-161, S-1059): checked every minute, sent daily (or weekly)
  // at settings.retro.digest. See src/retro-digest.ts.
  setInterval(() => {
    retroDigest.digestTick().catch((e) => console.error(`retro digest: ${e instanceof Error ? e.message : e}`));
  }, 60_000);
  // The periodic tree check timer (S-915) follows settings.treeCheck: reconciled at start and every 30 s.
  const treeCheckTick = () => { try { syncTreeCheck(); } catch (e) { console.error(`tree check: ${e instanceof Error ? e.message : e}`); } };
  treeCheckTick();
  setInterval(treeCheckTick, 30_000);
  // This machine's CPU, RAM, and swap, sampled every 5 s for the sidebar's meters.
  machines.startSampler();
  // Mail queued for a peer that didn't answer is redelivered (S-235).
  mail.startOutbox();
  credits.startCreditPolling();
  // The GitHub source (S-55): polls the subjects agents and ITSAs watch, every
  // settings.watch.githubSeconds. See src/sources/github.ts.
  githubSource.start();
  // The Linear source (S-56): polls through Linear's MCP server. See src/sources/linear.ts.
  linearSource.start();
  // The user's cost rules, once against the readings stored before this start.
  void rules.evaluateAll();
  // Budget blockers, from the ledger.
  void budgets.evaluateAll();
  // The peers' paid spend joins every budget (S-395); a change re-evaluates them.
  peerSpend.start(() => void budgets.evaluateAll());
  // Cost pauses: clear the ones whose time or window reset has passed, and reschedule timers.
  void costPause.evaluatePauses();
  // Error probes (and Claude's credits-out): probe every blocked account from the first step.
  costProbes.resumeAll();
  // Cost fallbacks: run the ones that came due while the daemon was down, and reschedule.
  void costFallback.reschedule();
  // STAM_HOME/busy is touched while any active agent here is starting, working, blocked, or
  // waiting (db.BUSY_ACTIVITIES), or resting with a wait (S-1982), so a machine that shuts itself
  // down when idle (such as storage) doesn't shut down under an agent waiting for a reply or a timer.
  setInterval(() => {
    if (db.listAgents().some(db.keepsMachineUp))
      writeFileSync(join(STAM_HOME, 'busy'), new Date().toISOString());
  }, 30_000);

  // `local` is true for requests from a peer daemon, which must not fan out again.
  // `human` is true for the web UI and the CLI outside an agent (x-stam-human). Agents run as
  // the same Unix user and could forge it; it keeps honest agents out, not hostile ones.
  type Handler = (m: RegExpMatchArray, body: any, url: URL, res: ServerResponse, local: boolean, human: boolean, req: IncomingMessage, caller: Caller) => unknown;
  const routes: [string, RegExp, Handler][] = [
    // `stalls` is the last event-loop stalls (src/stall.ts), for finding what blocked the loop.
    // `memory` is the daemon's heap and RSS (process.memoryUsage), to see what holds the memory.
    ['GET', /^\/api\/health$/, () => {
      const { heapUsed, heapTotal, rss, external } = process.memoryUsage();
      return { ok: true, machine: MACHINE, release: RELEASE, stalls: stalls.recent, memory: { heapUsed, heapTotal, rss, external } };
    }],
    // The deploy watcher's DB sample (S-474): one SELECT 1 and one cheap read of this daemon's own DB. Local only,
    // no peer fan-out, so its time is the DB's.
    ['GET', /^\/api\/health\/db$/, () => {
      db.open().prepare('SELECT 1 AS one').get();
      const agents = db.open().prepare('SELECT COUNT(*) AS n FROM agents').get() as { n: number };
      return { ok: true, machine: MACHINE, agents: agents.n };
    }],
    // This machine's CPU, RAM, and swap meters, plus each peer's; a peer that doesn't
    // answer comes back offline (src/machines.ts).
    // Each row carries `origin`, the serve origin the page may send that machine's human writes to (S-544). This
    // daemon computes it from its own peer list (peerServeOrigin, and its own web origin for itself); a peer's
    // own reading is never trusted for it.
    ['GET', /^\/api\/machines$/, async (_m, _b, _u, _r, local) => {
      const rows = (await machines.all(local)) as (machines.MachineReading & { origin?: string; terminalOrigin?: string })[];
      return rows.map(({ origin: _theirs, terminalOrigin: _theirTerm, ...r }) => {
        const peer = r.name === MACHINE ? undefined : peerByName(r.name);
        const origin = r.name === MACHINE ? publishedWebOrigin() : peer ? peerServeOrigin(peer.url) : undefined;
        // `terminalOrigin` is the same origin for terminals, set only when this daemon doesn't relay them.
        return origin ? { ...r, origin, ...(r.name !== MACHINE && strictOn() ? { terminalOrigin: origin } : {}) } : r;
      });
    }],
    // Starts a stopped peer (the start a spawn on it uses, ensureUp), so the Files world's Start button has
    // something to call (S-1526). A machine that is already up answers at once.
    [
      'POST',
      /^\/api\/machines\/([\w.-]+)\/start$/,
      async (m, _b, _u, _r, _l, _h, req) => {
        humanOnly(req, 'start a machine');
        const peer = peerByName(m[1]);
        if (!peer) throw new HttpError(404, `no machine ${m[1]}`);
        await ensureUp(peer).catch((e) => { throw new HttpError(503, e instanceof Error ? e.message : String(e)); });
        return { ok: true };
      },
    ],
    // Configuration the human can read and edit: templates, settings, and registry overrides.
    ['GET', /^\/api\/templates$/, () => listTemplates()],
    [
      'POST',
      /^\/api\/templates\/([\w-]+)$/,
      (m, body, _u, _r, _l, _h, req) => {
        humanOnly(req, "change stam's templates");
        if (body.reset) resetTemplate(m[1]);
        else saveTemplate(m[1], String(body.text ?? ''));
        return listTemplates().find((t) => t.name === m[1]);
      },
    ],
    // Agent types, written to the user's registry.json; see agent-types.ts.
    [
      'POST',
      /^\/api\/types\/([\w-]+)$/,
      (m, body, _u, _r, _l, _h, req) => {
        humanOnly(req, "change stam's agent types");
        homeOnly('agent types');
        let t: AgentType;
        try {
          t = saveType(m[1], body ?? {});
        } catch (e) {
          throw new HttpError(400, e instanceof Error ? e.message : String(e));
        }
        sharedFilesChanged();
        return t;
      },
    ],
    [
      'DELETE',
      /^\/api\/types\/([\w-]+)$/,
      (m, _b, _u, _r, _l, _h, req) => {
        humanOnly(req, "change stam's agent types");
        homeOnly('agent types');
        try {
          removeType(m[1]);
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e);
          throw new HttpError(why.startsWith('no agent type') ? 404 : 409, why);
        }
        sharedFilesChanged();
        return { removed: m[1] };
      },
    ],
    // The settings file holds peers' tokens and MCP credentials: an agent or the OpenCode server reads
    // it redacted (S-259). The shared token and the owner read it whole.
    [
      'GET',
      /^\/api\/config\/(settings|registry|instructions)$/,
      (m, _b, _u, _r, _l, _h, _q, caller) => {
        // The registry and instructions on a non-home daemon are the home's cached copy (S-387).
        if (m[1] !== 'settings') {
          const text = readConfigFile(m[1]);
          if (isSettingsHome()) return { text };
          const sync = syncState();
          return { text, home: sync.home, stale: sync.stale };
        }
        // A non-home daemon shows the settings it uses, the home's shared part with its own local keys
        // (S-398), and says which keys are local, which daemon is the home, and whether its copy may be behind.
        const peer = !isSettingsHome();
        const text = peer ? effectiveSettingsText() : readConfigFile(m[1]);
        const shown = caller.kind === 'agent' || caller.kind === 'opencode' ? redactSettingsText(text) : text;
        const sync = syncState();
        // The home sends the same fields (S-405) so the page can mark machine-local settings and say where shared ones live.
        // A peer adds the home's web origin, where its page sends shared writes (S-414).
        return { text: shown, local: LOCAL_KEYS, home: sync.home, stale: sync.stale, fetchedAt: sync.fetchedAt, ...(peer && sync.homeWeb ? { homeWeb: sync.homeWeb } : {}) };
      },
    ],
    // Settings › Skills (S-889): each skill with its description, an automatic summary of its body
    // (block-summaries; 'off' with no model, 'pending' while asked), size, source and reach per harness.
    // `attachedTo` lists the agent types that name the skill (S-891).
    ['GET', /^\/api\/skills$/, () => {
      const types = Object.entries(agentTypes());
      return skillInfos().map(({ body, ...s }) => ({ ...s, attachedTo: types.filter(([, t]) => Array.isArray(t.skills) && t.skills.includes(s.name)).map(([n]) => n), bodySummary: summaryFor(textHash(body), body, s.name) }));
    }],
    // Skill import (S-890). Only the human adds or replaces a skill; downloaded content is untrusted and
    // skill-import.ts runs nothing from it. `source` is a GitHub URL, OWNER/REPO or OWNER/REPO/path.
    // The update check asks the origin of every imported skill whether its folder moved.
    ['GET', /^\/api\/skills\/updates$/, async (_m, _b, _u, _r, _l, _h, req) => {
      humanOnly(req, 'check imported skills against their origin');
      const names = skillInfos().filter((s) => s.origin).map((s) => s.name);
      const opts = { allowFile: Boolean(testOnlyEnv('STAM_TEST_ALLOW_FILE_SKILLS')) };
      return Object.fromEntries(await Promise.all(names.map(async (n) => [n, await checkUpdate(n, opts)] as const)));
    }],
    ['POST', /^\/api\/skills\/(import|update)$/, async (m, body, _u, _r, _l, _h, req) => {
      humanOnly(req, 'import or update a skill');
      const opts = { allowFile: Boolean(testOnlyEnv('STAM_TEST_ALLOW_FILE_SKILLS')) };
      try {
        const out = m[1] === 'import' ? await importSkill(String(body.source ?? ''), opts) : await updateSkill(String(body.name ?? ''), opts);
        relinkSkills();
        console.log(`skill ${out.updated ? 'updated' : 'imported'}: ${out.name} at ${out.commit.slice(0, 7)}`);
        return out;
      } catch (e) {
        if (e instanceof ImportError) throw new HttpError(400, e.message);
        throw e;
      }
    }],
    // The MCP tools every agent talks to, grouped, for Settings › Tools and the
    // decision-steps UI (S-60). Read-only; the shape is documented in mcp.ts's toolCatalog.
    ['GET', /^\/api\/tools$/, () => toolCatalog({ requirements: requirements.enabled() })],
    [
      'POST',
      /^\/api\/config\/(settings|registry|instructions)$/,
      (m, body, _u, res, _l, _h, req, caller) => {
        // On a non-home daemon only local keys change, through the same guards (S-398).
        if (m[1] === 'settings' && !isSettingsHome()) {
          const human = trustedHuman(req, owner);
          if (!human) mayAskSettings(caller);
          const text = String(body.text ?? '');
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch (e) {
            throw new HttpError(400, `not valid JSON: ${e instanceof Error ? e.message : e}`);
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'the settings must be a JSON object');
          if (!human) {
            // An agent's text holds the redacted values its GET showed: they count as unchanged.
            peerLocalOnly(unredacted({ kind: 'post', text }));
            return askSettingsChange(res, caller, { kind: 'post', text });
          }
          const local = peerLocalOnly(parsed as Record<string, unknown>);
          patchLocalKeys(local);
          return { text: effectiveSettingsText() };
        }
        // The chief of staff and the assistant may ask for a settings change; the human decides (S-362).
        if (m[1] === 'settings' && !trustedHuman(req, owner)) return askSettingsChange(res, caller, { kind: 'post', text: String(body.text ?? '') });
        // The same for the registry (S-496); it lives on the settings home.
        if (m[1] === 'registry' && !trustedHuman(req, owner)) {
          mayAskSettings(caller);
          homeOnly('registry entries');
          return askSettingsChange(res, caller, { kind: 'registry', text: String(body.text ?? '') });
        }
        humanOnly(req, "change stam's settings, registry and instructions");
        if (m[1] !== 'settings') homeOnly(m[1] === 'instructions' ? 'the instructions for all agents' : 'registry entries');
        const text = String(body.text ?? '');
        if (m[1] === 'instructions') {
          writeFileSync(GLOBAL_INSTRUCTIONS, text);
          sharedFilesChanged();
          return { text };
        }
        let parsed: any;
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          throw new HttpError(400, `not valid JSON: ${e instanceof Error ? e.message : e}`);
        }
        // An invalid cost config is rejected, so the file keeps the last valid one.
        if (m[1] === 'settings') {
          const problem = costProblem(parsed);
          if (problem) {
            noteInvalid(problem);
            throw new HttpError(400, `cost config rejected: ${problem}`);
          }
        }
        if (m[1] === 'settings') {
          const before = settings().permissionModes;
          writeSettingsText(text);
          permissionModes.noteSettingsChange(before, mail.HUMAN);
          // A raised or removed budget lifts its stop now.
          void budgets.evaluateAll();
        } else {
          writeFileSync(configPath(m[1]), text);
          sharedFilesChanged();
        }
        return { text };
      },
    ],
    // The human's partial change to the settings (S-293): see patchSettings. A view record merges per
    // id, so a page that sends only what it changed never overwrites another page's views.
    [
      'PATCH',
      /^\/api\/config\/settings$/,
      (_m, body, _u, res, _l, _h, req, caller) => {
        if (!trustedHuman(req, owner)) {
          mayAskSettings(caller);
          if (!body.patch || typeof body.patch !== 'object' || Array.isArray(body.patch)) throw new HttpError(400, 'the patch must be an object');
          // On a non-home daemon an ask about a shared key is refused before it is made (S-398).
          if (!isSettingsHome()) peerLocalOnly(unredacted({ kind: 'patch', patch: body.patch, fill: body.fill === true }), body.fill === true);
          return askSettingsChange(res, caller, { kind: 'patch', patch: body.patch, fill: body.fill === true });
        }
        humanOnly(req, "change stam's settings");
        if (!body.patch || typeof body.patch !== 'object' || Array.isArray(body.patch)) throw new HttpError(400, 'the patch must be an object');
        if (!isSettingsHome()) {
          // A peer's own page sends the local part of a change here and the shared part to the home
          // (S-414): with localOnly, the shared keys in it are the home's business, not a refusal.
          patchLocalKeys(body.localOnly === true ? splitSettingsPatch(body.patch).local : peerLocalOnly(body.patch, body.fill === true));
          return { text: effectiveSettingsText() };
        }
        // A peer's page changes only shared settings here; the home keeps its own local keys (S-414).
        // MCP servers name commands every machine runs, so they change only on the home's own page.
        if (peerUiRequests.has(req) && 'mcpServers' in body.patch) throw new HttpError(403, `MCP servers change only on ${MACHINE}'s own page`);
        const before = settings().permissionModes;
        const r = peerUiRequests.has(req) ? patchSharedSettings(body.patch, body.fill === true) : patchSettings(body.patch, body.fill === true);
        if ('problem' in r) {
          if (r.field === 'cost') noteInvalid(r.problem);
          throw new HttpError(400, `${r.field} config rejected: ${r.problem}`);
        }
        permissionModes.noteSettingsChange(before, mail.HUMAN);
        void budgets.evaluateAll();
        return { text: r.text };
      },
    ],
    // Shared settings across machines (S-390): the home serves the shared part of its settings to
    // its peers, a peer hears when it changed, and the sync state shows where a peer's copy stands.
    [
      'GET',
      /^\/api\/config\/settings\/shared$/,
      (_m, _b, url, _r, local) => {
        if (!local) throw new HttpError(403, 'only a peer can fetch the shared settings');
        if (!isSettingsHome()) throw new HttpError(409, `${MACHINE} is not the settings home`);
        const payload = sharedPayload();
        if (!payload) throw new HttpError(503, 'settings.json is not valid JSON');
        // The home's web origin rides along, so a peer's page knows where to send shared writes (S-414).
        const web = publishedWebOrigin();
        return { ...(url.searchParams.get('rev') === payload.rev ? { unchanged: true, rev: payload.rev } : payload), ...(web ? { web } : {}) };
      },
    ],
    // A peer's page wrote to the home (S-414) and asks its own daemon to fetch the result now, so what
    // it reads next is the home's new copy. Only a fetch from the home; it changes nothing else.
    [
      'POST',
      /^\/api\/config\/settings\/sync$/,
      async () => {
        await syncShared();
        const sync = syncState();
        return { rev: sync.rev, stale: sync.stale, fetchedAt: sync.fetchedAt };
      },
    ],
    [
      'POST',
      /^\/api\/config\/settings\/changed$/,
      (_m, body, _u, _r, local) => {
        if (!local) throw new HttpError(403, 'only a peer can say its settings changed');
        homeChanged(body?.rev);
        return { scheduled: true };
      },
    ],
    ['GET', /^\/api\/config\/settings\/sync$/, () => syncState()],
    // The files stam generated for an agent, such as its system prompt and harness settings.
    [
      'GET',
      /^\/api\/agents\/([\w-]+)\/files$/,
      (m) => {
        const dir = agentDir(mustAgent(m[1]).id);
        return readdirSync(dir)
          .filter((f) => statSync(join(dir, f)).isFile())
          .map((f) => ({ name: f, text: readFileSync(join(dir, f), 'utf8').slice(0, 50_000) }));
      },
    ],
    // Everything an agent receives, in order, for the web UI's Instructions view. A request
    // about an agent on another machine is forwarded to its daemon above.
    [
      'GET',
      /^\/api\/agents\/([\w-]+)\/instructions$/,
      async (m) => {
        const a = mustAgent(m[1]);
        await itsaOwners.loadOwned(a.id);
        return agentInstructionParts(a);
      },
    ],
    // Everything an agent receives, every layer split into heading-level blocks with token
    // estimates, text hashes and summaries (S-877, S-879, stage 1 of S-868). Read-only; no prompt
    // change. A summary is a model's (state auto/pending/off/failed) or, for an MCP tool's schema,
    // the tool's own description (state source). A request about an agent on another machine is forwarded to its daemon above.
    [
      'GET',
      /^\/api\/agents\/([\w-]+)\/inventory$/,
      async (m) => {
        const a = mustAgent(m[1]);
        await itsaOwners.loadOwned(a.id);
        return withSummaries(agentInventory(a));
      },
    ],
    // The same inventory for an agent type, as a synthetic agent of that type (S-877): its harness
    // and model from the registry unless ?harness= overrides, in the daemon's own repo.
    [
      'GET',
      /^\/api\/types\/([\w-]+)\/inventory$/,
      (m, _b, url) => {
        if (!agentTypes()[m[1]]) throw new HttpError(404, `no agent type ${m[1]}`);
        const harness = url.searchParams.get('harness') ?? undefined;
        if (harness !== undefined && !Object.hasOwn(registry().harnesses, harness)) throw new HttpError(400, `unknown harness ${harness}`);
        return withSummaries(typeInventory(m[1], harness));
      },
    ],
    // The blocks a type's composer lists and the replacement files it can pick (S-892).
    [
      'GET',
      /^\/api\/blocks\/composing$/,
      (_m, _b, url) => {
        const type = url.searchParams.get('type') ?? undefined;
        if (type && !agentTypes()[type]) throw new HttpError(404, `no agent type ${type}`);
        return composerCatalog(type, url.searchParams.get('harness') ?? undefined);
      },
    ],
    [
      'GET',
      /^\/api\/tiny-models$/,
      () => ({ models: tinyModels() }),
    ],
    // Tool-call summaries for the conversation view (S-1481): the calls it shows, in priority order,
    // as {agent, calls: [{id, name, input}], wait}. Stored summaries come back, missing ones are
    // asked for (waiting up to `wait` ms), and with the step off nothing is asked or returned.
    // Only the human's view asks, so an agent can't spend on it.
    [
      'POST',
      /^\/api\/tool-summaries$/,
      async (_m, body, _url, _res, _local, human) => {
        if (!human) throw new HttpError(403, 'tool summaries are for the human\'s view');
        if (typeof body?.agent !== 'string' || !body.agent || body.agent.length > ID_CHARS) throw new HttpError(400, 'agent is required, at most 200 characters');
        let calls;
        try {
          calls = readCalls(body.calls);
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
        const wait = Number(body.wait);
        return toolSummaries(body.agent, calls, Number.isFinite(wait) && wait > 0 ? wait : 0);
      },
    ],
    // Tool names (S-1933): the labels of the tools the human's view shows, as {agent, names, wait}. The
    // labels are per harness, read from the agent; seeded and stored ones come back, missing ones are
    // asked for (waiting up to `wait` ms) once, with no model or key nothing is asked.
    [
      'POST',
      /^\/api\/tool-names$/,
      async (_m, body, _url, _res, _local, human) => {
        if (!human) throw new HttpError(403, 'tool names are for the human\'s view');
        if (typeof body?.agent !== 'string' || !body.agent || body.agent.length > ID_CHARS) throw new HttpError(400, 'agent is required, at most 200 characters');
        const agent = db.getAgent(body.agent);
        if (!agent) throw new HttpError(404, 'no such agent');
        let names;
        try {
          names = readNames(body.names);
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
        const wait = Number(body.wait);
        return toolNames(agent.harness, names, Number.isFinite(wait) && wait > 0 ? wait : 0);
      },
    ],
    [
      'POST',
      /^\/api\/mail-titles$/,
      // The mails the human's view shows: a stale title or summary is asked again (S-1843, src/mail-title.ts).
      async (_m, body, _url, _res, _local, human) => {
        if (!human) throw new HttpError(403, 'mail titles are for the human\'s view');
        if (!Array.isArray(body?.ids) || body.ids.some((x: unknown) => typeof x !== 'string' || !x || x.length > ID_CHARS)) throw new HttpError(400, 'ids must be mail ids, at most 200 characters each');
        return mailTitlesShown(body.ids);
      },
    ],
    [
      'GET',
      /^\/api\/registry$/,
      () => {
        const r = registry();
        for (const [name, h] of Object.entries<any>(r.harnesses)) {
          try {
            h.version = adapters[name]?.version();
          } catch {
            h.version = null;
          }
        }
        return r;
      },
    ],
    // The models a Settings model field can pick (S-379): OpenRouter's catalogue, or a harness's.
    [
      'GET',
      /^\/api\/models$/,
      async (_m, _b, url) => {
        const kind = url.searchParams.get('kind');
        if (kind === 'openrouter') return { models: await openRouterModels() };
        if (kind === 'harness') return { models: harnessModels(url.searchParams.get('harness') ?? '') };
        throw new HttpError(400, 'kind is openrouter or harness');
      },
    ],
    [
      'GET',
      /^\/api\/agents$/,
      async (_m, _b, url, _r, local) => {
        const cost = timed('agents: cost by agent', () => db.costByAgent());
        const allAgents = timed('agents: list', () => db.listAgents());
        const raws = timed('agents: raw cost', () => agentRaw(allAgents));
        const display = costDisplay();
        const pending = timed('agents: permission requests', () => db.pendingRequestCounts());
        const cos = settings().chiefOfStaff;
        // Whether each agent belongs to at least one open ITSA (step 10), for the tree's
        // mark. With ITSAs not required, or the home unreachable, nobody is marked.
        const itsaOn = settings().itsa.required;
        const inItsa = itsaOn ? await itsaOwners.openAgentSet() : null;
        // Extras for the web UI's tree: all parents, unread mail, spend, open requests, and what
        // stam's own view of the agent offers.
        const listed = timed('agents: search or list', () => (url.searchParams.get('q') ? db.searchAgents(url.searchParams.get('q')!) : allAgents));
        // Each per-agent read is one grouped read for the whole list, not one query per agent.
        const parents = timed('agents: parents', () => db.parentsByChild(listed));
        const unread = timed('agents: unread', () => db.unreadCounts());
        const blockersOf = timed('agents: blockers', () => blockers.blockersByAgent());
        const waitsOf = timed('agents: waits', () => waits.webWaitsByAgent());
        const here = timed('agents: per-agent state', () =>
          listed.map((a) => ({
            ...a,
            parents: parents.get(a.id) ?? [],
            unread: unread.get(a.id) ?? 0,
            cost_usd: cost.get(a.id) ?? 0,
            // Own and tree cost in every display unit (src/cost-display.ts).
            cost: timed('agents: cost units', () => toCost(raws.get(a.id)!, display)),
            // For the daemon serving the UI, which converts with its own prices (src/agent-costs.ts).
            ...(local ? { cost_raw: raws.get(a.id) } : {}),
            pending_requests: pending.get(a.id) ?? 0,
            chief_of_staff: cos === a.name || cos === a.id,
            blockers: blockersOf.get(a.id) ?? [],
            waits: waitsOf.get(a.id) ?? [],
            resting: lifecycle.restingOf(a, waitsOf.get(a.id) ?? []),
            in_itsa: !itsaOn || !inItsa ? true : inItsa.has(a.id),
            view: timed('agents: view capabilities', () => agentView.capabilities(a)),
            ...(a.standing && a.lifecycle !== 'archived' ? { load: timed('agents: standing load', () => cachedLoadOf(a)) } : {}),
          })),
        );
        // A peer's agents carry the cost its daemon computed; the mode shown is this daemon's.
        const fetched = local
          ? here
          : [...here, ...(await fanOut<db.Agent>(url.pathname + url.search)).map((a: any) => timed('agents: peer cost', () => withOwnCost(a, display) as db.Agent))];
        // Peers' agents seen here are remembered, so mail to one can wait while its peer is down (S-235).
        if (!local) timed('agents: remember peers', () => { for (const a of fetched) if (a.machine !== MACHINE) db.rememberPeerAgent(a); });
        // The human's default view of each agent is this daemon's, for peers' agents too.
        const views = timed('agents: default views', () => db.agentViews());
        const all = timed('agents: default view merge', () => fetched.map((a) => ({ ...a, default_view: views.get(a.id) ?? null })));
        const viewer = url.searchParams.get('as');
        const visible = viewer ? timed('agents: visibility', () => org.visibleTo(viewer, all)) : all;
        // `role=TEXT` keeps agents whose role or name contains it, standing agents first (S-918).
        const role = url.searchParams.get('role');
        return role === null ? visible : db.agentsByRole(visible, role);
      },
    ],
    // One search across stam for the web palette: agents, the human's mail threads, ITSAs,
    // and Settings, ranked together. Peers add their own agents and mail (search.ts).
    [
      'GET',
      /^\/api\/search$/,
      (_m, _b, url, _r, local, _h, _q, caller) => {
        const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit') ?? 20) || 20));
        // The human's mail is searched for the human only: an agent's or the OpenCode server's token gets none (S-259).
        return search.search(url.searchParams.get('q') ?? '', limit, local, caller.kind !== 'agent' && caller.kind !== 'opencode');
      },
    ],
    // Prompt suggestions (S-1459): agents, the human's threads and ITSAs near the text typed so
    // far, by meaning; `recent` is the ids the client visited lately, newest first.
    [
      'GET',
      /^\/api\/suggest$/,
      (_m, _b, url, _r, local, _h, _q, caller) => {
        const limit = Math.max(1, Math.min(20, Number(url.searchParams.get('limit') ?? 8) || 8));
        const recent = (url.searchParams.get('recent') ?? '').split(',').filter(Boolean).slice(0, 50);
        const floor = Number(url.searchParams.get('floor'));
        return suggest.suggest(url.searchParams.get('q') ?? '', { limit, recent, local, floor: floor > 0 && floor <= 1 ? floor : undefined, humanMail: caller.kind !== 'agent' && caller.kind !== 'opencode' });
      },
    ],
    // The Decision Model pass over those suggestions (S-1465): the text's top candidates, each scored by
    // the model. Null when decisions.suggestRescore is off or the model fails; the client keeps its first order.
    [
      'GET',
      /^\/api\/suggest\/rescore$/,
      (_m, _b, url, _r, local, _h, _q, caller) => {
        const recent = (url.searchParams.get('recent') ?? '').split(',').filter(Boolean).slice(0, 50);
        return suggestRescore.rescoreSuggest(url.searchParams.get('q') ?? '', { recent, local, humanMail: caller.kind !== 'agent' && caller.kind !== 'opencode' });
      },
    ],
    // For harness plugins that know a session id but not the stam agent id (OpenCode).
    [
      'GET',
      /^\/api\/by-session\/([\w-]+)\/notice$/,
      (m, _b, _u, _r, _l, _h, _q, caller) => {
        const a = db.getAgentBySession(m[1]);
        if (a) mayActAs(caller, a.id, true);
        const text = a && mail.inTurnNotice(a.id);
        if (text) db.addEvent(a.id, 'mail:notice');
        return { text };
      },
    ],
    [
      'GET',
      /^\/api\/by-session\/([\w-]+)\/system$/,
      async (m, _b, _u, _r, _l, _h, _q, caller) => {
        const a = db.getAgentBySession(m[1]);
        if (a) mayActAs(caller, a.id, true);
        if (a) await itsaOwners.loadOwned(a.id);
        return {
          text: a && render('system-prompt', { id: a.id, name: a.name, machine: a.machine, role: a.role || 'not set', org: org.orgPrompt(a), instructions: instructionsPrompt(a.harness, a.cwd), cost: org.managerCostPrompt(a), retro: render('retro', {}, a.type), lessons: cachedLessons(a.id) ?? await warmLessons(a), workspace: workspacePrompt(a), itsa: itsaPrompt(a.id), requirements: requirements.prompt(), human_mail: humanMailPrompt(a.model, a.type) }, a.type),
        };
      },
    ],
    [
      'GET',
      /^\/api\/by-session\/([\w-]+)\/compact-instructions$/,
      (m, _b, _u, _r, _l, _h, _q, caller) => {
        const a = db.getAgentBySession(m[1]);
        if (a) mayActAs(caller, a.id, true);
        return { text: a && context.takeCompactInstructions(a.id) };
      },
    ],
    [
      'POST',
      /^\/api\/harness\/(\w+)\/upgrade$/,
      async (m, body) => {
        try {
          return await lifecycle.upgradeHarness(m[1], body?.command ? String(body.command) : undefined);
        } catch (e) {
          throw new HttpError(409, e instanceof Error ? e.message : String(e));
        }
      },
    ],
    // An agent stam didn't spawn gets its own token here when it asks for one (`token: true`, as `stam mcp` does), as a launch gives one, since the shared token can't name an agent that has one (S-545).
    ['POST', /^\/api\/register$/, (_m, body) => { const a = registerAgent(body); return body?.token === true ? { ...a, token: mintAgentToken(a.id) } : a; }],
    // Shared MCP logins (S-50). The human starts and ends a login; the proxy fetches a
    // server's token. The callback is the OAuth redirect the browser follows, protected by
    // the single-use state in mcp-auth.ts, not by the token.
    [
      'POST',
      /^\/api\/mcp\/([\w-]+)\/login$/,
      (m, _b, _u, _r, _l, _h, req) => {
        // Only the human, proven as trustedHuman proves it (the web UI through `tailscale
        // serve`), starts a login; an agent's token and an x-stam-human header prove nothing.
        humanOnly(req, 'log in to an MCP server');
        const origin = canonicalWebOrigin();
        const given = req.headers.origin;
        if (typeof given === 'string' && trimSlash(given) !== origin) throw new HttpError(403, `a login must come from ${origin}`);
        return mcpAuth.startLogin(m[1], origin + '/oauth/callback');
      },
    ],
    [
      'GET',
      /^\/oauth\/callback$/,
      async (_m, _b, url, res) => {
        try {
          const r = await mcpAuth.finishLogin(url.searchParams.get('code') ?? '', url.searchParams.get('state') ?? '');
          sendHtml(res, 200, `Logged in to ${r.name}. You can close this tab.`);
        } catch (e) {
          sendHtml(res, 400, `Login failed: ${e instanceof Error ? e.message : e}`);
        }
        return HANDLED;
      },
    ],
    ['GET', /^\/api\/mcp\/status$/, async () => ({ servers: await mcpAuth.status() })],
    [
      'POST',
      /^\/api\/mcp\/([\w-]+)\/logout$/,
      (m, _b, _u, _r, _l, _h, req) => {
        // Only the human, as with login.
        humanOnly(req, 'log out of an MCP server');
        mcpAuth.logout(m[1]);
        return { logged_out: m[1] };
      },
    ],
    // The one route that returns a token: the human or a known agent (the proxy) may read it.
    [
      'GET',
      /^\/api\/mcp\/([\w-]+)\/token$/,
      (m, _b, url, _r, _l, human) => {
        const agent = url.searchParams.get('agent');
        if (!human && !(agent && db.getAgent(agent))) throw new HttpError(403, 'only the human or a known agent may fetch an MCP token');
        return mcpAuth.tokenFor(m[1], { refresh: url.searchParams.get('refresh') === '1' });
      },
    ],
    // Paste any harness's normal MCP config and get stam's servers back (S-51). Read only,
    // so no human check: it just reads the text it is handed.
    [
      'POST',
      /^\/api\/mcp\/parse$/,
      (_m, body) => {
        try {
          return parseMcpConfig(String(body?.text ?? ''));
        } catch (e) {
          throw new HttpError(400, e instanceof Error ? e.message : String(e));
        }
      },
    ],
    // Connect to one configured server and list its tools, for the Settings section's Test.
    [
      'POST',
      /^\/api\/mcp\/([\w-]+)\/test$/,
      (m, _b, _u, _r, _l, _h, req) => {
        humanOnly(req, 'test an MCP server');
        const server = settings().mcpServers?.[m[1]];
        if (!server) throw new HttpError(404, `no MCP server ${m[1]}`);
        return testServer(m[1], server);
      },
    ],
    // The servers already configured in the harnesses, for the human to import (S-52).
    // Read-only: it scans files, never writes.
    [
      'GET',
      /^\/api\/mcp\/import$/,
      (_m, _b, _u, _r, _l, _h, req) => {
        humanOnly(req, 'import MCP servers');
        const cwds = [...new Set(db.listAgents().map((a) => a.cwd).filter((c): c is string => Boolean(c)))];
        // STAM_HARNESS_HOME points the scan at fixture files in a test; otherwise the user's home.
        return { servers: scanHarnesses({ home: process.env.STAM_HARNESS_HOME || homedir(), cwds, existing: settings().mcpServers ?? {} }) };
      },
    ],
    // The public MCP registry, proxied for the human (S-53). Read-only and cached.
    [
      'GET',
      /^\/api\/mcp\/registry$/,
      (_m, _b, url, _r, _l, _h, req) => {
        humanOnly(req, 'browse the MCP registry');
        return browseRegistry({ search: url.searchParams.get('search') ?? '', cursor: url.searchParams.get('cursor') ?? undefined });
      },
    ],
    // What login a remote server likely needs, checked when it is added and not before.
    [
      'POST',
      /^\/api\/mcp\/registry\/probe$/,
      async (_m, body, _u, _r, _l, _h, req) => {
        humanOnly(req, 'check an MCP server');
        const url = String(body?.url ?? '');
        if (!/^https?:\/\//.test(url)) throw new HttpError(400, 'a http or https url is required');
        return { auth: await remoteAuth(url) };
      },
    ],
    [
      'POST',
      /^\/api\/mail$/,
      async (_m, body, _u, _r, local, human, _q, caller) => {
        // The fields only stam sets (S-466): a peer forwarding mail, or the daemon itself, which
        // calls sendMail directly. From an agent's or the OpenCode server's token they would place
        // mail in any thread, or skip the checks on its sender, so they are refused.
        const own = (caller.kind === 'agent' || caller.kind === 'opencode') && !local ? mail.DAEMON_FIELDS.filter((f) => body?.[f] !== undefined) : [];
        if (own.length) throw new HttpError(403, `${own.join(', ')} ${own.length > 1 ? 'are' : 'is'} set only by stam, not in an agent's mail`);
        // from_stam marks stam's own notice, so it lands as one in any thread, even an ITSA's (S-2033). Only a peer's
        // daemon forwarding its own mail may set it, as the ITSA post route allows.
        if (body?.from_stam !== undefined && !(local && caller.kind === 'shared')) throw new HttpError(403, 'from_stam is set only by stam');
        // The human replies from the web UI; agents mail as themselves.
        // `forwarded` is a peer's relay. Under auth.humanStrict it counts only from a peer (the peer token), never
        // from the shared token; and `system` also passes for a deploy watcher sender from a non-agent caller (S-543).
        const oldFwd = Boolean(body.forwarded);
        const peerFwd = oldFwd && local;
        if (body.from === mail.HUMAN && !human && (!oldFwd || strictRefuses('forwarded mail from the human, not from a peer', !peerFwd))) throw new HttpError(403, 'only the human mails as the human');
        const watcher = caller.kind !== 'agent' && caller.kind !== 'opencode' && SYSTEM_SENDERS.includes(String(body.system));
        if (body.system !== undefined && !human && !watcher && (!oldFwd || strictRefuses('forwarded system mail, not from a peer', !peerFwd))) throw new HttpError(403, 'only the human mails as a system sender');
        let input;
        try {
          input = normalizeMailInput(body);
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
        // A reply in an ITSA's thread from an agent that may not post there is a 403 (S-480); a
        // recipient nobody has, or none at all, is a 400 (S-542).
        const sent = await mail.sendMail(input as mail.SendInput).catch((e) => {
          throw e instanceof itsa.ForbiddenError ? new HttpError(403, e.message) : e instanceof mail.RefusedError ? new HttpError(400, e.message) : e;
        });
        // A thread the human starts waits in the archive until an answer comes: the first reply
        // to the human brings it back, since archive hides only the messages it recorded (mail
        // between agents in it doesn't, S-542). The human's own follow-ups in it stay archived too.
        if (body.from === mail.HUMAN && sent.thread_id) {
          if (body.new_thread) db.archiveThread(mail.HUMAN, sent.thread_id, [sent.id]);
          else {
            db.keepArchived(mail.HUMAN, sent.thread_id, sent.id);
            db.keepDeferred(mail.HUMAN, sent.thread_id, sent.id);
          }
        }
        return sent;
      },
    ],
    [
      'GET',
      /^\/api\/agents\/([\w-]+)\/inbox$/,
      async (m, _b, url, _r, local, _h, _q, caller) => {
        const limit = Number(url.searchParams.get('limit') ?? 20);
        const here = db.inbox(mailboxId(m[1]), url.searchParams.get('unread') === '1', limit);
        // The human's mail lives on whichever machine it was sent from. The OpenCode server never
        // reads the human's box (mayActAs), so viaOf names every caller that gets here (S-476).
        if (m[1] !== mail.HUMAN || local) return here;
        const all = [...here, ...(await fanOut<db.Mail>(url.pathname + url.search, viaOf(caller)))];
        return all.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
      },
    ],
    [
      'GET',
      /^\/api\/agents\/([\w-]+)\/threads$/,
      // For the web UI: the threads a mailbox takes part in, each with all its messages.
      // Messages live with their recipients, so peers add the ones sent to their agents.
      // `archived=1` lists the threads archive hides; the state lives on the daemon that
      // serves the request, so a peer returns every thread and this daemon sorts them.
      // `with=ID` keeps the threads where that agent sent or received a message (S-1121).
      async (m, _b, url, _r, local, _h, _q, caller) => {
        const limit = Number(url.searchParams.get('limit') ?? 50);
        const box = boxRef(m[1]);
        // A peer's own request: hand it everything, so it can sort by its own archive state.
        const withRef = url.searchParams.get('with');
        const withId = withRef ? boxRef(withRef) : undefined;
        if (local) return db.threads(box, limit, withId);
        // The peers get the id this daemon resolved, not NAME: a peer's agent of the same name is another mailbox (S-587).
        // Ask every source for the page plus this mailbox's archived threads, so filtering
        // by archive can't leave the page short of matches. Peers check the box read as, so the
        // OpenCode server isn't answered as a daemon (S-476).
        const { active, archived, deferred } = await mailboxThreads(box, limit, viaBox(caller, box), viaOf(caller), withId);
        return (url.searchParams.get('archived') === '1' ? archived : url.searchParams.get('deferred') === '1' ? deferred : active).slice(0, limit);
      },
    ],
    [
      'POST',
      /^\/api\/agents\/([\w-]+)\/threads\/([\w-]+)\/(archive|unarchive|defer|undefer)$/,
      // Archive hides a thread from a mailbox's list; unarchive brings it back. The state
      // lives here, on the daemon that serves the request, not on the peers that hold parts
      // of the thread. A pending permission request must be answered before its thread archives; defer sets it aside only.
      async (m, body, _u, _r, local, human, _q, caller) => {
        const box = boxRef(m[1]);
        // The human archives the human mailbox; an agent may archive its own mailbox or a
        // child's, as with other per-agent mutations.
        if (box === mail.HUMAN) {
          if (!human) throw new HttpError(403, 'only the human archives the human mailbox');
        } else {
          const a = mustAgent(m[1]);
          const by = body?.by ? mustAgent(String(body.by)).id : undefined;
          if (!by && strictRefuses('thread archive with no by', unattributed(human, local, caller))) throw new HttpError(403, 'only the human, or an agent naming itself (by), archives a thread');
          if (!(!by || isAssistant(by) || by === a.id || db.parentsOf(a).includes(by))) throw new HttpError(403, `${by} may archive only its own mailbox or its children's`);
        }
        if (m[3] === 'undefer') {
          db.undeferThread(box, m[2]);
          // Mail that came back is pushed to an idle agent (S-1880).
          if (box !== mail.HUMAN) mail.schedulePush(box);
        } else if (m[3] === 'archive' || m[3] === 'defer') {
          const here = db.threadMail(m[2]);
          const all = local ? here : [...here, ...(await fanOut<db.ThreadMail>(`/api/threads/${m[2]}`, viaOf(caller)))];
          const verb = 'archiving';
          if (m[3] === 'archive' && all.some((x) => x.permission?.status === 'pending')) throw new HttpError(409, `answer the permission request in this thread before ${verb} it`);
          // Defer sets aside an ask or a decision too (S-1068): it stays listed under To answer, unanswered.
          if (m[3] === 'archive' && box === mail.HUMAN && (await decisionThreads(local, viaOf(caller))).has(m[2])) throw new HttpError(409, `answer the decision in this thread before ${verb} it`);
          if (m[3] === 'defer') {
            db.deferThread(box, m[2], all.map((x) => x.id));
          } else {
            db.archiveThread(box, m[2], all.map((x) => x.id));
            db.forgetAutoArchived(box, m[2]);
          }
        } else {
          db.unarchiveThread(box, m[2]);
          // The human took it back: auto-archive leaves it alone until it has new mail for them (S-637).
          if (box === mail.HUMAN) {
            const here = db.threadMail(m[2]);
            const all = local ? here : [...here, ...(await fanOut<db.ThreadMail>(`/api/threads/${m[2]}`, viaOf(caller)))];
            db.keepOpen(box, m[2], all.map((x) => x.id));
          }
        }
        return m[3] === 'defer' || m[3] === 'undefer' ? { deferred: m[3] === 'defer' } : { archived: m[3] === 'archive' };
      },
    ],
    [
      // A peer's part of an ITSA's mail threads (see /api/itsas/:id/threads), raw by thread.
      'GET',
      /^\/api\/threads\/about\/([\w-]+)$/,
      (m, _b, url, _r, local, _h, _q, caller) => {
        if (!local) mayReadItsaThreads(caller, m[1]!, url.searchParams.get('as'));
        return db.aboutItsaThreads(m[1]!);
      },
    ],
    [
      // The threads holding mail linked to an ITSA (S-986), newest first, one row per thread: the
      // ITSA view's Linked mail. Only mail the viewer may read (mayReadMail); peers answer their own
      // part, and a thread's rows merge. The id may be the ITSA's key.
      'GET',
      /^\/api\/mail\/linked\/([\w-]+)$/,
      async (m, _b, url, _r, local, _h, _q, caller) => {
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? 20)));
        // The box is resolved once (readableLinkedThreads asks readability per linked mail).
        const box = await viewerBox(caller, url.searchParams.get('box'));
        const all = !box || caller.boss || org.chiefOfStaff()?.id === box || isAssistant(box);
        const here = linkedThreadsFor(m[1]!, limit, { all, box: box ? boxRef(box) : '', reader: box ? readerOf(caller, box) : '' });
        if (local) return here;
        return itsa.mergeLinkedThreads([...here, ...(await fanOut<db.LinkedThread>(`${url.pathname}?limit=${limit}${box ? `&box=${encodeURIComponent(box)}` : ''}`, viaBox(caller, box)))], limit);
      },
    ],
    [
      'GET',
      /^\/api\/threads\/([\w-]+)$/,
      // One thread, oldest first; with ?box=ID, only what that mailbox sent or received. The id
      // may be any mail in the thread, such as one cited in a brief (S-448).
      async (m, _b, url, _r, local, _h, _q, caller) => {
        const box = await viewerBox(caller, url.searchParams.get('box'));
        if (box) url.searchParams.set('box', box);
        const tid = local ? m[1] : await threadOfMail(m[1], box, viaBox(caller, box));
        // A viewer reads only its own part of a thread, except a thread with the human that one of its
        // ancestors took part in (mail-search.ts), and the own thread of an ITSA whose threads it may read (S-448).
        const scope = box && !mayReadWholeThread(boxRef(box), tid, readerOf(caller, box)) ? boxRef(box) : undefined;
        const here = db.threadMail(tid, scope);
        if (local) return here;
        // A whole thread is asked of the peers without the box, as the ITSA thread reads do.
        const path = `/api/threads/${tid}${scope ? `?box=${encodeURIComponent(box!)}` : ''}`;
        return db.foldMails([...here, ...(await fanOut<db.ThreadMail>(path, viaBox(caller, box)))]).sort((a, b) => a.created_at.localeCompare(b.created_at));
      },
    ],
    [
      'GET',
      /^\/api\/mail\/search$/,
      // Keyword search over the mail a viewer may read (mail-search.ts). Peers answer their own part.
      async (_m, _b, url, _r, local, _h, _q, caller) => {
        const box = await viewerBox(caller, url.searchParams.get('box'));
        if (!box) throw new HttpError(400, 'box is required');
        const limit = Math.min(30, Math.max(1, Number(url.searchParams.get('limit') ?? 10)));
        return searchMail(boxRef(box), url.searchParams.get('q') ?? '', { with: url.searchParams.get('with') || undefined, limit, local, via: viaBox(caller, box) });
      },
    ],
    [
      'POST',
      /^\/api\/mail\/([\w-]+)\/title$/,
      // A peer that asked a model for a mail's title (S-297) hands it to this copy of the mail;
      // a title or summary already here stays. Agents don't set titles.
      (m, body, _u, _r, _l, _h, _q, caller) => {
        if (caller.kind === 'agent' || caller.kind === 'opencode') throw new HttpError(403, 'only a daemon sets a mail title');
        const x = db.getMail(m[1]);
        if (!x) throw new HttpError(404, `no mail ${m[1]}`);
        const t = cleanTitle(body?.title);
        if (t && !x.title) db.setMailTitle(x.id, t, db.PEER_TITLE_CONFIG);
        const s = cleanSummary(body?.summary);
        if (s && !x.summary) db.setMailSummary(x.id, s);
        // The peer's answer is the peer's to regenerate: a copy with no config here takes the peer one (S-1843).
        if ((t || s) && db.mailTitleRow(x.id)?.configHash === null) db.setMailTitleConfig(x.id, db.PEER_TITLE_CONFIG);
        const now = db.getMail(x.id);
        return { title: now?.title ?? null, summary: now?.summary ?? null };
      },
    ],
    [
      'GET',
      // A mail id (db.newMailId: `m` and hex), so other /api/mail/<word> routes aren't taken.
      /^\/api\/mail\/(m[0-9a-f]+)$/,
      // The fields a reply to this mail needs, for a daemon whose copy of it is on a peer (S-359).
      // A viewer sees it only if mayReadMail lets it; otherwise [].
      async (m, _b, url, _r, local, _h, _q, caller) => {
        const x = db.getMail(m[1]);
        if (!x) {
          if (local) return [];
          const box = await viewerBox(caller, url.searchParams.get('box'));
          return fanOut<mail.ReplyParent>(withBox(url.pathname, box), viaBox(caller, box));
        }
        if (!(await mayReadMail(caller, x, url))) return [];
        return [{ id: x.id, thread_id: x.thread_id, subject: x.subject, from_id: x.from_id, itsa_id: x.itsa_id }];
      },
    ],
    [
      'GET',
      /^\/api\/mail\/([\w-]+)\/thread$/,
      // The thread a mail belongs to and its subject, for links to it: [] if no daemon has it, or the
      // viewer may not read it (mayReadMail, S-388). Peers are asked for the same viewer (viaOf).
      async (m, _b, url, _r, local, _h, _q, caller) => {
        const x = db.getMail(m[1]);
        if (!x) {
          if (local) return [];
          const box = await viewerBox(caller, url.searchParams.get('box'));
          return (await fanOut<{ thread_id: string; subject: string }>(withBox(url.pathname, box), viaBox(caller, box))).slice(0, 1);
        }
        if (!(await mayReadMail(caller, x, url))) return [];
        return [{ thread_id: x.thread_id ?? x.id, subject: db.getMail(x.thread_id ?? x.id)?.subject ?? x.subject }];
      },
    ],
    [
      'POST',
      /^\/api\/agents\/([\w-]+)\/read$/,
      async (m, body, _u, _r, local) => {
        const box = mailboxId(m[1]);
        const hold = readHolds.get(box);
        if (hold) await hold.gate;
        // An agent's read carries a batch id (its MCP client, S-357): the mail is recorded as handed
        // out in it, and stays owed until a batch holding it is acknowledged. The batch the client last
        // got a reply to is acknowledged here; a read without ids hands out the owed mail too.
        const batch = box !== mail.HUMAN && typeof body.batch === 'string' ? body.batch : undefined;
        if (batch && typeof body.ack === 'string') db.ackDelivered(box, body.ack);
        const ids: string[] = body.ids?.length ? body.ids : box === mail.HUMAN ? db.inbox(box, true, 10).map((x) => x.id) : db.defaultRead(box);
        const here = db.readMail(box, ids, batch);
        if (box !== mail.HUMAN || local) return here;
        const missing = body.ids?.length ? ids.filter((id) => !here.some((x) => x.id === id)) : [];
        const rest = await Promise.all(
          peers().map((p) =>
            body.ids?.length && !missing.length ? [] : peerCall(p, 'POST', `/api/agents/human/read`, { ids: missing }).then((r) => (Array.isArray(r.data) ? r.data : []), () => []),
          ),
        );
        return [...here, ...rest.flat()];
      },
    ],
    // The sender withdraws its own ask from the human, or its parent, the chief of staff or the assistant (S-425).
    [
      'POST',
      /^\/api\/mail\/([\w-]+)\/withdraw-ask$/,
      async (m, body, _u, _r, local, _h, _q, caller) => {
        // An agent's own token acts as that agent; the OpenCode server's acts as the agent actor() checked
        // in body.by (resolveActors). A peer's forwarded call names its agent and its boss flag (S-239).
        if (caller.kind !== 'agent' && caller.kind !== 'opencode') throw new HttpError(403, 'only an agent withdraws its ask');
        const by = caller.kind === 'agent' ? String(caller.agent ?? '') : String(body.by ?? '');
        if (!by) throw new HttpError(403, 'an ask is withdrawn for a named agent');
        const boss = caller.boss === true || org.chiefOfStaff()?.id === by || isAssistant(by);
        try {
          return { withdrawn: await withdraw.withdrawAsk(m[1], by, String(body.note ?? ''), { boss, fromPeer: local, byName: local ? String(body.by_name ?? '') || undefined : undefined }) };
        } catch (e) {
          if (e instanceof withdraw.AskRefused) throw new HttpError(e.status, e.message);
          throw e;
        }
      },
    ],
    // An agent attaches ITSAs and agents to a mail, silently (S-1305): no mail, notice or unread state.
    [
      'POST',
      /^\/api\/mail\/([\w-]+)\/attach$/,
      async (m, body, _u, _r, _local, _h, _q, caller) => {
        if (caller.kind !== 'agent' && caller.kind !== 'opencode') throw new HttpError(403, 'only an agent attaches to mail');
        const by = caller.kind === 'agent' ? String(caller.agent ?? '') : String(body.by ?? '');
        if (!by) throw new HttpError(403, 'attaching is for a named agent');
        const boss = caller.boss === true || org.chiefOfStaff()?.id === by || isAssistant(by);
        const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
        try {
          return { attached: attachToMail(m[1], by, { itsas: list(body.itsas), agents: list(body.agents) }, boss) };
        } catch (e) {
          if (e instanceof AttachRefused) throw new HttpError(e.status, e.message);
          throw e;
        }
      },
    ],
    // A peer archives a thread it found resolved (S-637) for the human here too; only a peer may.
    [
      'POST',
      /^\/api\/mail\/archive-resolved$/,
      async (_m, body, _u, _r, local) => {
        if (!local) throw new HttpError(403, 'only a peer archives a resolved thread this way');
        const ids = Array.isArray(body?.ids) ? body.ids.map(String) : [];
        if (!body?.thread_id || !ids.length) throw new HttpError(400, 'thread_id and ids are required');
        // A thread the human unarchived here stays, unless it has new mail for them since.
        const human = Array.isArray(body?.human_ids) ? body.human_ids.map(String) : ids;
        if (db.keptOpen(mail.HUMAN, String(body.thread_id), human)) return { archived: false };
        db.archiveThread(mail.HUMAN, String(body.thread_id), ids);
        return { archived: true };
      },
    ],
    // The auto-archive pass on demand (S-637): `dry` lists what it would archive; `all` takes in
    // threads resolved before it was switched on, the one-off sweep, which the chief of staff approves
    // from a dry run first. The CLI (`stam archive-resolved`) and the human may run it; an agent may not.
    [
      'POST',
      /^\/api\/mail\/resolved$/,
      async (_m, body, _u, _r, local, _h, _q, caller) => {
        if (local || caller.kind === 'agent' || caller.kind === 'opencode') throw new HttpError(403, 'only the CLI or the human runs the archive pass');
        const threads = await autoArchive.archiveResolved(autoArchiveSources(), { dry: body?.dry !== false, all: body?.all === true });
        return { dry: body?.dry !== false, all: body?.all === true, count: threads.length, threads };
      },
    ],
    // A peer withdraws mail it doesn't hold from the human (src/withdraw.ts); only a peer may.
    [
      'POST',
      /^\/api\/mail\/withdraw$/,
      async (_m, body, _u, _r, local) => {
        if (!local) throw new HttpError(403, 'only a peer withdraws mail from the human this way');
        const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
        return { withdrawn: await withdraw.withdrawFromHuman(ids, String(body.by ?? ''), String(body.note ?? ''), { fromPeer: true, keepThread: Boolean(body.keep_thread), closeKept: Boolean(body.close_kept) }) };
      },
    ],
    // stam's own view of an agent: its conversation, live (src/agent-view.ts). Sending is
    // the human's, from the web UI.
    [
      'GET',
      /^\/api\/agents\/([\w-]+)\/view$/,
      async (m, _b, _u, res) => {
        await viewCall(() => agentView.stream(mustAgent(m[1]), res));
        return HANDLED;
      },
    ],
    [
      'GET',
      /^\/api\/agents\/([\w-]+)\/view\/history$/,
      (m, _b, url) => viewCall(() => agentView.history(mustAgent(m[1]), url.searchParams.get('before') ?? undefined, Number(url.searchParams.get('limit') ?? 50))),
    ],
    [
      // The tool calls an agent made before a mail it sent, for the ITSA thread (S-1643).
      'GET',
      /^\/api\/agents\/([\w-]+)\/view\/tools$/,
      (m, _b, url) => viewCall(() => agentView.mailTools(mustAgent(m[1]), url.searchParams.get('mail') ?? '')),
    ],
    // Sending acts as the human: only the human, proven as trustedHuman proves it (the web UI
    // through `tailscale serve`); an agent's token and an x-stam-human header prove nothing.
    [
      'POST',
      /^\/api\/agents\/([\w-]+)\/view\/prompt$/,
      (m, body, _u, _r, _l, _h, req) => (humanOnly(req, "send to an agent's view"), viewCall(() => viewPrompt.prompt(mustAgent(m[1]), String(body.text ?? ''), body.delivery ?? 'queue')).then(() => ({ sent: true }))),
    ],
    [
      'POST',
      /^\/api\/agents\/([\w-]+)\/view\/interrupt$/,
      (m, _b, _u, _r, _l, _h, req) => (humanOnly(req, 'interrupt an agent from its view'), viewCall(() => agentView.interrupt(mustAgent(m[1]))).then((stopped) => ({ stopped }))),
    ],
    [
      'POST',
      /^\/api\/agents\/([\w-]+)\/view\/permission$/,
      (m, body, _u, _r, _l, _h, req) => (humanOnly(req, 'answer permissions from the view'), viewCall(() => agentView.answerPermission(mustAgent(m[1]), String(body.request ?? ''), body.decision)).then(() => ({ answered: true }))),
    ],
    [
      'GET',
      /^\/api\/agents\/([\w-]+)\/stream$/,
      (m, _b, _u, res) => {
        addStream(mustAgent(m[1]).id, res);
        return HANDLED;
      },
    ],
    // The new agent's view capabilities come back with it, as the list gives them, so the web
    // UI opens it in its default view at once (S-173).
    [
      'POST',
      /^\/api\/agents$/,
      (_m, body, _u, _r, local, human, _q, caller) => {
        if (!body?.by && strictRefuses('spawn with no by', unattributed(human, local, caller))) throw new HttpError(403, 'only the human, or an agent naming itself (by), spawns an agent');
        // A ring reviewer type with no harness, model, or preset is spawned as a ring.
        if (body.type && agentTypes()[String(body.type)]?.review?.ring && !body.preset && !body.harness && !body.model) return spawnRingType(body, human);
        // An agent's queued spawn is keyed by the agent itself, whatever `by` it names (S-2134).
        return spawnAgent(body, human, undefined, { queue: true, by: caller.kind === 'agent' ? caller.agent : undefined }).then(
          (a) => {
            // The same agent queued on another machine would start a duplicate (S-2134): those queued spawns are dropped.
            const by = spawnerKey(caller.kind === 'agent' ? caller.agent : undefined, body.by);
            if (by) dropQueuedDuplicates(a.name, by);
            return { ...a, view: agentView.capabilities(a) };
          },
          (e) => {
            if (e instanceof QueuedSpawn) return e.reply;
            throw e;
          },
        );
      },
    ],
    // Cancels a queued developer spawn by its name (S-2134): agent_control cancel.
    [
      'POST',
      /^\/api\/slot-queue\/([\w-]+)\/cancel$/,
      (m, _b, _u, _r, _l, _h, _q, caller) => cancelQueuedSpawn(m[1]!, caller),
    ],
    // A peer's spawn of a queued name from the same caller drops this machine's queued one (S-2134).
    [
      'POST',
      /^\/api\/slot-queue\/([\w-]+)\/duplicate$/,
      (m, body, _u, _r, _l, _h, _q, caller) => dropQueuedDuplicate(decodeURIComponent(m[1]!), body?.caller, caller),
    ],
    [
      'POST',
      /^\/api\/agents\/([\w-]+)\/permission-mode$/,
      async (m, body, _u, _r, _l, _h, req) => {
        // Bypass is a privilege: only trustedHuman's proof counts, never the x-stam-human claim alone.
        humanOnly(req, 'set permission modes, from the web UI');
        const a = mustAgent(m[1]);
        const result = await setPermissionMode(a, body.mode, mail.HUMAN);
        return { agent: db.getAgent(a.id), result };
      },
    ],
    // Settings › permission modes (S-1967): the settings, each harness's modes in its own words, the
    // agent types, and the running agents still on another mode than the settings give them.
    [
      'GET',
      /^\/api\/permission-modes$/,
      () => ({ settings: settings().permissionModes, harnesses: permissionModes.HARNESS_MODES, types: Object.keys(agentTypes()), stale: permissionModes.staleAgents() }),
    ],
    // Switches those agents now, each at the end of its step, keeping its session.
    [
      'POST',
      /^\/api\/permission-modes\/apply$/,
      async (_m, _b, _u, _r, _l, _h, req) => {
        humanOnly(req, 'apply permission modes, from the web UI');
        const r = await applyPermissionModes(mail.HUMAN);
        db.addEvent(mail.HUMAN, 'permission-modes:apply', { by: mail.HUMAN, applied: r.applied.map((x) => x.name), skipped: r.skipped });
        return { ...r, stale: permissionModes.staleAgents() };
      },
    ],
    // The chief of staff's name (null when none is active), for agents that mail it.
    ['GET', /^\/api\/chief-of-staff$/, () => ({ chiefOfStaff: org.chiefOfStaff()?.name ?? null, setting: settings().chiefOfStaff ?? null })],
    [
      'POST',
      /^\/api\/chief-of-staff$/,
      (_m, body, _u, _r, _l, human) => {
        if (!human && !isAssistant(body.by)) throw new HttpError(403, 'only the human and the assistant name the chief of staff');
        const a = body.agent ? mustAgent(String(body.agent)) : undefined;
        setSetting('chiefOfStaff', a?.name ?? null);
        return { chiefOfStaff: a?.name ?? null };
      },
    ],
    // The janitor: sweeps test leftovers whose owner is gone (src/janitor.ts). Anyone on
    // the machine may ask; it only ever removes /tmp/stam-test.* leftovers.
    // Reads agents' transcripts into the activity timeline now (src/activity.ts): one agent,
    // or every agent with a reader. Turn ends and daemon start do this on their own.
    ['POST', /^\/api\/activity\/ingest$/, (_m, body) => activity.ingestAll(body?.agent ? String(body.agent) : undefined)],
    ['POST', /^\/api\/activity\/classify$/, (_m, body) => activity.classifyAll(body?.agent ? String(body.agent) : undefined)],
    // The model classifier's backfill (S-214): NULL items since an ISO time, now, up to the daily cap.
    // It runs in the background (S-252); the human polls GET for its progress.
    ['POST', /^\/api\/activity\/classify-model$/, (_m, body, _u, _r, _l, _h, req) => (humanOnly(req, 'classify activity with the model'), activityClassify.startBackfill(body?.since ? String(body.since) : ''))],
    ['GET', /^\/api\/activity\/classify-model$/, (_m, _b, _u, _r, _l, _h, req) => (humanOnly(req, 'read the classifier backfill'), activityClassify.backfillProgress())],
    // Test-only (test/e2e-cost.sh; STAM_TEST_COST_HOOKS=1 is set only by test/lib.sh, and only a daemon
    // with its own home and a stam-test- tmux socket honours it, see testHooksAllowed): store a
    // subscription reading as an adapter would (`reading`), or run the OpenRouter credit poll now
    // (`poll-credits`), or run the cost fallbacks due by a given time (`fallback-due`, `now` in ms),
    // so a test needn't wait for the five-minute timers or the fallback minutes. `error` records a
    // provider error signal on an agent as its adapter would (`agent`, `class`, `source`), and
    // `probe-due` runs an account's error probe now (src/cost-probes.ts). `spend` reports an agent's
    // cumulative cost (`agent`, `cost`) as its adapter would, which books it on the agent's account.
    // An agent's token is refused (S-1287), as the other human-only routes refuse it.
    [
      'POST',
      /^\/api\/test\/cost$/,
      async (_m, body) => {
        if (body?.action === 'reading') usage.reportSubscription(String(body.name), body.windows ?? {});
        else if (body?.action === 'poll-credits') await credits.pollCredits();
        else if (body?.action === 'fallback-due') await costFallback.evaluate(Number(body.now));
        else if (body?.action === 'error') rules.signal(mustAgent(String(body.agent)).id, { source: String(body.source ?? 'test'), class: String(body.class) });
        else if (body?.action === 'probe-due') await costProbes.runProbe(String(body.account));
        else if (body?.action === 'spend') usage.report(mustAgent(String(body.agent)), { cost: Number(body.cost) });
        else throw new HttpError(400, 'action must be reading, poll-credits, fallback-due, error, probe-due or spend');
        return { ok: true };
      },
    ],
    // Test-only (test/e2e-read-mail.sh): hold an agent's read_mail
    // route until `release`, so its client times out first (S-357). `hold` and `release` by agent.
    [
      'POST',
      /^\/api\/test\/read-hold$/,
      (_m, body) => {
        const id = mustAgent(String(body.agent)).id;
        if (body.action === 'hold') {
          if (!readHolds.has(id)) {
            let release = () => {};
            const gate = new Promise<void>((r) => (release = r));
            readHolds.set(id, { gate, release });
          }
        } else if (body.action === 'release') {
          readHolds.get(id)?.release();
          readHolds.delete(id);
        } else throw new HttpError(400, 'action must be hold or release');
        return { ok: true };
      },
    ],
    // Test-only (test/e2e-agents-route.sh): start counting statement executions on the database, or stop and
    // return the count, so a test can bound the database work one request does.
    [
      'POST',
      /^\/api\/test\/statements$/,
      (_m, body) => {
        if (body?.action === 'start') {
          if (!statementStop) statementStop = countStatements(db.open());
          return { ok: true };
        }
        if (body?.action !== 'stop' || !statementStop) throw new HttpError(400, 'action must be start, then stop');
        const count = statementStop();
        statementStop = null;
        return { ok: true, statements: count };
      },
    ],
    // Test-only (test/e2e-stall.sh): block the loop for `ms` under `label`,
    // so a test sees the stall watch log it with that label.
    [
      'POST',
      /^\/api\/test\/stall$/,
      (_m, body) => {
        const until = performance.now() + Number(body?.ms ?? 0);
        while (performance.now() < until);
        return { ok: true };
      },
    ],
    // Test-only (test/e2e-reviewer-ring.sh): the named agents' launches fail after their row exists.
    [
      'POST',
      /^\/api\/test\/launch-fail$/,
      (_m, body) => {
        failLaunch.clear();
        for (const n of body?.names ?? []) failLaunch.add(String(n));
        return { ok: true };
      },
    ],
    // Test-only (test/e2e-reviewer-ring.sh): hold the ITSA lookup of a spawn until released.
    // `status` reports how many spawns wait at it, so a test synchronizes on state.
    [
      'POST',
      /^\/api\/test\/itsa-gate$/,
      (_m, body) => {
        if (body?.action === 'hold') itsaGate.hold();
        else if (body?.action === 'release') itsaGate.release();
        return { waiting: itsaGate.waiting };
      },
    ],
    // Test-only (test/e2e-stall.sh): a request that awaits, so it is in flight while another request
    // blocks the loop. It writes stall-awaiting, then holds until stall-release exists.
    [
      'POST',
      /^\/api\/test\/await$/,
      async () => {
        writeFileSync(join(STAM_HOME, 'stall-awaiting'), '');
        while (!existsSync(join(STAM_HOME, 'stall-release'))) await new Promise((r) => setTimeout(r, 50));
        return { ok: true };
      },
    ],
    ['POST', /^\/api\/janitor$/, (_m, body) => janitorSweep(Boolean(body?.dry_run), Array.isArray(body?.only) ? body.only.map(String) : undefined)],
    [
      'GET',
      /^\/api\/usage$/,
      async (_m, _b, url, _r, local, _h, _q, caller) => {
        const tree = url.searchParams.get('tree');
        const viewer = usageViewer(caller, url);
        const visible = viewer === undefined ? undefined : usageScope.visibleAgents(viewer);
        if (visible && tree && !usageScope.mayReadTree(visible, tree)) throw new HttpError(403, `an agent reads the usage of its own tree and its ancestors' trees only, not ${tree}'s`);
        // `agents=developer,manager`: the same type list as /api/activity (src/agent-class.ts); absent keeps every agent.
        let keep: Set<string> | null = null;
        try {
          keep = parseAgentFilter(url.searchParams.get('agents'));
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
        const summary = usage.summary(Number(url.searchParams.get('days') ?? 14), tree ? mustAgent(tree).id : undefined, keep) as Record<string, unknown>;
        // Each machine's load and its agents by state (src/machines.ts), for usage_info.
        // Paid spend per machine (S-395): a peer's own request gets only its local totals.
        const spend = local ? undefined : await peerSpend.refresh().then(() => peerSpend.perMachine(MACHINE));
        const full = { ...summary, machines: (await machines.all(local)).map(machines.compact), ...(spend ? { paid_spend_by_machine: spend } : {}) };
        return visible ? usageScope.scopeSummary(full, visible) : full;
      },
    ],
    // This machine's paid totals by period, which the other daemons add to their budgets (S-395).
    [
      'GET',
      /^\/api\/usage\/spend$/,
      (_m, _b, _u, _r, local) => {
        const s = peerSpend.serve(local);
        if (!s) throw new HttpError(403, 'only a peer can read spend');
        return s;
      },
    ],
    // Spend per ITSA, averages by configuration, and what no ITSA worked on (src/issue-costs.ts).
    // `days` limits the samples to the last N days; all of them when absent.
    [
      'GET',
      /^\/api\/usage\/issues$/,
      (_m, _b, url, _r, _l, _h, _q, caller) => {
        const days = url.searchParams.get('days');
        const r = issueCosts({ days: days == null ? undefined : Number(days), display: displayCtx() });
        const viewer = usageViewer(caller, url);
        return viewer === undefined ? r : usageScope.scopeIssueCosts(r, viewer);
      },
    ],
    // Spend over time, split by a dimension, for the redesigned Usage page's charts (S-657). One
    // row per day, or per hour when days=1 (usage_samples), into the top 5 groups plus Other;
    // `previous` is the same-length period before, for the trend tile. Response shape:
    //   { note, days, group, bucket, groups: [{id,name,harness?}], rows: [{t, cost_usd, tokens_*, groups: {ID: {cost_usd, tokens_*}}}], total, previous }
    // The model group's id is `harness · model` (its name the model, its harness alongside), so
    // one model on two harnesses is two groups.
    // Scoped like /api/usage: hidden agents become Other for group=tree|agent, unreadable ITSAs
    // become Other for group=itsa. In usage-drill.ts.
    [
      'GET',
      /^\/api\/usage\/series$/,
      (_m, _b, url, _r, _l, _h, _q, caller) => {
        const group = (url.searchParams.get('group') ?? 'tree') as usageDrill.SeriesGroup;
        if (!usageDrill.SERIES_GROUPS.includes(group)) throw new HttpError(400, `group must be one of ${usageDrill.SERIES_GROUPS.join(', ')}, not ${group}`);
        const days = Number(url.searchParams.get('days') ?? 14);
        if (!Number.isFinite(days) || days < 1 || days > usageDrill.MAX_DAYS) throw new HttpError(400, `days must be a number from 1 to ${usageDrill.MAX_DAYS}, not ${url.searchParams.get('days')}`);
        const viewer = usageViewer(caller, url);
        const visible = viewer === undefined ? undefined : usageScope.visibleAgents(viewer);
        const mayItsa = viewer === undefined ? undefined : usageScope.itsaFilter(viewer);
        return usageDrill.spendSeries({ days, group, visible, mayItsa });
      },
    ],
    // One drilled scope for the Usage page (S-657): a tree, ITSA, model, harness or agent. model=
    // takes a bare model (any harness), the `harness · model` id the series emits, or a harness=
    // alongside. Its totals (own/children/total for an ITSA), its share of each subscription
    // window, spend over time by agent, by model, the agents table, and for an ITSA its child
    // ITSAs and typical cost.
    // Response shape:
    //   { note, days, bucket, scope: {kind,id,name[,key]}, totals, windows: [{account,window,percent,worth_usd}],
    //     timeseries: {group:'agent', groups, rows}, by_agent: [{id,name,role,harness,model,cost_usd,tokens_*}],
    //     by_model: [{harness,model,cost_usd,tokens_*}], itsas?: [{key,title,status,owner,cost_usd}], typical? }
    // Scoped like /api/usage: an unreadable tree, agent or ITSA is refused (403); every row holds
    // only the agents the token may see. In usage-drill.ts.
    [
      'GET',
      /^\/api\/usage\/scope$/,
      (_m, _b, url, _r, _l, _h, _q, caller) => {
        const named = (['tree', 'itsa', 'agent'] as const).filter((k) => {
          const v = url.searchParams.get(k);
          return v != null && v !== '';
        });
        const harness = url.searchParams.get('harness') || undefined;
        const model = url.searchParams.get('model') || undefined;
        // model may be bare (any harness), a `harness · model` id as the series emits, or combined
        // with an explicit harness.
        if (named.length > 1 || (named.length && (harness || model))) throw new HttpError(400, 'scope takes one of tree, itsa or agent, or a harness and/or model');
        let kind: usageDrill.ScopeKind;
        let ref: string;
        if (named.length) {
          kind = named[0];
          ref = url.searchParams.get(kind)!;
          if (kind === 'tree' || kind === 'agent') ref = mustAgent(ref).id;
          else {
            const found = itsa.find(ref);
            if (!found) throw new HttpError(404, `no ITSA ${ref}`);
            ref = found.key;
          }
        } else if (model || harness) {
          kind = model ? 'model' : 'harness';
          ref = (model ?? harness)!;
        } else throw new HttpError(400, 'scope needs one of tree, itsa, model, harness or agent');
        const viewer = usageViewer(caller, url);
        const visible = viewer === undefined ? undefined : usageScope.visibleAgents(viewer);
        const mayItsa = viewer === undefined ? undefined : usageScope.itsaFilter(viewer);
        if ((kind === 'tree' || kind === 'agent') && visible && !usageScope.mayReadTree(visible, ref))
          throw new HttpError(403, `an agent reads the usage of its own tree and its ancestors' trees only, not ${ref}'s`);
        if (kind === 'itsa' && mayItsa && !mayItsa(ref)) throw new HttpError(403, `an agent reads the cost of the ITSAs it belongs to only, not ${ref}`);
        const days = Number(url.searchParams.get('days') ?? 14);
        if (!Number.isFinite(days) || days < 1 || days > usageDrill.MAX_DAYS) throw new HttpError(400, `days must be a number from 1 to ${usageDrill.MAX_DAYS}, not ${url.searchParams.get('days')}`);
        // An ITSA may ask for its own span: since=ISO (when it opened) and bucket=hour|day.
        const sinceRaw = url.searchParams.get('since');
        const since = sinceRaw ? Date.parse(sinceRaw) : undefined;
        if (since !== undefined && Number.isNaN(since)) throw new HttpError(400, `since must be an ISO time, not ${sinceRaw}`);
        const bucketRaw = url.searchParams.get('bucket');
        if (bucketRaw && bucketRaw !== 'hour' && bucketRaw !== 'day') throw new HttpError(400, `bucket must be hour or day, not ${bucketRaw}`);
        return usageDrill.drillScope({ days, kind, ref, harness, visible, mayItsa, since, bucket: (bucketRaw as usageDrill.Bucket | null) ?? undefined });
      },
    ],
    // Activity baseline (S-212): working and waiting time, cost, and review rounds per agent, ITSA,
    // model, or agent type (src/activity-stats.ts). `closed=1` keeps closed ITSAs; `days` limits the window.
    // by=summary (S-1009, src/activity-summary.ts) is the Activity tab's one answer, scoped by
    // `scope=tree:AGENT|itsa:S-N|agent:AGENT`; it is served from digests and never blocks the loop.
    [
      'GET',
      /^\/api\/activity$/,
      async (_m, _b, url, _r, local, _h, _q, caller) => {
        const by = url.searchParams.get('by') ?? 'agent';
        if (by === 'summary') return activityRoute(url, caller);
        // What a daemon reads of its peers for the summary (S-1079, src/activity-wire.ts): a peer's call only.
        if (by === 'digests' || by === 'attribution') {
          if (!local || caller.kind === 'agent') throw new HttpError(403, `by=${by} is for a peer's daemon`);
          if (by === 'attribution') {
            if ((settings().itsa.home ?? MACHINE) !== MACHINE) throw new HttpError(404, `${MACHINE} is not the ITSA home`);
            return activitySummaryMod.attributionExport(url.searchParams.get('sig'), Number(url.searchParams.get('events_after') ?? -1), url.searchParams.get('cont') === '1', url.searchParams.get('rows_since'));
          }
          return activitySummaryMod.digestsPage({
            days: Number(url.searchParams.get('days') ?? 7),
            since: Number(url.searchParams.get('since') ?? -1),
            epoch: url.searchParams.get('epoch') ?? '',
            after: url.searchParams.get('after') ?? '',
          }).catch((e) => {
            if (e instanceof activitySummaryMod.ScopeError) throw new HttpError(e.status, e.message);
            throw e;
          });
        }
        if (!['agent', 'itsa', 'model', 'type'].includes(by)) throw new HttpError(400, `by must be agent, itsa, model, type, or summary, not ${by}`);
        const days = url.searchParams.get('days');
        if (days != null && !(Number(days) >= 1 && Number(days) <= 3650)) throw new HttpError(400, `days must be 1 to 3650, not ${days}`);
        // Sliced and kept for 30 s (src/activity-stats.ts, S-2094); each slice is labelled with the mode and the caller.
        const r = await activityStatsCached({ by: by as By, days: days == null ? undefined : Number(days), closed: url.searchParams.get('closed') === '1' }, (fn) => timed(`GET /api/activity slice by=${by} caller=${caller.kind}`, fn));
        const viewer = usageViewer(caller, url);
        const scoped = viewer === undefined ? r : usageScope.scopeActivity(r as any, viewer, usageScope.visibleAgents(viewer));
        // `itsa=S-N`: one ITSA's row, for a page that shows one (the full report stays one memo).
        const only = url.searchParams.get('itsa');
        return only && by === 'itsa' ? { ...scoped, rows: (scoped as { rows: { key: string }[] }).rows.filter((x) => x.key === only) } : scoped;
      },
    ],
    // A manager records that it handled a cost notice, by the event id in the notice.
    [
      'POST',
      /^\/api\/cost\/ack$/,
      (_m, body, _u, _r, local, human, _q, caller) => {
        if (!body?.by && strictRefuses('cost ack with no by', unattributed(human, local, caller))) throw new HttpError(403, 'a cost notice is acknowledged by an agent (by) or the human');
        return costNotices.ack(String(body?.event ?? ''), body?.by ? mustAgent(String(body.by)).id : mail.HUMAN);
      },
    ],
    // Allocations (docs/cost-policy.md, build step 10): the user (or the CLI, or the
    // assistant) sets any, the chief of staff any, every other agent only its own tree's.
    [
      'GET',
      /^\/api\/cost\/allocations$/,
      (_m, _b, url) => {
        const tree = url.searchParams.get('tree');
        return { allocations: allocations.view(tree ? mustAgent(tree).id : undefined) };
      },
    ],
    [
      'POST',
      /^\/api\/cost\/allocate$/,
      (_m, body, _u, _r, _l, human) => {
        const by = body?.by ? mustAgent(String(body.by)).id : human ? mail.HUMAN : undefined;
        if (!by) throw new HttpError(403, 'an allocation needs an agent (by) or the human');
        try {
          // Setting or clearing a tree's allocation counts as acting on its cost notices.
          const ackTree = (rootId: string | undefined) => {
            const root = rootId ? db.getAgent(rootId) : undefined;
            if (root) costPause.ackTree(root, by, 'cost_allocate');
          };
          if (body?.clear) {
            const root = body?.tree ? String(body.tree) : body?.id ? allocations.find(String(body.id))?.root_id : undefined;
            const cleared = allocations.clear(body ?? {}, by);
            if (cleared) ackTree(root);
            return { cleared };
          }
          const r = allocations.set(body ?? {}, by);
          ackTree(r.allocation.root_id);
          return { allocation: r.allocation, warning: r.warning };
        } catch (e) {
          if (e instanceof HttpError) throw e;
          throw new HttpError(400, e instanceof Error ? e.message : String(e));
        }
      },
    ],
    // A manager pauses a tree for cost until a window resets or a set time, or clears it.
    // Permissions match cost_allocate: the human, the chief of staff, or a manager of a
    // tree inside its own tree (src/cost-auth.ts).
    [
      'POST',
      /^\/api\/cost\/pause$/,
      async (_m, body, _u, _r, _l, human) => {
        const by = body?.by ? mustAgent(String(body.by)).id : human ? mail.HUMAN : undefined;
        if (!by) throw new HttpError(403, 'cost_pause needs an agent (by) or the human');
        try {
          return await costPause.costPause({
            root: String(body?.tree ?? ''),
            by,
            until: body?.until != null ? String(body.until) : undefined,
            account: body?.account != null ? String(body.account) : undefined,
            window: body?.window != null ? String(body.window) : undefined,
            reason: body?.reason != null ? String(body.reason) : undefined,
            clear: Boolean(body?.clear),
          });
        } catch (e) {
          throw new HttpError(e instanceof Object && (e as { forbidden?: boolean }).forbidden ? 403 : 400, e instanceof Error ? e.message : String(e));
        }
      },
    ],
    // A manager moves an agent's work to another preset with a handover (cost-switch.ts).
    // Refusals (permission, a blocked account) come back at once; a working agent's switch
    // goes on in the background after its soft-stop, and its outcome reaches the manager.
    [
      'POST',
      /^\/api\/cost\/switch$/,
      async (_m, body, _u, _r, _l, human) => {
        const by = body?.by ? mustAgent(String(body.by)).id : human ? mail.HUMAN : undefined;
        if (!by) throw new HttpError(403, 'cost_switch needs an agent (by) or the human');
        try {
          return await costSwitch.startSwitch({
            agent: String(body?.agent ?? ''),
            preset: String(body?.preset ?? ''),
            by,
            softStopMinutes: body?.soft_stop_minutes != null ? Number(body.soft_stop_minutes) : undefined,
          });
        } catch (e) {
          throw new HttpError(e instanceof Object && (e as { forbidden?: boolean }).forbidden ? 403 : 400, e instanceof Error ? e.message : String(e));
        }
      },
    ],
    // Plain terminals for the human: a shell in tmux, on this machine or a peer's.
    [
      'POST',
      /^\/api\/agents\/([\w-]+)\/prompt$/,
      // The web UI's prompt input: the human's message, pasted into the agent's terminal as
      // typed input. Files are saved next to the agent and named at the end of the message.
      async (m, body, _u, _r, _l, human) => {
        if (!human) throw new HttpError(403, 'only the human types into an agent');
        const a = mustAgent(m[1]);
        if (!tmux.hasSession(a.id)) throw new HttpError(409, `${a.name} isn't running`);
        // The human's choice even when the agent is held: admitted, with a cost:override event.
        // Only an agent taken over by a live successor refuses it.
        const ok = admit(a, 'human');
        if (!ok.ok) throw new HttpError(409, `${a.name} is ${ok.reason}`);
        // Claude Code with vim keys must be in insert mode, or the paste becomes commands.
        if (tmux.capturePane(a.id).includes('-- NORMAL --')) tmux.sendKeys(a.id, 'i');
        await tmux.pasteText(a.id, withUploads(String(body.text ?? ''), body.files, a.id));
        db.addEvent(a.id, 'human:prompt', { chars: String(body.text ?? '').length, files: body.files?.length ?? 0 });
        return { sent: true };
      },
    ],
    [
      'POST',
      /^\/api\/shells\/(sh-[\w]+)\/input$/,
      async (m, body, _u, _r, _l, human) => {
        if (!human) throw new HttpError(403, 'terminals are for the human');
        if (body.machine && body.machine !== MACHINE) {
          const peer = peerByName(String(body.machine));
          if (!peer) throw new HttpError(404, `no peer machine ${body.machine}`);
          return (await peerCall(peer, 'POST', `/api/shells/${m[1]}/input`, { ...body, machine: undefined }, 30_000, relayHuman(peer, human, true, 'a terminal'))).data;
        }
        if (!tmux.hasSession(m[1])) throw new HttpError(404, `no terminal ${m[1]}`);
        await tmux.pasteText(m[1], withUploads(String(body.text ?? ''), body.files, m[1], true));
        return { sent: true };
      },
    ],
    [
      'GET',
      /^\/api\/mail\/([\w-]+)\/attachments\/([^/]+)$/,
      // An attachment's bytes, for showing it in the web UI. Ranges let a video seek.
      (m, _b, _u, res, _l, _h, req) => {
        const f = db.attachment(m[1], decodeURIComponent(m[2]));
        if (!f || !existsSync(f.path)) throw new HttpError(404, 'no such attachment');
        const type = files.typeByExt(f.name);
        const size = statSync(f.path).size;
        const head = { 'content-type': type, 'accept-ranges': 'bytes', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'cache-control': 'private, max-age=86400' };
        const r = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
        if (r && (r[1] || r[2])) {
          const start = r[1] ? Number(r[1]) : Math.max(0, size - Number(r[2]));
          const end = r[1] && r[2] ? Math.min(Number(r[2]), size - 1) : size - 1;
          if (start >= size || start > end) { res.writeHead(416, { 'content-range': `bytes */${size}` }); res.end(); return HANDLED; }
          res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
          createReadStream(f.path, { start, end }).pipe(res);
          return HANDLED;
        }
        res.writeHead(200, { ...head, 'content-length': size });
        createReadStream(f.path).pipe(res);
        return HANDLED;
      },
    ],
    [
      'GET',
      /^\/api\/files\/(list|read)$/,
      // The human's view of files on this machine or a peer (S-1525), inside `files.roots` and past the
      // fixed deny list (src/files.ts). Another host is forwarded over the peer token as the human; a
      // peer that is down answers {state:'stopped'} so the UI can offer Start instead of hanging.
      async (m, _b, url, res, _l, human, req) => {
        if (!human) throw new HttpError(403, `only the human can read files, ${humanWays()}`);
        const host = url.searchParams.get('host') || MACHINE;
        const path = url.searchParams.get('path') ?? '';
        const all = url.searchParams.get('all') === '1';
        if (host !== MACHINE) {
          const peer = peerByName(host);
          if (!peer) throw new HttpError(404, `no machine ${host}`);
          const up = await peerRaw(peer, `/api/files/${m[1]}?path=${encodeURIComponent(path)}${all ? '&all=1' : ''}`, req.headers.range ? { range: String(req.headers.range) } : {}, relayHuman(peer, human, true, 'a file'));
          if (!up) {
            res.writeHead(503, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ state: 'stopped', host, error: `${host} is stopped` }));
            return HANDLED;
          }
          // A body fetch decoded keeps no length of the encoded one.
          const keep = ['content-type', ...(up.headers.get('content-encoding') ? [] : ['content-length']), 'content-range', 'content-disposition', 'x-stam-size', 'x-stam-truncated'];
          res.writeHead(up.status, { ...files.SAFE_HEADERS, ...Object.fromEntries(keep.flatMap((k) => (up.headers.get(k) ? [[k, up.headers.get(k)!]] : []))) });
          try {
            for await (const chunk of (up.body ?? []) as any) {
              if (res.destroyed) break;
              if (!res.write(chunk)) await new Promise<void>((r) => (res.once('drain', r), res.once('close', r)));
            }
          } catch {}
          res.end();
          return HANDLED;
        }
        try {
          const roots = files.realRoots(settings().files.roots);
          if (!path) return { host, ...files.listRoots(roots) };
          const real = files.resolveIn(path, roots);
          if (m[1] === 'list') return { host, path: real, entries: files.listDir(real) };
          files.serve(req, res, real, all, roots);
          return HANDLED;
        } catch (e) {
          if (e instanceof files.FilesError) throw new HttpError(e.status, e.message);
          throw e;
        }
      },
    ],
    [
      'GET',
      /^\/api\/diff(\/file|\/repos)?$/,
      // The human's PR diff (S-1530, src/diff.ts), built from git on the ITSA home. Another machine's daemon
      // forwards there over the peer token as the human, as the Files API does for a peer.
      async (m, _b, url, res, _l, human) => {
        if (!human) throw new HttpError(403, `only the human can read diffs, ${humanWays()}`);
        const kind = m[1] === '/file' ? 'file' : m[1] === '/repos' ? 'repos' : 'list';
        const itsaHome = settings().itsa.home ?? MACHINE;
        if (itsaHome !== MACHINE) {
          const peer = peerByName(itsaHome);
          if (!peer) throw new HttpError(503, `ITSA home '${itsaHome}' is not a configured peer`);
          const up = await peerRaw(peer, `/api/diff${m[1] ?? ''}${url.search}`, {}, relayHuman(peer, human, true, 'a diff'));
          if (!up) throw new HttpError(503, `${itsaHome} (the ITSA home) is stopped`);
          const keep = ['content-type', ...(up.headers.get('content-encoding') ? [] : ['content-length']), 'content-disposition', 'x-stam-size', 'x-stam-sha', 'x-stam-head', 'x-stam-base', 'x-stam-truncated'];
          res.writeHead(up.status, { ...files.SAFE_HEADERS, 'accept-ranges': 'none', ...Object.fromEntries(keep.flatMap((k) => (up.headers.get(k) ? [[k, up.headers.get(k)!]] : []))) });
          try {
            for await (const chunk of (up.body ?? []) as any) {
              if (res.destroyed) break;
              if (!res.write(chunk)) await new Promise<void>((r) => (res.once('drain', r), res.once('close', r)));
            }
          } catch {}
          res.end();
          return HANDLED;
        }
        try {
          const out = await diff.request(kind, human, url.searchParams, res);
          return out ?? HANDLED;
        } catch (e) {
          if (e instanceof diff.DiffError) throw new HttpError(e.status, e.message);
          throw e;
        }
      },
    ],
    [
      'GET',
      /^\/api\/decl$/,
      // Go to declaration (S-1532, src/decl.ts): the declaration index lives on the ITSA home with the diff cache,
      // so another machine's daemon forwards there as the human, as /api/diff does. 202 while the index builds.
      async (_m, _b, url, res, _l, human) => {
        if (!human) throw new HttpError(403, `only the human can look up declarations, ${humanWays()}`);
        const itsaHome = settings().itsa.home ?? MACHINE;
        let status: number;
        let body: unknown;
        if (itsaHome !== MACHINE) {
          const peer = peerByName(itsaHome);
          if (!peer) throw new HttpError(503, `ITSA home '${itsaHome}' is not a configured peer`);
          const up = await peerRaw(peer, `/api/decl${url.search}`, {}, relayHuman(peer, human, true, 'a declaration lookup'));
          if (!up) throw new HttpError(503, `${itsaHome} (the ITSA home) is stopped`);
          status = up.status;
          body = await up.json().catch(() => ({ error: `HTTP ${up.status} from ${itsaHome}` }));
        } else {
          try {
            ({ status, body } = await decl.request(human, url.searchParams));
          } catch (e) {
            if (e instanceof decl.DeclError) throw new HttpError(e.status, e.message);
            throw e;
          }
        }
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
        return HANDLED;
      },
    ],
    [
      'POST',
      /^\/api\/cos\/(start|stop)$/,
      // start: runs one from the cos type if none is active. stop: shuts the active one down.
      async (m, _body, _u, _r, _l, human) => {
        if (!human) throw new HttpError(403, 'only the human starts or stops the chief of staff this way');
        if (m[1] === 'start') return startCos();
        const cos = org.chiefOfStaff();
        if (!cos) throw new HttpError(404, 'no chief of staff is active');
        await lifecycle.shutdown(cos, true);
        return db.getAgent(cos.id)!;
      },
    ],
    ['GET', /^\/api\/assistant$/, () => ({ agent: assistantAgent() ?? null, config: settings().assistant })],
    [
      'POST',
      /^\/api\/assistant\/(message|start|replace)$/,
      // message: the human's message from the prompt input, with what they were looking at.
      // start: makes sure it runs. replace: retires the current one and starts a new one with
      // the settings, since a running agent can't change harness or model.
      async (m, body, _u, _r, _l, human) => {
        if (!human) throw new HttpError(403, 'only the human talks to the assistant this way');
        if (m[1] === 'start') return messageAssistant();
        if (m[1] === 'replace') {
          const old = assistantAgent();
          if (old) {
            if (old.lifecycle === 'active' || old.lifecycle === 'paused') await lifecycle.shutdown(old, true);
            let name = `${old.name}-old`;
            for (let i = 2; db.getAgent(name); i++) name = `${old.name}-old-${i}`;
            db.updateAgent(old.id, { kind: null, name, role: 'Former executive assistant' });
          }
          return startAssistant();
        }
        let text = withUploads(String(body.text ?? ''), body.files, 'assistant');
        if (body.context) text += `\n\n[stam: your user sent this from the prompt input while looking at ${String(body.context).slice(0, 300)}.]`;
        // The same system notes as mail from the human carries (S-1462, S-1474): sent without a pick, and what the main world showed.
        if (body.routing_uncertain === true) text += `\n\n[stam: ${render('routing-uncertain', {})}]`;
        const at = lookingAtNote(body.looking_at);
        if (at) text += `\n\n[stam: ${at}]`;
        return messageAssistant(text);
      },
    ],
    // A one-time ticket for a browser socket (S-742): the socket carries `?ticket=` instead of the token.
    [
      'POST',
      /^\/api\/tickets$/,
      async (_m, body, _u, _res, _l, human, req) => {
        if (!human) throw new HttpError(403, 'sockets are for the human');
        const kind = String(body.kind ?? '') as TicketKind;
        const path = String(body.path ?? '');
        if (!TICKET_KINDS.includes(kind)) throw new HttpError(400, `kind must be one of ${TICKET_KINDS.join(', ')}`);
        if (!/^\/api\/(agents|shells)\/[\w-]+\/tty$/.test(path)) throw new HttpError(400, 'path must be a terminal socket path');
        return issueTicket(kind, path, trustedHuman(req, owner));
      },
    ],
    ['GET', /^\/api\/shells$/, () => tmux.listShells()],
    [
      'POST',
      /^\/api\/shells$/,
      async (_m, body, _u, _r, _l, human) => {
        if (!human) throw new HttpError(403, 'terminals are for the human');
        if (body.machine && body.machine !== MACHINE) {
          const peer = peerByName(String(body.machine));
          if (!peer) throw new HttpError(404, `no peer machine ${body.machine}`);
          const r = await peerCall(peer, 'POST', '/api/shells', { cwd: body.cwd }, 10_000, relayHuman(peer, human, true, 'a terminal'));
          if (r.status !== 200) throw new HttpError(r.status, r.data?.error ?? 'peer failed');
          return r.data;
        }
        const cwd = String(body.cwd ?? homedir()).replace(/^~(?=$|\/)/, homedir());
        return tmux.newShell(existsSync(cwd) ? cwd : homedir());
      },
    ],
    [
      'POST',
      /^\/api\/shells\/(sh-[\w]+)\/kill$/,
      async (m, body, _u, _r, _l, human) => {
        if (!human) throw new HttpError(403, 'terminals are for the human');
        if (body.machine && body.machine !== MACHINE) {
          const peer = peerByName(String(body.machine));
          if (!peer) throw new HttpError(404, `no peer machine ${body.machine}`);
          return (await peerCall(peer, 'POST', `/api/shells/${m[1]}/kill`, {}, 10_000, relayHuman(peer, human, true, 'a terminal'))).data;
        }
        tmux.killSession(m[1]);
        return { killed: m[1] };
      },
    ],
    ['GET', /^\/api\/rings$/, () => ring.status()],
    ['GET', /^\/api\/rings\/([\w-]+)$/, (m) => ring.status(m[1])],
    [
      'POST',
      /^\/api\/rings$/,
      async (_m, body, _u, _r, _l, human) => {
        const createdBy = body.by ? mustAgent(String(body.by)).id : human ? mail.HUMAN : undefined;
        if (!createdBy) throw new HttpError(403, 'a ring needs a creator');
        return (await startRing({ ...body, name: String(body.name), topic: String(body.topic ?? ''), format: String(body.format ?? 'rounds') }, createdBy, human)).ring;
      },
    ],
    [
      'POST',
      /^\/api\/rings\/([\w-]+)\/(submit|decide)$/,
      (m, body) => {
        const by = mustAgent(String(body.by)).id;
        try {
          return { result: m[2] === 'submit' ? ring.submit(m[1], by, String(body.text ?? ''), Boolean(body.agree), body.verdict == null ? undefined : String(body.verdict)) : ring.decide(m[1], by, Boolean(body.continue), String(body.text ?? '')) };
        } catch (e) {
          throw new HttpError(409, e instanceof Error ? e.message : String(e));
        }
      },
    ],
    // Decision steps; the API's shape is in src/steps.ts. `decisions` before the :id routes.
    ['GET', /^\/api\/steps$/, () => ({ steps: steps.list(), events: steps.EVENTS })],
    ['POST', /^\/api\/steps$/, (_m, body) => stepRoute(() => steps.create(body ?? {}))],
    // A tool call's check, before the tool runs (mcp.ts). The agent is named in the body and
    // must be registered. An agent's token may check only as itself (actor, S-238; S-117): with no
    // agent named, the token's own agent checks (S-271).
    ['POST', /^\/api\/steps\/check$/, async (_m, body, _u, _r, _l, _h, _q, caller) => {
      const named = body?.agent ?? (caller.kind === 'agent' ? caller.agent : undefined);
      if (typeof named !== 'string' || typeof body?.tool !== 'string') throw new HttpError(400, 'a check needs agent and tool');
      const a = mustAgent(String(actor(caller, named)));
      return steps.checkTool(a.id, body.tool, body.args && typeof body.args === 'object' ? body.args : {});
    }],
    // Requirement checks for subjects on a non-home daemon (src/req-check.ts): peers only.
    ['POST', /^\/api\/requirements\/check-subject$/, (_m, body, _u, _r, local) => {
      if (!local) throw new HttpError(403, 'only a peer can forward a subject');
      return { accepted: reqCheck.acceptForwarded(body?.subject) };
    }],
    ['POST', /^\/api\/requirements\/check-tool$/, (_m, body, _u, _r, local) => {
      if (!local) throw new HttpError(403, 'only a peer can ask for a tool check');
      return reqCheck.toolFromPeer(body);
    }],
    ['GET', /^\/api\/requirements\/enforced-tools$/, (_m, _b, _u, _r, local) => {
      if (!local) throw new HttpError(403, 'only a peer can read the enforced-tools index');
      return { tools: reqCheck.enforcedToolsList() };
    }],
    ['POST', /^\/api\/requirements\/enforced-tools\/changed$/, (_m, _b, _u, _r, local) => {
      if (!local) throw new HttpError(403, 'only a peer can say the index changed');
      void reqCheck.fetchRemoteIndex();
      return { scheduled: true };
    }],
    ['GET', /^\/api\/steps\/decisions$/, (_m, _b, url) => ({ decisions: steps.decisionsOn(String(url.searchParams.get('subject') ?? ''), Number(url.searchParams.get('limit')) || 100) })],
    ['GET', /^\/api\/steps\/([\w-]+)$/, (m) => stepRoute(() => steps.must(m[1]))],
    ['PATCH', /^\/api\/steps\/([\w-]+)$/, (m, body) => stepRoute(() => steps.update(m[1], body ?? {}))],
    [
      'DELETE',
      /^\/api\/steps\/([\w-]+)$/,
      (m) =>
        stepRoute(() => {
          steps.remove(m[1]);
          return { removed: m[1] };
        }),
    ],
    ['POST', /^\/api\/steps\/([\w-]+)\/preview$/, (m, body) => stepRoute(() => steps.preview(m[1], Number(body?.n) || 5))],
    ['GET', /^\/api\/steps\/([\w-]+)\/log$/, (m, _b, url) => stepRoute(() => ({ decisions: steps.log(steps.must(m[1]).id, Number(url.searchParams.get('limit')) || 100) }))],
    // The process designer's read (S-869, step 2): every process under processes/ with the live
    // count of open ITSAs at each node that names statuses (src/process.ts, processRoute). Its
    // counts come from the ITSAs, so a peer proxies the path to the ITSA home, as it does theirs.
    ['GET', /^\/api\/processes$/, () => processRoute()],
    // Save an edited process as a proposal (S-1084, S-1085): a branch, a PR and a needs_approval ITSA. The human saves
    // from the editor; an agent calls the process_propose tool, which lands here with `by` the calling agent. Either way
    // the proposal waits for the human's Approve: onProposalStatus acts on no one else's.
    [
      'POST',
      /^\/api\/processes\/([\w-]+)\/proposal$/,
      (m, body, _u, _r, _l, human) =>
        itsaRoute(async () => {
          const by = human ? mail.HUMAN : itsaActor(body, human);
          if (!human && typeof body?.base !== 'string') throw new HttpError(400, 'an agent\'s proposal needs base: the exact text of the process file it edited from (an empty string for a new process)');
          try {
            return await processProposal.propose({ process: m[1], yaml: body?.yaml, summary: body?.summary, base: body?.base, by }, undefined, undefined, processesHere().processes.map((p) => p.id));
          } catch (e) {
            if (e instanceof processProposal.ProposalError) throw new HttpError(e.status, e.message);
            throw e;
          }
        }),
    ],
    // ITSAs (issue management). Every ITSA lives on its home daemon (settings.itsa.home);
    // on any other daemon these are proxied to it below, before the routes run.
    [
      'GET',
      /^\/api\/itsas$/,
      (_m, _b, url) =>
        itsaRoute(() =>
          itsa.list({
            parent: url.searchParams.get('parent') ?? undefined,
            subtree: url.searchParams.get('subtree') ?? undefined,
            status: url.searchParams.get('status') ?? undefined,
            category: url.searchParams.get('category') ?? undefined,
            owner: url.searchParams.get('owner') ?? undefined,
            participant: url.searchParams.get('participant') ?? undefined,
            kind: url.searchParams.get('kind') ?? undefined,
            text: url.searchParams.get('text') ?? url.searchParams.get('q') ?? undefined,
          }),
        ),
    ],
    [
      'POST',
      /^\/api\/itsas$/,
      (_m, body, _u, _r, _l, human, _q, caller) => {
        // The ITSA's thread is stam's to start, with the first post (S-480): from an agent, a thread_id
        // would alias another ITSA's thread, to read and post there through this one.
        if ((caller.kind === 'agent' || caller.kind === 'opencode') && body?.thread_id !== undefined) throw new HttpError(403, 'thread_id is set only by stam');
        return itsaRoute(() => itsa.create({ ...body, by: itsaActor(body, human) }));
      },
    ],
    // ITSA fields (S-364): the shared column definitions. Before the :id routes, which would read `fields` as a key.
    ['GET', /^\/api\/itsas\/fields$/, () => itsaRoute(() => itsa.fields())],
    ['POST', /^\/api\/itsas\/fields$/, (_m, body, _u, _r, _l, human) => itsaRoute(() => itsa.createField(body ?? {}, itsaActor(body, human)))],
    ['POST', /^\/api\/itsas\/fields\/order$/, (_m, body, _u, _r, _l, human) => itsaRoute(() => itsa.reorderFields(body?.order ?? body?.ids, itsaActor(body, human)))],
    ['PATCH', /^\/api\/itsas\/fields\/([\w-]+)$/, (m, body, _u, _r, _l, human) => itsaRoute(() => itsa.updateField(m[1], body ?? {}, itsaActor(body, human)))],
    ['DELETE', /^\/api\/itsas\/fields\/([\w-]+)$/, (m, body, _u, _r, _l, human) => itsaRoute(() => itsa.removeField(m[1], itsaActor(body, human)))],
    // The status set and its categories, for pickers and board columns. Before the :id route,
    // which would read `statuses` as a key.
    ['GET', /^\/api\/itsas\/statuses$/, () => ({ categories: itsa.CATEGORIES, statuses: itsa.statuses() })],
    // Search by meaning over the ITSAs (itsa-search.ts). Before the :id route, which would read `search` as a key.
    // `kind` limits the search to those kinds, comma-separated; `open=1` drops closed ITSAs; `offset` pages
    // the ranked results (the retro search's own).
    [
      'GET',
      /^\/api\/itsas\/search$/,
      (_m, _b, url) =>
        itsaRoute(() =>
          searchItsas(url.searchParams.get('q') ?? '', {
            limit: Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 10))),
            kinds: (url.searchParams.get('kind') ?? '')
              .split(',')
              .map((k) => k.trim())
              .filter(Boolean),
            open: url.searchParams.get('open') === '1',
            offset: Math.max(0, Number(url.searchParams.get('offset') ?? 0)),
          }),
        ),
    ],
    // The merge queue (S-40): ready_to_merge ITSAs with a branch link, each with the branch's facts.
    ['GET', /^\/api\/itsas\/queue$/, (_m, _b, _u, _r, _l, _h, _q, caller) => { notAgentToken(caller, 'read the merge queue'); return itsaRoute(() => itsaQueue.queue()); }],
    // The agents in at least one open ITSA, for the web tree's "not in any ITSA" mark.
    ['GET', /^\/api\/itsas\/open-agents$/, () => itsa.openAgentIds()],
    // From a peer that spawned an agent with no `itsa`: it joins its parent's open ITSA.
    [
      'POST',
      /^\/api\/itsas\/join-parent$/,
      (_m, body, _u, _r, local) => {
        if (!local) throw new HttpError(403, 'only a peer can join an agent to an ITSA');
        const agent = String(body?.agent ?? '');
        const parent = String(body?.parent ?? '');
        if (!agent || !parent) throw new HttpError(400, 'join-parent needs agent and parent');
        return itsaRoute(async () => ({ key: await itsaOwners.joinParentLocal(agent, parent, String(body?.by ?? '')) }));
      },
    ],
    // From a peer that spawned a reviewer for an ITSA: it joins as a participant, the owner unchanged.
    [
      'POST',
      /^\/api\/itsas\/join$/,
      (_m, body, _u, _r, local, _h, _q, caller) => {
        if (!local) throw new HttpError(403, 'only a peer can join an agent to an ITSA');
        const ref = String(body?.itsa ?? '');
        const agent = String(body?.agent ?? '');
        if (!ref || !agent) throw new HttpError(400, 'join needs itsa and agent');
        return itsaRoute(async () => {
          itsaOwners.mayAssign(ref, viaOf(caller));
          await itsa.addParticipant(ref, agent, String(body?.by ?? ''));
          return { ok: true };
        });
      },
    ],
    // The ITSAs waiting on the human, oldest first, with their actions.
    // What the human is asked to decide: not an agent's to read (S-587).
    ['GET', /^\/api\/itsas\/attention$/, (_m, _b, _u, _r, _l, _h, _q, caller) => { notAgentToken(caller, 'read what waits on the human'); return itsaRoute(() => itsaHuman.attention()); }],
    // The agents' mail to the human that holds a decision and waits for their reply (decision-mail.ts).
    ['GET', /^\/api\/mail\/decisions$/, async (_m, _b, _u, _r, local, _h, _q, caller) => decisionMailsAll(local, viaOf(caller))],
    // The open waits on the human this daemon holds (S-637): auto-archive asks every daemon for them.
    ['GET', /^\/api\/mail\/human-waits$/, (_m, _b, _u, _r, _l, _h, _q, caller) => { notAgentToken(caller, 'read what waits on the human'); return waits.openHumanWaits(); }],
    // From a peer that holds the agent: its owner stopped, or it was archived or forgotten.
    [
      'POST',
      /^\/api\/itsas\/owner-stopped$/,
      async (_m, body, _u, _r, local) => {
        // Only a peer reports a stop, and only for an agent it holds that really stopped.
        return holderRoute(() => itsaOwners.guardPeerReport(local, String(body?.id), ['active', 'paused', 'shut_down', 'archived'], 'that agent can report its stop', () => itsaOwners.stopped({ id: String(body.id), name: String(body.name) }, String(body.what))));
      },
    ],
    // A peer's cascade over the children this machine holds of an archived agent (S-1378).
    [
      'POST',
      /^\/api\/archive-children$/,
      async (_m, body, _u, _r, local, _human, _q, caller) => {
        if (!local || caller.kind === 'agent' || caller.kind === 'opencode') throw new HttpError(403, 'only a peer runs the archive cascade this way');
        const parents = (Array.isArray(body?.parents) ? body.parents : []).map(String).filter(Boolean);
        if (!parents.length) throw new HttpError(400, 'parent ids are needed');
        return lifecycle.cascadeForPeer(parents, (Array.isArray(body?.fallback) ? body.fallback : []).map(String));
      },
    ],
    [
      'POST',
      /^\/api\/itsas\/unown-agent$/,
      async (_m, body, _u, _r, local) => {
        const how = body?.how === 'forgotten' ? 'forgotten' : 'archived';
        return holderRoute(() => itsaOwners.guardPeerReport(local, String(body?.id), how === 'forgotten' ? ['shut_down', 'archived'] : ['archived'], 'that archived agent can unown its ITSAs', () => itsaOwners.unownLocal({ id: String(body.id), name: String(body.name), parent: typeof body.parent === 'string' ? body.parent : null }, how)));
      },
    ],
    ['GET', /^\/api\/itsas\/([\w-]+)$/, (m) => itsaRoute(() => itsa.get(m[1]))],
    ['GET', /^\/api\/itsas\/([\w-]+)\/cost$/, (m, _b, _u, _r, _l, _h, _q, caller) => { notAgentToken(caller, "read an ITSA's cost"); return itsaRoute(() => itsaCost(m[1], { display: displayCtx() })); }],
    [
      'PATCH',
      /^\/api\/itsas\/([\w-]+)$/,
      (m, body, _u, _r, _l, human, _q, caller) =>
        itsaRoute(async () => {
          // `action` is recorded only by the human's act route (itsa-human.ts), never from a request.
          const { action: _action, system: _system, ...fields } = body ?? {};
          const by = itsaActor(body, human);
          // An agent changes only an ITSA it belongs to, so it can't add itself as a participant (S-480);
          // and only the chief of staff or the assistant opens an ITSA to every agent, or closes one, by its kind.
          mayActOnItsa(caller, by, m[1]!, 'edit');
          if ((caller.kind === 'agent' || caller.kind === 'opencode') && fields.kind !== undefined && visibility.isOpenBoard(fields.kind) !== visibility.isOpenBoard(itsa.must(m[1]).kind) && !caller.boss && org.chiefOfStaff()?.id !== by && !isAssistant(by))
            throw new HttpError(403, `only the chief of staff or the assistant makes an ITSA a retro item or feedback report, or turns one into another kind`);
          const r = await itsa.set(m[1], fields, by);
          // Closing a project or initiative offers its epic retro (S-163), in the same result.
          const offer = r.changes.status && itsa.isClosedStatus(r.itsa.status) ? await retroDigest.epicRetroOffer(r.itsa) : null;
          return offer ? { ...r, retro_offer: offer } : r;
        }),
    ],
    [
      // The human acts on an ITSA waiting on them: { action, text }.
      'POST',
      /^\/api\/itsas\/([\w-]+)\/act$/,
      (m, body, _u, _r, _l, human) => {
        if (!human) throw new HttpError(403, 'only the human acts on an ITSA that waits on them');
        return itsaRoute(() => itsaHuman.act(m[1], String(body?.action ?? ''), String(body?.text ?? '')));
      },
    ],
    [
      'POST',
      /^\/api\/itsas\/([\w-]+)\/post$/,
      (m, body, _u, _r, local, human, _q, caller) =>
        itsaRoute(() => {
          // Only stam posts as stam: the daemon itself, or a peer's daemon forwarding its post (S-480).
          if (body?.from_stam !== undefined && !(local && caller.kind === 'shared')) throw new HttpError(403, 'from_stam is set only by stam');
          const by = itsaActor(body, human);
          mayActOnItsa(caller, by, m[1]!, 'post');
          return itsa.post(m[1], { ...body, by });
        }),
    ],
    [
      // The ITSA's thread for the UI: its mails (from every daemon holding a part) and its
      // status and owner changes as one-line events, merged by time.
      'GET',
      /^\/api\/itsas\/([\w-]+)\/thread$/,
      (m, _b, url, _r, _l, _h, _q, caller) =>
        itsaRoute(async () => {
          const x = itsa.must(m[1]);
          mayReadItsaThreads(caller, x.id, url.searchParams.get('as'));
          // Always fans out: a proxied request arrives here marked local, but the parts of the thread are on other daemons.
          // ?local=1 reads this daemon's copy only: the merge gate (S-1490) asks the ITSA home, where its thread is posted, and a peer's failure must not hide a mail.
          const mails = x.thread_id ? [...db.threadMail(x.thread_id), ...(url.searchParams.get('local') === '1' ? [] : await fanOut<db.ThreadMail>(`/api/threads/${x.thread_id}`))] : [];
          return { itsa: { id: x.id, key: x.key, title: x.title, thread_id: x.thread_id }, items: itsa.mergeThread(mails, itsa.threadEvents(x.id)) };
        }),
    ],
    [
      // The mail threads about an ITSA (its view's Mail section), from every daemon holding a part,
      // without its own thread.
      'GET',
      /^\/api\/itsas\/([\w-]+)\/threads$/,
      (m, _b, url, _r, _l, _h, _q, caller) =>
        itsaRoute(async () => {
          const x = itsa.must(m[1]);
          mayReadItsaThreads(caller, x.id, url.searchParams.get('as'));
          const groups = db.foldThreads([...db.aboutItsaThreads(x.id), ...(await fanOut<{ thread_id: string; mails: db.ThreadMail[] }>(`/api/threads/about/${x.id}`))]);
          return itsa.aboutThreads(groups, x.thread_id);
        }),
    ],
    [
      // The +1 count alone (S-796): a +1 on a retro item or feedback report must never make the
      // caller read its thread, which the OpenCode server must name an agent for and only a
      // participant of the item may read. On the open board any agent reads the count, as any may
      // +1 there; elsewhere it stays with those who may read the threads. The answer is the number
      // alone, never thread content.
      'GET',
      /^\/api\/itsas\/([\w-]+)\/plus-ones$/,
      (m, _b, url, _r, _l, _h, _q, caller) =>
        itsaRoute(() => {
          const x = itsa.must(m[1]);
          if (!visibility.isOpenBoard(x.kind)) mayReadItsaThreads(caller, x.id, url.searchParams.get('as'));
          return { count: retroLoop.plusOnesOf(x) };
        }),
    ],
    [
      // The PR relay (S-514): opens a branch's PR where gh runs, the ITSA home. An agent without gh (on storage) calls pr_open, which lands here.
      'POST',
      /^\/api\/pr\/open$/,
      (_m, body, _u, _r, _l, human, _q, caller) =>
        itsaRoute(async () => {
          const by = itsaActor(body, human);
          // The OpenCode server names its agent (`by`, verified in resolveActors), so it is judged as that agent, not as the shared token (S-581).
          const via = viaBox(caller, caller.kind === 'opencode' ? by : undefined);
          // On a machine that isn't the ITSA home, the home fetches the branch from this machine's origin: push it first (S-667).
          const me = by ? db.getAgent(by) : undefined;
          if (me?.machine === MACHINE) await prOpen.pushOwnBranch(me.cwd, String(body?.branch ?? ''), via);
          const pr = await prOpen.openPrRouted({ branch: body?.branch, title: body?.title, body: body?.body, itsa: body?.itsa, by }, via);
          // A note, not a refusal (S-1662, S-1706): the PR is fine, but the agent's tests ran against stale deps, so they are relinked here. Only the caller's own worktree is touched.
          const warning = me?.machine === MACHINE && me.cwd ? await prOpenDepsRelink(me.cwd) : '';
          return warning ? { ...pr, warning } : pr;
        }),
    ],
    [
      // What a caller that timed out on pr_open finds on GitHub (S-1332): read-only, so it's safe to ask again.
      'POST',
      /^\/api\/pr\/open-status$/,
      (_m, body, _u, _r, _l, human, _q, caller) =>
        itsaRoute(async () => {
          const by = itsaActor(body, human);
          const via = viaBox(caller, caller.kind === 'opencode' ? by : undefined);
          return prOpen.prStatusRouted({ branch: body?.branch, body: body?.body, itsa: body?.itsa, by }, via);
        }),
    ],
    [
      // The verdict relay (S-1061): a reviewer without gh posts its stam/review verdict; the ITSA home runs pr-review.mjs as that reviewer.
      'POST',
      /^\/api\/pr\/review$/,
      (_m, body, _u, _r, _l, _h, _q, caller) =>
        reviewRoute(() => {
          prReview.assertPeerCaller(caller);
          // The reviewer is the caller's agent, as pr_open's (viaBox); a body's name is never the reviewer.
          const via = viaBox(caller, caller.kind === 'opencode' ? String(body?.by ?? '') || undefined : undefined);
          return prReview.reviewPrRouted({ pr: body?.pr, verdict: body?.verdict, summary: body?.summary, head: body?.head }, via);
        }),
    ],
    [
      // The ITSA home's verdict on a push to a peer's origin (S-684): rules 1 and 2, before pr_open pushes the branch.
      'POST',
      /^\/api\/pr\/push-check$/,
      (_m, body, _u, _r, _l, human, _q, caller) =>
        itsaRoute(async () => {
          const by = itsaActor(body, human);
          const via = viaBox(caller, caller.kind === 'opencode' ? by : undefined);
          if (via && !via.boss) await prOpen.pushCheckHere(String(body?.branch ?? ''), via);
          return { ok: true };
        }),
    ],
    [
      // The default GitHub repo for a bare PR number (S-614): asked of the ITSA home, so a peer's watch_pr gets the home's.
      'GET',
      /^\/api\/pr\/github-repo$/,
      async () => ({ github: await prOpen.githubRepoRouted() }),
    ],
    [
      // Who owns a branch, from this daemon's agents, for the daemon that asks (S-581): the answer is relative to `agent`.
      'GET',
      /^\/api\/pr\/branch-scope$/,
      (_m, _b, url, _r, local) => {
        if (!local) throw new HttpError(403, 'only a peer can ask who owns a branch');
        return { scope: branchScope.localScope(url.searchParams.get('agent') ?? '', url.searchParams.get('branch') ?? '') };
      },
    ],
    [
      'POST',
      /^\/api\/itsas\/([\w-]+)\/links$/,
      (m, body, _u, _r, _l, human, _q, caller) =>
        itsaRoute(async () => {
          const by = itsaActor(body, human);
          mayActOnItsa(caller, by, m[1]!, 'edit');
          // An agent links a branch only if no other agent's worktree owns it (S-581): a link must not open pr_open's push to it.
          if (body?.system === 'branch' && (caller.kind === 'agent' || caller.kind === 'opencode') && !caller.boss && org.chiefOfStaff()?.id !== by && !isAssistant(by)) {
            const why = await branchScope.linkRefusal(viaBox(caller, caller.kind === 'opencode' ? by : undefined) ?? { agent: by, boss: false }, String(body.external_id ?? ''));
            if (why) throw new HttpError(403, why);
          }
          return itsa.addLink(m[1], body ?? {}, by);
        }),
    ],
    [
      // Records a branch link's review, tests, and screenshots (S-40); each field replaces its part.
      'PATCH',
      /^\/api\/itsas\/([\w-]+)\/links\/(\d+)$/,
      (m, body, _u, _r, _l, human, _q, caller) =>
        itsaRoute(() => {
          const by = itsaActor(body, human);
          mayActOnItsa(caller, by, m[1]!, 'edit');
          return itsa.recordLink(m[1], Number(m[2]), body ?? {}, by);
        }),
    ],
    [
      'DELETE',
      /^\/api\/itsas\/([\w-]+)\/links\/(\d+)$/,
      (m, body, _u, _r, _l, human, _q, caller) =>
        itsaRoute(() => {
          const by = itsaActor(body, human);
          mayActOnItsa(caller, by, m[1]!, 'edit');
          return itsa.removeLink(m[1], Number(m[2]), by);
        }),
    ],
    // Requirements (S-461, step 1: storage and reads). Off unless
    // settings.requirements.enabled, checked before any proxy or table exists. They live on the
    // ITSA home, like the ITSAs, and are proxied there below. No checks, MCP tools, or UI yet.
    [
      'GET',
      /^\/api\/requirements$/,
      (_m, _b, url) =>
        reqRoute(() =>
          requirements.list({
            parent: url.searchParams.get('parent') ?? undefined,
            status: url.searchParams.get('status') ?? undefined,
            text: url.searchParams.get('text') ?? url.searchParams.get('q') ?? undefined,
            latest: url.searchParams.get('verdicts') === 'latest',
          }),
        ),
    ],
    [
      'POST',
      /^\/api\/requirements$/,
      (_m, body, _u, _r, _l, human) =>
        reqRoute(async () => {
          const by = itsaActor(body, human);
          const r = await requirements.create({ ...(body ?? {}), by });
          // A draft an agent wrote reaches the human's attention list as an ask (src/req-approval.ts).
          if (by && by !== mail.HUMAN && r.status === 'draft') {
            const a = await reqApproval.ask(r, (await itsa.person(by)) ?? by);
            return { ...r, approval: 'key' in a ? { itsa: a.key, to: a.to } : { error: a.error } };
          }
          return r;
        }),
    ],
    // A batch of drafts, parents first ({requirements: [...]}, `stam req seed`), with one approval
    // ask for the whole batch when an agent made it (src/req-approval.ts askBatch).
    [
      'POST',
      /^\/api\/requirements\/batch$/,
      (_m, body, _u, _r, _l, human) =>
        reqRoute(async () => {
          const by = itsaActor(body, human);
          const made = await requirements.createBatch((body ?? {}).requirements, by);
          const actor = (await itsa.person(by)) ?? mail.HUMAN;
          if (actor === mail.HUMAN) return { requirements: made };
          const a = await reqApproval.askBatch(made, actor);
          return { requirements: made, approval: 'key' in a ? { itsa: a.key, to: a.to } : { error: a.error } };
        }),
    ],
    // The batch behind an approval ITSA (key or id): each draft with its text and rationale, for the
    // human's list to drop items from (src/req-approval.ts batchOf).
    ['GET', /^\/api\/requirements\/asks\/([\w-]+)$/, (m) => reqRoute(() => {
      const b = reqApproval.batchOf(m[1]);
      if (!b) throw new Error(`no requirement approval ${m[1]}`);
      return { itsa: b.itsa.key, items: b.items };
    })],
    // The human drops one draft from the batch, keeping it a draft or marking it obsolete too, at the
    // rev shown (if_rev). Only the human as trustedHuman proves it: a shared token with x-stam-human
    // proves nothing, and a peer's request doesn't come from the human's loopback, so it's refused.
    ['POST', /^\/api\/requirements\/asks\/([\w-]+)\/drop$/, (m, body, _u, _r, _l, _h, req) => reqRoute(async () => {
      if (!trustedHuman(req as IncomingMessage, owner)) throw new HttpError(403, `only the human drops a draft from an approval, ${humanWays(`${MACHINE}'s Tailscale address`)}`);
      const ifRev = (body ?? {}).if_rev;
      if (!Number.isInteger(ifRev)) throw new HttpError(400, 'if_rev is the rev of the draft shown, a whole number');
      await reqApproval.dropFromBatch(m[1], String((body ?? {}).key ?? ''), (body ?? {}).obsolete === true, ifRev);
      return { items: reqApproval.batchOf(m[1])?.items ?? [] };
    })],
    // A waiver on a verdict: false_positive or accepted_deviation, with a reason.
    ['POST', /^\/api\/requirements\/waivers$/, (_m, body, _u, _r, _l, human) => reqRoute(() => requirements.waive({ ...(body ?? {}), by: itsaActor(body, human) }))],
    // Whether requirements are on, for the MCP shim to list its tools; not gated by the feature.
    ['GET', /^\/api\/req-enabled$/, () => ({ enabled: requirements.enabled() })],
    // A check on demand: {text} or {subject: mail:ID | itsa:KEY | branch:REPO/NAME}, optional keys.
    // Records verdicts and tells nobody (src/req-check.ts manual).
    ['POST', /^\/api\/requirements\/check$/, (_m, body) => reqRoute(() => reqCheck.manual(body ?? {}))],
    // The requirement on the last n (default 20, at most 50) real subjects of its scope: the verdict
    // per subject. Records nothing, tells nobody; cost under decide:req:preview, daily cap applies.
    ['POST', /^\/api\/requirements\/([\w-]+)\/preview$/, (m, body) => reqRoute(() => reqCheck.preview(m[1], (body ?? {}).n))],
    // `?verdict=ID` keeps that verdict in the list however old: the compliance matrix opens it.
    ['GET', /^\/api\/requirements\/([\w-]+)$/, (m, _b, url) => reqRoute(() => requirements.get(m[1], { verdict: /^\d+$/.test(url.searchParams.get('verdict') ?? '') ? Number(url.searchParams.get('verdict')) : undefined }))],
    [
      'PATCH',
      /^\/api\/requirements\/([\w-]+)$/,
      (m, body, _u, _r, _l, human) =>
        reqRoute(async () => {
          const by = itsaActor(body, human);
          const r = await requirements.set(m[1], body ?? {}, by);
          // An edit to a draft with an open approval ask refreshes the ask (src/req-approval.ts).
          if (Object.keys(r.changes).length && r.requirement.status === 'draft') await reqApproval.refresh(r.requirement.key, (await itsa.person(by)) ?? by);
          // In force by any other way than the ask's Approve (the human, or the chief of staff): the ask closes.
          if (r.changes.status?.to === 'in_force') await reqApproval.approvedElsewhere(r.requirement.key, (await itsa.person(by)) ?? by ?? mail.HUMAN);
          return r;
        }),
    ],
    [
      'POST',
      /^\/api\/requirements\/([\w-]+)\/links$/,
      (m, body) => reqRoute(() => requirements.addLink(m[1], body ?? {})),
    ],
    [
      'DELETE',
      /^\/api\/requirements\/([\w-]+)\/links\/(\d+)$/,
      (m) =>
        reqRoute(() => {
          requirements.removeLink(m[1], Number(m[2]));
          return { removed: Number(m[2]) };
        }),
    ],
    // External events (docs/design.md, Event subscriptions). Sources POST normalized events;
    // the daemon stores, matches, and delivers. Subscriptions name an agent, an ITSA, or the
    // human, with a filter; who may create one is checked in watch.ts.
    [
      'POST',
      /^\/api\/events$/,
      (_m, body, _u, _r, _l, _h, _q, caller) => {
        // Events come from the daemon's sources and the human's scripts. From an agent's token, a forged
        // event would have stam post into the threads of the ITSAs it subscribes (S-480).
        if (caller.kind === 'agent' || caller.kind === 'opencode') throw new HttpError(403, "an agent's token can't post external events");
        try {
          return watch.ingest(body ?? {});
        } catch (e) {
          throw new HttpError(400, e instanceof Error ? e.message : String(e));
        }
      },
    ],
    [
      'GET',
      /^\/api\/events$/,
      (_m, _b, url, _r, _l, _h, _q, caller) => {
        // The event log holds every subject's events, so an agent's token reads none of it (S-587).
        notAgentToken(caller, 'read the event log');
        return watch.events({ subject: url.searchParams.get('subject') ?? undefined, limit: Number(url.searchParams.get('limit') ?? 50) });
      },
    ],
    // The daemon's own event stream (S-456): mail, agents, ITSAs, and usage, so the system
    // view can animate instead of polling. One path of its own, as the layout's is; same auth
    // as every /api route. Ping every 25 s and cleanup on close live in events.ts. The MCP
    // shims keep their per-agent streams (push.ts).
    [
      'GET',
      /^\/api\/live$/,
      (_m, _b, _u, res, _l, _h, _q, caller) => {
        // The stream carries every agent's mail headers and ITSA changes: not an agent's to read (S-587).
        notAgentToken(caller, 'read the daemon event stream');
        events.addEventStream(res);
        return HANDLED;
      },
    ],
    // What the pollers last saw, per requested subject, for the dashboard (S-65). See
    // src/sources/github.ts; the query param `subject` repeats.
    [
      'GET',
      /^\/api\/watch\/state$/,
      (_m, _b, url) => {
        const subjects = url.searchParams.getAll('subject');
        return { ...githubSource.stateFor(subjects.filter((s) => !s.startsWith('linear:'))), ...linearSource.stateFor(subjects.filter((s) => s.startsWith('linear:'))) };
      },
    ],
    [
      'GET',
      /^\/api\/subscriptions$/,
      (_m, _b, url, _r, _l, human, _q, caller) => watch.listSubscriptions(actor(caller, url.searchParams.get('by')) ?? (human ? mail.HUMAN : '')),
    ],
    [
      'POST',
      /^\/api\/subscriptions$/,
      (_m, body, _u, _r, _l, human) => {
        try {
          return watch.createSubscription({ ...body, by: body?.by ?? (human ? mail.HUMAN : undefined) });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new HttpError(/may not/.test(msg) ? 403 : 400, msg);
        }
      },
    ],
    [
      'DELETE',
      /^\/api\/subscriptions\/([\w-]+)$/,
      (m, body, _u, _r, _l, human) => {
        try {
          return { removed: watch.removeSubscription(m[1], body?.by ?? (human ? mail.HUMAN : '')).id };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new HttpError(/may not/.test(msg) ? 403 : /^no subscription/.test(msg) ? 404 : 400, msg);
        }
      },
    ],
    // The human's layout (worlds, panes, tabs), shared by every web client. Reading and the
    // stream are open to anyone with the token; arranging it is the human's (the web UI) or
    // an agent's when the human asked (its MCP tools, naming itself with `by`). Setting the
    // whole layout is the human's alone.
    ['GET', /^\/api\/layout$/, () => layout.getLayout()],
    [
      'GET',
      /^\/api\/layout\/stream$/,
      (_m, _b, _u, res) => {
        layout.streamLayout(res);
        return HANDLED;
      },
    ],
    [
      'POST',
      /^\/api\/layout\/ops$/,
      (_m, body, _u, res, _l, human) => {
        // The human (web UI) or an agent naming itself with `by`, as the other routes do.
        const agent = body?.by ? db.getAgent(String(body.by)) : undefined;
        if (!human && !agent) throw new HttpError(403, 'only the human, or an agent naming itself (by), changes the layout');
        if (!Array.isArray(body?.ops)) throw new HttpError(400, 'ops must be a list of layout ops');
        if (body.base !== undefined && !Number.isInteger(body.base)) throw new HttpError(400, 'base must be a layout version');
        if (body.batch !== undefined && (typeof body.batch !== 'string' || body.batch.length > 64)) throw new HttpError(400, 'batch must be a short string');
        return layoutRoute(res, () => {
          const next = layout.applyOps(body.ops as LayoutOp[], body.base, body.batch);
          if (agent && body.ops.length) db.addEvent(agent.id, 'layout', { summary: body.ops.map(layout.describeOp).join('; ') });
          return next;
        });
      },
    ],
    [
      'PUT',
      /^\/api\/layout$/,
      (_m, body, _u, res, _l, human) => {
        if (!human) throw new HttpError(403, 'only the human sets the layout, from the web UI');
        return layoutRoute(res, () => layout.replaceLayout(body?.layout));
      },
    ],
    // Voice input: whether ElevenLabs is configured (true or false only; the key never leaves
    // the daemon), and the transcription of one recorded clip, read as the raw request body.
    [
      'GET',
      /^\/api\/voice$/,
      (_m, _b, _u, _r, _l, _h, req) => (humanOnly(req, 'use voice input'), { configured: voice.configured() }),
    ],
    [
      'POST',
      /^\/api\/voice\/transcribe$/,
      async (_m, _b, _u, _r, _l, _h, req) => {
        humanOnly(req, 'use voice input');
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of req) {
          size += (c as Buffer).length;
          if (size > voice.MAX_BYTES) throw new HttpError(413, 'the clip is larger than 25 MB');
          chunks.push(c as Buffer);
        }
        try {
          return await voice.transcribe(Buffer.concat(chunks), String(req.headers['content-type'] ?? '').split(';')[0]);
        } catch (e) {
          if (e instanceof voice.VoiceError) throw new HttpError(e.status, e.message);
          throw e;
        }
      },
    ],
    // Phone notifications (Web Push): this daemon's key, and the devices subscribed here.
    [
      'GET',
      /^\/api\/push$/,
      (_m, _b, _u, _r, _l, _h, req) => (humanOnly(req, 'see notification devices'), {
        publicKey: webpush.vapidKeys().publicKey,
        kinds: webpush.KINDS,
        devices: db.listPushDevices().map(({ p256dh: _k, auth: _a, ...d }) => d),
      }),
    ],
    [
      'POST',
      /^\/api\/push\/devices$/,
      (_m, body, _u, _r, _l, _h, req) => {
        humanOnly(req, 'turn on notifications');
        const sub = body.subscription ?? {};
        if (!/^https?:\/\//.test(String(sub.endpoint ?? '')) || !sub.keys?.p256dh || !sub.keys?.auth) throw new HttpError(400, 'a push subscription needs endpoint, keys.p256dh, and keys.auth');
        const kinds = Array.isArray(body.kinds) ? body.kinds.filter((k: string) => (webpush.KINDS as readonly string[]).includes(k)) : [...webpush.KINDS];
        const { p256dh: _k, auth: _a, ...d } = db.savePushDevice({ endpoint: String(sub.endpoint), p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth), label: String(body.label ?? '').slice(0, 80) || 'A device', origin: body.origin ? String(body.origin) : null, kinds, replaces: body.replaces ? String(body.replaces) : undefined });
        return d;
      },
    ],
    [
      'PATCH',
      /^\/api\/push\/devices\/(\w+)$/,
      (m, body, _u, _r, _l, _h, req) => {
        humanOnly(req, 'change notifications');
        if (!db.getPushDevice(m[1])) throw new HttpError(404, `no device ${m[1]}`);
        const kinds = Array.isArray(body.kinds) ? body.kinds.filter((k: string) => (webpush.KINDS as readonly string[]).includes(k)) : undefined;
        db.updatePushDevice(m[1], { label: body.label ? String(body.label).slice(0, 80) : undefined, kinds });
        const { p256dh: _k, auth: _a, ...d } = db.getPushDevice(m[1])!;
        return d;
      },
    ],
    [
      'DELETE',
      /^\/api\/push\/devices\/(\w+)$/,
      (m, _b, _u, _r, _l, _h, req) => {
        humanOnly(req, 'remove devices');
        if (!db.deletePushDevice(m[1])) throw new HttpError(404, `no device ${m[1]}`);
        return { removed: m[1] };
      },
    ],
    [
      'POST',
      /^\/api\/push\/test$/,
      async (_m, body, _u, _r, _l, _h, req) => {
        humanOnly(req, 'send a test notification');
        const ids = body.device ? [String(body.device)] : db.listPushDevices().map((d) => d.id);
        if (!ids.length) throw new HttpError(404, 'no device has notifications on');
        return webpush.pushLocal({ kind: 'test', title: 'stam', body: 'Notifications work on this device.', tag: 'test', machine: MACHINE }, ids);
      },
    ],
    // A peer stored mail to the human: it names the mail, and this daemon checks it with
    // that peer before pushing to its own devices (webpush.onRelay).
    [
      'POST',
      /^\/api\/push\/notify$/,
      async (_m, body, _u, _r, local) => {
        // Only a peer daemon relays: an agent's token reaches this route too, and a close from it must not close the user's notifications.
        if (!local) throw new HttpError(403, 'only a peer daemon relays notifications');
        try {
          return await webpush.onRelay(body);
        } catch (e) {
          throw new HttpError(403, e instanceof Error ? e.message : String(e));
        }
      },
    ],
    ['GET', /^\/api\/permissions$/, (_m, _b, url, _r, _l, _h, _q, caller) => {
        const audience = url.searchParams.get('audience');
        // An agent's token lists its own requests and its tree's (S-593); the bosses and the user list all.
        const viewer = usageViewer(caller, url);
        const own = viewer === undefined ? undefined : usageScope.ownTree(viewer);
        return db.listPermissionRequests(url.searchParams.get('status') ?? undefined).filter((r) => (!audience || r.audience === audience) && (!own || own.has(r.agent_id)));
      }],
    [
      'POST',
      /^\/api\/suggest-input$/,
      // An agent suggests input for its own harness only (S-422): the agent is the one its own
      // token names, never a body field, and never one a peer forwards.
      async (_m, body, _u, _r, local, _h, _q, caller) => {
        if (caller.kind === 'opencode') throw new HttpError(403, "suggest_input types into a Claude Code input box only; stam can't type into an OpenCode agent's input this way. Use request_permission instead");
        if (local || caller.kind !== 'agent' || !caller.agent) throw new HttpError(403, 'only an agent suggests input, for itself, with its own token');
        const a = db.getAgent(caller.agent);
        if (!a) throw new HttpError(409, `${caller.agent} runs on another machine; suggest input through its own daemon`);
        if (a.harness !== 'claude') throw new HttpError(403, `suggest_input types into a Claude Code input box only; ${a.name} runs ${a.harness}, whose input stam can't type into this way. Use request_permission instead`);
        try {
          return await permissions.suggestInput(a, body?.text, String(body?.reason ?? ''));
        } catch (e) {
          throw new HttpError(400, e instanceof Error ? e.message : String(e));
        }
      },
    ],
    [
      'POST',
      /^\/api\/permissions$/,
      (_m, body, _u, _r, _l, _h, _q, caller) => {
        const agent = mustAgent(String(actor(caller, body.agent)));
        // A request without an audience comes from an agent whose tool schema predates the field: it
        // defaults to 'delegate', which reaches the human when the agent has no live parent or chief of staff.
        const omitted = body.audience === undefined || body.audience === null || body.audience === '';
        if (!omitted && body.audience !== 'human' && body.audience !== 'delegate')
          throw new HttpError(400, "audience must be 'human' when only your user's consent unblocks it (a harness or auto-mode safety block, an irreversible or outward action, spend above the caps), or 'delegate' when your parent or the chief of staff can decide it (they escalate to your user if needed)");
        const audience = omitted ? 'delegate' : body.audience;
        return permissions.requestPermission(agent, String(body.action ?? ''), String(body.reason ?? ''), String(body.details ?? ''), false, {}, audience).then((r) => {
          if (omitted) db.addEvent(agent.id, 'permission:audience-defaulted', { id: r.id, audience: r.audience });
          return r;
        });
      },
    ],
    [
      'POST',
      /^\/api\/permissions\/(\w+)\/answer$/,
      async (m, body, url, _r, local, human, req, caller) => {
        // Suggested input (S-422) is approved only by the human as trustedHuman proves it here, on
        // the daemon that has the request: never by a token, x-stam-human, an owner header, `by`,
        // or an answer a peer forwarded. Its denial is answered below like any request's.
        const input = db.getPermissionRequest(m[1]);
        if (input?.kind === 'input' && body?.approve) {
          if (local) throw new HttpError(409, `approve ${m[1]} from stam's web UI on ${MACHINE}; an approval forwarded from another machine is never accepted`, { machine: MACHINE });
          if (!trustedHuman(req, owner)) throw new HttpError(403, `only the human approves suggested input, from stam's web UI on ${MACHINE}, ${humanWays()}`);
          try {
            return await permissions.approveInput(m[1], body.text_sha256);
          } catch (e) {
            if (e instanceof permissions.InputRefused) throw new HttpError(409, e.message);
            throw e;
          }
        }
        // A request from an agent on another machine is answered by the daemon that owns it:
        // the one the notification names, or else whichever peer has it.
        if (!local && !db.getPermissionRequest(m[1]) && body.machine !== MACHINE) {
          // The service worker's failed direct attempt, why (S-426); text only, cut short, no secrets.
          if (typeof body.direct === 'string') console.log(`permission answer relayed after the direct attempt failed: ${body.direct.replace(/[\x00-\x1f\x7f\u0085\u2028\u2029]+/g, ' ').slice(0, 300)}`);
          const named = body.machine ? peerByName(String(body.machine)) : undefined;
          if (body.machine && !named) throw new HttpError(404, `no peer machine ${body.machine}`);
          for (const peer of named ? [named] : peers()) {
            let r;
            // Under strict with no machine named, ask each peer as a non-human: the one that holds the request
            // says anything but "no permission request", and is the machine the 409 names.
            const probing = !named && human && (!body.by || body.by === mail.HUMAN) && strictOn();
            const carry = probing ? false : relayHuman(peer, human, true, 'a permission answer', !body.by || body.by === mail.HUMAN);
            try {
              r = await peerCall(peer, 'POST', url.pathname, { ...body, ...(probing ? { by: undefined } : {}), machine: undefined }, 30_000, carry, viaOf(caller));
            } catch {
              continue;
            }
            if (probing && !/^no permission request /.test(String(r.data?.error ?? ''))) relayHuman(peer, true, true, 'a permission answer');
            if (r.status === 200) return r.data;
            if (named || !/^no permission request /.test(String(r.data?.error ?? ''))) throw new HttpError(r.status, r.data?.error ?? `HTTP ${r.status}`);
          }
        }
        // A peer forwards its own agent's answer (S-320): that agent isn't in this database, and
        // the peer vouches for it and says whether it is its chief of staff or assistant (boss).
        // A daemon that doesn't hold the request says so before any auth check, so a probe finds the holder.
        if (local && !db.getPermissionRequest(m[1])) throw new HttpError(404, `no permission request ${m[1]}`);
        const peerAgent = local && caller.kind === 'agent' && body.by === caller.agent && !db.getAgent(String(body.by));
        const by = peerAgent ? String(body.by) : body.by ? mustAgent(String(body.by)).id : human ? mail.HUMAN : undefined;
        if (!by) throw new HttpError(403, 'an answer must come from the human or a reviewing agent');
        try {
          if (body.decision === 'escalate') return await permissions.escalatePermission(m[1], by, String(body.note ?? ''), peerAgent ? { boss: Boolean(caller.boss) } : undefined);
          if (body.decision && body.decision !== 'approve' && body.decision !== 'deny') throw new Error(`decision must be approve, deny or escalate`);
          return await permissions.answerPermission(m[1], body.decision ? body.decision === 'approve' : Boolean(body.approve), by, String(body.note ?? ''), peerAgent ? { boss: Boolean(caller.boss) } : undefined);
        } catch (e) {
          throw new HttpError(409, e instanceof Error ? e.message : String(e));
        }
      },
    ],
    [
      'POST',
      /^\/api\/agents\/([\w-]+)\/(pause|unpause|shutdown|archive|resume|restart|reconnect-mcp|compact|adopt|set-visibility|set-child-notices|set-parent|rename|chief-of-staff|kill|forget)$/,
      async (m, body, _u, _r, local, human, _q, caller) => {
        const a = mustAgent(m[1]);
        // An agent may control itself and its children; the human (no `by`) and the
        // assistant control all, and alone reparent, rename, kill, and forget. An agent or the
        // OpenCode server with no `by` is never the human: it's refused below, not treated as boss.
        const asCaller = caller.kind === 'agent' || caller.kind === 'opencode';
        // Under auth.humanStrict a request with no `by` is the boss only when it is the human (S-543).
        // A peer's forwarded call carries whether its agent is its chief of staff (S-410); the assistant isn't in this database (S-321), so the peer vouches for it.
        const remote = asCaller && local && Boolean(body?.by) && body.by === caller.agent && !db.getAgent(String(body.by));
        const boss = asCaller ? Boolean(body?.by) && (isAssistant(body.by) || caller.assistant === true) : (!body?.by && (human || peerOwn(local, caller) || !strictRefuses('agent control with no by', true))) || isAssistant(body.by);
        const isParent = body?.by && db.parentsOf(a).includes(body.by);
        const isCos = body?.by && (org.chiefOfStaff()?.id === body.by || (remote && caller.boss === true));
        if (!boss && ['set-parent', 'rename', 'chief-of-staff', 'kill', 'forget'].includes(m[2]))
          throw new HttpError(403, `only the human and the assistant may ${m[2]}`);
        if (!boss && body?.by !== a.id && !isParent && !(isCos && m[2] === 'adopt'))
          throw new HttpError(403, `${body?.by ?? 'no one'} may control only itself and its children`);
        const result = await control(a, m[2], remote ? { ...body, remoteParent: true } : (body ?? {}));
        return { agent: db.getAgent(a.id), result };
      },
    ],
    [
      'GET',
      /^\/api\/agents\/([\w-]+)$/,
      (m) => {
        const a = mustAgent(m[1]);
        const ws = waits.webWaits(a.id);
        return { ...a, blockers: blockers.blockers(a), waits: ws, resting: lifecycle.restingOf(a, ws), view: agentView.capabilities(a) };
      },
    ],
    // The view the human's web UI opens an agent in (S-82): terminal or conversation, or
    // null for Settings' default. Any agent the UI lists, a peer's included.
    [
      'PUT',
      /^\/api\/agents\/([\w-]+)\/default-view$/,
      (m, body, _u, _r, _l, human) => {
        if (!human) throw new HttpError(403, "only the human sets an agent's default view");
        const v = body?.view ?? null;
        if (v !== null && v !== 'terminal' && v !== 'conversation') throw new HttpError(400, 'view must be terminal, conversation, or null');
        db.setAgentView(m[1], v);
        return { agent_id: m[1], default_view: v };
      },
    ],
    ['GET', /^\/api\/agents\/([\w-]+)\/events$/, (m) => db.listEvents(mustAgent(m[1]).id)],
    // One agent's own usage (S-95): its harness and model, and its token and cost totals
    // for today and its whole life, for the agent's own view. A counter its harness does
    // not report comes back null, so the UI shows it as missing rather than 0.
    ['GET', /^\/api\/agents\/([\w-]+)\/usage$/, (m, _b, url, _r, _l, _h, _q, caller) => {
      const viewer = usageViewer(caller, url);
      const a = mustAgent(m[1]);
      if (viewer !== undefined && !usageScope.visibleAgents(viewer).has(a.id)) throw new HttpError(403, `an agent reads the usage of agents in its own tree and its ancestors' trees only, not ${a.name}'s`);
      return usage.agentUsage(a);
    }],
    // What an agent waits for (db.syncWaits). The sources of waits use these.
    ['GET', /^\/api\/agents\/([\w-]+)\/waits$/, (m) => waits.webWaits(mustAgent(m[1]).id)],
    [
      'POST',
      /^\/api\/agents\/([\w-]+)\/waits$/,
      (m, body, _u, _r, local, human, _q, caller) => {
        const a = mustAgent(m[1]);
        mayManageWaits(a, body?.by, human, peerOwn(local, caller));
        const kind = String(body?.kind ?? '').trim();
        if (!kind) throw new HttpError(400, 'a wait needs a kind');
        const source = body.source ?? 'stam';
        if (!['stam', 'hook', 'declared'].includes(source)) throw new HttpError(400, "source must be 'stam', 'hook', or 'declared'");
        const str = (v: unknown) => (v == null ? null : String(v));
        const data = body.data == null ? null : JSON.stringify(body.data);
        return db.addWait({ agent_id: a.id, kind, source, target: str(body.target), detail: str(body.detail), until: str(body.until), data });
      },
    ],
    // A notice for an agent here, from a peer (an owner's stop, for the parent ITSA's owner).
    [
      'POST',
      /^\/api\/agents\/([\w-]+)\/notice$/,
      (m, body, _u, _r, local, _human) => {
        if (!local) throw new HttpError(403, 'only a peer can queue a notice');
        const a = mustAgent(m[1]);
        if ((a.lifecycle === 'active' || a.lifecycle === 'paused') && typeof body?.text === 'string') mail.queueNotice(a.id, body.text);
        return {};
      },
    ],
    // An agent's final retro round, filed as it is archived (S-159): its effort split, stored as an event.
    [
      'POST',
      /^\/api\/agents\/([\w-]+)\/retro-final$/,
      (m, body) => {
        const a = mustAgent(m[1]);
        if (body?.by !== a.id) throw new HttpError(403, 'only the agent itself files its final retro round');
        // The measured split (S-227) rides along, beside the self-report; null when the agent has no timed activity.
        db.addEvent(a.id, 'retro_final', { effort: body.effort, model: a.model, type: a.type, measured: measuredEffort(a.id)?.split ?? null });
        return {};
      },
    ],
    // The retro digest now, to the Retros owner or the chief of staff (S-161); the timer sends it on its day and hour.
    // Only the human, the CLI's shared token or the timer: an agent's token would mail the digest's recipients at will (S-587).
    ['POST', /^\/api\/retros\/digest$/, (_m, _b, _u, _r, _l, _h, _q, caller) => { notAgentToken(caller, 'send the retro digest'); return retroDigest.sendDigest(); }],
    // The Retros view (S-162): open retro items, the effort split, and coverage since a time.
    [
      'GET',
      /^\/api\/retros$/,
      (_m, _b, url) => {
        const since = url.searchParams.get('since');
        if (since && Number.isNaN(Date.parse(since))) throw new HttpError(400, 'since must be an ISO time');
        // `type=NAME`: the memory of an agent type (S-888), all time, open and done.
        const type = url.searchParams.get('type');
        if (type && !/^[\w-]+$/.test(type)) throw new HttpError(400, 'type must be an agent type name');
        if (type) return retroDigest.retrosOfType(type);
        return retroDigest.retros(since ? new Date(since).toISOString() : undefined);
      },
    ],
    [
      'POST',
      /^\/api\/agents\/([\w-]+)\/waits\/clear$/,
      (m, body, _u, _r, local, human, _q, caller) => {
        const a = mustAgent(m[1]);
        mayManageWaits(a, body?.by, human, peerOwn(local, caller));
        if (body?.id) return { cleared: db.listWaits(a.id).some((w) => w.id === body.id) && db.clearWait(String(body.id)) ? 1 : 0 };
        if (!body?.kind) throw new HttpError(400, 'clear a wait by id, or by kind and target');
        return { cleared: db.clearWaits(a.id, String(body.kind), body.target == null ? null : String(body.target)) };
      },
    ],
    // A declared wait for a reply (wait_for), a stam timer (wake_me), and clearing one's own
    // declared or timer wait (wait_done). See src/waits.ts.
    [
      'POST',
      /^\/api\/agents\/([\w-]+)\/waits\/declared$/,
      async (m, body, _u, _r, local, human, _q, caller) => {
        const a = mustAgent(m[1]);
        mayManageWaits(a, body?.by, human, peerOwn(local, caller));
        try {
          const w = await waits.declare(a.id, body ?? {});
          if (body?.rest === true) lifecycle.requestRest(a.id, w);
          return w;
        } catch (e) {
          throw new HttpError(400, e instanceof Error ? e.message : String(e));
        }
      },
    ],
    [
      'POST',
      /^\/api\/agents\/([\w-]+)\/waits\/wake$/,
      (m, body, _u, _r, local, human, _q, caller) => {
        const a = mustAgent(m[1]);
        mayManageWaits(a, body?.by, human, peerOwn(local, caller));
        try {
          const w = waits.wake(a.id, body ?? {});
          if (body?.rest === true) lifecycle.requestRest(a.id, w);
          return w;
        } catch (e) {
          throw new HttpError(400, e instanceof Error ? e.message : String(e));
        }
      },
    ],
    [
      'POST',
      /^\/api\/agents\/([\w-]+)\/waits\/done$/,
      (m, body, _u, _r, local, human, _q, caller) => {
        const a = mustAgent(m[1]);
        mayManageWaits(a, body?.by, human, peerOwn(local, caller));
        return { cleared: waits.done(a.id, body?.id) };
      },
    ],
    // workspace_share (S-896): the agent in the path shares its personal workspace.
    [
      'POST',
      /^\/api\/agents\/([\w-]+)\/workspace-share$/,
      (m, body, _u, _r, _l, _h, _q, caller) => {
        const a = mustAgent(m[1]);
        // Self only: no other agent shares a workspace on the owner's behalf.
        mayActAs(caller, a.id, true);
        try {
          return workspaceShare.share(a.id, String(body?.agent ?? ''), String(body?.access ?? ''));
        } catch (e) {
          throw new HttpError(400, e instanceof Error ? e.message : String(e));
        }
      },
    ],
    ['POST', /^\/api\/hook\/(\w+)\/([\w-]+)$/, (m, body, _u, _r, _l, _h, _q, caller) => (mayActAs(caller, m[2]!, true), onHook(m[1], m[2], body))],
    [
      'POST',
      /^\/api\/statusline\/(\w+)\/([\w-]+)$/,
      (m, body, _u, _r, _l, _h, _q, caller) => {
        mayActAs(caller, m[2]!, true);
        const a = mustAgent(m[2]);
        // Unchanged reports are skipped and quick changes coalesced per agent (statusline-gate.ts, S-2126).
        if (m[1] === 'claude') statuslineGate.submit(`${m[1]}/${a.id}`, body);
        else statuslineGate.run(`${m[1]}/${a.id}`, body);
        // Whether anyone views the agent: a web terminal, a web view, or a tmux client. The
        // wrapper caches its status line longer while nobody does (statusline-cache.ts, S-274).
        return { viewed: viewers.has(a.id) || agentView.hasViewers(a.id) || tmuxClientsOpen(a.id) };
      },
    ],
  ];

  // A web UI file, read and compressed once per encoding; a rebuild (a new mtime) reads it again.
  type Asset = { mtime: number; raw: Buffer; encoded: Partial<Record<'br' | 'gzip', Buffer>> };
  const assetCache = new Map<string, Asset>();
  const cachedAsset = (file: string): Asset => {
    const mtime = statSync(file).mtimeMs;
    const hit = assetCache.get(file);
    if (hit?.mtime === mtime) return hit;
    const fresh: Asset = { mtime, raw: readFileSync(file), encoded: {} };
    assetCache.set(file, fresh);
    return fresh;
  };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, data: unknown) => sendCompressed(req, res, status, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify(data)));
    // The web UI is web/'s build, web/dist (`npm run build` there; `stam deploy` runs it).
    const WEB = join(ROOT, 'web', 'dist');
    if (req.method === 'GET' && (req.url === '/' || req.url?.startsWith('/?') || req.url?.startsWith('/#'))) {
      if (!existsSync(join(WEB, 'index.html'))) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('The web UI is not built. Run `npm install && npm run build` in web/, or deploy with `stam deploy`.\n');
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(readFileSync(join(WEB, 'index.html')));
    }
    // The stories page (docs/stories.md): every component with its states, drawn from fixtures.
    // Public like the page above; it calls no API, so it works under auth.humanStrict too.
    if (req.method === 'GET' && (req.url === '/stories' || req.url?.startsWith('/stories?') || req.url?.startsWith('/stories#'))) {
      if (!existsSync(join(WEB, 'stories.html'))) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('The stories page is not built. Run `npm run build` in web/.\n');
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(readFileSync(join(WEB, 'stories.html')));
    }
    // The service worker lives at the root, so its scope is the whole page. It caches
    // nothing; a deploy shows at the next load as before.
    if (req.method === 'GET' && (req.url === '/sw.js' || req.url?.startsWith('/sw.js?'))) {
      try {
        const data = readFileSync(join(WEB, 'sw.js'));
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
        return res.end(data);
      } catch {
        res.writeHead(404);
        return res.end();
      }
    }
    // The web UI's scripts, styles, and fonts; public, like the page itself. Hashed
    // names under assets/ never change, so browsers keep them.
    const asset = req.method === 'GET' && req.url?.match(/^\/web\/((?:assets\/|fonts\/)?[\w.-]+\.(js|css|svg|woff2|woff|ttf|png|webmanifest|wasm))(\?|$)/);
    if (asset && !asset[1].includes('..')) {
      const types: Record<string, string> = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', png: 'image/png', webmanifest: 'application/manifest+json', wasm: 'application/wasm' };
      try {
        const file = join(WEB, asset[1]);
        const forever = asset[1].startsWith('assets/') || asset[1].startsWith('fonts/');
        const data = cachedAsset(file);
        sendCompressed(req, res, 200, { 'content-type': types[asset[2]], 'cache-control': forever ? 'max-age=31536000, immutable' : 'no-cache' }, data.raw, (enc) => (data.encoded[enc] ??= encodeBody(data.raw, enc)));
        return;
      } catch {
        res.writeHead(404);
        return res.end();
      }
    }
    // A browser asks before a peer's UI writes shared settings here (S-414). Only the settings home
    // answers, only the configured peers' UI origins, and only for those writes; anything else gets no
    // CORS headers.
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin.toLowerCase() : undefined;
    const reqPath = new URL(req.url ?? '/', 'http://x').pathname;
    const uiMethod = String(req.method === 'OPTIONS' ? req.headers['access-control-request-method'] : req.method);
    const fromPeerUi = Boolean(origin) && !sameOrigin(req, origin!) && peerOrigins().has(origin!) && ((isSettingsHome() && peerUiRoute(uiMethod, reqPath)) || peerUiHumanRoute(uiMethod, reqPath));
    if (req.method === 'OPTIONS') {
      if (!fromPeerUi) {
        res.writeHead(403);
        return res.end();
      }
      res.writeHead(204, {
        'access-control-allow-origin': origin!,
        'access-control-allow-methods': String(req.headers['access-control-request-method']),
        'access-control-allow-headers': `content-type, x-stam-human${testOnlyEnv('STAM_TEST_HUMAN_KEY') ? ', x-stam-test-human' : ''}`,
        ...(req.headers['access-control-request-private-network'] === 'true' ? { 'access-control-allow-private-network': 'true' } : {}),
        'access-control-max-age': '600',
        vary: 'origin',
      });
      return res.end();
    }
    if (fromPeerUi) {
      peerUiRequests.add(req);
      res.setHeader('access-control-allow-origin', origin!);
      res.setHeader('vary', 'origin');
    }
    try {
      if (reqPath === '/api/human/login' || reqPath === '/api/human/logout') return send(200, await localHumanRoute(req, reqPath));
      const verified = callerOf(req);
      // A peer forwards an agent's request with the shared token, x-stam-local, and the agent it
      // acts for (S-239). Only a peer can name one: an agent token can't set local (below).
      // Only the peer token proves a peer (S-545, S-1064). The shared token can't set `local` or name an agent: any
      // holder could forge both and act as any agent (body by/from, or boss with no by), so it is refused here.
      const peerHeaders = req.headers['x-stam-local'] === '1' || req.headers['x-stam-agent'] !== undefined;
      if (verified.kind === 'shared' && peerHeaders) throw new HttpError(403, "peer headers need the peer token (settings.peers[].peerToken); the shared token can't send them");
      const fromPeer = verified.kind === 'peer';
      const forwarded = fromPeer && req.headers['x-stam-local'] === '1' ? req.headers['x-stam-agent'] : undefined;
      // Past this point a peer acts as the shared token does, except for the peer-only routes (`local`).
      const caller: Caller = forwarded ? { kind: 'agent', agent: String(forwarded), boss: req.headers['x-stam-agent-boss'] === '1', assistant: req.headers['x-stam-agent-assistant'] === '1', scope: branchScope.parseScope(req.headers['x-stam-branch-scope']) } : verified.kind === 'peer' ? { kind: 'shared' } : verified;
      const owned = trustedHuman(req, owner);
      const url = new URL(req.url ?? '/', 'http://x');
      // Video, audio, and PDF players can't send a header, so an attachment may carry the
      // token in its URL instead.
      const mediaToken = req.method === 'GET' && /^\/api\/mail\/[\w-]+\/attachments\//.test(url.pathname) && url.searchParams.get('token') === token;
      // The OAuth callback is a browser redirect, not an API call: its single-use state is
      // its protection, not the token (mcp-auth.ts).
      const oauthCallback = req.method === 'GET' && url.pathname === '/oauth/callback';
      if (caller.kind === 'none' && !req.headers.authorization && req.headers.origin && req.method !== 'GET') logDirectRefused(req, owner);
      if (caller.kind === 'none' && fromPeerUi) throw new HttpError(403, peerUiHumanRoute(req.method ?? '', url.pathname) ? `only the human can do this, through ${MACHINE}'s Tailscale address (tailscale serve)` : `only the human can change shared settings, through ${MACHINE}'s Tailscale address (tailscale serve)`);
      if (caller.kind === 'none' && !mediaToken && !oauthCallback) throw new HttpError(401, 'bad token');
      // Without a token, the browser's tailnet identity is the only credential, and a page on any site
      // could use it (S-414). A request from another site is refused, except a peer's UI writing shared
      // settings; a write must carry x-stam-human, which no plain form or simple request can, and from a
      // peer's UI it must be JSON.
      if (caller.kind === 'owner') {
        const write = !['GET', 'HEAD'].includes(req.method ?? '');
        const refuse = (status: number, why: string, msg: string): never => {
          if (origin && write) logDirectRefused(req, owner, why);
          throw new HttpError(status, msg);
        };
        if (!ownHost(req)) refuse(403, `host: ${String(req.headers.host ?? '-')} is not this daemon's`, 'a request without a token must name this daemon as its host');
        if (origin && !sameOrigin(req, origin) && !fromPeerUi) refuse(403, `origin: ${origin} is not a peer UI for this route`, 'a request from another site needs a token');
        if (write && req.headers['x-stam-human'] !== '1') refuse(403, 'x-stam-human header missing', 'a write needs the x-stam-human header');
        if (fromPeerUi && !String(req.headers['content-type'] ?? '').startsWith('application/json')) refuse(415, 'content-type is not JSON', 'a write from a peer must be JSON');
      }
      const path = url.pathname;
      // An agent's own token proves nothing about the human or a peer, whatever the headers say.
      const local = fromPeer && req.headers['x-stam-local'] === '1';
      const notAgent = caller.kind !== 'agent' && caller.kind !== 'opencode';
      const oldHuman = notAgent && (req.headers['x-stam-human'] === '1' || owned);
      // Under auth.humanStrict only trustedHuman is the human (S-543). Otherwise a request the old rule
      // calls human and trustedHuman doesn't is logged, once a minute per path, so the setting can be
      // turned on knowing what it would refuse, and with it on, the log says what it refused.
      const human = strictOn() ? notAgent && owned && req.headers['x-stam-local'] !== '1' : oldHuman;
      if (oldHuman && !owned) logWouldRefuse(req, url.pathname, caller.kind);
      // A voice clip is binary: its route reads the request itself (voice.ts).
      const rawBody = path === '/api/voice/transcribe';
      const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '') && !rawBody ? await readJson(req) : undefined;
      if (caller.kind === 'shared' && !human && path.startsWith('/api/itsas') && body && typeof body === 'object' && SYSTEM_SENDERS.includes(String(body.as_system))) systemBodies.add(body);
      // A write from an agent or the OpenCode server is a JSON object or empty. Any other JSON has no
      // identity for resolveActors to check, and the routes would read it as the human (S-233 review).
      if ((caller.kind === 'agent' || caller.kind === 'opencode') && body !== undefined && (body === null || typeof body !== 'object' || Array.isArray(body)))
        throw new HttpError(400, 'the request body must be a JSON object');
      // The identity a request claims is checked before anything forwards it (S-238).
      if (!local || caller.kind === 'agent') resolveActors(caller, body, url, req.method ?? '');
      // The mailbox and wait routes act as the agent in the path, so they are checked here,
      // before a request is forwarded to the agent's machine (S-242).
      const acting = matchActing(req.method ?? '', path);
      if (acting) mayActAs(caller, acting[1]!);

      // A request about an agent on another machine goes to the daemon that owns it.
      const am = path.match(/^\/api\/agents\/([\w-]+)(\/[\w-]+|\/view\/[\w-]+)?$/);
      // An id two machines' agents both have can't say which is meant (S-577): refuse it, naming
      // both, rather than act on the local one. An agent naming itself is not ambiguous, and a
      // name is unique, so only another exact id is checked.
      const idLocal = am && db.getAgent(am[1]);
      if (idLocal && idLocal.id === am![1] && caller.agent !== idLocal.id) refuseAmbiguousId(idLocal.id, idLocal);
      const spawnElsewhere = path === '/api/agents' && req.method === 'POST' && body?.machine && body.machine !== MACHINE;
      // A notice is queued by a peer's daemon for its own agent, never relayed for a caller.
      if (!local && !human && am?.[2] === '/notice') throw new HttpError(403, 'only a peer can queue a notice');
      // The human's own preferences about an agent (its default view) stay on the daemon the
      // web talks to, which lists them for peers' agents too.
      const mine = am?.[2] === '/default-view';
      if (!local && ((am && am[1] !== mail.HUMAN && !mine && !db.getAgent(am[1])) || spawnElsewhere)) {
        const target = spawnElsewhere ? { peer: peerByName(String(body.machine)) } : await findAgentPeer(am![1]);
        if (!target?.peer) throw new HttpError(404, spawnElsewhere ? `no peer machine ${body.machine}` : `no agent ${am![1]}`);
        // The human's proof (trustedHuman) holds only on the daemon the browser reaches, so
        // what an agent's view sends isn't relayed: the human sends from that machine's stam.
        if (/^\/view\/(prompt|interrupt|permission)$/.test(am?.[2] ?? '')) throw new HttpError(409, `${am![1]} runs on ${target.peer.name}; send to its view from stam on ${target.peer.name}`);
        // The agent view's event stream stays open, so it's piped rather than read whole.
        if (req.method === 'GET' && am?.[2] === '/view') return void (await peerStream(target.peer!, path + url.search, res, viaOf(caller)));
        // A peer takes a no-`by` write from a peer as the peer's own, so this daemon refuses the shared token's here (S-543).
        if (req.method !== 'GET' && !body?.by && strictRefuses('a write relayed to a peer with no by', unattributed(human, local, caller))) throw new HttpError(403, 'only the human, or an agent naming itself (by), controls another machine\'s agent');
        const relayed = relayHuman(target.peer, human, req.method !== 'GET', `${req.method} ${am?.[0] ?? path}`, !body?.by || body.by === mail.HUMAN);
        // A spawn on a stopped peer starts it first (S-234), and a peer on another release is deployed to this
        // one (S-236); a failed deploy doesn't stop the spawn: it warns. The new agent is remembered here (S-235).
        const relay: { status: number; data: any; warning?: string } = spawnElsewhere
          ? await spawnOnPeer(target.peer, body, relayed, viaOf(caller))
          : await peerCall(target.peer, req.method!, path + url.search, body, 660_000, relayed, viaOf(caller));
        const { warning, ...r } = relay;
        // A peer's agent forgotten through this daemon takes this daemon's preferences with it.
        if (am?.[2] === '/forget' && r.status < 300) db.setAgentView(am[1], null);
        return send(r.status, warning && r.status < 300 ? { ...r.data, warning } : ownRefusal(r.status, r.data));
      }

      // Every ITSA lives on its home daemon; another machine's daemon proxies there, as
      // it does for an agent it doesn't own. `/api/processes` rides along: its counts are ITSAs.
      // `local` stops a peer's own request looping.
      const itsaHome = settings().itsa.home ?? MACHINE;
      // Requirements are off unless enabled: answer 404 here, before any proxy or table.
      if (path.startsWith('/api/requirements') && !settings().requirements.enabled) throw new HttpError(404, requirements.OFF_MESSAGE);
      // Refused here, before the proxy: forwarded without a via, the OpenCode server's read would reach the home as a peer's (S-587).
      if (req.method === 'GET' && /^\/api\/itsas\/(queue|attention|[\w-]+\/cost)$/.test(path)) notAgentToken(caller, path.endsWith('/cost') ? "read an ITSA's cost" : path.endsWith('/queue') ? 'read the merge queue' : 'read what waits on the human');
      if (!local && /^\/api\/itsas\/(owner-stopped|unown-agent|join-parent|join)$/.test(path)) throw new HttpError(403, 'only a peer can call this');
      if (!local && (path.startsWith('/api/itsas') || path.startsWith('/api/requirements') || path === '/api/retros' || path === '/api/processes' || path.startsWith('/api/processes/')) && itsaHome !== MACHINE) {
        const peer = peerByName(itsaHome);
        if (!peer) throw new HttpError(503, `ITSA home '${itsaHome}' is not a configured peer`);
        const carry = relayHuman(peer, human, req.method !== 'GET', `${req.method} ${path.replace(/\/[0-9a-f]{6,}|\/S-\d+/g, '/:id')}`, !body?.by || body.by === mail.HUMAN);
        // The OpenCode server's request carries the agent it names (S-480): with no via, the home would
        // take it for this daemon's own call. Reading an ITSA's threads needs that agent named.
        const named = caller.kind === 'opencode' ? (body?.by ?? body?.from ?? body?.self ?? url.searchParams.get('as') ?? undefined) : undefined;
        if (caller.kind === 'opencode' && !named && /^\/api\/itsas\/[\w-]+\/threads?$/.test(path)) throw new HttpError(403, 'the OpenCode server must name the agent that reads the threads');
        try {
          let via = viaBox(caller, named === undefined ? undefined : String(named));
          // A branch link's owner check needs this daemon's agents: its answer rides along (S-581).
          if (via && !via.boss && req.method === 'POST' && /^\/api\/itsas\/[\w-]+\/links$/.test(path) && body?.system === 'branch') via = { ...via, scope: branchScope.localScope(via.agent, String(body.external_id ?? '')) };
          const r = await peerCall(peer, req.method!, path + url.search, body, 30_000, carry, via);
          return send(r.status, ownRefusal(r.status, r.data));
        } catch (e) {
          throw new HttpError(503, `${itsaHome} (the ITSA home) is unreachable: ${e instanceof Error ? e.message : e}`);
        }
      }

      // Every /api/test/* route (S-1732): only a test daemon has them, and an agent's token never reaches one.
      // The gate runs here, on the prefix, so a new test route can't skip it.
      if (path.startsWith('/api/test/')) {
        if (!(testHooksAllowed(process.env, STAM_HOME, TMUX_SOCKET) && testHome(STAM_HOME, LIVE_HOME))) throw new HttpError(404, 'not found');
        notAgentToken(caller, 'call the test hooks');
      }

      for (const [method, re, handler] of routes) {
        const m = path.match(re);
        if (m && req.method === method) {
          // The route's synchronous part is labelled for the stall watch (src/stall.ts).
          const out = await dedupByClientId(`${caller.kind}:${caller.agent ?? ''}|${path}${req.method === 'POST' && path === '/api/mail' && body && !body.reply_to && !body.new_thread && typeof body.from === 'string' ? `|${mail.readEpoch(body.from)}` : ''}`, req.method === 'POST' ? body?.client_id : undefined, async () => timed(path === '/api/activity' ? `${req.method} ${path} by=${url.searchParams.get('by') ?? 'agent'} caller=${caller.kind}` : `${req.method} ${path}`, () => handler(m, body, url, res, local, human, req, caller)), { keep: (r) => r !== HANDLED });
          if (out !== HANDLED) timed(`${req.method} ${path} response`, () => send(200, out ?? {}));
          return;
        }
      }
      throw new HttpError(404, `no route ${req.method} ${path}`);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e instanceof AmbiguousAgentError ? 409 : 500;
      // Under auth.humanStrict the CLI is never the human; tell it where to answer (S-543).
      const hint = status === 403 && strictOn() && req.headers['x-stam-human'] === '1' && !trustedHuman(req, owner) ? { hint: "answer from stam's web UI" } : undefined;
      send(status, { error: e instanceof Error ? e.message : String(e), ...hint, ...(e instanceof HttpError ? e.extra : undefined) });
    }
  };

  const wss = new WebSocketServer({ noServer: true });
  timed('reset window sizes', tmux.resetWindowSizes);
  // The canonical web origin, found before anything listens, so the first request sees a served host.
  // Bounded by discoverWebOrigin's 3 s timeout; a failure leaves the 127.0.0.1 fallback.
  await Promise.all([discoverWebOrigin(), agentIps.refresh()]);
  // While no serve is found, the origin is asked again in the background, never on a request. Stops
  // once one is found.
  if (!webServed) {
    const retry = setInterval(() => {
      if (webServed) {
        clearInterval(retry);
        return;
      }
      void discoverWebOrigin();
    }, WEB_RETRY_MS);
    retry.unref();
  }
  // Primes the bound hosts (bindAddresses runs tailscale ip -4) here, so no request spawns it.
  ownHosts();
  const addrs = bindAddresses();
  for (const addr of addrs) {
    const server = createServer(handler);
    server.on('upgrade', async (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const m = url.pathname.match(/^\/api\/(agents|shells)\/([\w-]+)\/tty$/);
      // A ticket (S-742) stands for the request that bought it; one that came from the human's proof is as good as trustedHuman here.
      const ticket = m ? redeemTicket(url.searchParams.get('ticket'), 'tty', url.pathname) : undefined;
      if (ticket && !ticket.trusted && strictOn()) return socket.destroy();
      if ((!trustedHuman(req, owner) && !ticket && !tokenOk(url.searchParams.get('token'))) || !m) return socket.destroy();
      // A terminal opened on the tailnet identity alone must come from this daemon's own page: a socket
      // from another site would get the human's terminal (S-414).
      const wsOrigin = typeof req.headers.origin === 'string' ? req.headers.origin.toLowerCase() : undefined;
      if (!(ticket && !ticket.trusted) && !tokenAuth(url.searchParams.get('token')) && (!ownHost(req) || (wsOrigin && !sameOrigin(req, wsOrigin) && !peerOrigins().has(wsOrigin)))) return socket.destroy();
      const size = [Number(url.searchParams.get('cols')), Number(url.searchParams.get('rows'))] as const;
      // Relays a terminal on another machine from its daemon's terminal socket.
      const relay = (peer: Peer, path: string) => {
        // The human's proof holds only on the daemon the browser reaches, so under auth.humanStrict a terminal
        // isn't relayed: the socket is answered 409 naming the machine and its serve origin, and the web opens it
        // there itself (S-544). Off, it relays as before and the daemon logs it.
        if (strictOn()) {
          const to = { error: `a terminal on ${peer.name} is opened from stam's web UI on ${peer.name}`, refusal: 'human-on-machine', machine: peer.name, origin: peerServeOrigin(peer.url) };
          return void socket.end(`HTTP/1.1 409 Conflict\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n${JSON.stringify(to)}`);
        }
        logRelay(peer.name, 'a terminal socket');
        const q = new URLSearchParams(url.search);
        q.set('token', (peer as { peerToken?: string }).peerToken || peer.token);
        q.delete('machine');
        q.delete('ticket');
        const upstream = new WebSocket(`${peer.url.replace(/^http/, 'ws').replace(/\/$/, '')}${path}?${q}`);
        // The remote screen starts arriving at once; hold it until the browser side is ready.
        const early: [WebSocket.RawData, boolean][] = [];
        let client: WebSocket | undefined;
        upstream.on('message', (d, isBinary) => (client ? client.send(d, { binary: isBinary }) : early.push([d, isBinary])));
        upstream.on('error', () => socket.destroy());
        upstream.on('open', () =>
          wss.handleUpgrade(req, socket, head, (ws) => {
            client = ws;
            for (const [d, isBinary] of early) ws.send(d, { binary: isBinary });
            ws.on('message', (d, isBinary) => upstream.send(d, { binary: isBinary }));
            ws.on('close', () => upstream.close());
            upstream.on('close', () => ws.close());
          }),
        );
      };
      if (m[1] === 'shells') {
        const machine = url.searchParams.get('machine');
        if (machine && machine !== MACHINE) {
          const peer = peerByName(machine);
          return peer ? relay(peer, url.pathname) : socket.destroy();
        }
        if (!m[2].startsWith('sh-') || !tmux.hasSession(m[2])) return socket.destroy();
        return wss.handleUpgrade(req, socket, head, (ws) => attachTerminal(ws, m[2], size[0], size[1]));
      }
      const agent = db.getAgent(m[2]);
      if (!agent) {
        // A name that two live agents share (AmbiguousAgentError) closes the socket, not the daemon.
        let found;
        try {
          found = await findAgentPeer(m[2]);
        } catch (e) {
          const refusal = ambiguousRefusal(e);
          if (refusal) return socket.end(refusal);
          console.error(`tty ${m[2]}: ${e instanceof Error ? e.message : e}`);
          return socket.destroy();
        }
        return found ? relay(found.peer, `/api/agents/${found.agent.id}/tty`) : socket.destroy();
      }
      if (!tmux.hasSession(agent.id)) return socket.destroy();
      wss.handleUpgrade(req, socket, head, (ws) => attachTerminal(ws, agent.id, size[0], size[1]));
    });
    server.on('error', (e) => {
      console.error(`can't listen on ${addr}:${PORT}: ${e.message}`);
      // The primary address is this home's own port: another daemon has it, so this one exits
      // rather than run beside it (S-346).
      if (addr === addrs[0] && (e as NodeJS.ErrnoException).code === 'EADDRINUSE') process.exit(1);
    });
    server.listen(PORT, addr, () => {
      console.log(`stamd listening on http://${addr}:${PORT}`);
      // Indexes the mail that has no vector yet, in the background, and again once the local
      // embedder is installed (S-141).
      void backfill();
      whenInstalled(() => void backfill());
      // Shared settings (S-390), once this home's own port serves: the home tells peers of a change
      // (and once now), and a peer fetches them, in the background.
      if (addr === addrs[0]) {
        watchHomeChanges();
        startSettingsSync();
      }
    });
  }
}
