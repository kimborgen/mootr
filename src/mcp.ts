// `stam mcp`: the MCP server every agent talks to. A thin stdio process: all logic lives
// in the daemon, so the daemon can restart or update without the agent reconnecting.
// For Claude Code it is also a channel (claude/channel), so the daemon can push prompts.
import { api, SWITCH_CALL_MS, WRITE_CALL_MS, writeId } from './client.ts';
import { normalizeMailInput } from './mail-input.ts';
import { unconfirmedVerdict } from './pr-review-message.ts';
import { formatPrediction, type PrPrediction } from './pr-predict-format.ts';
import { existsSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MACHINE, RELEASES, ROOT, STAM_URL, readToken } from './config.ts';
import { extraTools } from './test-faults.ts';
import { template } from './templates.ts';
import { FEEDBACK_KINDS } from './feedback.ts';
import { blendHits } from './hit-blend.ts';
import { activityInfoOf, type Mode } from './activity-info.ts';
import { holdersText } from './developer-cap.ts';
import { compactUsage } from './usage-compact.ts';
import { fieldsChange, fieldsLine } from './itsa-fields-line.ts';
import { EFFORT_KEYS, EVIDENCE_KINDS, RETRO_KINDS, STAM_ISSUE_KIND, runRetro } from './retro.ts';
import { envVar, setEnvVar } from './env.ts';

let agentId = envVar('AGENT_ID');
// The read_mail batch each agent last got a reply to (S-357). The daemon keeps the mail of a batch
// owed until the next read acknowledges it, so a read whose reply never arrived loses nothing.
// Keyed by agent: some harnesses share one MCP process between agents. Kept in the environment, so
// a newer release's tools loaded in this process (followDeploys) and the release this process
// re-execs onto (reexecWhenIdle) acknowledge the same batch (S-811).
const ACK_ENV = 'STAM_MCP_READ_ACK';
const readAck = {
  all: (): Record<string, string> => {
    try {
      return JSON.parse(process.env[ACK_ENV] ?? '{}');
    } catch {
      return {};
    }
  },
  get: (id: string): string | undefined => readAck.all()[id],
  set: (id: string, batch: string) => void (process.env[ACK_ENV] = JSON.stringify({ ...readAck.all(), [id]: batch })),
};

const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));

// The layout as text: each world's panes as an indented tree, then the raw JSON.
function layoutText(l: any): { content: { type: 'text'; text: string }[] } {
  const lines = [`Layout version ${l.version}, current: ${l.current ?? 'home'} (the world an agent last sent the human to; each device may show another one, as the human navigates there)`];
  const node = (n: any, depth: number, focused: string) => {
    const pad = '  '.repeat(depth);
    if (n.split) {
      lines.push(`${pad}${n.split === 'row' ? 'row' : 'column'} split`);
      for (const c of n.children) node(c, depth + 1, focused);
      return;
    }
    lines.push(`${pad}pane ${n.id}${n.id === focused ? ' (focused)' : ''}${n.tabs.length ? '' : ' (empty)'}`);
    for (const t of n.tabs) lines.push(`${pad}  ${t === n.active ? '* ' : '- '}${t}${t === n.active ? ' (active)' : ''}`);
  };
  const world = (label: string, w: any) => {
    lines.push(`${label}:`);
    node(w.root, 1, w.focused);
  };
  for (const [id, w] of Object.entries<any>(l.agentWorlds ?? {})) world(`${id === '_home' ? 'home' : 'agent ' + id}${id === (l.current ?? '_home') ? ' (current)' : ''}`, w);
  for (const [name, w] of Object.entries<any>(l.worlds ?? {})) world(`world ${name}`, w);
  if (!Object.keys(l.agentWorlds ?? {}).length && !Object.keys(l.worlds ?? {}).length) lines.push('No panes yet.');
  lines.push('', `Raw: ${JSON.stringify(l)}`);
  return text(lines.join('\n'));
}

// Some harnesses (OpenCode) share one MCP process between agents, so the agent names
// itself with the `self` argument; its stam system prompt gives it its id.
function me(args: any = {}): string {
  const id = agentId ?? args.self;
  if (!id) throw new Error('Pass your stam id as `self`, or call `register` first if you have none.');
  return id;
}

const self = { type: 'string', description: 'Your stam agent id. Needed only when your system prompt asks for it.' };
// Where an ask to the human goes (S-3827, src/ask-home.ts): its home thread, named by the mail it arose from or its ITSA.
const ASK_HOME =
  " When it reaches your user it goes in its home thread, so they see it with its work: the thread of `thread` (the mail it arose from), else the thread of `itsa`, else of the one active ITSA you own. With none of these it goes in a new thread; pass `override` with a one-line reason when no thread or ITSA fits. A `thread` or `itsa` you can't read is refused.";
const askHomeProps = {
  thread: { type: 'string', description: 'The id of the mail this ask arose from, one you can read: the ask goes in that thread.' },
  itsa: { type: 'string', description: "The ITSA it is for (key or id): the ask goes in that ITSA's thread when you pass no thread. Without it, the one active ITSA you own." },
  override: { type: 'string', description: 'Only when no thread or ITSA fits: a one-line reason to send it in a new thread. Your user sees the reason.' },
};
const askHomeArgs = (a: Record<string, any>) => ({ thread: a.thread, itsa: a.itsa, override: a.override });
// The daemon's hint when the ask found no home thread (it went to a new one).
const hinted = (r: { hint?: string }) => (r?.hint ? ` It found no home thread, so it went to a new one. ${r.hint}` : '');

// The ITSA a tool acts on: its `ref` (or `itsa` for itsa_post), with key and id accepted as aliases.
// Missing, it says what to pass rather than failing later with "no ITSA undefined".

function itsaRef(a: any, name = 'ref'): string {
  const ref = a[name] ?? a.ref ?? a.key ?? a.id;
  if (typeof ref !== 'string' || !ref.trim()) throw new Error('ref is required: an ITSA key like S-12 or its id');
  return ref.trim();
}

// ITSA results name owners and participants. Ids resolve to names through the registry as
// the calling agent, so it sees only the agents it may see; one that doesn't resolve shows
// as its id. `human` is the human.
async function namesOf(self: string, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const want = new Set(ids.filter((x): x is string => !!x && x !== 'human'));
  if (!want.size) return out;
  try {
    // Only the wanted agents, in any state (S-3816), not the whole list.
    const list = await api<any[]>('GET', `/api/agents?${new URLSearchParams({ as: self, ids: [...want].join(',') })}`);
    for (const a of list) if (want.has(a.id)) out.set(a.id, a.name);
  } catch {}
  return out;
}

const nameOf = (id: string | null | undefined, m: Map<string, string>): string =>
  !id ? '—' : id === 'human' ? 'human' : m.get(id) ?? id;

// Every id inside a field value, for resolving a change's from and to.
function idsIn(values: unknown[]): string[] {
  return values.flatMap((v) => (Array.isArray(v) ? idsIn(v) : typeof v === 'string' && v ? [v] : []));
}

// A field value for a change line: ids become names, arrays join, empty becomes an em dash.
function showValue(v: unknown, m: Map<string, string>): string {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.length ? v.map((x) => showValue(x, m)).join(', ') : '—';
  return nameOf(String(v), m);
}

// A roll-up of counts per category, for an ITSA's children.
const rollupText = (r: any): string => `backlog ${r.backlog}, ready ${r.ready}, active ${r.active}, review ${r.review}, closed ${r.closed}`;

// Where each tool is shown in Settings › Tools, and the order the groups appear in. A tool
// names its group with the `group` field below; `toolCatalog()` turns them into the list the
// daemon serves. Keep this list and the catalog's shape stable: the decision-steps UI (S-60)
// picks a trigger from it.
export const TOOL_GROUPS = [
  { key: 'mail', name: 'Mail' },
  { key: 'agents', name: 'Agents' },
  { key: 'itsas', name: 'ITSAs' },
  { key: 'requirements', name: 'Requirements' },
  { key: 'cost', name: 'Cost' },
  { key: 'waits', name: 'Waits' },
  { key: 'permissions', name: 'Permissions' },
  { key: 'ring', name: 'Rings' },
  { key: 'registry', name: 'Registry' },
  { key: 'events', name: 'Events' },
  { key: 'layout', name: 'Layout' },
] as const;
type ToolGroup = (typeof TOOL_GROUPS)[number]['key'];

// `when: 'requirements'` lists the tool only while settings.requirements.enabled is true.
type Tool = { name: string; description: string; inputSchema: any; group: ToolGroup; when?: 'requirements'; validate?: (args: any) => void; run: (args: any) => Promise<unknown> };

// The PR events watch_pr can select: each preset is one event type. A merge or close always
// ends a PR watch (PR_END_TYPES), so it is delivered even when the preset list leaves it out.
const PR_EVENT_PRESETS: Record<string, string> = {
  checks: 'checks.completed',
  reviews: 'review.submitted',
  comments: 'comment.created',
  pushes: 'pull_request.synchronize',
  merged: 'pull_request.merged',
  closed: 'pull_request.closed',
};
const PR_END_TYPES = ['pull_request.merged', 'pull_request.closed'];

function presetType(name: string): string {
  const t = PR_EVENT_PRESETS[name];
  if (!t) throw new Error(`no PR event ${name}; use ${Object.keys(PR_EVENT_PRESETS).join(', ')}`);
  return t;
}

// A pull request as its subject key: a number (the default repo), OWNER/REPO#N, or a url.
async function prSubject(pr: unknown): Promise<{ key: string; number: number }> {
  const s = String(pr ?? '').trim();
  const m = /^#?(\d+)$/.exec(s) ?? /^([^/#\s]+\/[^/#\s]+)#(\d+)$/.exec(s) ?? /^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(s);
  if (!m) throw new Error(`pr must be a number, OWNER/REPO#N, or a pull request url, not ${JSON.stringify(s)}`);
  const number = Number(m[m.length - 1]);
  const repo = m.length === 3 ? m[1] : (await api<{ github: string | null }>('GET', '/api/pr/github-repo')).github;
  if (!repo) throw new Error('no default GitHub repo: set settings.itsa.prOpen.github on the ITSA home, or give the pr as OWNER/REPO#N');
  return { key: `github:${repo}#${number}`, number };
}

// Ends the watches `subscriber` (the id the daemon stored) has on one PR, so watching again
// replaces the earlier one. `keep` is the new watch's id, which stays. Returns how many it removed.
async function dropPrWatches(subscriber: string, key: string, by: string, keep: string | undefined): Promise<number> {
  const subs = await api<any[]>('GET', `/api/subscriptions?by=${encodeURIComponent(by)}`);
  const mine = subs.filter((x) => x.id !== keep && x.subscriber_id === subscriber && x.filter?.ends_on?.length && x.filter.subjects?.length === 1 && x.filter.subjects[0] === key);
  for (const x of mine) await api('DELETE', `/api/subscriptions/${encodeURIComponent(x.id)}`, { by });
  return mine.length;
}

// Titles are 1-4 words (blocks/itsa/20-itsa-owning.md). Nothing is refused: past this many words
// the reply asks the agent to shorten it.
export const TITLE_WARN_WORDS = 5;
export const titleWords = (title: unknown): number => (typeof title === 'string' ? title.trim().split(/\s+/).filter(Boolean).length : 0);
export function longTitleNote(key: string, title: unknown): string {
  const n = titleWords(title);
  if (n <= TITLE_WARN_WORDS) return '';
  return `\n\nTitle is ${n} words; titles are 1-4 words, a noun phrase (\`Phone mail header\`). Shorten it with itsa_set ref=${key} title=..., and move the detail to summary.`;
}

