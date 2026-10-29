import { warmLessons } from '../retro-lessons.ts';
import { workspacePrompt } from '../workspace-prompt.ts';
import { grantedPaths } from '../workspace-share.ts';
import { loadOwned, itsaPrompt } from '../itsa-owners.ts';
import { prompt as requirementsPrompt } from '../requirements.ts';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, writeFileSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { STAM_BIN, agentDir, testTmpBase } from '../config.ts';
import { settings as stamSettings } from '../settings.ts';
import { allowRules, denyRules } from './claude-permissions.ts';
import * as db from '../db.ts';
import { ttlOf, markCold, setTurnReader } from '../cache-cold.ts';
import type { CacheTtl } from '../cache-cold.ts';
import { signal as costSignal } from '../rules.ts';
import { turnSucceeded } from '../cost-probes.ts';
import type { Agent, Activity, PermissionRequest } from '../db.ts';
import type { Adapter, ErrorClass, HookResult, LaunchSpec } from './types.ts';
import * as tmux from '../tmux.ts';
import { render, humanMailPrompt } from '../templates.ts';
import { orgPrompt, managerCostPrompt } from '../org.ts';
import { instructionsPrompt, extraMcpServers, claudePluginDir } from '../instructions.ts';
import { streamPush } from '../push.ts';
import { hookWaits, replaceHookWaits } from './hook-waits.ts';
import { dialogDetails, dialogKey, dialogNames, dialogPrompt, dialogQuestion, dialogTarget, questionNames } from './claude-dialog.ts';
import { inputBox, inputShows, aroundBox, sameAround, menuUnderBox, boxRows } from './claude-input.ts';
import { promptInBox } from './claude-ghost.ts';
import { awaitFirstPrompt, firstPromptHook } from './claude-first-prompt.ts';
import { nextCronFire, harnessTimerDetail } from './claude-timer.ts';
import { envVar, setEnvVar } from '../env.ts';
import { agentExec } from '../agent-exec.ts';

// Tests point this at a scripted fake (test/fake-claude), so no model runs.
const BIN = envVar('CLAUDE_BIN') ?? 'claude';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Whether Claude Code runs with vim keys (editorMode in the user's settings or config). In normal
// mode it shows no mode at all, so the screen alone can't tell.
function vimKeys(): boolean {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  for (const f of [join(dir, 'settings.json'), join(homedir(), '.claude.json')])
    try {
      if (JSON.parse(readFileSync(f, 'utf8')).editorMode === 'vim') return true;
    } catch {}
  return false;
}
// The working line Claude Code shows during a turn, such as "✶ Blanching… (13s · ↓ 472 tokens)".
const SPINNER = /…\s*\(\d+[smh]/;

const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
  'PreCompact',
  'PostCompact',
];

// Whether a pending dialog request is for another call than this hook's tool, so the dialog
// still waits. A dialog request with no tool (a Notification's) waits for the turn to end.
function waitsOnOtherDialog(agent: Agent, p: Record<string, any>): boolean {
  const r = db.pendingDialog(agent.id);
  if (!r) return false;
  const d = dialogDetails(r.details);
  return d.tool !== p.tool_name || dialogTarget(d.input) !== dialogTarget(p.tool_input ?? {});
}

// The user's own statusline keeps working: ours forwards to it after reporting to the daemon.
function userStatusLine(): string | undefined {
  try {
    const s = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'));
    return s.statusLine?.type === 'command' ? s.statusLine.command : undefined;
  } catch {
    return undefined;
  }
}

// Claude Code's StopFailure hook carries { hook_event_name, error, error_details?,
// last_assistant_message? }; `error` is one of these values (verified against Claude Code
// 2.1.296's hook schema). Values a retry or the cost policy can't act on return null.
const CLAUDE_ERROR_CLASS: Record<string, ErrorClass> = {
  // Subscription window or rate limit, and extra usage (billing) running out.
  rate_limit: 'limit',
  billing_error: 'credits',
  // Authentication and authorization.
  authentication_failed: 'auth',
  oauth_org_not_allowed: 'auth',
  account_on_hold: 'auth',
  verification_required: 'auth',
  cloud_credential_error: 'auth',
  // Retryable provider failures (the harness has already spent its own retries).
  overloaded: 'transient',
  server_error: 'transient',
  // max_output_tokens is a generation limit the harness handles, invalid_request and
  // model_not_found are deterministic, and unknown is unclassified: none is a cost signal.
};

function classifyClaudeError(payload: Record<string, any>): ErrorClass | null {
  if (payload?.hook_event_name !== 'StopFailure') return null;
  return CLAUDE_ERROR_CLASS[String(payload.error)] ?? null;
}

// Claude Code's statusline reports only the current context window, not session totals:
// context_window.total_input_tokens is input + cache_read + cache_write of the latest
// response (docs, "Context window fields"). The transcript keeps one usage row per
// assistant message, so stam sums those for the session's cumulative input, output, cache
// read, and cache write. Only bytes appended since the last call are parsed, in bounded
// chunks; one message can span several rows (streaming writes) with the same message id,
// so the latest row for an id replaces the earlier one instead of double counting.
interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
interface TranscriptState {
  pos: number;
  carry: Buffer;
  rows: Map<string, TokenTotals>;
  totals: TokenTotals;
  bytes: number;
  recent: { id: string; cacheWrite: number; total: number }[]; // the latest model turns parsed, oldest first, each from one row
  ttl?: CacheTtl; // the cache window of the latest row that wrote to the cache (S-2236)
}
const RECENT_TURNS = 64; // model turns kept per session for the cold-turn measure
const CHUNK = 1 << 20; // parse a transcript one megabyte at a time
const CACHE_BYTES = 16 << 20; // cap the parsed state kept for sessions, oldest evicted first
const transcripts = new Map<string, TranscriptState>();
let cachedBytes = 0;

// Rough bytes a session's cached state holds: its partial line plus one entry per row (an id string, a map slot and four numbers, about 160 bytes).
const stateBytes = (s: TranscriptState) => s.carry.length + s.rows.size * 160;

function processUsageLine(s: TranscriptState, line: string): void {
  let id: string | undefined;
  let u: any;
  try {
    const e = JSON.parse(line);
    if (e?.type !== 'assistant') return;
    id = e.message?.id ?? e.uuid;
    u = e.message?.usage;
  } catch {
    return;
  }
  if (!u || !id) return;
  s.ttl = ttlOf(u.cache_creation) ?? s.ttl;
  const t: TokenTotals = {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  };
  const turn = { id, cacheWrite: t.cacheWrite, total: t.input + t.cacheRead + t.cacheWrite };
  const at = s.recent.findIndex((r) => r.id === id);
  if (at >= 0) s.recent[at] = turn; // a streaming row for the same message replaces it
  else if (s.recent.push(turn) > RECENT_TURNS) s.recent.shift();
  const old = s.rows.get(id);
  if (old) {
    s.totals.input -= old.input;
    s.totals.output -= old.output;
    s.totals.cacheRead -= old.cacheRead;
    s.totals.cacheWrite -= old.cacheWrite;
  }
  s.rows.set(id, t);
  s.totals.input += t.input;
  s.totals.output += t.output;
  s.totals.cacheRead += t.cacheRead;
  s.totals.cacheWrite += t.cacheWrite;
}

// The cache window the session's transcript shows so far; read after sessionTokens.
export function sessionTtl(file: string | null | undefined): CacheTtl | undefined {
  return file ? transcripts.get(file)?.ttl : undefined;
}

// The id of the latest model turn in the session's transcript, read up to date.
export function sessionLastId(file: string | null | undefined): string | undefined {
  if (!file) return undefined;
  sessionTokens(file);
  return transcripts.get(file)?.recent.at(-1)?.id;
}
setTurnReader((a) => sessionLastId(a.transcript_path), (file, seen) => sessionTurnAfter(file, seen));

// The first model turn after `seen` (a turn id) in the session: its id, cache write and context
// size, all from one transcript row. With no `seen`, or one this transcript doesn't hold (a new
// session after a compaction), the oldest turn kept; only the latest 64 turns are kept, so a gap
// longer than that measures a later turn than the first.
export function sessionTurnAfter(file: string | null | undefined, seen?: string): { id: string; cacheWrite: number; total: number } | undefined {
  if (!file) return undefined;
  sessionTokens(file);
  const recent = transcripts.get(file)?.recent ?? [];
  const at = seen ? recent.findIndex((r) => r.id === seen) : -1;
  return recent[at + 1];
}

export function sessionTokens(file: string | null | undefined): TokenTotals | undefined {
  if (!file) return undefined;
  let s = transcripts.get(file);
  if (s) {
    transcripts.delete(file); // move to the end, so eviction drops the least recently used
    transcripts.set(file, s);
  } else {
    s = { pos: 0, carry: Buffer.alloc(0), rows: new Map(), totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, bytes: 0, recent: [] };
    transcripts.set(file, s);
  }
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return undefined;
  }
  if (size < s.pos) resetState(s);
  advance(s, file, size, Infinity);
  note(s);
  return s.totals;
}