// Exported so a running server can load a newer release's tools (followDeploys).
export const tools: Tool[] = [
  {
    name: 'whoami',
    group: 'registry',
    description: 'Your own stam registry entry: id, name, role, state, the path to your conversation history file, and now (the daemon\'s clock, ISO UTC).',
    inputSchema: { type: 'object', properties: { self } },
    run: async (a) => json(await api('GET', `/api/agents/${me(a)}`)),
  },
  {
    name: 'register',
    group: 'registry',
    description: 'Join the stam registry, for an agent that stam did not spawn. Gives you an id so others can find and mail you.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique lowercase name with dashes, for example "docs-writer".' },
        role: { type: 'string', description: 'One or two sentences on what you work on.' },
        harness: { type: 'string', description: 'Your harness, for example "claude", "codex", or "opencode".' },
        model: { type: 'string' },
      },
      required: ['name', 'role'],
    },
    run: async (a) => {
      if (agentId) return text(`Already registered as ${agentId}.`);
      const r = await api('POST', '/api/register', { ...a, cwd: process.cwd(), token: true });
      agentId = r.id;
      // The agent's own token, for every later call (the shared token can't name an agent).
      if (r.token) setEnvVar('TOKEN', r.token);
      // A newer release's tools, loaded after a deploy, read the id from the environment.
      setEnvVar('AGENT_ID', r.id);
      startStream();
      const { token: _t, ...shown } = r;
      return json(shown);
    },
  },
  {
    name: 'workspace_share',
    group: 'agents',
    description:
      "Share your personal workspace folder with another agent on this machine. access: 'read' or 'write', or 'none' to stop sharing. The grantee gets a notice now. A revoke ('none') ends a Claude Code grant, or a Codex 'write' grant, at the grantee's next launch; other grants were never sandbox-enforced, so the grantee must stop using the folder. The grantee sees the folder in its \"Your workspace\" prompt block, and a Claude Code agent gets it as an allowed directory at its next launch (a Codex agent gets 'write' as a writable root). 'read' is advisory: every agent runs as the same Unix user, so stam can't stop a write. You need a personal workspace (spawned with `workspace`). Archiving you keeps the shares; archiving the grantee drops them.",
    inputSchema: {
      type: 'object',
      properties: { self, agent: { type: 'string', description: 'The agent to share with: id or name.' }, access: { type: 'string', enum: ['read', 'write', 'none'] } },
      required: ['agent', 'access'],
    },
    run: async (a) => {
      const r = await api<{ message: string }>('POST', `/api/agents/${me(a)}/workspace-share`, { agent: a.agent, access: a.access, self: me(a) });
      return text(r.message);
    },
  },
  {
    name: 'find_agents',
    group: 'registry',
    description: 'Search the stam registry by id, name, or role text. Without a query, lists the live agents you may see (active, paused and shut-down ones; archived ones are left out). With a query, archived agents are left out too, unless the query is exactly an agent\'s id or name. `state` overrides this: "archived" lists only archived agents, "all" lists every match. `role` keeps only agents whose role or name contains the text (case-insensitive); standing specialists come first, marked standing with their workspace name. Each agent carries its type: the saved type it was spawned as, or null.',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        query: { type: 'string' },
        role: { type: 'string', description: 'Specialty to find, matched against role and name as a case-insensitive substring.' },
        state: { type: 'string', enum: ['active', 'archived', 'all'], description: 'Which agents to list: active (not archived), archived, or all. Without it: live agents, plus an archived one only on an exact id or name match of the query.' },
      },
    },
    run: async (a) => {
      const q = new URLSearchParams();
      if (a.query) q.set('q', a.query);
      if (a.role) q.set('role', a.role);
      if (agentId ?? a.self) q.set('as', agentId ?? a.self);
      // The daemon lists only what is asked for (S-3816); the filter below still decides, for a daemon that lists all.
      q.set('state', a.state === 'all' ? 'all' : a.state === 'archived' ? 'archived' : 'live,stopped');
      if (!a.state && a.query) q.set('ids', a.query);
      const list = (await api<any[]>('GET', `/api/agents?${q}`)).filter((x) => {
        if (a.state) return a.state === 'all' || (a.state === 'archived') === (x.lifecycle === 'archived');
        return x.lifecycle !== 'archived' || (!!a.query && (x.id === a.query || x.name === a.query));
      });
      return json(
        list.map((x) => ({
          id: x.id,
          name: x.name,
          role: x.role,
          type: x.type ?? null,
          harness: x.harness,
          model: x.model,
          machine: x.machine,
          capabilities: x.capabilities ? JSON.parse(x.capabilities) : null,
          // A resting agent is live: it wakes on mail, a notice or a prompt, so it isn't reported as 'paused'.
          state: x.resting ? 'resting' : x.lifecycle === 'active' ? x.activity : x.lifecycle,
          ...(x.resting ? { resting: { reason: x.resting.reason, expected_wake: x.resting.expected_wake } } : {}),
          ...(x.standing ? { standing: true } : {}),
          ...(x.personal_workspace ? { personal_workspace: x.personal_workspace, workspace: basename(x.personal_workspace) } : {}),
          ...(x.standing && x.load ? { load: x.load } : {}),
          ...(x.lifecycle === 'paused' && !x.resting ? { paused_by: [...(x.paused_by ? JSON.parse(x.paused_by) : []), ...(x.blockers?.length ? ['stam'] : [])] } : {}),
          ...(x.waits?.length ? { waits: x.waits.map((w: any) => ({ id: w.id, kind: w.kind, target: w.target, detail: w.detail, since: w.since, until: w.until })) } : {}),
          // The open ask this agent waits on: its mail to open it in, and its kind (S-3982). Never the ask's text.
          ...(x.open_ask_detail ? { open_ask: x.open_ask_detail } : {}),
          ...(x.blockers?.length ? { blockers: x.blockers.map((b: any) => ({ kind: b.kind, account: b.account, reason: b.reason, since: b.since, clear: b.clear })) } : {}),
        })),
      );
    },
  },
  {
    name: 'registry_info',
    group: 'registry',
    description: 'Agent types (saved roles such as developer, reviewer, and manager, with when to use each; spawn one with spawn_agent type), harnesses, known models with their inputs (text, image, video), presets with when to use each, and the rule for missing capabilities.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => json(await api('GET', '/api/registry')),
  },
  {
    name: 'settings_ask',
    group: 'registry',
    description:
      "Ask the human to change stam's settings (chief of staff and assistant only). Pass patch, an object of the keys to change, merged into the settings (a nested object merges per key; fill:true only fills keys that are unset). This sends the human a settings-change approval with a diff and returns the request id; nothing is written until the human approves, and then stam applies the patch itself, unless a setting it changes has changed since you asked (then ask again; other settings changing doesn't matter). Read the current settings first with the settings GET (secrets show as REDACTED). Other agents are refused: ask your chief of staff." + ASK_HOME,
    inputSchema: {
      type: 'object',
      properties: {
        self,
        patch: { type: 'object', description: 'The settings keys to change, such as {"instructions":{"summaries":{"model":"claude-haiku-5-5"}}}.' },
        fill: { type: 'boolean', description: 'Only set keys that are not set yet.' },
        ...askHomeProps,
      },
      required: ['patch'],
    },
    run: async (a) => {
      const r = await api('PATCH', '/api/config/settings', { patch: a.patch, fill: a.fill === true, ...askHomeArgs(a) });
      return text(`Asked the human to change the settings (request ${r.requested}). Nothing changes until they approve; stam then applies the patch and tells you the result.${hinted(r)}`);
    },
  },
  {
    name: 'usage_info',
    group: 'cost',
    description:
      'Spend and tokens by day, model, and agent, and subscription windows (such as Claude 5-hour and weekly limits), with estimated shares of each window by agent and tree, the usual percent per hour by hour of day and weekday, and when it reaches 100% (at the rate of the last 30 minutes, and following the usual pattern), the trees\' allocations with their current use, plus the user\'s cost instructions. Compact by default (the windows with their projections, the top 5 trees, agents and models, the allocations, the machines); pass detail (true) for every agent, tree, model and cost unit with the hourly history, about 1 MB. Pass tree (an agent name or id) for that tree\'s estimated share and hourly history of each window, its allocations, and what a finished issue with its root\'s harness and model typically used. Use it to plan cost-aware work, for example picking a cheaper preset. It also includes machines: each computer\'s one-minute CPU, RAM, and swap averages, load, and its agents by state (null from a peer on an older release), to schedule work by load.',
    inputSchema: { type: 'object', properties: { days: { type: 'number' }, tree: { type: 'string', description: 'An agent name or id: show its tree\'s estimated share of each window.' }, detail: { type: 'boolean', description: 'The whole route answer, about 1 MB, not the compact one. False by default.' } } },
    run: async (a) => {
      const r = await api<Record<string, unknown>>('GET', `/api/usage?days=${a.days ?? 7}${a.tree ? `&tree=${encodeURIComponent(a.tree)}` : ''}${agentId ?? a.self ? `&as=${encodeURIComponent(agentId ?? a.self)}` : ''}`);
      return json({ ...(a.detail === true ? r : compactUsage(r, agentId ?? a.self)), see_also: 'For time and bottlenecks, call activity_info.' });
    },
  },
  {
    name: 'activity_info',
    group: 'cost',
    description:
      "The activity summary of a scope, compact by default: the clock in hours (working, friction, others, you, idle); the tiles (cost and cost per working hour, in the display mode of settings.cost.display, with its unit, and API $); the top 5 bottlenecks (what slows work most, with the agents hit and the longest span); the top 5 categories; the closed work issues by model and type, with their medians; and the trees' roots. Scope is tree:NAME, itsa:S-N, or agent:NAME (default: you). With compare (default true), a typical block gives the median per closed work issue (cost, working time, lead time, review rounds) for your type and model across the fleet you may see, beside the scope's own medians; the fleet is dropped when it equals the scope. Use it for a retro on your own work or a finished ITSA (what was slow, what it cost, against typical), for a manager tuning its tree's cost and time, and for the chief of staff scheduling work by where time goes. Ask for detail (true) only when you need the whole summary: every leaf and every cost mode, about 25 KB. Days is the window, 7 by default. It covers the agents of every machine; machines.missing names a machine that did not answer (its agents are left out).",
    inputSchema: {
      type: 'object',
      properties: {
        self,
        scope: { type: 'string', description: 'tree:NAME, itsa:S-N, or agent:NAME. Default: you (agent:YOU).' },
        days: { type: 'number', description: 'The window in days, 7 by default.' },
        compare: { type: 'boolean', description: 'Add the typical block for your type and model. True by default.' },
        detail: { type: 'boolean', description: 'The whole summary (every leaf and cost mode, about 25 KB), not the compact one. False by default.' },
      },
    },
    run: async (a) => {
      const id = me(a);
      const scope = a.scope ?? `agent:${id}`;
      const days = a.days ?? 7;
      const compare = a.compare !== false;
      const detail = a.detail === true;
      // `as` names the caller for an OpenCode server's shared token (as usage_info does); an agent's own token ignores it.
      const as = `&as=${encodeURIComponent(id)}`;
      // The summary route also names the caller's display mode (settings.cost.display.mode), which the compact answer prices in.
      const s = await api<Record<string, unknown> & { display_mode?: Mode }>('GET', `/api/activity?by=summary&days=${days}&scope=${encodeURIComponent(scope)}${as}`);
      const fleet = compare ? await api<Record<string, unknown>>('GET', `/api/activity?by=summary&days=${days}${as}`) : undefined;
      const caller = compare ? await api<{ type: string | null; harness: string | null; model: string | null }>('GET', `/api/agents/${id}`) : null;
      return json(activityInfoOf(s, { fleet, caller, detail, mode: s.display_mode }));
    },
  },
  {
    name: 'cost_allocate',
    group: 'cost',
    description:
      "Set or clear an allocation on a tree: how much of an account's subscription window (kind 'window' with a percent), or how many paid dollars per period (kind 'usd' with an amount and a period of day, week, or month), the tree may use. The user sets any allocation, the chief of staff any, every other agent only trees inside its own tree. Allocations are not enforced: at 80% and 100% of an allocation the tree's manager and its root get a cost notice. Setting one that pushes children past their parent tree's allocation warns but is not refused. Pass clear: true (with id, or tree/account/kind/scope) to remove one.",
    inputSchema: {
      type: 'object',
      properties: {
        self,
        tree: { type: 'string', description: 'The tree\'s root agent, by id or name.' },
        account: { type: 'string', description: 'The cost account, such as claude or openrouter.' },
        kind: { type: 'string', enum: ['window', 'usd'] },
        window: { type: 'string', description: "For kind 'window': the window name, such as five_hour." },
        percent: { type: 'number', description: "For kind 'window': the allocated percentage of the window." },
        amount: { type: 'number', description: "For kind 'usd': the allocated dollars." },
        period: { type: 'string', enum: ['day', 'week', 'month'], description: "For kind 'usd': the period." },
        note: { type: 'string', description: 'Optional note, carried in the notices.' },
        clear: { type: 'boolean', description: 'Remove the matching allocation instead of setting one.' },
        id: { type: 'string', description: 'With clear: the allocation id.' },
      },
    },
    run: async (a) => {
      const r = await api<any>('POST', '/api/cost/allocate', { ...a, self: undefined, by: me(a) });
      if (r.cleared !== undefined) return text(`Cleared ${r.cleared} allocation${r.cleared === 1 ? '' : 's'}.`);
      const x = r.allocation;
      const scope = x.kind === 'usd' ? `$${x.amount}/${x.period}` : `${x.percent}% of ${x.account} ${String(x.window).replace('_', '-')}`;
      return text(`Allocation ${x.id} on ${a.tree}: ${scope}.${r.warning ? `\n\n${r.warning}` : ''}`);
    },
  },
  {
    name: 'cost_ack',
    group: 'cost',
    description:
      'Record that you handled a cost notice, keyed by the event id in the notice. It stops the fallback timer for that event (the timer itself comes later). A manager calls this after it acts on a notice about its tree.',
    inputSchema: { type: 'object', properties: { self, event: { type: 'string', description: 'The event id from the cost notice, for example cn-1a2b3c4d.' } }, required: ['event'] },
    run: async (a) => text(JSON.stringify(await api('POST', '/api/cost/ack', { event: a.event, by: me(a) }))),
  },
  {
    name: 'cost_switch',
    group: 'cost',
    description:
      "Move an agent's work to another preset, for example when its account is exhausted. The agent gets time to finish its step and update HANDOVER.md (cost.softStopMinutes, default 10), then stam stops its harness (keeping its session) and holds it as taken over. A successor NAME-t2 starts on the preset in the same workspace, with the same parents, the agent's children, open threads and unread mail, and mail to the old name goes to it. Refused when the preset's account is blocked. A manager may switch agents in its own tree; the chief of staff and the human any. The predecessor's open cost notices are acknowledged. A working agent switches in the background and you hear the outcome.",
    inputSchema: {
      type: 'object',
      properties: {
        self,
        agent: { type: 'string', description: 'The agent whose work moves: an id or name.' },
        preset: { type: 'string', description: 'The preset to move it to; registry_info lists them.' },
        soft_stop_minutes: { type: 'number', description: 'Minutes the agent gets to finish its step before stam interrupts it. Defaults to cost.softStopMinutes.' },
      },
      required: ['agent', 'preset'],
    },
    run: async (a) => {
      const r = await api('POST', '/api/cost/switch', { agent: a.agent, preset: a.preset, soft_stop_minutes: a.soft_stop_minutes, by: me(a) }, SWITCH_CALL_MS);
      if (r.status === 'quiescing') return text(`${r.from} is finishing its step (up to ${r.minutes} minutes); then its work moves to ${r.to} on ${r.preset}. You'll get a notice when it's done.`);
      const moved = `${r.moved.children.length} children, ${r.moved.threads} threads, ${r.moved.unread} unread mails`;
      return text(`${r.from} now continues as ${r.to} on ${r.preset} (${moved}${r.interrupted ? '; its turn was interrupted' : ''}${r.handover ? '' : '; no HANDOVER.md'}). ${r.from} is stopped and held as taken over.`);
    },
  },
  {
    name: 'cost_pause',
    group: 'cost',
    description:
      'Pause a tree for cost until one of its subscription windows resets, or until a set time; stam lifts the pause by itself. Pass until="reset" (with an account and window; the default window is the one closest to 100% on the tree\'s account) or an ISO 8601 time. Pass clear:true to lift an earlier cost pause early. The tree is the agent you name and everything below it, and agents spawned into it while it is paused are held too. A manager may pause its own tree; the chief of staff and the human may pause any. Calling this also acknowledges the tree\'s open cost notices.',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        tree: { type: 'string', description: 'The tree root: an agent id or name.' },
        until: { type: 'string', description: '"reset", or an ISO 8601 time such as 2026-10-12T09:00:00Z.' },
        account: { type: 'string', description: 'For until=reset: the cost account. Defaults to the tree\'s account.' },
        window: { type: 'string', description: 'For until=reset: the window, for example five_hour. Defaults to the window closest to 100%.' },
        clear: { type: 'boolean', description: 'Remove the tree\'s cost pause early, instead of setting one.' },
        reason: { type: 'string', description: 'Why, for the resume notice and the record.' },
      },
      required: ['tree'],
    },
    run: async (a) => {
      const r = await api('POST', '/api/cost/pause', { tree: a.tree, until: a.until, account: a.account, window: a.window, clear: a.clear, reason: a.reason, by: me(a) });
      const acked = r.acked?.length ? `; acknowledged ${r.acked.length} cost notice${r.acked.length === 1 ? '' : 's'}` : '';
      return text(
        r.action === 'cleared'
          ? `Cleared the cost pause on ${r.root}'s tree (${r.agents.length} agent${r.agents.length === 1 ? '' : 's'}${acked}).`
          : `Paused ${r.agents.length} agent${r.agents.length === 1 ? '' : 's'} in ${r.root}'s tree: ${r.until}${acked}.`,
      );
    },
  },
  {
    name: 'send_mail',
    group: 'mail',
    description:
      'Send mail to one or more agents by id or name, to "all", or to "human" (your user). Mail works like Slack threads: an answer to a mail joins its thread. Pass the mail\'s id as reply_to to be sure; without it, an answer to mail you just read joins that thread anyway (if you read several threads in the last 30 minutes and don\'t name one, the daemon errors listing them, so pass reply_to). For a new topic, pass new_thread: true. A reply reaches your user only when `to` names "human", in their own threads too. Bodies render as Markdown. Before mailing "human", search for the relevant thread with search_mail and read it: if one exists, reply in it with reply_to; if unsure, ask your parent. A new thread is fine when none fits, but continuing an existing one is preferred. Mail to "human" is only for what your user must decide or read (see your instructions); mail between agents has no such rules. The body holds about 5,000 tokens; longer text becomes an attachment. Attach files by path or inline content.',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        to: { type: 'array', items: { type: 'string' } },
        subject: { type: 'string', description: 'Required for a new thread; optional with reply_to.' },
        body: { type: 'string' },
        reply_to: { type: 'string', description: 'Id of the mail this answers.' },
        supersedes: { type: 'string', description: 'The exact id of an earlier mail of yours that this one replaces, after you find it was wrong. The old mail stays in its thread, but leaves inboxes, unread counts and notifications, and its ask to your user is withdrawn. Only your own mail, by exact id.' },
        itsa: { type: 'string', description: 'The ITSA (key such as S-12, or id) this mail is about: the web UI shows it as a chip in the mail header. Mail in an ITSA\'s own thread is about that ITSA already.' },
        new_thread: { type: 'boolean', description: 'Start a new thread. Without it, an answer to a mail you just read joins that mail\'s thread.' },
        override: { type: 'string', description: 'Only for mail to "human": a mail check refuses a mail your user doesn\'t need or that breaks the rules for mail to them. If you disagree, resend with the reason here; the mail goes out and your user sees the reason.' },
        attachments: {
          type: 'array',
          items: { type: 'object', properties: { path: { type: 'string' }, name: { type: 'string' }, content: { type: 'string' } } },
        },
      },
      required: ['to', 'body'],
    },
    run: async (a) => {
      const input = normalizeMailInput(a);
      const m = await api('POST', '/api/mail', { ...input, self: undefined, from: me(a), client_id: writeId('mail', me(a), input.to, input.subject, input.body, input.reply_to, input.itsa, input.new_thread, input.supersedes, input.attachments) }, WRITE_CALL_MS);
      // S-384: a recipient that isn't running reads nothing until someone starts it.
      const stopped = m.not_running?.length ? ` Not running: ${m.not_running.join(', ')}; the mail waits unread until resumed, so ask their parent or the chief of staff to resume them if it can't wait.` : '';
      // S-542: in a thread your user started, only mail that names them reaches their inbox.
      const missed = m.misses_human ? " This answers your user's mail but doesn't reach them; add `human` to `to` if they should read it." : '';
      if (m.queued) return text(`Queued ${m.id} in thread ${m.thread_id}: storage is unreachable; it is delivered when storage answers.${stopped}${missed}`);
      return text((m.reply_to && !a.reply_to
        ? `Sent ${m.id} as a reply in the thread "${m.subject}" (${m.thread_id}), since it answers ${m.reply_to}. For a new topic, send with new_thread: true.`
        : `Sent ${m.id} in thread ${m.thread_id}.`) + stopped + missed);
    },
  },
  {
    name: 'mail_attach',
    group: 'mail',
    description:
      'Attach ITSAs and agents to an existing mail, silently: the web UI shows them as chips in its header. It sends no mail, makes no notice and no unread state. Use it instead of replying when all you would say is which ITSA or agent handles a request. Only a recipient of the mail, or the chief of staff, may attach.',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        mail_id: { type: 'string', description: 'The id of the mail to attach to.' },
        itsas: { type: 'array', items: { type: 'string' }, description: 'ITSA keys (S-12) or ids.' },
        agents: { type: 'array', items: { type: 'string' }, description: 'Agent names or ids.' },
      },
      required: ['mail_id'],
    },
    run: async (a) => {
      const r = await api('POST', `/api/mail/${a.mail_id}/attach`, { by: me(a), itsas: a.itsas ?? [], agents: a.agents ?? [] });
      return text(`Attached to ${a.mail_id}: ${r.attached.itsas.length} ITSA(s), ${r.attached.agents.length} new agent(s). No mail was sent.`);
    },
  },
  {
    name: 'withdraw_ask',
    group: 'mail',
    description: 'Withdraw your ask from your user when it no longer needs them: answered another way, or moot.',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        mail_id: { type: 'string', description: 'The id of your decision mail to the human.' },
        note: { type: 'string', description: 'Why, in a few words, for example "answered in the terminal".' },
      },
      required: ['mail_id', 'note'],
    },
    run: async (a) => {
      await api('POST', `/api/mail/${a.mail_id}/withdraw-ask`, { by: me(a), note: a.note });
      return text(`Withdrawn from your user: ${a.mail_id}.`);
    },
  },
  {
    name: 'spawn_agent',
    group: 'agents',
    description:
      'Start a new agent as your child: it is registered under you, you get its status and blockers, and you can control it with agent_control. Any model name works, even one stam does not know yet. The executive assistant can also start it under any parent or none, or as chief of staff. A developer spawn when the machine already runs developerCap developers (settings, default 6) is not refused but queued: you get "queued, place N" with the holders, the agent starts by itself when a slot frees (first come first served), and you get a notice when it does or fails. Keep working meanwhile; do not spawn it again. Reviewers and other types are never queued. To let the child comment on or join an ITSA without owning it, pass participate with its ids or keys; the spawn is refused before anything starts if you may not add participants to one.',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        name: { type: 'string', description: 'Unique lowercase name with dashes.' },
        role: { type: 'string', description: 'What it is for. Defaults to its type.' },
        prompt: { type: 'string', description: 'Its first task. With a type that has a brief, this is the brief\'s {{task}}.' },
        type: { type: 'string', description: 'An agent type from registry_info, such as "developer", "reviewer", or "manager": sets its harness, model, effort, role, standing instructions, brief, and worktree default. Explicit fields override it. A reviewer type follows its fallback chain when its account is held. A ring reviewer type (no harness, model, or preset allowed) starts a ring named NAME: members NAME-1, NAME-2, ... and a moderator NAME-mod, with your prompt as the topic; its result is mailed to you, and if a member can\'t start, the type\'s fallback runs as a single reviewer.' },
        brief_vars: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra values for placeholders in the type\'s brief.' },
        preset: { type: 'string', description: 'A preset from registry_info, such as "fast" or "deep". Sets harness, model, and effort.' },
        harness: { type: 'string', description: '"claude" (default), "opencode", or "codex".' },
        model: { type: 'string' },
        effort: { type: 'string' },
        cwd: { type: 'string', description: 'Directory to work in, or the repo for a worktree. Defaults to yours.' },
        machine: { type: 'string', description: 'Machine to run it on, from the machine field in find_agents. Defaults to yours.' },
        worktree: { type: 'boolean', description: 'Give it its own git worktree and branch, removed when it is archived. Defaults to the type\'s worktree default (the developer type is true). A developer that ends up without one in the live deploy checkout is refused, since its commits there would hold every deploy.' },
        base: { type: 'string', description: 'A git ref to cut the worktree\'s branch from, such as origin/stam/x (fetched first; a local branch works too). The spawn fails if it does not resolve. Without it, a repo with an origin remote is cut from a freshly fetched origin/main (falling back to the checkout\'s HEAD if the fetch fails; the spawn\'s workspace:base event says which). A base of origin/stam/X (or storage/stam/X) continues that PR: the worktree goes on stam/X itself at the base\'s commit, so pr_open updates the PR with no fast-forward (the spawn result and the workspace:base event say so). The spawn is refused when stam/X is checked out in another worktree (archive its holder) or a local stam/X has commits the base lacks. To stack a NEW PR on stam/X instead, pass branch: "new" (a reviewer type always gets its own branch). Only with a worktree.' },
        branch: { type: 'string', description: 'The worktree\'s branch name. Defaults to stam/NAME, or to the PR branch itself when base is origin/stam/X. Pass a new name, or "new" for stam/NAME, to cut a new branch (a stacked PR) from that base instead of continuing it. An explicit name is used as given. When the default stam/NAME is already taken (here or on origin), the branch gets a free -2, -3 suffix; the spawn result and the agent\'s brief name it. Only with a worktree.' },
        workspace_script: { type: 'string', description: 'Shell command that prints the directory to work in.' },
        workspace_instructions: { type: 'string', description: 'Tell it to create its own workspace this way.' },
        standing: { type: 'boolean', description: 'A long-lived specialist, kept as a standing agent rather than one for a single task. A standing agent idle for standing.idleHours (default 4) rests, harness stopped, and mail, a fired wake_me or an assigned ITSA wakes it.' },
        workspace: { type: ['boolean', 'string'], description: "A personal workspace folder for this agent, at STAM_HOME/workspaces/NAME, separate from its working directory and kept when it is archived. true uses the agent's own name; a string names a workspace (lowercase letters, digits, and dashes), so a respawned specialist can adopt an archived one's folder. Never a git repo or worktree." },
        visibility: {
          type: 'object',
          description: 'Whom the child may reach. reach: "all" (default), "tree", or "parent"; siblings: may it mail its siblings; registry: may it see the whole registry.',
          properties: { reach: { type: 'string', enum: ['all', 'tree', 'parent'] }, siblings: { type: 'boolean' }, registry: { type: 'boolean' } },
        },
        child_notices: { type: 'string', enum: ['turn', 'tree-idle', 'none'], description: "How much this child hears about its own children's finished turns: 'tree-idle' (default), 'turn', or 'none'. Blocked and errored agents always reach their parents." },
        urgent: { type: 'string', enum: ['red-main', 'deploy-hold', 'approved-pr', 'incident'], description: 'Only for a developer spawn that has to queue because the slots are full: the reason it should go ahead of normal spawns (first come first served within each class). red-main: a fix for a red main; deploy-hold: a fix that clears a deploy hold; approved-pr: a fix on an approved PR; incident: a fix for an incident, which goes ahead like red-main only when its itsa (or one of that ITSA\'s parents) is marked an incident by the chief of staff or the human (itsa_set incident=true), and is refused otherwise. On another machine the ITSA home is asked for the mark, and the spawn is refused unless it says yes. Not for anything else.' },
        itsa: { type: 'string', description: 'An ITSA id or key: the new agent becomes its owner (a reviewer type joins as a participant instead, and the owner stays), and its first prompt carries the ITSA (key, title, summary, body, parent chain, links). With no prompt, that block is the prompt.' },
        participate: { type: 'array', items: { type: 'string' }, description: 'ITSA ids or keys the new agent joins as a participant, without owning them: it can comment and change them, and the owner stays. You must be allowed to add participants to each (an owner, a participant, or an owner of a parent ITSA). If you are not, the spawn is refused and nothing starts.' },
        parent: { type: 'string', description: 'Executive assistant only: the parent agent, or "none" for a top-level agent. Defaults to you.' },
        chief_of_staff: { type: 'boolean', description: 'Executive assistant only: make it the chief of staff.' },
      },
      required: ['name'],
    },
    run: async (a) => {
      const by = me(a);
      const parent = a.parent === undefined ? by : a.parent === 'none' ? null : a.parent;
      // A spawn on another machine may wait for that peer to start and deploy (S-234, S-236).
      const remote = a.machine !== undefined && a.machine !== MACHINE;
      const r = await api('POST', '/api/agents', { ...a, self: undefined, by, parent, cwd: a.cwd ?? process.cwd() }, remote ? 960_000 : undefined);
      if (r.kind === 'ring') {
        const names = (r.members as { name: string; type: string | null }[]).map((m) => `${m.name} (${m.type ?? 'no type'})`).join(', ');
        return text(`Started ring ${r.ring.name} (${r.ring.id}, ${r.ring.format}, up to ${r.ring.max_rounds} rounds). Members: ${names}.${r.moderator ? ` Moderator: ${r.moderator.name} (${r.moderator.type ?? 'no type'}).` : ''} You'll get its result by mail.`);
      }
      if (r.queued) {
        return text(
          `Queued ${r.name}: place ${r.place} of ${r.queue_length}${r.urgent ? ` (urgent: ${r.urgent})` : ''} for a developer slot on ${r.machine}, all ${r.cap} in use. Holders: ${holdersText(r.holders, r.holder_info)}. It starts by itself when a slot frees, and you get a notice then (or if it fails to start). Do not spawn it again.`,
        );
      }
      const wt = (() => {
        try {
          return r.workspace ? (JSON.parse(r.workspace) as { worktree?: { branch: string; continues?: boolean }; baseUsed?: { sha: string } }) : undefined;
        } catch {
          return undefined;
        }
      })();
      const onPr = wt?.worktree?.continues ? ` On the existing PR branch ${wt.worktree.branch} at ${wt.baseUsed?.sha.slice(0, 8)}.` : '';
      return text(`Spawned ${r.name} (${r.id}) in ${r.cwd}.${onPr}${r.warning ? `\nWarning: ${r.warning}` : ''}`);
    },
  },
  {
    name: 'agent_control',
    group: 'agents',
    description:
      'Control yourself or one of your children: pause, unpause, shutdown, archive (shut down and remove its worktree), resume, restart, reconnect-mcp, set-visibility, set-child-notices (how much you hear about your children\'s finished turns: "turn", "tree-idle", or "none"; blocked and errored children always reach you). cancel removes a developer spawn that is still queued for a slot, by its name in agent (not an agent yet, so no agent id): its caller, the caller\'s parents, and the chief of staff may cancel it; a spawn already granted a slot is refused, and a name that isn\'t queued is a 404. Cancel finds the spawn on whichever machine queued it and forwards to that machine; there, the caller\'s parents can cancel only when that machine knows the caller (otherwise only the caller and the chief of staff can), and an unreachable machine gives a 502, not a 404. The chief of staff can also adopt any agent as its parent. Shutdown, archive, and restart wait until the agent finishes its current step. Every archive asks the agent for its final retro round and waits for its next turn end, bounded by settings.archive.finalRoundMinutes (default 3); a wrap-up pushed while the agent runs a step can get one more turn, with a fresh finalRoundMinutes deadline, because the harness may hold it for the next turn; archive with force only skips the turn-alive check for an agent whose harness is gone, and archive with discard removes uncommitted worktree changes. The executive assistant controls every agent, and alone can also set-parent (parent: an agent, or "none" for top-level), rename (name), make one chief-of-staff, kill (stop now), and forget (remove a stopped agent from the registry).',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        agent: { type: 'string', description: 'Id or name of the agent.' },
        action: { type: 'string', enum: ['pause', 'unpause', 'shutdown', 'archive', 'resume', 'restart', 'reconnect-mcp', 'adopt', 'set-visibility', 'set-child-notices', 'set-parent', 'rename', 'chief-of-staff', 'kill', 'forget', 'cancel'] },
        note: { type: 'string', description: 'For resume and restart: a note the agent receives.' },
        force: { type: 'boolean', description: 'For archive: do not wait for the agent\'s current step. A forced pending archive whose harness is gone runs at once, skipping the turn-alive check; it still asks the agent for its final round, bounded by settings.archive.finalRoundMinutes, and a forced archive of a live agent waits for that extra turn too. It also discards uncommitted worktree changes. For unpause: clear its cost blockers too.' },
        force_unpushed: { type: 'boolean', description: 'For archive: archive although the branch has commits that are on no remote (the archive is refused otherwise, naming the branch, the count and the head; push it or pr_open first). The commits stay on the local branch, which the archive keeps.' },
        discard: { type: 'boolean', description: 'For archive: discard the agent\'s uncommitted worktree changes. Every archive asks the agent for its final retro round and waits for its next turn end, at most settings.archive.finalRoundMinutes (default 3), before archiving.' },
        visibility: { type: 'object', description: 'For set-visibility: same shape as in spawn_agent.' },
        child_notices: { type: 'string', enum: ['turn', 'tree-idle', 'none'], description: 'For set-child-notices: how much you hear about your children\'s finished turns.' },
        parent: { type: 'string', description: 'For set-parent: the new parent, or "none".' },
        name: { type: 'string', description: 'For rename: the new name.' },
      },
      required: ['agent', 'action'],
    },
    run: async (a) => {
      // A queued spawn has no agent yet: its name is the path (S-2134).
      if (a.action === 'cancel') {
        const r = await api('POST', `/api/slot-queue/${a.agent}/cancel`, { by: me(a) });
        return text(`${r.name}: queued spawn cancelled on ${r.machine}`);
      }
      const r = await api('POST', `/api/agents/${a.agent}/${a.action}`, { by: me(a), note: a.note, reason: a.note, force: a.force, discard: a.discard, force_unpushed: a.force_unpushed, visibility: a.visibility, child_notices: a.child_notices, parent: a.parent, name: a.name });
      return text(`${r.agent.name}: ${r.result}`);
    },
  },
  {
    name: 'compact_self',
    group: 'agents',
    description:
      'Compact your own conversation when you end your current turn. Say what the summary must keep, and give a prompt you will receive right after compaction so you can continue.',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        instructions: { type: 'string', description: 'What the summary must keep.' },
        prompt_after: { type: 'string', description: 'The prompt you receive after compaction.' },
      },
      required: ['instructions', 'prompt_after'],
    },
    run: async (a) => {
      const id = me(a);
      await api('POST', `/api/agents/${id}/compact`, { by: id, instructions: a.instructions, prompt: a.prompt_after });
      return text('Compaction is scheduled for when you end this turn. End your turn now.');
    },
  },
  {
    name: 'request_permission',
    group: 'permissions',
    description:
      "Ask for permission when something you need is blocked or needs consent. `audience` is `human` when only your user's consent unblocks it: a harness or auto-mode safety block, an irreversible or outward action, spend above the caps. `delegate` when your parent or the chief of staff can decide it; they escalate to your user if needed. If omitted, it goes to your parent or the chief of staff, or to your user when you have neither. A delegate ask with no parent or chief of staff to decide goes to your user. The answer arrives as a stam notice saying who answered. Keep working on other things meanwhile." + ASK_HOME,
    inputSchema: {
      type: 'object',
      properties: {
        self,
        action: { type: 'string', description: 'What you need to do, in one line.' },
        reason: { type: 'string', description: 'Why it is needed for your task.' },
        details: { type: 'string', description: 'The exact command or tool call, and what the check said.' },
        audience: { type: 'string', enum: ['human', 'delegate'], description: "'human': only your user's consent unblocks it. 'delegate': your parent or the chief of staff can decide it. Omit it to default to delegate." },
        ...askHomeProps,
      },
      required: ['action', 'reason'],
    },
    run: async (a) => {
      const r = await api('POST', '/api/permissions', { agent: me(a), action: a.action, reason: a.reason, details: a.details ?? '', audience: a.audience, ...askHomeArgs(a) });
      return text(`Request ${r.id} sent. You'll get a notice with the answer.${hinted(r)}`);
    },
  },
  {
    name: 'suggest_input',
    group: 'permissions',
    description:
      "Claude Code only. Suggest one line for your user to approve, which stam then types into your own input box exactly as written and sends, as if your user typed it: for example `! git push` to run a command auto mode blocked. Only the human can approve it, from stam's web UI; reviewing agents can only deny it. A suggestion waits until your user answers it or it is withdrawn, and a new suggestion replaces your pending one. Once approved, it waits 30 minutes for your input box to be free, and expires after that. The answer arrives as a stam notice: typed, held until your input box is free, or expired." + ASK_HOME,
    inputSchema: {
      type: 'object',
      properties: {
        self,
        text: { type: 'string', description: 'The exact line to type: one line, no control characters, at most 2000 characters.' },
        reason: { type: 'string', description: 'Why you need it, for your user.' },
        ...askHomeProps,
      },
      required: ['text', 'reason'],
    },
    run: async (a) => {
      const r = await api('POST', '/api/suggest-input', { self: me(a), text: a.text, reason: a.reason, ...askHomeArgs(a) });
      return text(`Suggestion ${r.id} sent to your user; waits until your user answers it. You'll get a notice when it is typed, held, or expired.${hinted(r)}`);
    },
  },
  {
    name: 'answer_permission',
    group: 'permissions',
    description: 'Answer a permission request from one of your children (or any agent, if you are the chief of staff or the executive assistant). decision: approve, deny, or escalate (send it to the human, with a one-line reason in note). Never leave a request waiting. You can only deny or escalate a harness dialog (Claude Code asks to allow ...), and only deny a request whose audience is human; the human approves those.',
    inputSchema: {
      type: 'object',
      properties: { self, id: { type: 'string' }, decision: { type: 'string', enum: ['approve', 'deny', 'escalate'] }, approve: { type: 'boolean', description: 'Older form of decision: true approves, false denies.' }, note: { type: 'string', description: 'Your reasoning, passed to the requester. For escalate: the one-line reason the human reads.' } },
      required: ['id', 'note'],
    },
    run: async (a) => {
      if (!a.decision && typeof a.approve !== 'boolean') throw new Error('say decision: approve, deny or escalate');
      const r = await api('POST', `/api/permissions/${a.id}/answer`, { by: me(a), decision: a.decision, approve: a.approve, note: a.note });
      return text(a.decision === 'escalate' ? `Request ${r.id} is escalated to the human.` : `Request ${r.id} is now ${r.status}.`);
    },
  },
  {
    name: 'ring_create',
    group: 'ring',
    description:
      'Start a ring: several agents work on one topic together, best with models from different companies. format: "rounds" (all answer in parallel, then all read all), "fire" (one at a time, each sees everything before), or "debate". Name existing agents as members, or spawn new ones in spawn: each entry is { type: NAME } (an agent type from registry_info; a reviewer type follows its fallback chain when its account is held), { preset }, or { harness, model }. Optional moderator: an existing agent, or { type: NAME } (or { preset }) to spawn one named NAME-mod; it only facilitates or also decides. If the ring can\'t start, the agents spawned for it are archived. The result is mailed to you.',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        name: { type: 'string', description: 'Unique lowercase name with dashes; spawned members are named NAME-1, NAME-2, ...' },
        topic: { type: 'string' },
        format: { type: 'string', enum: ['rounds', 'fire', 'debate'] },
        members: { type: 'array', items: { type: 'string' }, description: 'Existing agents, by id or name.' },
        spawn: { type: 'array', items: { type: 'object', properties: { type: { type: 'string' }, preset: { type: 'string' }, harness: { type: 'string' }, model: { type: 'string' } } }, description: 'New members to spawn, by agent type, preset, or harness and model.' },
        moderator: {
          anyOf: [
            { type: 'string' },
            { type: 'object', properties: { type: { type: 'string' }, preset: { type: 'string' }, harness: { type: 'string' }, model: { type: 'string' } } },
          ],
          description: 'An existing agent (id or name) that reads each round, or an object like a spawn entry to spawn one.',
        },
        moderator_decides: { type: 'boolean', description: 'The moderator ends the ring with a decision, instead of only facilitating.' },
        max_rounds: { type: 'number' },
      },
      required: ['name', 'topic', 'format'],
    },
    run: async (a) => {
      const r = await api('POST', '/api/rings', { ...a, self: undefined, by: me(a), cwd: process.cwd() }, 120_000);
      return text(`Ring ${r.name} (${r.id}) started. You'll get its result by mail.`);
    },
  },
  {
    name: 'ring_submit',
    group: 'ring',
    description: 'Submit your contribution to a ring you were prompted in. Set agree to true only if you accept the current state as final. In a ring that reviews a PR, give your verdict too: the ring ends early only when every member\'s verdict is the same.',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        ring: { type: 'string' },
        text: { type: 'string' },
        agree: { type: 'boolean' },
        verdict: { type: 'string', enum: ['approve', 'request_changes'], description: 'Your verdict on the PR, in a ring that reviews one. Left out, stam reads it from your text.' },
        round: { type: 'number', description: 'The round your turn prompt shows ("round N of at most M"). A submit for a round the ring has moved past is refused and writes nothing. Left out, it goes to the ring\'s current round.' },
        seat: { type: 'string', description: 'The member the text is for, by the name your turn prompt shows ("You are NAME"). Required when you hold two or more open seats in the ring, such as your own and a predecessor\'s; a seat you don\'t hold is refused; one already filled this round is rewritten (rounds rings). Left out, the text goes to your one open seat.' },
      },
      required: ['ring', 'text', 'agree'],
    },
    // A parameter this schema lacks (`body`, say) would post an empty verdict with no findings (S-1919): name it, and the expected `text`.
    run: async (a) => {
      const unknown = Object.keys(a).filter((k) => !['self', 'ring', 'text', 'agree', 'verdict', 'round', 'seat'].includes(k));
      if (unknown.length) throw new Error(`ring_submit has no parameter ${unknown.join(', ')}: put your findings in text`);
      if (typeof a.text !== 'string' || !a.text.trim()) throw new Error('text is required: your findings for the ring, as a non-empty string');
      return text((await api('POST', `/api/rings/${a.ring}/submit`, { by: me(a), text: a.text, agree: a.agree, verdict: a.verdict, round: a.round, seat: a.seat })).result);
    },
  },
  {
    name: 'ring_decide',
    group: 'ring',
    description: 'As a ring\'s moderator, after a round: continue with a note for the members, or end the ring (with your decision, if you decide).',
    inputSchema: { type: 'object', properties: { self, ring: { type: 'string' }, continue: { type: 'boolean' }, text: { type: 'string' } }, required: ['ring', 'continue', 'text'] },
    run: async (a) => text((await api('POST', `/api/rings/${a.ring}/decide`, { by: me(a), continue: a.continue, text: a.text })).result),
  },
  {
    name: 'reconnect_mcp',
    group: 'agents',
    description: 'Reconnect your own MCP servers. In some harnesses this restarts you and resumes your conversation after your current step.',
    inputSchema: { type: 'object', properties: { self } },
    run: async (a) => {
      const id = me(a);
      const r = await api('POST', `/api/agents/${id}/reconnect-mcp`, { by: id });
      return text(r.result === 'reconnected' ? 'MCP servers reconnected.' : 'You will restart with reconnected MCP servers when you end your turn.');
    },
  },
  {
    name: 'defer_thread',
    group: 'mail',
    description: 'Set one of your mail threads aside for later: it leaves your unread count and your list, and comes back when new mail arrives in it. Not archived. Pass undo: true to bring it back now.',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        thread_id: { type: 'string', description: 'The thread to defer.' },
        undo: { type: 'boolean', description: 'Bring a deferred thread back (default false).' },
      },
      required: ['thread_id'],
    },
    run: async (a) => {
      const id = me(a);
      await api('POST', `/api/agents/${id}/threads/${a.thread_id}/${a.undo ? 'undefer' : 'defer'}`, { by: id });
      return text(a.undo ? `Thread ${a.thread_id} is back in your list.` : `Thread ${a.thread_id} deferred.`);
    },
  },
  {
    name: 'list_inbox',
    group: 'mail',
    description: 'List your mail, newest first, without bodies.',
    inputSchema: { type: 'object', properties: { self, unread_only: { type: 'boolean' }, limit: { type: 'number' } } },
    // A row's linked ITSAs are their keys here, not the full records the web UI reads (S-986).
    run: async (a) => json((await api<any[]>('GET', `/api/agents/${me(a)}/inbox?unread=${a.unread_only === false ? 0 : 1}&limit=${a.limit ?? 20}`)).map((m) => (m.itsas ? { ...m, itsas: m.itsas.map((l: any) => l.key) } : m))),
  },
  {
    name: 'read_mail',
    group: 'mail',
    description: 'Read mail and mark it read. Without ids, reads up to 10: mail whose earlier read got no reply first (not FYI or system mail, nor mail over 6 hours old), then unread mail, oldest first.',
    inputSchema: { type: 'object', properties: { self, ids: { type: 'array', items: { type: 'string' } } } },
    run: async (a) => {
      const id = me(a);
      const batch = randomUUID();
      const mails = await api<any[]>('POST', `/api/agents/${id}/read`, { ids: a.ids, batch, ack: readAck.get(id) });
      readAck.set(id, batch);
      // A cited id that isn't addressed to this agent, such as one in its brief, reads through read_thread (S-448).
      const other = (a.ids ?? []).filter((x: string) => !mails.some((m) => m.id === x));
      const hint = other.length ? `Not addressed to you: ${other.join(', ')}. read_thread with that id shows it if you may read its thread.` : '';
      if (!mails.length) return text(hint || 'No unread mail.');
      return text(
        (hint ? `${hint}\n\n` : '') +
        mails
          .map((m) => {
            const files = (m.attachments ?? []).map((f: any) => `  - ${f.name} (${f.size} bytes): ${f.path}`).join('\n');
            const thread = m.thread_id && m.thread_id !== m.id ? ` · thread ${m.thread_id}, in reply to ${m.reply_to ?? 'an earlier mail'}` : '';
            return `## ${m.id}: ${m.subject}${m.title ? ` [${m.title}]` : ''}\nFrom: ${m.from_name} (${m.from_id}) · ${m.created_at}${thread}\n\n${m.body}${m.note ? `\n\n[stam] ${m.note}` : ''}${files ? `\n\nAttachments:\n${files}` : ''}`;
          })
          .join('\n\n---\n\n') + '\n\nTo answer one, use send_mail with reply_to set to its id. read_thread shows a thread\'s earlier messages.',
      );
    },
  },
  {
    name: 'wait_for',
    group: 'waits',
    description:
      "Declare that you are waiting: stam shows you as waiting and holds your parent's finished-turn notice until it clears. on: 'agent' (with target, an agent id or name) or 'human' for a reply, or 'event' (with filter) for an external event. A reply wait clears when the mail arrives — for 'agent', mail from that agent to you (in `thread` if you name a mail id); for 'human', mail from your user. An event wait clears on the first event a source posts that fits filter (source, subjects, types, actors; subject and type patterns are globs, such as `github:OWNER/REPO#12`), and you get that event as a notice. Optional timeout_minutes: when it elapses the wait clears and you get a notice. If you can't continue until your user answers an ask, call `wait_for` with `on:'human'` and `thread` set to the ask's mail id. A wait on 'human' while your own permission request is pending with your user is about that request: it clears when the request is answered or closed, so a request needs no wait of its own. Returns the wait id, for wait_done.",
    inputSchema: {
      type: 'object',
      properties: {
        self,
        on: { type: 'string', enum: ['agent', 'human', 'event'], description: 'What you wait for.' },
        target: { type: 'string', description: "An agent id or name, for on 'agent'." },
        thread: { type: 'string', description: 'A mail id: clear only for mail in that mail\'s thread.' },
        filter: {
          type: 'object',
          description: "For on 'event' (required): which events clear the wait. Name at least one of source, subjects, types or actors; an empty filter is refused.",
          properties: {
            source: { type: 'string', description: 'Such as github or linear.' },
            subjects: { type: 'array', items: { type: 'string' }, description: 'Subject keys, such as github:OWNER/REPO#12; * is a glob within one segment.' },
            types: { type: 'array', items: { type: 'string' }, description: 'Event types, such as pull_request.synchronize.' },
            actors: { type: 'array', items: { type: 'string' }, description: 'Who the event is about.' },
          },
        },
        timeout_minutes: { type: 'number', description: 'Give up after this many minutes.' },
        expect_minutes: { type: 'number', description: 'Optional: about how many minutes until you expect the answer. Nothing fires then; it tells stam how long you will likely wait, so a long wait lets your harness rest until the answer wakes you.' },
        note: { type: 'string', description: 'What you wait for, shown as your wait detail.' },
        rest: { type: 'boolean', description: 'Optional: true asks stam to stop your harness as soon as this turn ends, instead of after the usual idle minutes, to free its memory; the answer, mail or a notice wakes you, with your conversation resumed. Pass it for a long wait with nothing to do meanwhile; leave it out when you expect an answer within minutes. stam keeps you up anyway while something still needs you.' },
      },
      required: ['on'],
    },
    run: async (a) => {
      // Only the declared parameters go to the daemon, and an unknown one is named rather than
      // sent: the daemon reads `from` as the identity a request acts as (S-302).
      const known = ['self', 'on', 'target', 'thread', 'filter', 'timeout_minutes', 'expect_minutes', 'note', 'rest'];
      const unknown = Object.keys(a ?? {}).filter((k) => !known.includes(k));
      if (unknown.length) throw new Error(`wait_for has no parameter ${unknown.map((k) => `'${k}'`).join(', ')}; its parameters are on, target (the agent to wait for, an id or name), thread, filter, timeout_minutes, expect_minutes, note, rest`);
      if (a.on === 'agent' && !a.target) throw new Error("wait_for on 'agent' needs target (an agent id or name)");
      const w = await api<any>('POST', `/api/agents/${me(a)}/waits/declared`, { on: a.on, target: a.target, thread: a.thread, filter: a.filter, timeout_minutes: a.timeout_minutes, expect_minutes: a.expect_minutes, note: a.note, rest: a.rest, by: me(a) });
      return text(`Waiting (${w.id}) for ${w.detail}${w.until ? `, timing out at ${w.until}` : ''}.${w.kind === 'human' && w.target ? ` It is tied to ${w.target}, so it clears when that is answered or closed.` : ''} Clear it with wait_done ${w.id}.`);
    },
  },
  {
    name: 'wait_done',
    group: 'waits',
    description: 'Clear one of your own waits declared with wait_for or scheduled with wake_me, by its id. Cron and periodic timers stay until you clear them this way.',
    inputSchema: { type: 'object', properties: { self, id: { type: 'string', description: 'The wait id from wait_for or wake_me.' } }, required: ['id'] },
    run: async (a) => {
      const r = await api<any>('POST', `/api/agents/${me(a)}/waits/done`, { id: a.id, by: me(a) });
      return text(r.cleared ? `Cleared wait ${a.id}.` : `No wait ${a.id} of yours to clear.`);
    },
  },
  {
    name: 'wake_me',
    group: 'waits',
    description:
      'Schedule a wake-up: stam sends your note back to you as a notice later (a prompt if you are idle). Exactly one schedule: in_minutes (once, N minutes from now), at (once, an ISO time), every_minutes (repeated every N minutes), or cron (a 5-field cron: minute hour day-of-month month day-of-week). A one-off wake clears when it fires; a cron or periodic one fires each time and stays until wait_done. Returns the wait id.',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        in_minutes: { type: 'number', description: 'Once, this many minutes from now.' },
        at: { type: 'string', description: 'Once, at this ISO 8601 time.' },
        every_minutes: { type: 'number', description: 'Repeated, every this many minutes.' },
        cron: { type: 'string', description: 'Repeated, on a 5-field cron schedule.' },
        note: { type: 'string', description: 'What to send back when it fires.' },
        rest: { type: 'boolean', description: 'Optional: true asks stam to stop your harness as soon as this turn ends, instead of after the usual idle minutes, to free its memory; the wake-up, mail or a notice wakes you, with your conversation resumed. Pass it for a long wait with nothing to do meanwhile; leave it out when it fires within minutes. stam keeps you up anyway while something still needs you.' },
      },
      required: ['note'],
    },
    run: async (a) => {
      const w = await api<any>('POST', `/api/agents/${me(a)}/waits/wake`, { ...a, self: undefined, by: me(a) });
      return text(`Wake-up (${w.id}) set for ${w.until}. Clear it with wait_done ${w.id}.`);
    },
  },
  {
    name: 'read_thread',
    group: 'mail',
    description: 'Read a mail thread you take part in, oldest first: the messages you sent or received in it. Also a thread with your user that one of your parents took part in, found with search_mail, and the threads of an ITSA you own or take part in, or whose parent ITSA you own. thread_id may be any mail id in the thread, such as one cited in your brief. Doesn\'t mark anything read.',
    inputSchema: { type: 'object', properties: { self, thread_id: { type: 'string' } }, required: ['thread_id'] },
    // Before the decision-step check, so a call that can't run costs no daemon request (S-4120).
    validate: (a) => {
      if (typeof a.thread_id !== 'string' || !a.thread_id.trim()) throw new Error('thread_id is required: any mail id in the thread, such as m1a2b3c');
    },
    run: async (a) => {
      const mails = await api<any[]>('GET', `/api/threads/${a.thread_id}?box=${me(a)}`);
      if (!mails.length) return text(`No mail of yours in thread ${a.thread_id}.`);
      return text(mails.map((m) => `## ${m.id}: ${m.subject}\nFrom: ${m.from_name} (${m.from_id}) to ${m.recipients.map((r: any) => r.id).join(', ')} · ${m.created_at}\n\n${m.body}${m.note ? `\n\n[stam] ${m.note}` : ''}`).join('\n\n---\n\n'));
    },
  },
  {
    name: 'search_mail',
    group: 'mail',
    description:
      'Search mail by keyword: your own mail, and the threads with your user that your parents (and their parents) took part in. Returns one line per thread, best first. Search before you mail your user, to find the thread to answer. "with" limits the results to threads an agent or "human" takes part in. To search ITSAs too, and to match by meaning, use search.',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        query: { type: 'string', description: 'Words to match in subjects and bodies.' },
        with: { type: 'string', description: 'An agent name or id, or "human": only threads that one takes part in.' },
        limit: { type: 'number', description: 'Threads to return. Defaults to 10, at most 30.' },
      },
      required: ['query'],
    },
    run: async (a) => {
      const params = new URLSearchParams({ box: me(a), q: a.query, limit: String(a.limit ?? 10) });
      if (a.with) params.set('with', a.with);
      const hits = await api<any[]>('GET', `/api/mail/search?${params}`);
      if (!hits.length) return text(`No mail matches "${a.query}".`);
      // Which ranking ran: by meaning when the embedder was ready (S-141), else by keyword.
      const by = hits.some((h) => h.by === 'meaning') ? 'by meaning' : 'by keyword';
      return text(
        `Ranked ${by}.\n` +
        hits.map((h) => `${h.thread_id} · ${h.subject} · latest ${h.latest} · ${h.people.join(', ')} · ${h.last} · ${h.excerpt}`).join('\n') +
          '\n\nRead one with read_thread; answer in it with send_mail and reply_to set to its latest mail id.',
      );
    },
  },
  {
    name: 'search',
    group: 'mail',
    description:
      'Search by meaning across mail and ITSAs, in one list, best first: the mail search_mail finds (your own, and the threads with your user that your parents took part in) and every ITSA. Each line is tagged [mail] or [itsa]. Words need not match the title: a query worded differently still finds the thread or ITSA about it.',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        query: { type: 'string', description: 'What to look for, in any words.' },
        kinds: { type: 'array', items: { type: 'string', enum: ['mail', 'itsa'] }, description: 'What to search: mail, itsa, or both. Defaults to both.' },
        limit: { type: 'number', description: 'Results to return. Defaults to 10, at most 30.' },
      },
      required: ['query'],
    },
    run: async (a) => {
      const limit = Math.min(30, Math.max(1, Number(a.limit ?? 10)));
      const kinds: string[] = a.kinds?.length ? a.kinds : ['mail', 'itsa'];
      const [mail, itsas] = await Promise.all([
        kinds.includes('mail') ? api<any[]>('GET', `/api/mail/search?${new URLSearchParams({ box: me(a), q: a.query, limit: String(limit) })}`) : [],
        kinds.includes('itsa') ? api<any[]>('GET', `/api/itsas/search?${new URLSearchParams({ q: a.query, limit: String(limit) })}`) : [],
      ]);
      // One order over both lists, from each route's score (hit-blend.ts). Each route's order survives,
      // so the top `limit` here are the top of each route's list.
      const { hits: ranked, by } = blendHits([mail.map((h) => ({ ...h, kind: 'mail' })), itsas.map((h) => ({ ...h, kind: 'itsa' }))]);
      const lines = ranked.slice(0, limit).map((h) =>
        h.kind === 'mail'
          ? `[mail] ${h.thread_id} · ${h.subject} · latest ${h.latest} · ${h.people.join(', ')} · ${h.last} · ${h.excerpt}`
          : `[itsa] ${h.key} · ${h.title} · ${h.status} · owner ${h.owner ?? 'nobody'} · ${h.excerpt}`,
      );
      if (!lines.length) return text(`Nothing matches "${a.query}".`);
      return text(
        `Ranked ${by === 'meaning' ? 'by meaning' : 'by keyword'}.\n` +
          lines.join('\n') +
          '\n\nOpen mail with read_thread (answer in it with send_mail and reply_to set to its latest mail id); open an ITSA with itsa_get and its key.',
      );
    },
  },
  {
    name: 'itsa_create',
    group: 'itsas',
    description:
      'Create an ITSA: a nestable, tracked piece of work (initiative, project, milestone, or issue are only a kind label; any ITSA can hold children). You join as a participant only when you are its owner. Returns its readable key like S-42. ITSAs are optional.',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        title: { type: 'string', description: 'Required. 1-4 words, a noun phrase that names the thing, like `Phone mail header`: no sentence, no colon, no parent key. The one-line detail goes in summary.' },
        summary: { type: 'string', description: 'One-line description.' },
        body: { type: 'string', description: 'Markdown body.' },
        parent: { type: 'string', description: 'Parent ITSA by id or key. Omit for a root.' },
        kind: { type: 'string', description: 'A label: initiative, project, milestone, issue, or proposal. An ITSA answering retro items (an Answers: line under Retros, or a retro steward\'s) with an instruction or template edit (a diff touching blocks/, templates/, CLAUDE.md, AGENTS.md, or registry/) must be proposal; a code fix answering retro items may be an issue.' },
        status: { type: 'string', description: 'A status name; defaults to backlog.' },
        owner: { type: 'string', description: 'An agent id or name, or "human". Defaults to nobody.' },
        participants: { type: 'array', items: { type: 'string' }, description: 'Agents or "human" to keep informed; the owner is always one.' },
        links: {
          type: 'array',
          items: { type: 'object', properties: { url: { type: 'string' }, system: { type: 'string' }, external_id: { type: 'string' } }, required: ['url'] },
          description: 'Links to external items (a PR, an issue, a URL).',
        },
      },
      required: ['title'],
    },
    run: async (a) => {
      const x = await api<any>('POST', '/api/itsas', {
        title: a.title, summary: a.summary, body: a.body, parent: a.parent, kind: a.kind,
        // The creator is not added here: the daemon makes the owner a participant, so the creator
        // joins only when it owns the ITSA. A creator that hands it on stops getting its relays (S-586).
        status: a.status, owner: a.owner, participants: a.participants ?? [], links: a.links, by: me(a),
      });
      const m = await namesOf(me(a), [x.owner]);
      const bits = [`Created ${x.key} "${x.title}" [${x.status}]`];
      if (x.owner) bits.push(`owner ${nameOf(x.owner, m)}`);
      if (a.parent) bits.push(`parent ${a.parent}`);
      return text(bits.join(', ') + '.' + longTitleNote(x.key, x.title ?? a.title));
    },
  },
  // --- Requirements (tools for agents, S-461): listed only while on ---
  {
    name: 'req_create',
    group: 'requirements',
    when: 'requirements',
    description:
      'Write a requirement as a draft: a "shall" statement your user keeps and stam checks work against. It is always a draft; under the default approval setting your user approves it, and an ask reaches them (the result names the ITSA). Give a title and the shall text; a rationale and source say why it exists. verification is a list of methods (decision, test, pattern, review, human); scope narrows what it applies to. Returns its key like R-7.',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        title: { type: 'string', description: 'Required: a short name.' },
        text: { type: 'string', description: 'The "shall" statement, in the words of the person who wrote it. The model reads this text.' },
        rationale: { type: 'string', description: 'Why it exists.' },
        source: { type: 'string', description: 'Where it came from: CLAUDE.md:58, a mail id, the user\'s words.' },
        parent: { type: 'string', description: 'The requirement it derives from, by key.' },
        level: { type: 'string', description: 'A free label: stakeholder, system, subsystem, process.' },
        severity: { type: 'string', enum: ['info', 'minor', 'major', 'critical'] },
        mode: { type: 'string', enum: ['observe', 'inform', 'enforce'], description: 'observe records only; inform tells the actor; enforce can also deny a tool call. Default observe.' },
        threshold: { type: 'number', description: 'P(violates) needed to act, 0 to 1. Default 0.8.' },
        verification: { type: 'array', items: { type: 'string' }, description: 'Methods: decision (a model inspects every subject in scope), test, pattern, review, human.' },
        scope: { type: 'object', description: 'What it applies to. Lists, any of: subjects (mail, mail-to-human, itsa, branch, tool, event, manual), paths (globs), repos, roles, agents, itsa (keys), tools, sources, types (event type globs such as pull_request.*).' },
        owner: { type: 'string', description: 'An agent id or name, or "human": answers waivers and false-positive reports.' },
      },
      required: ['title'],
    },
    run: async (a) => {
      const body: Record<string, unknown> = { by: me(a) };
      for (const k of ['title', 'text', 'rationale', 'source', 'parent', 'level', 'severity', 'mode', 'threshold', 'verification', 'scope', 'owner'] as const) if (a[k] !== undefined) body[k] = a[k];
      const r = await api<any>('POST', '/api/requirements', body);
      const ask = r.approval?.itsa
        ? `${r.approval.to === 'chief of staff' ? 'The chief of staff will approve it' : 'Your user will approve it'}: ask ${r.approval.itsa}.`
        : r.approval?.error
          ? `No ask reached your user (${r.approval.error}); tell your parent so it gets approved.`
          : '';
      return text(`Created ${r.key} "${r.title}" as a draft. ${ask}`.trim());
    },
  },
  {
    name: 'req_get',
    group: 'requirements',
    when: 'requirements',
    description:
      'Read requirements. With a key (R-7): the requirement, its trace (parents, children, links), and its recent verdicts with their numbers (for req_waive). Without one: the list, optionally filtered by status (draft, in_force, suspended, obsolete), parent (a key, or "root"), and text.',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        key: { type: 'string', description: 'A requirement key like R-7. Omit to list.' },
        status: { type: 'string' },
        parent: { type: 'string', description: 'List only the children of this requirement, or "root".' },
        text: { type: 'string', description: 'Words to find in keys, titles, texts, rationales, sources.' },
      },
    },
    run: async (a) => {
      if (a.key) {
        const r = await api<any>('GET', `/api/requirements/${encodeURIComponent(String(a.key).trim())}`);
        const out = [
          `${r.key} "${r.title}" [${r.status}] severity ${r.severity}, mode ${r.mode}, threshold ${r.threshold}, version ${r.version}, rev ${r.rev}, owner ${r.owner ?? 'nobody'}`,
          r.text ? `Text: ${r.text}` : 'Text: (none)',
        ];
        if (r.rationale) out.push(`Why: ${r.rationale}`);
        if (r.source) out.push(`Source: ${r.source}`);
        if (r.verification?.length) out.push(`Verification: ${r.verification.map((v: any) => (v.detail ? `${v.method} (${v.detail})` : v.method)).join(', ')}`);
        if (r.scope) out.push(`Scope: ${JSON.stringify(r.scope)}`);
        if (r.precision) {
          const p = r.precision;
          out.push(
            p.violates
              ? `Precision: ${p.false_positives} of its last ${p.violates} flags were waived as false positives (${Math.round((p.rate ?? 0) * 100)}%; above ${Math.round(p.max_rate * 100)}% it drops to observe), ${p.accepted_deviations} accepted deviations.`
              : 'Precision: no flags yet.',
          );
        }
        if (r.parent_chain?.length) out.push(`Derives from: ${r.parent_chain.map((p: any) => `${p.key} ${p.title}`).join(' > ')}`);
        if (r.children?.length) out.push(`Children: ${r.children.map((c: any) => `${c.key} ${c.title} [${c.status}]`).join('; ')}`);
        if (r.links?.length) out.push(`Links: ${r.links.map((l: any) => `${l.role} ${l.target_kind} ${l.target} (#${l.id})`).join('; ')}`);
        out.push(
          r.verdicts?.length
            ? `Recent verdicts (indications from a model, not proof):\n${r.verdicts.map((v: any) => `- #${v.id} ${v.subject}: ${v.verdict}${v.p_violates != null ? ` (p violates ${Number(v.p_violates).toFixed(2)})` : ''} v${v.req_version}${v.waiver ? ` [waived: ${v.waiver.kind}, ${v.waiver.reason ?? 'no reason'}]` : ''}`).join('\n')}`
            : 'No verdicts yet.',
        );
        return text(out.join('\n'));
      }
      const q = new URLSearchParams();
      for (const k of ['status', 'parent', 'text'] as const) if (a[k]) q.set(k, String(a[k]));
      const rows = await api<any[]>('GET', `/api/requirements${q.toString() ? `?${q}` : ''}`);
      if (!rows.length) return text('No requirements.');
      return text(rows.map((r) => `${r.key} [${r.status}] ${r.severity}/${r.mode} ${r.title}${r.parent_id ? ' (child)' : ''}`).join('\n'));
    },
  },
  {
    name: 'req_set',
    group: 'requirements',
    when: 'requirements',
    description:
      'Change a requirement: title, text, rationale, source, parent, level, severity, mode, threshold, verification, scope, owner, or status (draft, in_force, suspended, obsolete). A change to the text or scope makes a new version. Moving a requirement into in_force is the approval: the API refuses unless the approval setting allows you. An agent approving must pass if_rev (the rev in req_get and in the ask) and nothing else in that call, so it approves exactly what it read. Under human or cos approval an agent cannot change the text or scope of a requirement that is in force or suspended: create a new draft linked with role refines and mail the owner. Nor can it change the mode, threshold, or severity of such a requirement, nor approve text it last changed. Add links with add_links, remove them with remove_links.',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        key: { type: 'string', description: 'Required: the requirement, like R-7.' },
        title: { type: 'string' }, text: { type: 'string' }, rationale: { type: 'string' }, source: { type: 'string' },
        parent: { type: 'string', description: 'A key, or "root".' },
        level: { type: 'string' },
        severity: { type: 'string', enum: ['info', 'minor', 'major', 'critical'] },
        mode: { type: 'string', enum: ['observe', 'inform', 'enforce'] },
        threshold: { type: 'number' },
        status: { type: 'string', enum: ['draft', 'in_force', 'suspended', 'obsolete'] },
        owner: { type: 'string' },
        verification: { type: 'array', items: { type: 'string' } },
        scope: { type: 'object' },
        if_rev: { type: 'number', description: 'Refuse the change unless the requirement is at this rev (shown in req_get and in the approval ask): approve the draft you read, not one edited since.' },
        add_links: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              target: { type: 'string' },
              target_kind: { type: 'string', enum: ['itsa', 'file', 'test', 'mail', 'url', 'requirement'] },
              role: { type: 'string', enum: ['implements', 'verifies', 'allocated_to', 'refines', 'conflicts_with'] },
            },
            required: ['target'],
          },
        },
        remove_links: { type: 'array', items: { type: 'number' }, description: 'Link numbers (#N in req_get).' },
      },
      required: ['key'],
    },
    run: async (a) => {
      const key = String(a.key ?? '').trim();
      if (!key) throw new Error('key is required: a requirement like R-7');
      const patch: Record<string, unknown> = {};
      for (const k of ['title', 'text', 'rationale', 'source', 'parent', 'level', 'severity', 'mode', 'threshold', 'status', 'owner', 'verification', 'scope'] as const) if (a[k] !== undefined) patch[k] = a[k];
      const notes: string[] = [];
      if (a.if_rev !== undefined) patch.ifRev = Number(a.if_rev);
      if (Object.keys(patch).length) {
        const r = await api<any>('PATCH', `/api/requirements/${encodeURIComponent(key)}`, { ...patch, by: me(a) });
        const changed = Object.entries(r.changes).map(([f, c]: [string, any]) => `${f}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`);
        notes.push(changed.join('; ') || 'nothing changed');
      }
      for (const l of a.add_links ?? []) {
        const r = await api<any>('POST', `/api/requirements/${encodeURIComponent(key)}/links`, l);
        notes.push(`linked ${r.role} ${r.target_kind} ${r.target} (#${r.id})`);
      }
      for (const id of a.remove_links ?? []) {
        await api('DELETE', `/api/requirements/${encodeURIComponent(key)}/links/${Number(id)}`);
        notes.push(`removed link #${id}`);
      }
      if (!notes.length) throw new Error('nothing to set: pass a field, add_links, or remove_links');
      return text(`${key}: ${notes.join('; ')}`);
    },
  },
  {
    name: 'req_check',
    group: 'requirements',
    when: 'requirements',
    description:
      'Check work against the requirements in scope, before you send mail or open a pull request: pass `text` (a draft mail, a body), or a subject: mail:ID, itsa:KEY, or branch:REPO/NAME (a branch\'s diff against main). Optionally keys limits it to named requirements. Returns a verdict per requirement: conforms, violates, na, or unsure. A verdict is an indication from a model, not proof; if one is wrong, record it with req_waive. Nobody is told by this call.',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        text: { type: 'string', description: 'Text to check.' },
        subject: { type: 'string', description: 'mail:ID, itsa:KEY, or branch:REPO/NAME.' },
        keys: { type: 'array', items: { type: 'string' }, description: 'Only these requirements, like ["R-7"].' },
        preview: { type: 'boolean', description: 'Instead of checking a subject, run the requirements named in keys on the last n real subjects of their scope (recent mail, ITSAs, branches) and show what they would flag. Records nothing and tells nobody. Use it on a new or reworded requirement.' },
        n: { type: 'number', description: 'With preview: how many subjects, default 20, at most 50.' },
      },
    },
    run: async (a) => {
      if (a.preview) {
        const keys: string[] = a.keys ?? [];
        if (!keys.length) throw new Error('preview needs keys: the requirements to run, like ["R-7"]');
        const blocks: string[] = [];
        for (const k of keys) {
          const r = await api<any>('POST', `/api/requirements/${encodeURIComponent(k)}/preview`, { n: a.n }, 120_000);
          const word: Record<string, string> = { violates: 'likely violates', conforms: 'likely conforms', na: 'likely not applicable', unsure: 'unsure' };
          const flagged = r.rows.filter((x: any) => x.verdict === 'violates').length;
          blocks.push(
            `${r.key}: preview on ${r.rows.length} subjects, ${flagged} likely violate${r.note ? ` (${r.note})` : ''}\n` +
              r.rows.map((x: any) => `- ${x.subject} ${x.summary}: ${x.error ?? `${word[x.verdict] ?? x.verdict}${x.p_violates != null ? ` (p violates ${Number(x.p_violates).toFixed(2)})` : ''}`}`).join('\n'),
          );
        }
        return text(`${blocks.join('\n\n')}\n\nNothing was recorded and nobody was told. These are indications from a model, not proof.`);
      }
      const r = await api<any>('POST', '/api/requirements/check', { text: a.text, subject: a.subject, keys: a.keys }, 60_000);
      if (!r.results.length) return text(`${r.subject}: no requirement in scope, or the check got no answer.`);
      const word: Record<string, string> = { violates: 'likely violates', conforms: 'likely conforms', na: 'likely not applicable', unsure: 'unsure' };
      return text(
        `${r.subject}\n` +
          r.results.map((x: any) => `- ${x.key}: ${word[x.verdict] ?? x.verdict}${x.p_violates != null ? ` (p violates ${Number(x.p_violates).toFixed(2)})` : ''}${x.id != null ? ` [verdict #${x.id}]` : ''}${x.cached ? ' (stored)' : ''}`).join('\n') +
          '\n\nThese are indications from a model, not proof. If one is wrong, say so with req_waive and its verdict number.',
      );
    },
  },
  {
    name: 'req_waive',
    group: 'requirements',
    when: 'requirements',
    description:
      'Mark a verdict as a false positive (the model was wrong) or an accepted deviation (it is right and the exception is fine), with a reason. The verdict stays, marked. Take the verdict number from req_check or req_get.',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        verdict_id: { type: 'number', description: 'The verdict number (#N).' },
        kind: { type: 'string', enum: ['false_positive', 'accepted_deviation'] },
        reason: { type: 'string', description: 'Required: why.' },
      },
      required: ['verdict_id', 'kind', 'reason'],
    },
    run: async (a) => {
      const w = await api<any>('POST', '/api/requirements/waivers', { verdict_id: a.verdict_id, kind: a.kind, reason: a.reason, by: me(a) });
      return text(`Waived verdict #${w.verdict_id} as ${w.kind}: ${w.reason}`);
    },
  },
  {
    name: 'feedback',
    group: 'itsas',
    description:
      'Alias of retro with kind=stam_issue: report a problem with stam or its MCP tools. Use retro, the one place to report, for new reports. Not for bugs in the project you are working on.',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        kind: { type: 'string', enum: [...FEEDBACK_KINDS], description: 'bug, inconsistency, missing_param, missing_feature, or other.' },
        title: { type: 'string', description: 'Required. 1-4 words, a noun phrase that names the problem, like `send_mail reply_to`: no sentence, no colon. summary keeps the one line.' },
        summary: { type: 'string', description: 'One line.' },
        details: { type: 'string', description: 'What happened, what you expected, and the tool or route involved.' },
        tool: { type: 'string', description: 'The MCP tool involved, if any.' },
      },
      required: ['kind', 'summary', 'details'],
    },
    run: async (a) => text(await runRetro(api, me(a), { kind: STAM_ISSUE_KIND, feedback_kind: a.kind, title: a.title, summary: a.summary, details: a.details, tool: a.tool })),
  },
  {
    name: 'retro',
    group: 'itsas',
    description:
      'Record how the work went: a time sink, a misleading instruction, a trick that worked, or an idea. A retro item is about the work. A problem with stam or its MCP tools is kind=stam_issue with feedback_kind and tool: the one place to report those, filed under Feedback with one mail to the chief of staff. Search first with search: it finds open retro items and feedback reports by meaning, best first, up to three, each with its +1 count and the first line of its details, so a match worded differently is still visible. +1 a match with plus_one and your own scenario rather than filing a near-duplicate. Otherwise file it with kind, title, summary and details. One or two sentences.',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        search: { type: 'string', description: 'Search open retro items and feedback reports by meaning, best first. Returns up to three matches with their +1 counts and the first line of their details.' },
        plus_one: { type: 'string', description: 'The key of a retro item or feedback report to +1, like S-42. Needs details.' },
        kind: { type: 'string', enum: [...RETRO_KINDS, STAM_ISSUE_KIND], description: 'went_well, improve, idea, instruction, or stam_issue.' },
        feedback_kind: { type: 'string', enum: [...FEEDBACK_KINDS], description: 'For stam_issue: bug, inconsistency, missing_param, missing_feature, or other.' },
        tool: { type: 'string', description: 'For stam_issue: the MCP tool involved, if any.' },
        title: { type: 'string', description: 'Required when filing a new item (not for search or plus_one). 1-4 words, a noun phrase that names the item, like `Idle pane waits`: no sentence, no colon. It becomes the ITSA title; summary keeps the one-line lesson.' },
        summary: { type: 'string', description: 'One line: the lesson.' },
        details: { type: 'string', description: 'The specific scenario: what happened, and where.' },
        target: { type: 'string', description: 'The template, tool, or file it is about, such as type-developer or ring_submit. Required for improve and instruction.' },
        evidence: { type: 'string', enum: [...EVIDENCE_KINDS], description: 'What external event backs the item: human (a correction from the human), gate (a merge gate result), review (a review verdict), rollback (a rollback or deploy hold), measured (a measured wait or cost), or none (default).' },
        evidence_detail: { type: 'string', description: 'For evidence: the specifics, like "phone 360-light failed on #183".' },
        when: { type: 'string', description: 'One line: the condition under which the lesson applies.' },
        final: { type: 'boolean', description: 'true for your final round, when stam archives you: record your effort split with effort. Not an ITSA.' },
        effort: {
          type: 'object',
          description: 'For final: percentages of your work over reading, implementing, testing, waiting, review_fixes, and coordination.',
          properties: Object.fromEntries(EFFORT_KEYS.map((k) => [k, { type: 'number', minimum: 0, maximum: 100 }])),
          additionalProperties: false,
        },
      },
    },
    run: async (a) => text(await runRetro(api, me(a), a)),
  },
  {
    name: 'itsa_get',
    group: 'itsas',
    description:
      "One ITSA by id or key: title, status, owner, summary, parent chain, participants, links, and its direct children with each one's roll-up.",
    inputSchema: { type: 'object', properties: { self, ref: { type: 'string', description: 'ITSA id or key, like S-42.' } }, required: ['ref'] },
    run: async (a) => {
      const x = await api<any>('GET', `/api/itsas/${encodeURIComponent(itsaRef(a))}`);
      const m = await namesOf(me(a), [x.owner, ...(x.participants ?? []), ...(x.children ?? []).map((c: any) => c.owner)]);
      const lines: string[] = [`${x.key} "${x.title}" [${x.status}]${x.kind ? ` · ${x.kind}` : ''}`];
      if (x.summary) lines.push(x.summary);
      if (x.body) lines.push(x.body);
      lines.push(`owner: ${nameOf(x.owner, m)}`);
      // The open ask it waits on: its mail, then its kind, never the ask's text (S-3982).
      if (x.open_ask_detail) lines.push(`open ask: ${[x.open_ask_detail.mail, x.open_ask_detail.kind].filter(Boolean).join(' · ')}`);
      if (x.parent_chain?.length) lines.push(`parents: ${x.parent_chain.map((p: any) => `${p.key} ${p.title}`).join(' > ')}`);
      if (fieldsLine(x.fields)) lines.push(`fields: ${fieldsLine(x.fields)}`);
      if (x.participants?.length) lines.push(`participants: ${x.participants.map((p: string) => nameOf(p, m)).join(', ')}`);
      for (const l of x.links ?? []) lines.push(`link ${l.system}${l.external_id ? ` #${l.external_id}` : ''}: ${l.url}`);
      if (x.children?.length) {
        lines.push('children:');
        for (const c of x.children) lines.push(`  ${c.key} "${c.title}" [${c.status}] owner ${nameOf(c.owner, m)}${c.rollup ? ` · roll-up: ${rollupText(c.rollup)}` : ''}`);
      }
      const r = x.rollup;
      if (x.children?.length && r) lines.push(`roll-up: ${rollupText(r)}`);
      // Mail linked to the ITSA (S-986): the threads that name it, newest first; read one with read_thread.
      const linked = await api<any[]>('GET', `/api/mail/linked/${encodeURIComponent(x.id)}?limit=5`).catch(() => []);
      if (linked.length) {
        lines.push('linked mail (newest first):');
        for (const l of linked) lines.push(`  ${l.thread_id} "${l.subject}" from ${l.from_name ?? l.from_id}, ${String(l.last_at).slice(0, 10)}${l.mails > 1 ? ` (${l.mails} mails)` : ''}`);
      }
      return text(lines.join('\n'));
    },
  },
  {
    name: 'itsa_list',
    group: 'itsas',
    description:
      'List ITSAs as short rows (key, status, owner, title). Filters: mine (you own or take part in), parent, subtree, status, category, owner, participant, kind, text. Use mine to see your own work.',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        mine: { type: 'boolean', description: 'Only ITSAs you own or take part in.' },
        parent: { type: 'string', description: 'Direct children of this ITSA; "root" for top-level ITSAs.' },
        subtree: { type: 'string', description: 'This ITSA and everything below it.' },
        status: { type: 'string' },
        category: { type: 'string', description: 'backlog, ready, active, review, or closed.' },
        owner: { type: 'string' },
        participant: { type: 'string' },
        kind: { type: 'string' },
        text: { type: 'string', description: 'Match against title, summary, or body.' },
      },
    },
    run: async (a) => {
      const q = new URLSearchParams();
      for (const k of ['parent', 'subtree', 'status', 'category', 'owner', 'participant', 'kind', 'text'] as const)
        if (a[k] != null && String(a[k]) !== '') q.set(k, String(a[k]));
      let rows: any[];
      if (a.mine) {
        // `mine` is "you own or take part in"; the owner is always a participant, so it is
        // exactly "you are a participant". Keep every filter the caller gave: add the
        // caller as the participant when they named none, else intersect the two.
        const withMe = new URLSearchParams(q);
        withMe.set('participant', me(a));
        if (!q.has('participant')) {
          rows = await api<any[]>('GET', `/api/itsas?${withMe}`);
        } else {
          const [a1, a2] = await Promise.all([api<any[]>('GET', `/api/itsas?${withMe}`), api<any[]>('GET', `/api/itsas?${q}`)]);
          const given = new Set(a2.map((x) => x.id));
          rows = a1.filter((x) => given.has(x.id));
        }
        rows.sort((x, y) => x.created_at.localeCompare(y.created_at));
      } else {
        rows = await api<any[]>('GET', `/api/itsas${q.toString() ? `?${q}` : ''}`);
      }
      if (!rows.length) return text('No ITSAs.');
      const m = await namesOf(me(a), rows.map((x) => x.owner));
      return text(rows.map((x) => `${x.key} [${x.status}] ${nameOf(x.owner, m)} ${x.title}${fieldsLine(x.fields) ? ` {${fieldsLine(x.fields)}}` : ''}`).join('\n'));
    },
  },
  {
    name: 'itsa_set',
    group: 'itsas',
    description:
      'Change an ITSA: status, owner, title, summary, body, kind, parent, participants, or Work page column values (fields). Use a closed status to finish it. Use a human status only for a question only your user can answer (post a comment with itsa_post first: a human status is refused until you have); for anything your parent or the chief of staff can decide, use waiting or blocked. Moving an ITSA out of a human status withdraws the ask from your user. Returns what changed.',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        ref: { type: 'string', description: 'ITSA id or key.' },
        title: { type: 'string', description: '1-4 words, a noun phrase that names the thing, like `Phone mail header`: no sentence, no colon, no parent key. The one-line detail goes in summary.' },
        summary: { type: 'string' },
        body: { type: 'string' },
        kind: { type: 'string' },
        status: { type: 'string', description: 'A status name. A closed one finishes the ITSA.' },
        owner: { type: 'string', description: 'An agent id or name, or "human".' },
        parent: { type: 'string', description: 'Move it under this ITSA, or "root" to free it.' },
        participants: { type: 'array', items: { type: 'string' }, description: 'Replace the participant list (the owner stays one).' },
        fields: { type: 'object', description: 'Values for Work page columns, by field key (see itsa_fields list); null clears one. For example {"stage": "dev"}.' },
        incident: { type: 'boolean', description: 'Mark the ITSA an incident (true) or clear the mark (false). Only the chief of staff or your user may set it; a developer spawn with urgent incident then goes ahead under it or its child ITSAs. Closing the ITSA clears the mark.' },
      },
      required: ['ref'],
    },
    run: async (a) => {
      const patch: Record<string, unknown> = {};
      for (const k of ['title', 'summary', 'body', 'kind', 'status', 'owner', 'parent'] as const) if (a[k] !== undefined) patch[k] = a[k];
      if (a.participants !== undefined) patch.participants = a.participants;
      if (a.fields !== undefined) patch.fields = a.fields;
      if (a.incident !== undefined) patch.incident = a.incident;
      const ref = itsaRef(a);
      if (!Object.keys(patch).length) throw new Error('nothing to set: pass at least one field (status, owner, title, ...)');
      const r = await api<any>('PATCH', `/api/itsas/${encodeURIComponent(ref)}`, { ...patch, by: me(a) });
      const m = await namesOf(me(a), [r.itsa.owner, ...idsIn(Object.values(r.changes).flatMap((c: any) => [c.from, c.to]))]);
      // Fields change as {from, to} maps of key to value, so they show as key=value pairs, not as objects.
      const changed = Object.entries(r.changes).map(([f, c]: [string, any]) =>
        f === 'fields' ? fieldsChange(c) : `${f}: ${showValue(c.from, m)} -> ${showValue(c.to, m)}`,
      );
      return text(`${r.itsa.key}: ${changed.join('; ') || 'nothing changed'}${a.title !== undefined ? longTitleNote(r.itsa.key, a.title) : ''}${r.retro_offer ? `\n\n${r.retro_offer}` : ''}`);
    },
  },
  {
    name: 'itsa_fields',
    group: 'itsas',
    description:
      'The Work page columns, called ITSA fields: a field is a shared column that agents fill per ITSA (with itsa_set fields), and its description says what goes in it. action: list (default), create, update, remove, or order. create needs key (a slug), label, and type (text, number, choice, link, date, check); a choice field needs options. update and remove take field (key or id). order takes order: field keys, first to last. Your user may always change fields; while a chief of staff is set, only that agent may, and others get a refusal naming it: mail them to ask. With none set, any agent may, sparingly.',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        action: { type: 'string', enum: ['list', 'create', 'update', 'remove', 'order'] },
        field: { type: 'string', description: 'update and remove: the field key or id.' },
        key: { type: 'string', description: 'A slug: lowercase letters, digits, - and _.' },
        label: { type: 'string' },
        type: { type: 'string', enum: ['text', 'number', 'choice', 'link', 'date', 'check'] },
        options: { type: 'array', items: { type: 'object', properties: { value: { type: 'string' }, label: { type: 'string' }, tone: { type: 'string', enum: ['ok', 'warn', 'bad', 'muted', 'accent'] } }, required: ['value'] }, description: 'A choice field\'s options.' },
        description: { type: 'string', description: 'What goes in this column, for the agents that fill it.' },
        hint: { type: 'string' },
        width: { type: 'string', enum: ['s', 'm', 'l'] },
        align: { type: 'string', enum: ['start', 'end'] },
        card: { type: 'string', enum: ['chip', 'meta'] },
        kinds: { type: 'array', items: { type: 'string' }, description: 'The ITSA kinds this field applies to, such as ["issue"]: other ITSAs skip it, and a value on one is refused. Omit or [] for every kind. Narrowing keeps values and hides them.' },
        order: { type: 'array', items: { type: 'string' }, description: 'order: field keys, first to last.' },
      },
    },
    run: async (a) => {
      const action = a.action ?? 'list';
      const body: Record<string, unknown> = { by: me(a) };
      for (const k of ['key', 'label', 'type', 'options', 'description', 'hint', 'width', 'align', 'card', 'kinds'] as const) if (a[k] !== undefined) body[k] = a[k];
      const need = () => {
        if (!a.field) throw new Error(`${action} needs field (the key or id)`);
        return encodeURIComponent(String(a.field));
      };
      let list: any[];
      let done = '';
      if (action === 'list') list = await api<any[]>('GET', '/api/itsas/fields');
      else if (action === 'create') {
        const f = await api<any>('POST', '/api/itsas/fields', body);
        done = `created ${f.key}`;
        list = await api<any[]>('GET', '/api/itsas/fields');
      } else if (action === 'update') {
        const f = await api<any>('PATCH', `/api/itsas/fields/${need()}`, body);
        done = `updated ${f.key}`;
        list = await api<any[]>('GET', '/api/itsas/fields');
      } else if (action === 'remove') {
        await api('DELETE', `/api/itsas/fields/${need()}`, { by: me(a) });
        done = `removed ${a.field} and its values`;
        list = await api<any[]>('GET', '/api/itsas/fields');
      } else if (action === 'order') {
        list = await api<any[]>('POST', '/api/itsas/fields/order', { order: a.order, by: me(a) });
        done = 'reordered';
      } else throw new Error('action is list, create, update, remove, or order');
      const rows = list.map((f) => `${f.key} · ${f.label} · ${f.type}${f.options ? ` (${f.options.map((o: any) => o.value).join(' | ')})` : ''}${f.kinds ? ` · kinds: ${f.kinds.join(', ')}` : ''}${f.description ? ` — ${f.description}` : ''}`);
      return text([done, rows.length ? rows.join('\n') : 'No fields.'].filter(Boolean).join('\n'));
    },
  },
  {
    name: 'itsa_link',
    group: 'itsas',
    description:
      'Link an ITSA to something outside it, or record on one of its links. To add a link, give ref and a url (and system, or external_id). To link a branch for the merge queue, give ref, system "branch", external_id (the branch name), and repo (a name in settings.itsa.repos). To record on a branch link, give ref and n (its number), with any of: review ({verdict: approve, request_changes, or comment; summary}), tests ({passed, failed, skipped, command}), screenshots ([{mail_id, name}] naming attachments on mail, such as ones in the ITSA\'s thread). Each field given replaces that part of the record.',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        ref: { type: 'string', description: 'ITSA id or key.' },
        url: { type: 'string', description: 'A link\'s url. Optional for a branch link.' },
        system: { type: 'string', description: 'The link kind: github, url, or branch.' },
        external_id: { type: 'string', description: 'An outside id, such as a PR number, or a branch name for a branch link.' },
        repo: { type: 'string', description: 'A branch link\'s repo: a name in settings.itsa.repos.' },
        n: { type: 'number', description: 'The link number to record on (a branch link).' },
        review: { type: 'object', description: '{ verdict: approve | request_changes | comment, summary }.' },
        tests: { type: 'object', description: '{ passed, failed, skipped, command }: counts of whole numbers.' },
        screenshots: { type: 'array', items: { type: 'object', properties: { mail_id: { type: 'string' }, name: { type: 'string' } }, required: ['mail_id', 'name'] }, description: 'Attachments on mail that show the change.' },
      },
      required: ['ref'],
    },
    run: async (a) => {
      const ref = itsaRef(a);
      if (a.n !== undefined) {
        const rec: Record<string, unknown> = {};
        for (const k of ['review', 'tests', 'screenshots'] as const) if (a[k] !== undefined) rec[k] = a[k];
        if (!Object.keys(rec).length) throw new Error('nothing to record: pass review, tests, or screenshots');
        const r = await api<any>('PATCH', `/api/itsas/${encodeURIComponent(ref)}/links/${a.n}`, { ...rec, by: me(a) });
        return text(`Recorded on link ${r.n} (${r.system}${r.external_id ? ' ' + r.external_id : ''}): ${Object.keys(rec).join(', ')}.`);
      }
      const r = await api<any>('POST', `/api/itsas/${encodeURIComponent(ref)}/links`, { url: a.url ?? '', system: a.system, external_id: a.external_id, repo: a.repo, by: me(a) });
      return text(`Linked ${r.link.n}: ${r.link.system}${r.link.external_id ? ' ' + r.link.external_id : ''}${r.link.url ? ' ' + r.link.url : ''}`);
    },
  },
  {
    name: 'itsa_post',
    group: 'itsas',
    description:
      'Comment on an ITSA, or post a status update, in the ITSA\'s mail thread (the first post creates the thread). It goes to the ITSA\'s participants except you, plus anyone in `to`, and makes you a participant. Your user gets it only when `to` names "human", even as a participant: to answer them in an ITSA thread, include "human" in `to`. Comments and updates arrive with the next idle batch and don\'t interrupt a working agent, unless you name the recipient as @name in the body or you own the ITSA. An update (kind "update", the ITSA owner\'s periodic report) needs a health: on_track, at_risk, or off_track. Answering an ITSA mail with send_mail and reply_to does the same as a comment. Write other issues as their key (S-12) and agents as @name; the web UI links both.',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        itsa: { type: 'string', description: 'The ITSA\'s id or key, for example S-42.' },
        body: { type: 'string', description: 'Markdown; mail components work.' },
        kind: { type: 'string', enum: ['comment', 'update'], description: 'Default comment.' },
        health: { type: 'string', enum: ['on_track', 'at_risk', 'off_track'], description: 'Required for an update.' },
        to: { type: 'array', items: { type: 'string' }, description: 'Extra recipients besides the participants.' },
        override: { type: 'string', description: 'Only when `to` names "human": a mail check refuses a post your user doesn\'t need or that breaks the rules for mail to them. If you disagree, repost with the reason here; it goes out and your user sees the reason.' },
      },
      required: ['itsa', 'body'],
    },
    run: async (a) => {
      const m = await api('POST', `/api/itsas/${encodeURIComponent(itsaRef(a, 'itsa'))}/post`, { body: a.body, kind: a.kind, health: a.health, to: a.to, override: a.override, by: me(a), client_id: writeId('post', me(a), itsaRef(a, 'itsa'), a.body, a.kind, a.to) }, WRITE_CALL_MS);
      return text(`Posted ${m.id} in the ITSA's thread ${m.thread_id}.`);
    },
  },
  {
    name: 'pr_open',
    group: 'itsas',
    description:
      'Open a branch\'s pull request on GitHub, from any machine (S-514). It runs on the ITSA home, where gh is: it fetches the branch from storage (or, on the home, from your own worktree), pushes it to origin, and opens the PR, or replaces the body of the open PR for that branch. The body is the docs/pull-requests.md body: its ITSA, Gates, and Deploy lines first. With itsa, the ITSA gets the PR and branch links, and a branch you own that is not yet linked is linked to it. Returns the PR number and url; then watch_pr it. Every later push to the branch needs pr_open again: a push to origin reaches storage only, not GitHub, so pr_open is what updates the PR. Run it with predict: true first (S-3287): a dry run that needs no title or body, pushes nothing to GitHub and opens nothing, and returns the tests the gate adds for the branch (each with its path and rule), which LIGHT ones it ran and passed, and the exact NAME: PASS lines the body must carry. A prediction that fails or times out is an error, never an empty list.',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        branch: { type: 'string', description: 'The branch you pushed to storage.' },
        predict: { type: 'boolean', description: 'Dry run (default false): return the NAME: PASS lines the body must carry. Needs no title or body; pushes nothing to GitHub and opens no PR.' },
        title: { type: 'string', description: 'One line. Not needed with predict.' },
        body: { type: 'string', description: 'The PR body, in the docs/pull-requests.md format. Exactly one of body and body_file.' },
        body_file: { type: 'string', description: 'The path of a file holding the PR body, in your worktree or your scratch dir (read on your machine, at most 256 KiB). Exactly one of body and body_file.' },
        itsa: { type: 'string', description: 'The ITSA the branch delivers (id or key), to link the PR and branch to.' },
      },
      required: ['branch'],
    },
    run: async (a) => {
      const by = me(a);
      const unknown = Object.keys(a).filter((k) => !PR_OPEN_PARAMS.includes(k));
      if (unknown.length) throw new Error(`pr_open has no parameter ${unknown.join(', ')}: its parameters are ${PR_OPEN_PARAMS.join(', ')}`);
      if (a.predict) {
        // A dry run: never a timeout recovery, since it opened nothing. A failure throws; the list is never made up (S-3287).
        return text(formatPrediction(await api<PrPrediction>('POST', '/api/pr/predict', { branch: a.branch, by }, PR_OPEN_CALL_MS)));
      }
      if (!String(a.title ?? '').trim()) throw new Error('pr_open needs a title (or predict: true for a dry run)');
      try {
        const r = await api<any>('POST', '/api/pr/open', { branch: a.branch, title: a.title, body: a.body, body_file: a.body_file, itsa: a.itsa, by }, PR_OPEN_CALL_MS);
        return text(`${r.created ? 'Opened' : 'Updated'} PR #${r.number} for ${r.branch}: ${r.url}\nEvery later push to ${r.branch} needs pr_open again: a push to origin reaches storage only, not GitHub.${r.warning ? `\nWARNING: ${r.warning}` : ''}${r.advisory?.length ? `\nADVISORY (LIGHT tests, not a refusal): ${r.advisory.join('; ')}` : ''}`);
      } catch (e) {
        if (!isTimeout(e)) throw e;
        return text(await prOpenTimedOut(a, by, e));
      }
    },
  },
  {
    name: 'pr_merge',
    group: 'itsas',
    description:
      'Merge an approved pull request, from any machine (S-2279). The ITSA home starts the merge script for it, detached from your shell (a build without the merge scripts refuses, and you merge with gh pr merge), and mails you the outcome when it ends: the merge sha, a refusal with its reason, or "not merged" with the script\'s last lines (call again to retry). Only the tree that owns the PR\'s ITSA (its body\'s ITSA: line) or its branch, or the chief of staff, may merge it. A call while a merge of the PR runs returns that run. With status, it starts nothing and returns the run\'s state and queue place. With cancel (S-2709), it takes the PR out of the merge queue without closing it: the ITSA home stops the PR\'s merge run and worker by recorded pid and drops its queue ticket, on the same tree rules; you and the run\'s requester get a "merge cancelled" mail. If a train holds the gate lock and carries the PR, the cancel claims the PR\'s ticket and the train drops the PR before its merge (the result says the cancel is pending in the train, and the run\'s mail reports it); if the train already claimed the merge the cancel is refused as "already merging" and the PR merges; a lock held by anything else refuses the cancel with nothing changed. A PR with no run is an error.',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        pr: { type: ['string', 'number'], description: 'The PR number.' },
        status: { type: 'boolean', description: 'Only report the run\'s state, queue place, and last log lines. Default false.' },
        cancel: { type: 'boolean', description: 'Take the PR out of the merge queue: stop its merge run and drop its ticket, without closing the PR. Default false.' },
      },
      required: ['pr'],
    },
    run: async (a) => {
      const by = me(a);
      if (a.status) {
        const s = await api<any>('POST', '/api/pr/merge-status', { pr: a.pr, by }, 30_000);
        const r = s.run;
        const head = s.note ? `PR #${s.pr}: ${s.note}.` : !r ? `No pr_merge run for PR #${s.pr}.` :`PR #${s.pr}: ${r.state}${r.sha ? ` (${r.sha})` : ''}, started ${r.started} by ${r.by}${r.reason ? `\n${r.reason}` : ''}`;
        const place = s.queue ? `\nQueue place ${s.queue.rank} (first: PR #${s.queue.first}).` : r?.state === 'running' ? '\nNot in the merge queue yet, or holding the gate lock.' : '';
        const train = s.train ? `\n${s.train.text}.` : '';
        return text(`${head}${place}${train}${s.tail.length ? `\nLast log lines:\n${s.tail.join('\n')}` : ''}`);
      }
      if (a.cancel) {
        const c = await api<any>('POST', '/api/pr/merge-cancel', { pr: a.pr, by }, 120_000);
        if (c.pending === 'train') return text(`Cancel claimed for PR #${c.pr}: it is in a running train, which drops it before its merge (no train step is stopped; the other PRs go on). The run ends as cancelled when the train ends, and you and the requester get the "merge cancelled" mail. The PR is still open.`);
        return text(`Cancelled the merge of PR #${c.pr}: stopped ${[c.stopped.shell && 'the run', c.stopped.worker && 'the merge worker'].filter(Boolean).join(' and ') || 'nothing running'}, dropped ${c.stopped.tickets} queue ticket(s). The PR is still open; pr_merge queues it again.`);
      }
      const r = await api<any>('POST', '/api/pr/merge', { pr: a.pr, by }, 120_000);
      // A previous run whose mail failed: its outcome reaches this caller instead.
      const p = r.previous ? `\nThe previous run (by ${r.previous.by}) ended ${r.previous.state}${r.previous.sha ? `: ${r.previous.sha}` : r.previous.reason ? `:\n${r.previous.reason}` : ''}` : '';
      return text(`${r.already ? 'A merge of' : 'Started merging'} PR #${r.pr} (${r.branch})${r.already ? ` is already running, since ${r.started}` : ''}. You get mail when it ends; pr_merge with status shows its queue place.${p}`);
    },
  },
  {
    name: 'pr_close',
    group: 'itsas',
    description:
      'Close a pull request with a comment, from any machine (S-2279), such as one a later PR superseded. It runs on the ITSA home, where gh is, on pr_merge\'s terms: only the tree that owns the PR\'s ITSA or its branch, or the chief of staff, may close it. A PR that is already closed or merged is left as it is.',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        pr: { type: ['string', 'number'], description: 'The PR number.' },
        comment: { type: 'string', description: 'Why it is closed, such as "Superseded by #728."' },
      },
      required: ['pr', 'comment'],
    },
    run: async (a) => {
      const r = await api<any>('POST', '/api/pr/close', { pr: a.pr, comment: a.comment, by: me(a) }, 120_000);
      return text(r.closed ? `Closed PR #${r.pr}.` : `PR #${r.pr} is already ${String(r.state).toLowerCase()}; nothing was done.`);
    },
  },
  {
    name: 'process_propose',
    group: 'itsas',
    description:
      'Propose a change to a process (S-1085): the whole new processes/ID.yaml. The YAML is checked as a process file; a branch, a pull request and a proposal ITSA in needs_approval are made (as you). Nothing changes until your user approves the proposal and the PR merges; you cannot approve it yourself. base is required: the exact text of the file you started from (empty for a new process); the proposal is refused (409) if the process on main has changed since. Returns the ITSA key and the PR url.',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        id: { type: 'string', description: 'The process id (the file name without .yaml).' },
        yaml: { type: 'string', description: 'The full new file text.' },
        summary: { type: 'string', description: 'What the change does and why.' },
        base: { type: 'string', description: 'The exact file text you edited from (empty string for a new process). Refused with 409 when main has a different copy.' },
      },
      required: ['id', 'yaml', 'summary', 'base'],
    },
    run: async (a) => {
      if (typeof a.base !== 'string') throw new Error('Pass base: the exact text of the process file you edited from (an empty string for a new process), so a newer change is not overwritten.');
      const r = await api<any>('POST', `/api/processes/${encodeURIComponent(String(a.id ?? ''))}/proposal`, { yaml: a.yaml, summary: a.summary, base: a.base, by: me(a) });
      return text(`Proposed ${a.id}: ${r.key} is waiting for your user's approval. PR #${r.pr.number}: ${r.pr.url}`);
    },
  },
  {
    name: 'pr_view',
    group: 'itsas',
    description:
      'Read a pull request, from any machine (S-3107): its title, state, base and head branches, the full head sha, its merge base with the base branch and the one git diff for the PR (S-3751), its body, the files changed with their +/- counts, and its checks and commit statuses (stam/review included). It runs on the ITSA home, where gh is, so you need no GitHub login. Read-only apart from refreshing storage\'s PR head mirror when it lags. pr is a number (in the home\'s default repo) or OWNER/REPO#N in a repo of settings.itsa.repos.',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        pr: { type: ['string', 'number'], description: 'The PR number, or OWNER/REPO#N.' },
      },
      required: ['pr'],
    },
    run: async (a) => {
      // Longer than the home's peer wait (pr-view.ts VIEW_PEER_MS), so the caller doesn't give up first.
      const r = await api<any>('POST', '/api/pr/view', { pr: a.pr, by: me(a) }, 180_000);
      const files = r.files.map((f: any) => `  ${f.path} +${f.additions} -${f.deletions}`);
      const checks = r.checks.map((c: any) => `  ${c.name}: ${c.state}`);
      return text([
        `PR #${r.number} in ${r.repo}: ${r.title}`,
        `${r.url}`,
        `State ${r.state}. Base ${r.base}, head ${r.head_branch} at ${r.head}.`,
        ...(r.merge_base ? [`Merge base ${r.merge_base}.`, `Diff: ${r.diff}`] : []),
        `Files (${r.files.length}):`,
        ...(files.length ? files : ['  none']),
        `Checks (${r.checks.length}):`,
        ...(checks.length ? checks : ['  none']),
        'Body:',
        r.body,
      ].join('\n'));
    },
  },
  {
    name: 'pr_review',
    group: 'itsas',
    description:
      'Give your verdict on a PR (S-1061), from any machine: a comment, "Review (YOU): approve|request_changes. SUMMARY", and the stam/review status on the PR\'s head, which merge-pr.mjs reads. It runs on the ITSA home, where gh is, as you: the reviewer is your own agent, never a name you pass. head is the full sha of the commit you reviewed; the verdict is refused (409) when the PR\'s head has moved since, so review the new head again.',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        pr: { type: 'number', description: 'The PR number.' },
        verdict: { type: 'string', enum: ['approve', 'request_changes'], description: 'Your verdict.' },
        summary: { type: 'string', description: 'One line: why.' },
        head: { type: 'string', description: 'The sha of the commit you reviewed: the full 40 characters, or a unique prefix of at least 7. The status is posted on the PR\'s full head.' },
      },
      required: ['pr', 'verdict', 'summary', 'head'],
    },
    run: async (a) => {
      // Longer than the home's peer wait (pr-review.ts forwardMs), so this call doesn't give up before the home answers (S-2631).
      let r: any;
      try {
        r = await api<any>('POST', '/api/pr/review', { pr: a.pr, verdict: a.verdict, summary: a.summary, head: a.head, by: me(a) }, 190_000);
      } catch (e: any) {
        // No HTTP answer at all: the call timed out or the connection dropped, so the verdict may be posted (S-2631).
        if (e?.status === undefined) throw new Error(unconfirmedVerdict(a.pr, 'this daemon timed out or lost its connection'));
        throw e;
      }
      return text(`Posted ${r.verdict} on PR #${r.pr} at ${String(r.head).slice(0, 7)}: ${r.line}`);
    },
  },
  {
    name: 'subscribe',
    description:
      'Ask to be told about external events (GitHub, Linear, Slack, and other sources): each matching event arrives as a notice while you work, or as mail from stam when you are idle. Filter by source, subjects (glob patterns over keys like `github:OWNER/REPO#12`, `github:OWNER/*`, `linear:TEAM-123`, `slack:CHANNEL`), types (glob patterns like `pull_request.*`), actors, and exclude_actors. By default you subscribe yourself; pass `itsa` to notify an ITSA\'s thread instead, or `for` another agent in your tree (an ITSA you take part in, or the human, if allowed). Events close in time arrive as one message. Returns a subscription id for unsubscribe.',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        source: { type: 'string', description: 'Only this source, for example github.' },
        subjects: { type: 'array', items: { type: 'string' }, description: 'Subject glob patterns; * matches within one segment.' },
        types: { type: 'array', items: { type: 'string' }, description: 'Event type glob patterns, for example pull_request.*.' },
        actors: { type: 'array', items: { type: 'string' }, description: 'Only events by these actors.' },
        exclude_actors: { type: 'array', items: { type: 'string' }, description: 'Skip events by these actors.' },
        itsa: { type: 'string', description: 'Subscribe an ITSA (id or key): matching events post into its thread instead.' },
        for: { type: 'string', description: 'Subscribe another agent (id or name) in your tree, or "human". Defaults to you.' },
        note: { type: 'string', description: 'A short label carried in the deliveries.' },
        expires_in_minutes: { type: 'number', description: 'Let the subscription expire after this many minutes.' },
      },
    },
    group: 'events',
    run: async (a) => {
      const by = me(a);
      const r = await api<any>('POST', '/api/subscriptions', {
        subscriber_kind: a.itsa ? 'itsa' : a.for === 'human' ? 'human' : 'agent',
        subscriber_id: a.itsa ?? (a.for === 'human' ? 'human' : a.for ?? by),
        filter: { source: a.source, subjects: a.subjects, types: a.types, actors: a.actors, exclude_actors: a.exclude_actors },
        note: a.note,
        expires_in_minutes: a.expires_in_minutes,
        by,
      });
      return text(`Subscribed (${r.id}): ${a.itsa ? `ITSA ${a.itsa}` : a.for === 'human' ? 'the human' : a.for ?? 'you'} hears about matching events.`);
    },
  },
  {
    name: 'unsubscribe',
    description: 'Remove one of your event subscriptions (or one you created) by its id, from subscribe or list_subscriptions.',
    inputSchema: { type: 'object', properties: { self, id: { type: 'string', description: 'The subscription id.' } }, required: ['id'] },
    group: 'events',
    run: async (a) => {
      await api('DELETE', `/api/subscriptions/${encodeURIComponent(a.id)}`, { by: me(a) });
      return text(`Removed subscription ${a.id}.`);
    },
  },
  {
    name: 'list_subscriptions',
    description: 'List event subscriptions you made or that name you as the subscriber: id, subscriber, filter, note, and expiry.',
    inputSchema: { type: 'object', properties: { self } },
    group: 'events',
    run: async (a) => {
      const subs = await api<any[]>('GET', `/api/subscriptions?by=${encodeURIComponent(me(a))}`);
      if (!subs.length) return text('No event subscriptions.');
      const describe = (f: any) => Object.entries(f ?? {}).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`).join(' ') || 'any events';
      return text(
        subs
          .map((s) => `${s.id}  ${s.subscriber_kind}:${s.subscriber_id}  ${describe(s.filter)}${s.note ? `  (${s.note})` : ''}${s.expires_at ? `  expires ${new Date(s.expires_at).toISOString()}` : ''}`)
          .join('\n'),
      );
    },
  },

  {
    name: 'watch_pr',
    description:
      'Watch a pull request: its checks, reviews, comments, pushes, and merge or close reach you as they happen, as notices while you work or as mail when you are idle. pr is a number (in the default repo of the ITSA home: settings.itsa.prOpen.github there, else its origin), OWNER/REPO#N, or a PR url. events narrows what you hear: checks, reviews, comments, pushes, merged, closed (default all). A merge or close always ends the watch, and is always delivered. To wait for CI, use wait_for on event with subject github:OWNER/REPO#N and type checks.completed. Watching again replaces the earlier watch. Pass for to watch on another agent\'s behalf.',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        pr: { type: ['string', 'number'], description: 'The PR number, OWNER/REPO#N, or its url.' },
        events: { type: 'array', items: { type: 'string', enum: Object.keys(PR_EVENT_PRESETS) }, description: 'What to hear: checks, reviews, comments, pushes, merged, closed. Default all.' },
        for: { type: 'string', description: 'Watch for another agent (id) in your tree, or "human". Defaults to you.' },
      },
      required: ['pr'],
    },
    group: 'events',
    run: async (a) => {
      const by = me(a);
      const { key, number } = await prSubject(a.pr);
      const types = [...new Set([...(a.events?.length ? a.events : Object.keys(PR_EVENT_PRESETS)).map((e: string) => presetType(e)), ...PR_END_TYPES])];
      // Create first: the daemon resolves `for` (an id or a name) and refuses one it can't, so a
      // refused watch leaves the earlier one in place. Then the earlier watch on this PR goes.
      const r = await api<any>('POST', '/api/subscriptions', {
        subscriber_kind: a.for === 'human' ? 'human' : 'agent',
        subscriber_id: a.for === 'human' ? 'human' : (a.for ?? by),
        filter: { source: 'github', subjects: [key], types, ends_on: PR_END_TYPES, since: new Date().toISOString() },
        note: `PR #${number} watch`,
        by,
      });
      await dropPrWatches(r.subscriber_id, key, by, r.id);
      return text(`Watching PR #${number} (${key}): ${types.map((t) => t.replace(/^pull_request\./, '')).join(', ')}. A merge or close ends the watch.`);
    },
  },
  {
    name: 'unwatch_pr',
    description: 'Stop watching a pull request you watch with watch_pr. pr is as watch_pr takes it.',
    inputSchema: { type: 'object', properties: { self, pr: { type: ['string', 'number'], description: 'The PR number, OWNER/REPO#N, or its url.' }, for: { type: 'string', description: 'The agent (id) or "human" you watched for, if not you.' } }, required: ['pr'] },
    group: 'events',
    run: async (a) => {
      const { key, number } = await prSubject(a.pr);
      const n = await dropPrWatches(a.for === 'human' ? 'human' : (a.for ?? me(a)), key, me(a), undefined);
      return text(n ? `Stopped watching PR #${number}.` : `No watch on PR #${number}.`);
    },
  },

  {
    name: 'layout_get',
    group: 'layout',
    description:
      'Read the human\'s web layout: each world\'s panes as an indented tree (tabs, which tab is active, which pane is focused), then the raw layout JSON with its version. Read it before you arrange anything. Use layout_arrange only when the human asked you to arrange their screen.',
    inputSchema: { type: 'object', properties: { self } },
    run: async () => layoutText(await api('GET', '/api/layout')),
  },
  {
    name: 'layout_arrange',
    group: 'layout',
    description:
      'Arrange the human\'s web layout (panes and tabs) with a batch of ops, applied all or none. Act only when the human asked you to arrange their screen (for example "open my usage page beside this agent"); never rearrange it on your own initiative. Read the layout first with layout_get, and pass its version as base so a change made meanwhile is refused (409) rather than overwritten. Tab keys name views: agent:ID (an agent\'s terminal), view:ID (stam\'s own conversation view of an agent), details:ID, instructions:ID, mail:ID (mail:human is the human\'s inbox), thread:ID (a mail thread), itsa:ID (an ITSA), board:ID or board:all (ITSA boards), shell:MACHINE:ID, config (Settings), usage. World: "main" is the layout\'s current world (or home when none is current): the world an agent last sent the human to, not necessarily what each device shows, since the human\'s own navigation stays on that device. A current op moves every device to its world; other worlds are named as the layout names them (agent IDs, t:THREAD, w:config, w:usage, w:itsa:ID). Returns the new layout as layout_get does. An invalid op or a stale base returns the error and changes nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        self,
        base: { type: 'integer', description: 'The layout version you read with layout_get. A different current version is refused.' },
        ops: {
          type: 'array',
          description: 'Applied in order.',
          items: {
            oneOf: [
              { type: 'object', description: 'open: show a tab in a world; splits beside pane, or adds to it. Opens in the background when background is true.', required: ['op', 'world', 'key'], properties: { op: { const: 'open' }, world: { type: 'string' }, key: { type: 'string', description: 'A tab key such as agent:ID.' }, pane: { type: 'string', description: 'Pane to put it in (default: the focused pane).' }, split: { enum: ['right', 'left', 'down', 'up'], description: 'Make a new pane beside the pane, on this side.' }, background: { type: 'boolean' } }, additionalProperties: false },
              { type: 'object', description: 'close: remove a tab from its pane; an empty pane goes.', required: ['op', 'world', 'key'], properties: { op: { const: 'close' }, world: { type: 'string' }, key: { type: 'string' } }, additionalProperties: false },
              { type: 'object', description: 'swap: show a tab in place of another, in the same pane and place (an agent\'s terminal agent:ID and stam\'s view of it view:ID trade places); with, open elsewhere in the world, moves there.', required: ['op', 'world', 'key', 'with'], properties: { op: { const: 'swap' }, world: { type: 'string' }, key: { type: 'string' }, with: { type: 'string' } }, additionalProperties: false },
              { type: 'object', description: 'move: move a tab to a pane, before a tab, or to a new pane on a side.', required: ['op', 'world', 'key', 'to'], properties: { op: { const: 'move' }, world: { type: 'string' }, key: { type: 'string' }, to: { type: 'string', description: 'Target pane id.' }, before: { type: ['string', 'null'], description: 'Tab key to put it before.' }, side: { enum: ['right', 'left', 'down', 'up'] } }, additionalProperties: false },
              { type: 'object', description: 'split: make an empty pane beside a pane (or move its active tab into the new pane when it has several).', required: ['op', 'world', 'pane', 'side'], properties: { op: { const: 'split' }, world: { type: 'string' }, pane: { type: 'string' }, side: { enum: ['right', 'left', 'down', 'up'] } }, additionalProperties: false },
              { type: 'object', description: 'closePane: close a pane; its tabs join a neighbour.', required: ['op', 'world', 'pane'], properties: { op: { const: 'closePane' }, world: { type: 'string' }, pane: { type: 'string' } }, additionalProperties: false },
              { type: 'object', description: 'activate: make a tab the active one in its pane.', required: ['op', 'world', 'pane', 'key'], properties: { op: { const: 'activate' }, world: { type: 'string' }, pane: { type: 'string' }, key: { type: 'string' } }, additionalProperties: false },
              { type: 'object', description: 'focus: make a pane the focused one.', required: ['op', 'world', 'pane'], properties: { op: { const: 'focus' }, world: { type: 'string' }, pane: { type: 'string' } }, additionalProperties: false },
              { type: 'object', description: 'tabBar: show or hide a pane\'s tab bar.', required: ['op', 'world', 'pane', 'on'], properties: { op: { const: 'tabBar' }, world: { type: 'string' }, pane: { type: 'string' }, on: { type: 'boolean' } }, additionalProperties: false },
              { type: 'object', description: 'setRoot: replace a world\'s whole pane tree. root is a pane or a split node (id, split row|col, children, sizes; a pane has id, tabs, active).', required: ['op', 'world', 'root'], properties: { op: { const: 'setRoot' }, world: { type: 'string' }, root: { type: 'object' }, focusKey: { type: 'string', description: 'Focus the pane holding this tab.' } }, additionalProperties: false },
              { type: 'object', description: 'current: send the human to a world: every device switches to it, and it becomes the one "main" names; null for home.', required: ['op', 'world'], properties: { op: { const: 'current' }, world: { type: ['string', 'null'] } }, additionalProperties: false },
            ],
          },
        },
      },
      required: ['ops'],
    },
    run: async (a) => {
      const r = await api('POST', '/api/layout/ops', { ops: a.ops, base: a.base, by: me(a) });
      return layoutText(r);
    },
  },
];
// Test-only (S-2596): tools a test home's test-faults.json adds to this release (src/test-faults.ts).
for (const t of extraTools()) {
  tools.push({ name: t.name, group: t.group as Tool['group'], description: t.description, inputSchema: { type: 'object', properties: {} }, run: async () => text(t.text) });
}

// The MCP tool catalogue, for the human's Settings › Tools view and for the decision-steps
// UI that will pick a trigger from it. The daemon serves it at GET /api/tools; importing
// this module does not start the MCP server (only `runMcp` does). Shape, kept stable:
//   { groups: [{ name, tools: [{ name, description, inputSchema }] }], harnessTools: { note } }
export function toolCatalog(opts: { requirements?: boolean } = {}): {
  groups: { name: string; tools: { name: string; description: string; inputSchema: any }[] }[];
  harnessTools: { note: string };
} {
  return {
    groups: TOOL_GROUPS.map((g) => ({
      name: g.name,
      tools: tools.filter((t) => t.group === g.key && (t.when !== 'requirements' || opts.requirements)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    })).filter((g) => g.tools.length > 0),
    harnessTools: {
      note:
        "Tools a harness gives its own agents — Claude Code's Bash, Edit, Write, and Read, Codex's shell and patches, OpenCode's tools — are not listed yet. They could be added later through harness hooks, for example Claude Code's PreToolUse.",
    },
  };
}

// Run one tool by name, as a tools/call would, without the decision-step check (tests call it).
// pr_open's wait for the daemon: longer than the push it makes on this machine plus the home's whole call (pr-open.ts
// PR_OPEN_PEER_MS), so a slow storage fetch doesn't end the wait while the PR is still being made (S-1332).
const PR_OPEN_CALL_MS = 360_000;
// pr_open's parameters (S-2677): any other key is refused by name, so a misspelt one (body-file) isn't taken as no body.
const PR_OPEN_PARAMS = ['self', 'branch', 'predict', 'title', 'body', 'body_file', 'itsa'];

// Whether a call gave up waiting (the client's or a peer's timeout), not a refusal.
const isTimeout = (e: unknown): boolean => e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError' || /aborted due to timeout/.test(e.message));

// What a timed-out pr_open left on GitHub (S-1332), so the caller doesn't guess. Asking again is safe: pr_open reuses the
// open PR on the branch and replaces only its body, so a retry never double-creates.
async function prOpenTimedOut(a: any, by: string, e: unknown): Promise<string> {
  const why = e instanceof Error ? e.message : String(e);
  const again = 'pr_open is safe to run again: it reuses the open PR on the branch';
  try {
    const s = await api<any>('POST', '/api/pr/open-status', { branch: a.branch, body: a.body, itsa: a.itsa, by }, 30_000);
    if (!s.found) return `pr_open timed out (${why}); no open PR is on ${a.branch} yet. ${again}.`;
    const yes = (ok: boolean | null) => (ok === null ? 'n/a' : ok ? 'written' : 'NOT written: run pr_open again');
    return `pr_open timed out (${why}), but PR #${s.number} is open on ${s.branch}: ${s.url}\nhead ${s.head}; body ${yes(s.body_written)}; ITSA link ${yes(s.itsa_linked)}.`;
  } catch (s) {
    return `pr_open timed out (${why}), and the status lookup failed too (${s instanceof Error ? s.message : s}). Check GitHub for an open PR on ${a.branch} before you run pr_open again; ${again}.`;
  }
}

export async function callTool(name: string, args: any): Promise<unknown> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`unknown tool ${name}`);
  return tool.run(args);
}