function resetState(s: TranscriptState): void {
  s.pos = 0;
  s.carry = Buffer.alloc(0);
  s.rows.clear();
  s.totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  s.ttl = undefined;
  s.recent = [];
}

// Reads up to maxBytes of the unread part of file, one CHUNK at a time.
function advance(s: TranscriptState, file: string, size: number, maxBytes: number): void {
  if (size <= s.pos) return;
  const fd = openSync(file, 'r');
  try {
    let pos = s.pos;
    const stop = Math.min(size, pos + maxBytes);
    while (pos < stop) {
      const len = Math.min(CHUNK, stop - pos);
      const buf = Buffer.allocUnsafe(len);
      const n = readSync(fd, buf, 0, len, pos);
      if (n <= 0) break;
      pos += n;
      const chunk = n === len ? buf : buf.subarray(0, n);
      const data = s.carry.length ? Buffer.concat([s.carry, chunk]) : chunk;
      let start = 0;
      for (;;) {
        const nl = data.indexOf(0x0a, start);
        if (nl < 0) break;
        const line = data.subarray(start, nl);
        if (line.length && line.indexOf('"usage"') >= 0) processUsageLine(s, line.toString('utf8'));
        start = nl + 1;
      }
      s.carry = Buffer.from(data.subarray(start)); // copy, so the chunk is freed
    }
    s.pos = pos;
  } finally {
    closeSync(fd);
  }
}

// Accounts the session's cached size and evicts the least recently used sessions past the cap.
function note(s: TranscriptState): void {
  cachedBytes += stateBytes(s) - s.bytes;
  s.bytes = stateBytes(s);
  for (const [key, other] of transcripts) {
    if (cachedBytes <= CACHE_BYTES) break;
    if (other === s) continue;
    cachedBytes -= other.bytes;
    transcripts.delete(key);
  }
}

// Waits that Claude Code itself creates (source 'hook'): background work that outlives the
// turn ('job': Bash or Monitor with run_in_background, Agent with run_in_background) and
// timers ('timer': CronCreate, and ScheduleWakeup, which Claude Code stores as a one-shot
// cron). Reliable, verified live on 2.1.296: every Stop payload carries Claude Code's own
// list of what is still open, `background_tasks` ({id, type, status, description}; a
// background subagent's own shells are listed too) and `session_crons` ({id, schedule,
// recurring, prompt}), so each Stop replaces the agent's hook waits with that list; the ids
// are the task and cron ids the tools return. Between turns, a job ending or a timer firing
// starts a turn (UserPromptSubmit with a <task-notification> naming the task id, or with the
// timer's prompt), which ends in a Stop that drops it. Clearing the matching wait at that
// UserPromptSubmit is inferred from the prompt text, and only makes the wait go a turn
// sooner. Not covered: a job killed from Claude Code's task panel while idle stays until the
// next Stop. Jobs and crons survive /clear (tested), but not a restart of the process, so
// SessionStart on startup or resume drops the hook waits; durable crons come back at the
// next Stop.
const JOB_LABEL: Record<string, string> = { shell: 'background command', subagent: 'background agent', monitor: 'monitor' };

function syncStopWaits(agentId: string, p: Record<string, any>): void {
  if (Array.isArray(p.background_tasks)) {
    const jobs = p.background_tasks.filter((t: any) => t?.id && (t.status ?? 'running') === 'running');
    replaceHookWaits(
      agentId,
      'job',
      jobs.map((t: any) => ({ target: String(t.id), detail: `${JOB_LABEL[t.type] ?? t.type ?? 'job'} "${t.description ?? t.command ?? t.id}"`, data: { type: t.type } })),
    );
  }
  if (Array.isArray(p.session_crons)) {
    const crons = p.session_crons.filter((c: any) => c?.id);
    replaceHookWaits(
      agentId,
      'timer',
      crons.map((c: any) => {
        const until = c.recurring ? null : nextCronFire(String(c.schedule ?? ''));
        return {
          target: String(c.id),
          detail: harnessTimerDetail(c, until),
          until,
          data: { schedule: c.schedule, recurring: !!c.recurring, prompt: c.prompt },
        };
      }),
    );
  }
}

// A turn started by a finished job or a firing one-shot timer clears its wait.
function clearStartedWaits(agentId: string, prompt: string): void {
  const task = /^\s*<task-notification>[\s\S]*?<task-id>([^<]+)<\/task-id>[\s\S]*?<status>(\w+)<\/status>/.exec(prompt);
  if (task) {
    if (task[2] !== 'running') db.clearWaits(agentId, 'job', task[1].trim());
    return;
  }
  for (const w of hookWaits(agentId, 'timer')) {
    const d = w.data ? JSON.parse(w.data) : {};
    if (!d.recurring && d.prompt === prompt) db.clearWait(w.id);
  }
}

// The input box is the last line starting with ❯; it must hold nothing but the prompt,
// with no dialog on screen.
function inputFree(lines: string[]): boolean {
  const input = [...lines].reverse().find((l) => /^\s*❯/.test(l));
  if (!input || input.replace(/^\s*❯/, '').trim() !== '') return false;
  return !lines.some((l) => /Enter to confirm|Esc to cancel/.test(l));
}


// Stam's own unfinished typing (S-534). When an attempt stops short and the erase leaves part of the
// text in the box, that remainder (what the screen showed after the erase, and a start of the text
// stam typed) is kept with the harness session it was typed in. The next attempt in the same session
// may clear it, and only when the box holds exactly it. Anything else in the box is a draft.
const leftover = new Map<string, { text: string; session: string }>();

function rememberLeftover(agent: Agent, graphemes: string[], now: string[], width: number): void {
  const session = db.getAgent(agent.id)?.session_id ?? agent.session_id ?? '';
  let n = graphemes.length;
  while (n > 0 && !inputShows(now, graphemes.slice(0, n).join(''), width)) n--;
  if (n > 0 && session) leftover.set(agent.id, { text: graphemes.slice(0, n).join(''), session });
  else leftover.delete(agent.id);
}

// Terminal columns of a line, enough for the cursor check: wide and emoji characters take two,
// combining marks, joiners and variation selectors none. A wrong guess only makes the clear refuse.
function columns(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (/\p{M}|\u200d|[\ufe00-\ufe0f]|[\u{1f3fb}-\u{1f3ff}]/u.test(ch)) continue;
    w += /\p{Extended_Pictographic}/u.test(ch) || (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) ? 2 : 1;
  }
  return w;
}

// Clears the box if it holds exactly stam's own leftover from this session, with the cursor at the end of
// its last row: in insert mode (vim keys), End first, one backspace per grapheme, then the box is read
// again and must be empty. True only then; on any doubt nothing more is sent and the box stays a draft.
async function clearOwnLeftover(agent: Agent, lines: string[], width: number, notInsert: boolean): Promise<boolean> {
  const own = leftover.get(agent.id);
  if (!own) return false;
  const fresh = db.getAgent(agent.id);
  // A completion menu under the box is the usual reason stam's own leftover stays: one Esc closes it, as the typing
  // does, and the leftover is cleared once the screen is free. A menu that stays keeps the box a draft (S-3830).
  if (fresh?.session_id === own.session && !notInsert && boxRows(lines) && inputShows(lines, own.text, width) && menuUnderBox(lines) && !lines.some((l) => /Enter to confirm|Esc to cancel/.test(l))) {
    tmux.sendKeys(agent.id, 'Escape');
    await sleep(150);
    lines = tmux.capturePane(agent.id).split('\n');
  }
  const rows = boxRows(lines);
  if (fresh?.session_id !== own.session || notInsert || !rows || !inputShows(lines, own.text, width) || lines.some((l) => /Enter to confirm|Esc to cancel/.test(l)) || menuUnderBox(lines)) {
    // Not its own leftover any more (the human's edit, a new session, a menu): never matched later.
    if (!(fresh?.session_id === own.session && rows && inputShows(lines, own.text, width))) leftover.delete(agent.id);
    return false;
  }
  tmux.sendKeys(agent.id, 'End');
  await sleep(150);
  const cur = tmux.cursor(agent.id);
  const now = tmux.capturePane(agent.id).split('\n');
  const r2 = boxRows(now);
  if (!cur || !r2 || !inputShows(now, own.text, width) || cur.y !== r2.end - 1 || cur.x !== columns(now[r2.end - 1].replace(/\s+$/, ''))) return false;
  const graphemes = [...new Intl.Segmenter().segment(own.text)].map((g) => g.segment);
  // A key typed since the capture above would be deleted too: look again right before the backspaces.
  const last = tmux.capturePane(agent.id).split('\n');
  const cur2 = tmux.cursor(agent.id);
  if (!inputShows(last, own.text, width) || cur2?.x !== cur.x || cur2?.y !== cur.y) return false;
  tmux.sendKeys(agent.id, ...graphemes.map(() => 'BSpace'));
  await sleep(250);
  const after = inputBox(tmux.capturePane(agent.id).split('\n'), width);
  if (after?.mark === '❯' && after.text === '') {
    leftover.delete(agent.id);
    db.addEvent(agent.id, 'input:cleared', { text: own.text.slice(0, 200) });
    return true;
  }
  return false;
}