// The decision steps' check of a tool call, before it runs. A refusal from the daemon (a 403: this
// caller may not check as that agent) withholds the call: enforcement fails closed (S-233 review).
// A check that fails another way (daemon down or timeout, bad reply, other status) lets the tool
// run and says so on stderr, as before: enforcement fails open. A caller with no id (before
// `register`) has no steps to check against, so its calls run unchecked.
async function checkStep(tool: string, args: any, selfArg?: string): Promise<{ allow: boolean; error?: string } | null> {
  const agent = agentId ?? selfArg;
  if (!agent) return null;
  try {
    const r = await api('POST', '/api/steps/check', { agent, tool, args }, 8_000);
    if (typeof r?.allow !== 'boolean') throw new Error('no verdict in the reply');
    return r;
  } catch (e) {
    if ((e as { status?: number }).status === 403) return { allow: false, error: `Refused: decision steps can't check ${tool}: ${e instanceof Error ? e.message : e}` };
    process.stderr.write(`stam: decision steps could not check ${tool}, running it anyway: ${e instanceof Error ? e.message : e}\n`);
    return null;
  }
}

// The harness keeps this process for the agent's whole life, but a deploy moves
// releases/current. Before each tools/list and tools/call, and when the stream reconnects
// (the daemon restarts on deploy), a server running from a release loads the tools of the
// one now current and tells the harness the list changed (S-178). A checkout doesn't follow.
const realOrNull = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};
let live = tools;
const ownRoot = realOrNull(ROOT);
let liveRoot = ownRoot && dirname(ownRoot) === realOrNull(RELEASES) ? ownRoot : null;
let following: Promise<void> | undefined;
// Whether the loaded release takes over a session across an exec (reexecWhenIdle, S-811).
let liveAdopts = false;
// A release whose tools didn't load is tried again, after 1 s, then twice as long each
// time up to a minute; the query makes Node import mcp.ts afresh rather than repeat the
// failure. A module it imports that failed stays cached, but no deploy shows a half-copied
// release: `stam deploy` builds and checks it in releases/.build-*, renames it into place
// whole, and only then swaps the `current` symlink by rename (deploy.ts).
let failed: { root: string; tries: number; at: number } | undefined;
const retryDelay = (tries: number) => Math.min(1000 * 2 ** (tries - 1), 60_000);
async function followDeploys(): Promise<void> {
  if (!liveRoot) return;
  const current = realOrNull(join(RELEASES, 'current'));
  if (!current || current === liveRoot) return;
  if (failed?.root === current && Date.now() < failed.at + retryDelay(failed.tries)) return;
  following ??= (async () => {
    try {
      const url = pathToFileURL(join(current, 'src', 'mcp.ts')).href + (failed?.root === current ? `?try=${failed.tries}` : '');
      const mod = await import(url);
      if (!Array.isArray(mod.tools)) throw new Error('it exports no tools');
      live = mod.tools;
      liveRoot = current;
      liveAdopts = mod.ADOPTS_SESSION === 1;
      failed = undefined;
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    } catch (e) {
      failed = { root: current, tries: failed?.root === current ? failed.tries + 1 : 1, at: Date.now() };
      process.stderr.write(`stam: keeping the tools of ${liveRoot}; release ${current} didn't load (try ${failed.tries}): ${e instanceof Error ? e.message : e}\n`);
    } finally {
      following = undefined;
    }
  })();
  await following;
}