export const claude: Adapter = {
  name: 'claude',
  upgradeCommand: 'claude update',
  version: () => agentExec([BIN, '--version'], {}, { mode: 'fileSync' }).trim(),

  async launch(agent: Agent, opts: { resume?: boolean } = {}): Promise<LaunchSpec> {
    const dir = agentDir(agent.id);
    const hook = { type: 'command', command: `${STAM_BIN} hook claude` };
    // The guard runs before Bash only, and is the one hook that can refuse a command.
    // A hang would stall the agent's tool call, so the guard gives up after 5 s and lets it run.
    const guard = { type: 'command', command: `${STAM_BIN} guard`, timeout: 5 };
    // The test base folder, the agent's own workspace, and the workspaces shared with it (S-896): outside
    // these, reading a folder stops the agent on a dialog.
    const extraDirs = [...(testTmpBase() ? [testTmpBase()] : []), ...(agent.personal_workspace ? [agent.personal_workspace] : []), ...grantedPaths(agent.id)];
    const settings = {
      hooks: {
        ...Object.fromEntries(HOOK_EVENTS.map((e) => [e, [{ hooks: [hook] }]])),
        PreToolUse: [{ hooks: [hook] }, { matcher: 'Bash', hooks: [guard] }],
      },
      statusLine: { type: 'command', command: `${STAM_BIN} statusline claude`, padding: 0 },
      // stam's own tools are pre-approved (a project decision, 2026-10-11): mail stays inside
      // the user's own system, and auto mode's check blocked agents mailing what they were asked to.
      // The test base folder holds every test's daemon home and logs; outside it, reading them
      // stops the agent on a dialog even in auto mode (S-276).
      // Read-only commands are pre-approved and secrets denied (S-570, claude-permissions.ts).
      permissions: { allow: ['mcp__stam', ...allowRules()], deny: denyRules(), ...(extraDirs.length ? { additionalDirectories: extraDirs } : {}) },
      // stam compacts idle agents itself, before the cache expires (settings.idleCompaction, S-2238); Claude
      // Code's own idle compaction at about 54 minutes would race it.
      idleCompaction: false,
      // settings.harness.claude (S-2240): the cache and compaction keys the human set, over stam's; none set
      // writes the file as before.
      ...stamSettings().harness.claude,
    };
    const settingsFile = join(dir, 'claude-settings.json');
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2));

    const mcpFile = join(dir, 'claude-mcp.json');
    // The mcp-config file holds env values and header values, so it is private to the user.
    // A url server needs its type: Claude Code reads `http` as a streamable HTTP server.
    const servers: Record<string, unknown> = {};
    for (const [name, s] of Object.entries(extraMcpServers()))
      // An auth server is reached through stam's proxy, never its url or a header: the token
      // lives in the daemon (mcp-auth.ts).
      servers[name] = s.auth
        ? { command: STAM_BIN, args: ['mcp-proxy', name] }
        : s.url
          ? { type: 'http', url: s.url, ...(s.headers ? { headers: s.headers } : {}) }
          : { command: s.command, ...(s.args ? { args: s.args } : {}), ...(s.env ? { env: s.env } : {}) };
    writeFileSync(mcpFile, JSON.stringify({ mcpServers: { ...servers, stam: { command: STAM_BIN, args: ['mcp'] } } }, null, 2), { mode: 0o600 });

    await loadOwned(agent.id);
    const promptFile = join(dir, 'system-prompt.md');
    writeFileSync(
      promptFile,
      render('system-prompt', { id: agent.id, name: agent.name, machine: agent.machine, role: agent.role || 'not set', org: orgPrompt(agent), instructions: instructionsPrompt('claude', agent.cwd), cost: managerCostPrompt(agent), retro: render('retro', {}, agent.type), lessons: await warmLessons(agent), workspace: workspacePrompt(agent), itsa: itsaPrompt(agent.id), requirements: requirementsPrompt(), human_mail: humanMailPrompt(agent.model, agent.type) }, agent.type),
    );

    // The stam MCP server doubles as a Claude Code channel, which lets stam start a
    // turn in an idle session without typing into its input box.
    const argv = [
      BIN,
      opts.resume ? '--resume' : '--session-id',
      agent.session_id!,
      '--settings',
      settingsFile,
      '--mcp-config',
      mcpFile,
      '--dangerously-load-development-channels',
      'server:stam',
      '--append-system-prompt-file',
      promptFile,
    ];
    const plugin = claudePluginDir();
    if (plugin) argv.push('--plugin-dir', plugin);
    if (agent.model) argv.push('--model', agent.model);
    if (agent.effort) argv.push('--effort', agent.effort);
    argv.push('--permission-mode', agent.permission_mode === 'bypass' ? 'bypassPermissions' : agent.permission_mode === 'default' ? 'default' : 'auto');
    const env: Record<string, string> = {};
    const usl = userStatusLine();
    if (usl) setEnvVar('USER_STATUSLINE', usl, env);
    return { argv, env };
  },

  onHook(agent: Agent, p: Record<string, any>): HookResult {
    const event = p.hook_event_name as string;
    const set = (activity: Activity, detail: string | null = null): HookResult => ({ activity, detail });
    switch (event) {
      case 'SessionStart':
        // A new process has none of the old one's jobs or session timers (see syncStopWaits).
        if (p.source === 'startup' || p.source === 'resume') for (const w of hookWaits(agent.id)) db.clearWait(w.id);
        if (agent.activity === 'starting' && agent.activity_detail === 'with prompt') return { session_id: p.session_id, transcript_path: p.transcript_path };
        // S-3250: a launch's SessionStart that lands late (it retried while the daemon restarted) after
        // reconcile settled the agent and a turn began doesn't end that turn.
        if ((p.source === 'startup' || p.source === 'resume') && (agent.activity === 'working' || agent.activity === 'blocked')) return { session_id: p.session_id, transcript_path: p.transcript_path };
        return { activity: 'idle', detail: `session ${p.source ?? 'start'}`, session_id: p.session_id, transcript_path: p.transcript_path };
      case 'UserPromptSubmit':
        firstPromptHook(agent.id, p.prompt);
        if (typeof p.prompt === 'string' && hookWaits(agent.id).length) {
          // Working first, so clearing the last wait doesn't pass through idle and tell parents.
          db.updateAgent(agent.id, { activity: 'working', activity_detail: null });
          clearStartedWaits(agent.id, p.prompt);
        }
        return set('working');
      case 'PreToolUse':
        // A tool the model runs in parallel starts while a dialog waits; the agent stays
        // blocked on the dialog (S-320).
        if (db.pendingDialog(agent.id)) return {};
        return set('working', `tool ${p.tool_name}`);
      case 'PostToolUse':
        // The model answered: if this turn is its account's probe, the account works.
        turnSucceeded(agent.id);
        // Only the dialog's own tool finishing says the dialog was answered (yes, in the terminal).
        if (waitsOnOtherDialog(agent, p)) return { afterTool: true };
        return { activity: 'working', detail: null, afterTool: true };
      case 'PermissionRequest':
        // A question's dialog is an ask too: its card shows the question and options, and the human's choice is typed back (answerDialog).
        if (p.tool_name === 'AskUserQuestion') return { ...set('blocked', 'question'), dialog: { action: 'Claude Code asks a question', details: JSON.stringify({ tool: p.tool_name, input: p.tool_input ?? {}, session: p.session_id ?? agent.session_id }), replaces: true } };
        // Auto mode still shows some dialogs, such as a read outside the working directories.
        return { ...set('blocked', `permission ${p.tool_name}`), dialog: { action: `Claude Code asks to allow ${p.tool_name}`, details: JSON.stringify({ tool: p.tool_name, input: p.tool_input ?? {}, session: p.session_id ?? agent.session_id }), replaces: true } };
      case 'Notification':
        // Claude Code also sends this for a dialog no PermissionRequest announced.
        if (p.notification_type === 'permission_prompt') return { ...set('blocked', 'permission prompt'), dialog: { action: 'Claude Code shows a permission dialog', details: JSON.stringify({ message: p.message ?? '', session: p.session_id ?? agent.session_id }) } };
        if (String(p.notification_type ?? '').startsWith('elicitation')) return set('blocked', 'elicitation');
        if (p.notification_type === 'idle_prompt') return set('idle', 'waiting for input');
        return {};
      case 'Stop':
        turnSucceeded(agent.id);
        syncStopWaits(agent.id, p);
        return { activity: 'idle', detail: 'turn finished', turnEnded: true, last_message: p.last_assistant_message };
      case 'StopFailure': {
        const cls = classifyClaudeError(p);
        if (cls) costSignal(agent.id, { source: 'StopFailure', class: cls, error: p.error });
        return set('errored', String(p.error ?? 'unknown error'));
      }
      case 'SessionEnd':
        // SessionEnd also fires on /clear, which starts a new session in the same harness. Any other
        // reason ends the harness: the tmux check notices a pane that exits, and the daemon's
        // session-end check one whose pane outlives it (S-384). A SessionStart that follows sets it back.
        // A harness stam takes down itself (a compaction, shutdown, or relaunch) keeps the state stam gave it.
        if (p.reason === 'clear' || agent.lifecycle !== 'active' || agent.activity === 'starting' || agent.activity_detail?.startsWith('compacting')) return {};
        return set('unknown', db.SESSION_ENDED);
      case 'PreCompact':
        return set('working', `compacting (${p.trigger})`);
      case 'PostCompact':
        // The harness's own compaction (stam's marks once, see markCold) leaves its next turn cold.
        markCold(agent, 'compaction');
        return { activity: 'idle', detail: 'compacted', turnEnded: true };
      default:
        return {};
    }
  },

  classifyError: classifyClaudeError,

  // A live Claude Code session can't be compacted from outside, so stam quits it,
  // runs /compact headless on the same session, and resumes it.
  async compact(agent: Agent, instructions?: string, opts?: { op?: string }) {
    tmux.killSession(agent.id);
    // The command goes in on stdin: instructions on a command line would show in `ps`.
    const args = ['-p', '--resume', agent.session_id!, '--output-format', 'json'];
    if (agent.model) args.push('--model', agent.model);
    const run = agentExec([BIN, ...args], { STAM_AGENT_ID: '', STAM_COMPACTOR: `${agent.id}:${opts?.op ?? ''}` }, { mode: 'file', cwd: agent.cwd, timeout: 600_000 });
    // A compactor that exits before reading stdin fails this write with EPIPE. Unhandled, that
    // took the daemon down (S-2040); the run's own rejection reports the failure.
    run.child.stdin!.on('error', () => {});
    run.child.stdin!.end(`/compact ${instructions ?? ''}`.trim());
    await run;
    return { relaunch: true };
  },
  compactQuits: true,

  // S-358: /compact appends its rows only once the summary is back, so a compactor stopped
  // mid-run leaves at most a last row cut short by the kill; it is trimmed back to the last newline.
  async repairSession(agent: Agent) {
    const file = agent.transcript_path;
    if (!file || !existsSync(file)) return;
    const fh = await open(file, 'r+');
    try {
      const { size } = await fh.stat();
      const tail = Buffer.alloc(Math.min(size, 1 << 20));
      await fh.read(tail, 0, tail.length, size - tail.length);
      if (!tail.length || tail[tail.length - 1] === 0x0a) return;
      const nl = tail.lastIndexOf(0x0a);
      // A row longer than the tail read is left alone rather than guessed at.
      if (nl >= 0 || tail.length === size) await fh.truncate(size - tail.length + nl + 1);
    } finally {
      await fh.close();
    }
  },

  async pushPrompt(agent: Agent, text: string): Promise<boolean> {
    return streamPush(agent.id, text, { kind: 'mail' });
  },

  // An empty input box, with no spinner or dialog on screen.
  async atPrompt(agent: Agent): Promise<boolean> {
    if (!(await tmux.hasSessionAsync(agent.id))) return false;
    const screen = await tmux.capturePaneByNameAsync(agent.id);
    return !SPINNER.test(screen) && inputFree(screen.split('\n'));
  },

  // Answers only the request's own dialog, in the session that showed it. A yes needs the
  // dialog on screen, from its top rule to its "Esc to cancel" line, to name the request's
  // tool and full target (dialogNames), and to offer a one-time yes (dialogKey); it is that
  // option's number, since Enter would take whichever option the cursor is on, and never an
  // option that keeps allowing. A no is "No, and ask again next time" when offered, else Esc,
  // which Claude Code reads as No; neither denies anything the agent hasn't asked for.
  // A question dialog (AskUserQuestion) takes the human's choice instead: `choice` must be one of its
  // option labels, and the screen must show that question with those options in order (questionNames),
  // else nothing is typed ('unsafe'). A no needs the same screen match for the question's text and labels
  // (dialogPrompt), so it never cancels another dialog. The choice goes in as its option number. Free text is not typed yet.
  answerDialog(agent: Agent, request: PermissionRequest, approve: boolean, choice?: string) {
    const d = dialogDetails(request.details);
    if (agent.activity !== 'blocked' || !tmux.hasSession(agent.id) || (d.session && d.session !== agent.session_id)) return 'gone' as const;
    const lines = tmux.capturePane(agent.id).split('\n');
    const end = lines.findLastIndex((l) => /Esc to cancel/.test(l));
    if (end < 0) return 'gone' as const;
    const top = lines.slice(0, end).findLastIndex((l) => /^\s*[╭─━]{3,}/.test(l));
    const body = top < 0 ? [] : lines.slice(top + 1, end);
    if (d.tool === 'AskUserQuestion') {
      // A no matches the screen to the question's text and every label, multi-select or not, so Esc only lands on this dialog.
      const prompt = dialogPrompt(d.input);
      if (!prompt || !questionNames(body, prompt.question, prompt.options)) return 'unsafe' as const;
      if (!approve) {
        tmux.sendKeys(agent.id, 'Escape');
        return 'typed' as const;
      }
      const q = dialogQuestion(d.input);
      const at = q && choice !== undefined ? q.options.indexOf(choice) : -1;
      if (!q || at < 0 || !questionNames(body, q.question, q.options)) return 'unsafe' as const;
      tmux.sendKeys(agent.id, String(at + 1));
      return 'typed' as const;
    }
    const key = dialogKey(body, approve);
    if (approve && (!dialogNames(body, d.tool ?? '', dialogTarget(d.input)) || !key)) return 'unsafe' as const;
    tmux.sendKeys(agent.id, key ?? 'Escape');
    return 'typed' as const;
  },

  // What the input box holds right now, as typed (a bash-mode box starts with !), for telling the
  // agent what blocks an approved line (S-524). Undefined when the screen doesn't show a box.
  inputText(agent: Agent): string | undefined {
    if (!tmux.hasSession(agent.id)) return undefined;
    const box = inputBox(tmux.capturePane(agent.id).split('\n'), tmux.paneWidth(agent.id));
    return box?.text === undefined ? undefined : (box.mark === '!' ? '!' : '') + box.text;
  },

  async typeHumanInput(agent: Agent, text: string): Promise<boolean> {
    if (agent.activity !== 'idle' && agent.activity !== 'waiting') return false;
    if (!tmux.hasSession(agent.id)) return false;
    const lines = tmux.capturePane(agent.id).split('\n');
    if (!inputFree(lines)) return false;
    // With vim keys, the box must be in insert mode or the text becomes commands.
    if (lines.some((l) => l.includes('-- NORMAL --'))) {
      tmux.sendKeys(agent.id, 'i');
      await sleep(200);
    }
    tmux.sendKeys(agent.id, '-l', text.replace(/\s+/g, ' ').trim());
    await sleep(600);
    tmux.sendKeys(agent.id, 'Enter');
    return true;
  },

  // A suggestion the human approved (S-422), typed exactly as written into this agent's own
  // session: the text goes in as its UTF-8 bytes (send-keys -H), so tmux parses none of it (an
  // argument ending in ';' would be cut). Enter follows only once the box shows exactly the text in
  // the right mode (inputShows), the screen around it is as before (aroundBox), and `proceed` says
  // yes right before it. A completion menu (after `/` or `@`) would take Enter for its highlighted
  // item, so it gets one Esc (two would clear the box or rewind), and if the screen isn't back as it
  // was, nothing is sent. With vim keys the box must be in insert mode first. Someone's draft in the
  // box is never touched: that is 'draft', as a busy agent or a dialog on screen is 'busy', and the
  // caller holds the approval. When it doesn't send, it erases what it typed: 'failed' when the
  // screen was wrong, 'cancelled' when `proceed` said no.
  async typeLiteralInput(agent: Agent, text: string, proceed: (stillTyped: () => boolean) => boolean | Promise<boolean> = () => true) {
    if (agent.activity !== 'idle' && agent.activity !== 'waiting') return 'busy' as const;
    if (!tmux.hasSession(agent.id)) return 'busy' as const;
    const width = tmux.paneWidth(agent.id);
    const screen = () => tmux.capturePane(agent.id).split('\n');
    // A turn is running: a dialog, or Claude Code's working line ("✽ Marinating…", which has no
    // timer yet when the turn has just started, before its hook reaches stam). Typing then races
    // the turn's output, and an Esc would interrupt it.
    const running = (l: string[]) => l.some((x) => /Enter to confirm|Esc to cancel/.test(x) || /^\s*[·✢✳✶✻✽*]\s+\S.*…/.test(x)) || SPINNER.test(l.join('\n'));
    let lines = screen();
    if (running(lines)) return 'busy' as const;
    const empty = (b: ReturnType<typeof inputBox>) => b?.mark === '❯' && b.text === '';
    const box = inputBox(lines, width);
    if (!box) return 'busy' as const;
    // With vim keys, the box must be in insert mode or the text becomes commands. Claude Code
    // shows -- INSERT -- in the footer under the box then, and nothing in normal mode.
    const insert = (l: string[]) => aroundBox(l).footer.some((x) => x.includes('-- INSERT --'));
    const vim = insert(lines) || aroundBox(lines).footer.some((l) => l.includes('-- NORMAL --')) || vimKeys();
    if (empty(box)) leftover.delete(agent.id);
    else {
      // Only stam's own unfinished typing from an earlier attempt, exactly, is taken back (S-534).
      if (!(await clearOwnLeftover(agent, lines, width, vim && !insert(lines)))) return 'draft' as const;
      lines = screen();
      if (!empty(inputBox(lines, width))) return 'draft' as const;
    }
    if (vim && !insert(lines)) {
      // The footer may be mid-redraw: look again before taking it for normal mode.
      for (let i = 0; i < 3 && !insert(lines); i++) {
        await sleep(300);
        lines = screen();
      }
    }
    if (vim && !insert(lines)) {
      if (!empty(inputBox(lines, width))) return 'draft' as const;
      tmux.sendKeys(agent.id, 'i');
      await sleep(200);
      lines = screen();
      // It was in insert mode after all, and the i went into the box: take it back, and try later.
      if (inputBox(lines, width)?.text === 'i') {
        tmux.sendKeys(agent.id, 'BSpace');
        return 'busy' as const;
      }
      if (!insert(lines)) return 'busy' as const;
      if (!empty(inputBox(lines, width))) return 'draft' as const;
    }
    const around = aroundBox(lines);
    const bytes = [...Buffer.from(text, 'utf8')].map((b) => b.toString(16).padStart(2, '0'));
    tmux.sendKeys(agent.id, '-H', ...bytes);
    // Set when the box changed after the typing and before Enter, so the erase below is 'failed', not 'cancelled'.
    let changed = false;
    // Erasing takes back only what stam typed: the box must show the text, or a start of it, and no
    // dialog, else nothing is sent. Claude Code deletes a grapheme per backspace; it leaves bash mode
    // on a backspace in an empty box, which the leading ! started. An Esc may have left vim's insert
    // mode, so `A` goes back to it at the end of the text first.
    const graphemes = [...new Intl.Segmenter().segment(text)].map((g) => g.segment);
    const erase = async <T>(outcome: T): Promise<T | 'failed'> => {
      if (!tmux.hasSession(agent.id)) return outcome;
      let now = screen();
      if (vim && !insert(now)) {
        tmux.sendKeys(agent.id, 'A');
        await sleep(150);
        now = screen();
      }
      if (now.some((l) => /Enter to confirm|Esc to cancel/.test(l)) || (vim && !insert(now))) return 'failed';
      let n = graphemes.length;
      while (n > 0 && !inputShows(now, graphemes.slice(0, n).join(''), width)) n--;
      if (n === 0 && !empty(inputBox(now, width))) return 'failed';
      if (n) tmux.sendKeys(agent.id, ...Array.from({ length: n }, () => 'BSpace'));
      // Whatever the box still shows of it afterwards is stam's own, noted for the next attempt.
      await sleep(250);
      rememberLeftover(agent, graphemes, screen(), width);
      return outcome;
    };
    // Why it failed, and the screen then, kept as an event for whoever looks into it.
    const failed = (what: string, before: ReturnType<typeof aroundBox>) => {
      const now = tmux.hasSession(agent.id) ? screen() : [];
      db.addEvent(agent.id, 'input:screen', { what, before: before.above.slice(-8), now: now.filter((l) => l.trim()).slice(-14) });
      return 'failed' as const;
    };
    // 'ok' once the box shows the text with the screen around it as before; 'busy' when a turn
    // started meanwhile (the approval stays held and is typed again at the next idle).
    const settled = async () => {
      for (let i = 0; i < 10; i++) {
        await sleep(150);
        if (!tmux.hasSession(agent.id)) return 'no';
        const now = screen();
        if (running(now)) return 'busy';
        if (inputShows(now, text, width) && sameAround(around, aroundBox(now)) && !menuUnderBox(now) && (!vim || insert(now))) return 'ok';
      }
      return 'no';
    };
    let state = await settled();
    if (state === 'no') {
      if (!tmux.hasSession(agent.id) || !inputShows(screen(), text, width)) return erase(failed('the box', around));
      // The text is there but something drew around it, such as a completion menu (over the box, or
      // under it as a path menu after `! rm ~/…` can, S-500): one Esc closes it,
      // never while a turn runs, where it would interrupt the turn.
      if (running(screen())) return erase('busy' as const);
      tmux.sendKeys(agent.id, 'Escape');
      state = await settled();
      if (state === 'no') return erase(failed('the screen around the box, after one Esc', around));
    }
    if (state === 'busy') return erase('busy' as const);
    // `proceed` gets `stillTyped`, which reads the screen once more: `proceed` claims the approval only if
    // the box still shows exactly the text, so a key typed into it since the check above (by the agent or
    // the human) is never submitted with the text. Such a change is 'failed', not 'cancelled' (S-3830).
    const stillTyped = () => {
      const now = screen();
      if (!inputShows(now, text, width) || !sameAround(around, aroundBox(now)) || menuUnderBox(now)) changed = true;
      return !changed;
    };
    if (!(await proceed(stillTyped))) return erase((changed ? 'failed' : 'cancelled') as 'failed' | 'cancelled');
    tmux.sendKeys(agent.id, 'Enter');
    return 'typed' as const;
  },

  inTurnNotice(text: string): string {
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } });
  },

  onStatusLine(agent: Agent, p: Record<string, any>) {
    const cw = p.context_window;
    const u = cw?.current_usage;
    // Before its first model call (at launch, and on the relaunch after a compaction) the
    // usage is missing or all zeros: the size is unknown, not 0.
    const tokens = u ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) || undefined : undefined;
    // The transcript path is the session identity: a new one starts the token counters over.
    const session = p.transcript_path ?? agent.transcript_path;
    const totals = sessionTokens(session);
    return {
      context_tokens: tokens,
      context_window: cw?.context_window_size,
      cost: p.cost?.total_cost_usd,
      tokensIn: totals?.input,
      tokensOut: totals?.output,
      tokensCacheRead: totals?.cacheRead,
      tokensCacheWrite: totals?.cacheWrite,
      // The latest turn's cache write and the detected cache window, for cache-cold.ts.
      cacheTtl: sessionTtl(session),
      session,
      subscription: p.rate_limits,
    };
  },

  // Claude Code shows dialogs at launch (folder trust, new MCP servers, development
  // channels). Nobody has attached yet, so answering them can't collide with a human's
  // typing. Some dialogs default to "No, exit", so the cursor is moved to the accepting
  // option before Enter. Then the first prompt is typed in (see typeFirstPrompt).
  // Esc stops a running turn, as the human's does. With vim keys on, the first Esc only
  // leaves INSERT mode and the turn runs on, so a second one stops it (verified live on
  // 2.1.296). Each Esc goes in only while the turn still runs (stam's state and the spinner
  // on screen), so an idle input, or a human's draft, is never touched; insert mode isn't
  // restored, since an `i` typed then would land in the input. Claude Code runs no hook for
  // an interrupted turn: it counts as confirmed only when a new "Interrupted" line appears.
  async interrupt(agent: Agent): Promise<boolean> {
    const screen = () => (tmux.hasSession(agent.id) ? tmux.capturePane(agent.id) : '');
    const running = () => {
      const a = db.getAgent(agent.id);
      return (a?.activity === 'working' || a?.activity === 'starting') && SPINNER.test(screen());
    };
    const marks = () => (screen().match(/Interrupted ·/g) ?? []).length;
    const before = marks();
    for (let i = 0; i < 2 && running(); i++) {
      const insert = screen().includes('-- INSERT --');
      tmux.sendKeys(agent.id, 'Escape');
      await sleep(400);
      if (!insert) break;
    }
    for (let i = 0; i < 20; i++) {
      if (marks() > before) return true;
      await sleep(250);
    }
    return false;
  },

  async afterLaunch(agent: Agent, prompt?: string, opts: { admit?: () => boolean; current?: () => boolean } = {}) {
    await answerLaunchDialogs(agent);
    if (prompt) await typeFirstPrompt(agent, prompt, opts.admit, opts.current);
  },
};