// Server-sent events from the daemon become channel notifications. Reconnects forever,
// so a daemon restart doesn't cut the agent off.
let streaming = false;
// The part of an event read but not yet complete; a re-exec waits until it is empty.
let eventBuf = '';
async function startStream() {
  if (streaming || !agentId) return;
  streaming = true;
  for (;;) {
    try {
      const res = await fetch(`${STAM_URL}/api/agents/${agentId}/stream`, { headers: { authorization: `Bearer ${readToken() ?? ''}` } });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await followDeploys();
      reexecWhenIdle();
      eventBuf = '';
      for await (const chunk of res.body as any) {
        eventBuf += Buffer.from(chunk).toString('utf8');
        let i;
        while ((i = eventBuf.indexOf('\n\n')) >= 0) {
          const block = eventBuf.slice(0, i);
          eventBuf = eventBuf.slice(i + 2);
          const data = block
            .split('\n')
            .filter((l) => l.startsWith('data: '))
            .map((l) => l.slice(6))
            .join('\n');
          if (!data) continue;
          const { content, meta } = JSON.parse(data);
          send({ jsonrpc: '2.0', method: 'notifications/claude/channel', params: { content, meta } });
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// The MCP session this process took over from the release it re-exec'd from: the harness sent
// `initialize` once, to that process, and won't again (S-811).
const SESSION_ENV = 'STAM_MCP_SESSION';
let session: { protocolVersion: string; capabilities?: unknown; clientInfo?: unknown } | undefined;

async function handle(m: any) {
  if (m.method === 'initialize') {
    session = { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: m.params?.capabilities, clientInfo: m.params?.clientInfo };
    send({
      jsonrpc: '2.0',
      id: m.id,
      result: {
        protocolVersion: session.protocolVersion,
        capabilities: { tools: { listChanged: true }, experimental: { 'claude/channel': {} } },
        serverInfo: { name: 'stam', version: '0.1.0' },
        instructions: template('mcp-instructions'),
      },
    });
    startStream();
  } else if (m.method === 'tools/list') {
    await followDeploys();
    // Tools that need a feature are listed only while it is on; the daemon says (a failed ask hides them).
    const reqOn = live.some((t) => t.when === 'requirements') ? await api<any>('GET', '/api/req-enabled').then((r) => r?.enabled === true, () => false) : false;
    send({ jsonrpc: '2.0', id: m.id, result: { tools: live.filter((t) => t.when !== 'requirements' || reqOn).map(({ run, when, ...t }) => t) } });
  } else if (m.method === 'tools/call') {
    await followDeploys();
    const tool = live.find((t) => t.name === m.params?.name);
    try {
      if (!tool) throw new Error(`unknown tool ${m.params?.name}`);
      const args = m.params.arguments ?? {};
      tool.validate?.(args);
      const check = await checkStep(tool.name, args, m.params.arguments?.self);
      if (check && !check.allow) send({ jsonrpc: '2.0', id: m.id, result: { ...text(check.error ?? `Denied by a decision step: ${tool.name}`), isError: true } });
      else send({ jsonrpc: '2.0', id: m.id, result: await tool.run(args) });
    } catch (e) {
      send({ jsonrpc: '2.0', id: m.id, result: { ...text(`Error: ${e instanceof Error ? e.message : e}`), isError: true } });
    }
  } else if (m.id !== undefined && m.method) {
    send({ jsonrpc: '2.0', id: m.id, result: {} });
  }
}

// followDeploys serves a newer release's tools, but this process still runs, and so pins, the
// release it started from. Once `current` has moved and that release's tools have loaded here,
// the server replaces itself with `current`'s at its next idle point (S-811): no request being
// handled, no partial line read from stdin, no partial event from the daemon, nothing left to
// write. The exec keeps the pid and stdin/stdout, so the harness sees the same server; the
// session (agent id and token, the initialize it got, the read acknowledgements) crosses in the
// environment. Checked after each request and every STAM_MCP_REEXEC_MS (default a minute).
// An exec can't be undone, so it goes only to a release that says it adopts a session
// (ADOPTS_SESSION; an older one would wait for an initialize that never comes, and its channel
// would stay silent), and only once that release's server, started as a canary with the
// session, has answered a tools/list. A canary that fails is tried again with backoff.
export const ADOPTS_SESSION = 1;
const CANARY_ENV = 'STAM_MCP_CANARY';
let inflight = 0;
let stdinBuf = '';
let reexecing: Promise<void> | undefined;
let canaryFailed: { root: string; tries: number; at: number } | undefined;
let warnedNoAdopt: string | undefined;
const idle = () => inflight === 0 && stdinBuf === '' && eventBuf === '' && process.stdin.readableLength === 0 && process.stdout.writableLength === 0;
function reexecWhenIdle(): Promise<void> {
  // Assigned before it can settle: the checks below may finish without awaiting anything.
  return (reexecing ??= reexec().finally(() => (reexecing = undefined)));
}

// Starts `bin mcp` with the session, as the exec would, and resolves whether it answers a
// tools/list with tools within STAM_MCP_CANARY_MS (default 10 s). The canary doesn't open the
// agent's stream, so the daemon never sees two servers for one agent.
function canary(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const env = { ...process.env, [SESSION_ENV]: JSON.stringify(session), [CANARY_ENV]: '1' };
    const child = spawn(bin, ['mcp'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    const done = (ok: boolean) => {
      clearTimeout(timer);
      child.kill();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), Number(envVar('MCP_CANARY_MS')) || 10_000);
    child.on('error', () => done(false));
    child.on('exit', () => done(false));
    child.stdout.on('data', (d) => {
      out += d;
      // Whole lines only: the answer is larger than a pipe chunk, so its first read is a half line.
      const line = out.split('\n').slice(0, -1).find((l) => l.includes('"id":"canary"'));
      if (!line) return;
      try {
        done((JSON.parse(line).result?.tools?.length ?? 0) > 0);
      } catch {
        done(false);
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'canary', method: 'tools/list', params: {} }) + '\n');
  });
}

async function reexec(): Promise<void> {
  try {
    if (!ownRoot || !liveRoot || typeof process.execve !== 'function' || !session || !idle()) return;
    const current = realOrNull(join(RELEASES, 'current'));
    if (!current || current === ownRoot) return;
    if (canaryFailed?.root === current && Date.now() < canaryFailed.at + retryDelay(canaryFailed.tries)) return;
    // The new release must load before this process gives itself up to it.
    await followDeploys();
    const bin = join(current, 'bin', 'stam');
    if (liveRoot !== current || !existsSync(bin)) return;
    if (!liveAdopts) {
      if (warnedNoAdopt !== current) process.stderr.write(`stam: staying on ${ownRoot}: ${current} doesn't adopt a running session\n`);
      warnedNoAdopt = current;
      return;
    }
    if (!(await canary(bin))) {
      canaryFailed = { root: current, tries: canaryFailed?.root === current ? canaryFailed.tries + 1 : 1, at: Date.now() };
      process.stderr.write(`stam: staying on ${ownRoot}: ${current}'s MCP server didn't answer (try ${canaryFailed.tries})\n`);
      return;
    }
    canaryFailed = undefined;
    // Let anything already read from stdin or the stream reach its handler first.
    await new Promise((r) => setImmediate(r));
    if (!idle() || realOrNull(join(RELEASES, 'current')) !== current) return;
    process.stderr.write(`stam: MCP server moving from ${ownRoot} to ${current}\n`);
    process.execve!(bin, [bin, 'mcp'], { ...process.env, [SESSION_ENV]: JSON.stringify(session) });
  } catch (e) {
    process.stderr.write(`stam: staying on ${ownRoot}: ${e instanceof Error ? e.message : e}\n`);
  }
}

export function runMcp(): void {
  // A canary (see canary) answers and is killed; it never streams or moves on.
  const isCanary = !!process.env[CANARY_ENV];
  delete process.env[CANARY_ENV];
  // Taking over a session from the process this one replaced: no initialize will come.
  if (process.env[SESSION_ENV]) {
    try {
      session = JSON.parse(process.env[SESSION_ENV]!);
    } catch {}
    delete process.env[SESSION_ENV];
    if (session && !isCanary) {
      startStream();
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    }
  }
  process.stdin.on('data', (d) => {
    stdinBuf += d;
    let i;
    while ((i = stdinBuf.indexOf('\n')) >= 0) {
      const line = stdinBuf.slice(0, i);
      stdinBuf = stdinBuf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      inflight++;
      handle(msg).finally(() => {
        if (--inflight === 0 && !isCanary) reexecWhenIdle();
      });
    }
  });
  process.stdin.on('end', () => process.exit(0));
  if (liveRoot && !isCanary) setInterval(reexecWhenIdle, Number(envVar('MCP_REEXEC_MS')) || 60_000).unref();
}