// Returns once the input prompt is visible or after a timeout.
async function answerLaunchDialogs(agent: Agent): Promise<void> {
  const accept = /Yes, I trust this folder|Yes, proceed|I am using this for local development|Use this and all future MCP servers|Resume full session/i;
  const ready = /\? for shortcuts|bypass permissions|auto mode|accept edits|plan mode|esc to interrupt/i;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await sleep(400);
    if (!tmux.hasSession(agent.id) || tmux.isDead(agent.id)) return;
    const lines = tmux.capturePane(agent.id).split('\n');
    const target = lines.findIndex((l) => accept.test(l));
    const cursor = lines.findIndex((l) => /^\s*❯/.test(l));
    if (target >= 0 && cursor >= 0 && Math.abs(target - cursor) < 6) {
      // Press Enter only once the cursor is on the accepting option: a dialog that is
      // still drawing can drop the arrow key, and Enter would then pick "No, exit".
      if (target !== cursor) {
        tmux.sendKeys(agent.id, target > cursor ? 'Down' : 'Up');
        await sleep(300);
        continue;
      }
      tmux.sendKeys(agent.id, 'Enter');
      await sleep(1500);
    } else if (ready.test(lines.join('\n'))) {
      return;
    }
  }
}

// Claude Code takes a first prompt only as a command-line argument, so stam types it into
// the input box instead, once the box is up and empty: one bracketed paste (the text
// reaches tmux on stdin), then Enter. Typed input is the user's own message, as the
// argument was, so auto mode trusts it; a channel message it would not. Nobody has
// attached yet, or the harness has just restarted, so no human draft is in the way.
// A placeholder or prompt suggestion, drawn faint, counts as an empty box: the paste replaces it
// (S-2123). Enter goes only to a box that holds exactly one copy of the prompt (promptInBox). A
// paste that never shows and leaves the box empty past a settle was lost (a Claude Code still
// resuming drops it) and goes in again; a box with anything else in it is left as it is, with
// nothing pressed, so a late first paste can't make a doubled prompt. Done when UserPromptSubmit
// ends 'starting': nothing is pasted or pressed after that. A box that empties on Enter took the
// prompt, so its hook gets a grace period (a stalled daemon handles it late) before a failure.
// A launch a restart or resume superseded (`current` false) pastes, presses and fails nothing
// more, and returns quietly (event first-prompt:superseded): the session under this agent's id is
// the new launch's now.
async function typeFirstPrompt(agent: Agent, text: string, admit?: () => boolean, current: () => boolean = () => true): Promise<void> {
  const first = awaitFirstPrompt(agent.id);
  try {
    await deliverFirstPrompt(agent, text, first.taken, admit, current);
  } catch (e) {
    if (current()) throw e;
  } finally {
    first.done();
  }
  if (!current()) db.addEvent(agent.id, 'first-prompt:superseded');
}

// `firstTaken` is true once a UserPromptSubmit that isn't a channel push has come (firstPromptHook).
async function deliverFirstPrompt(agent: Agent, text: string, firstTaken: () => boolean, admit: (() => boolean) | undefined, current: () => boolean): Promise<void> {
  const delivered = firstTaken;
  const screen = () => {
    const ansi = tmux.capturePaneAnsi(agent.id, 200).split('\n');
    return { lines: tmux.capturePane(agent.id).split('\n'), box: promptInBox(ansi, text) };
  };
  const alive = () => {
    if (!tmux.hasSession(agent.id) || tmux.isDead(agent.id)) throw new Error('the harness exited');
  };
  // A failure records the screen it saw, styles and all (S-2123), so its cause can be read later.
  const failed = (msg: string) => {
    if (current() && tmux.hasSession(agent.id)) db.addEvent(agent.id, 'first-prompt:screen', { error: msg, screen: tmux.capturePaneAnsi(agent.id, 16).split('\n') });
    return new Error(msg);
  };
  const notOne = () => failed('the input box does not show the prompt exactly once, so nothing was pressed');
  let deadline = Date.now() + 30_000;
  for (;;) {
    alive();
    if (!current()) return;
    const { lines, box } = screen();
    if (box === 'empty' && !lines.some((l) => /Enter to confirm|Esc to cancel/.test(l))) {
      // With vim keys, the box must be in insert mode or the text becomes commands.
      if (lines.some((l) => l.includes('-- NORMAL --'))) {
        tmux.sendKeys(agent.id, 'i');
        await sleep(200);
      }
      break;
    }
    if (Date.now() > deadline) throw failed('no empty input box');
    await sleep(300);
  }
  if (admit && !admit()) return;
  const until = async (ms: number, done: () => boolean) => {
    const end = Date.now() + ms;
    while (Date.now() < end && !done()) await sleep(300);
    return done();
  };
  for (let paste = 0; ; paste++) {
    alive();
    if (delivered() || !current()) return;
    tmux.paste(agent.id, text);
    // A long paste takes a moment to land; an Enter before that is lost.
    if (await until(10_000, () => screen().box !== 'empty')) break;
    // Still empty after a settle: the paste was lost, so pasting again can't double it.
    await sleep(2000);
    if (screen().box !== 'empty') break;
    if (paste === 2) throw failed('pasted the prompt, but it never showed in the input box');
  }
  // It lands in parts; then it must stay exactly one copy through a settle.
  if (!(await until(10_000, () => screen().box === 'one'))) throw notOne();
  await sleep(500);
  if (screen().box !== 'one') throw notOne();
  // The box empties (or goes, as the turn starts) once Claude Code takes the prompt.
  const took = () => screen().box !== 'one';
  let taken = false;
  for (let attempt = 0; attempt < 3 && !taken; attempt++) {
    alive();
    if (delivered() || !current()) return;
    tmux.sendKeys(agent.id, 'Enter');
    taken = await until(10_000, () => delivered() || !current() || took());
    if (delivered() || !current()) return;
    // The Enter was lost and the text is still in the box: Enter again. Anything else is left alone.
    if (taken && screen().box === 'other') throw notOne();
  }
  if (!taken) throw failed('typed the prompt, but Claude Code did not take it');
  const done = () => delivered() || !current();
  if (await until(2000, done)) return;
  db.addEvent(agent.id, 'first-prompt:awaiting-hook');
  if (await until(120_000, done)) return;
  throw failed('Claude Code took the prompt, but its UserPromptSubmit hook never came');
}
