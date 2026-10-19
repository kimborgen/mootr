import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync, renameSync, statSync, chmodSync } from 'node:fs';
import { MACHINE, ROOT, STAM_HOME } from './config.ts';
import { validate, noteInvalid, retryNotices } from './accounts.ts';
import type { McpServer } from './instructions.ts';

// Cost policy (docs/cost-policy.md): which provider login or key agents bill to, and what
// happens at a limit. Config only for now (build step 2); nothing enforces it yet.
// A budget caps paid dollars per period; "cap" lasts until the human raises it.
export interface CostBudget {
  usd: number;
  per: 'day' | 'week' | 'month' | 'cap';
  raiseSteps?: number[];
}
// A known action name, or take-over with its targets and the action when none is eligible.
export type CostAction = string | { action: string; to?: string[]; else?: string; askRaise?: boolean };
// One provider login or key. match picks the agents that bill here, by harness and an
// optional model prefix; an agent that matches none is unmanaged.
// The cost account stam's own model calls bill to (see accounts.ts isOpenRouter). Defined here, a
// leaf module, so decide.ts and accounts.ts can both use it without an import cycle.
export const SYSTEM_ACCOUNT = 'openrouter-system';

export interface CostAccount {
  match: { harness: string; model?: string };
  // false means extra usage is turned off in the harness.
  subscription?: boolean;
  paid?: boolean;
  warnPercent?: number[];
  budget?: CostBudget | null;
  lowCreditsUsd?: number;
  onBillingUnknown?: CostAction;
  onSubExhausted?: CostAction;
  onBudgetExhausted?: CostAction;
  onCreditsOut?: CostAction;
  // Overrides cost.onError for this account's provider errors.
  onError?: CostAction;
}
// All paid spend on the machine: one budget, and what subscription work does once it's spent.
export interface CostGlobal {
  budget?: CostBudget | null;
  onExhausted?: string;
  subscriptionWork?: 'continue' | 'stop';
}
export interface CostConfig {
  subscriptionWarnPercent: number[];
  dailyWarnUsd: number | null;
  global: CostGlobal | null;
  accounts: Record<string, CostAccount>;
  onError: CostAction;
  // The user's free-text cost instructions: how the agents who manage cost should manage
  // it. Empty means no Cost section is added to any agent (docs/cost-policy.md).
  instructions?: string;
  // How long a cost notice waits for its manager before the account's fallback runs.
  fallbackMinutes?: number;
  // How long cost_switch lets a working agent finish its step before it interrupts it.
  softStopMinutes?: number;
  display?: { mode: 'api' | 'five_hour' | 'seven_day' | 'subscription'; prices: Record<string, number> };
}

// The tree check's interval is clamped to this range (hours).
export const TREE_CHECK_MIN_HOURS = 0.25;
export const TREE_CHECK_MAX_HOURS = 168;

// User settings live in STAM_HOME/settings.json; the daemon writes the defaults there on
// first start so they are visible and editable. Missing keys fall back to the defaults.
export const DEFAULTS = {
  // The machine that holds the settings every other daemon reads a cached copy of (S-380); null
  // means this one. Falls back to itsa.home, which names the same machine until the two are split.
  home: null as string | null,
  context: {
    // Announce each threshold once; enforcement compacts the agent when its turn ends.
    warnTokens: 300_000,
    instructTokens: 400_000,
    enforceTokens: 500_000,
  },
  idleCompaction: {
    // Prompt caches expire after about 5 minutes or 1 hour; compact before the 1-hour mark.
    enabled: true,
    idleMinutes: 55,
    // Compact when the context is this much above its size after the last compaction,
    // or above the average size after compaction over the last 5 days, or else above minTokens.
    // The context thresholds also count only once an agent has grown this much since its
    // last compaction, so one whose summary is above a threshold isn't compacted every turn.
    growthTokens: 50_000,
    minTokens: 100_000,
  },
  // A harness that exits at or above percentOfWindow of its context window is resumed once, to
  // compact first (S-220). The registry has no windows yet, so windowTokens applies to every model.
  // A second exit within repeatMinutes isn't resumed again; the parent hears either way.
  // A standing agent idle this many hours rests (lifecycle.restSweep); mail, a wake_me or an assigned ITSA wakes it. May be fractional.
  // Growth (S-920): a standing agent over any threshold is told to propose helpers, a split or a team (standing-growth.ts).
  // openItsas: ITSAs it owns in ready or active; leadHours: median lead time of its last ten closed; contextPct: context size as a percent of the compaction threshold.
  standing: { idleHours: 4, growth: { enabled: true, openItsas: 8, leadHours: 48, contextPct: 80 } },
  exitRecovery: { percentOfWindow: 85, windowTokens: 350_000, repeatMinutes: 5 },
  // Harness menus that pop up over an idle agent's input and block delivery. When one is
  // on screen, stam sends these keys. Escape cancels a menu without touching a draft.
  banners: [
    { harness: 'claude', match: 'Teach auto mode about your environment\\?', keys: ['Escape'] },
  ] as { harness: string; match: string; keys: string[] }[],
  cost: {
    // Mail the human when a subscription window (such as Claude's 5-hour and weekly
    // limits) crosses each of these percentages.
    subscriptionWarnPercent: [80, 95],
    // Mail the human when today's spend across agents passes this many dollars; null: never.
    dailyWarnUsd: null as number | null,
    // Mail the human once per top-up when OpenRouter's remaining credit drops below this
    // many dollars; null: never.
    openrouterWarnUsd: 2 as number | null,
    // Dollars of the shared OpenRouter credit kept for stam's own model calls when the system
    // account (openrouter-system) has no budget; with one, its unspent part is the reserve.
    // Agents on OpenRouter are held once the remaining credit falls to the reserve.
    openrouterSystemReserveUsd: 1 as number,
    // No accounts by default: every agent is unmanaged and behaves as today.
    global: null as CostGlobal | null,
    accounts: {} as Record<string, CostAccount>,
    onError: 'soft-stop' as CostAction,
    // The user's free-text cost instructions: the chief of staff and managers follow it
    // (docs/cost-policy.md). Empty: no Cost section is added anywhere.
    instructions: '' as string,
    // Minutes a cost notice waits for its manager before the account's fallback runs.
    fallbackMinutes: 15 as number,
    // Minutes cost_switch lets a working agent finish its step and write HANDOVER.md
    // before it interrupts the turn.
    softStopMinutes: 10 as number,
    // How cost is shown (src/cost-display.ts): mode api | five_hour | seven_day | subscription, and
    // the subscription price per account in USD per month, e.g. { "claude-max": 200 }.
    display: { mode: 'api', prices: {} } as { mode: 'api' | 'five_hour' | 'seven_day' | 'subscription'; prices: Record<string, number> },
  },
  // MCP servers added to every agent, in Claude Code's format: a stdio server
  // { "name": { "command": "...", "args": [], "env": {} } }, a remote one
  // { "name": { "url": "...", "headers": {} } }; "enabled": false keeps it out of every
  // harness. The type lives in instructions.ts (McpServer), the form all harnesses share.
  mcpServers: {} as Record<string, McpServer>,
  // The decision model (src/decide.ts): a cheap call to microsoft/microsoft-decision-1
  // through OpenRouter that answers a fixed question about a piece of state. `model` is the
  // model id; `mailCheck` (Settings › Mail to you) asks it, on each mail to the human,
  // whether the mail follows the rules in templates/mail-to-human.md. `mailGate` (S-983) runs
  // that check before an agent's mail to the human is stored: a fail refuses the send, and the
  // agent resends with `override` to send anyway. A mail the gate checked isn't checked again.
  // `suggestRescore` (S-1465) rescores the prompt suggestions with the same model (src/suggest-rescore.ts).
  decisions: {
    model: 'microsoft/microsoft-decision-1',
    mailCheck: true,
    mailGate: true,
    suggestRescore: false,
  } as { model: string; mailCheck: boolean; mailGate: boolean; suggestRescore: boolean },
  // Mail titles (src/mail-title.ts): `model` is an OpenRouter model id that gives each mail a
  // 1-3 word title for scanning. Empty: off, nothing is asked or spent.
  mail: { titles: { model: '' } } as { titles: { model: string } },
  // Block summaries (src/block-summaries.ts, S-878): `model` is an OpenRouter model id that
  // gives each instruction text block a one- or two-sentence summary for the read-only
  // Instructions inventory, cached by the block's hash. Empty: off, nothing is asked or spent.
  instructions: { summaries: { model: '' } } as { summaries: { model: string } },
  // Tiny models that have no settings of their own elsewhere (src/tiny-models.ts, S-1480). The tool
  // summary (one tool call in two fields, S-1481) is off until a human turns it on; `instructions`
  // empty means the shipped default text. The other tiny steps keep the keys above.
  // The mail-title and block-summary prompts are overridable the same way (S-1579): empty means the
  // shipped prompt in src/mail-title.ts / src/block-summaries.ts.
  tiny: {
    toolSummary: { enabled: false, model: 'google/gemma-3-4b-it', instructions: '' },
    mailTitles: { titleInstructions: '', summaryInstructions: '' },
    blockSummaries: { instructions: '' },
  } as { toolSummary: { enabled: boolean; model: string; instructions: string }; mailTitles: { titleInstructions: string; summaryInstructions: string }; blockSummaries: { instructions: string } },
  // The model classifier for activity items the rules leave NULL (src/activity-classify.ts, S-214).
  // Off by default: nothing is spent until a human turns it on. maxUsdPerDay caps its day's spend
  // (UTC); concurrency is how many items it asks at once.
  activity: {
    classify: { enabled: false, maxUsdPerDay: 0.2, concurrency: 2 },
  } as { classify: { enabled: boolean; maxUsdPerDay: number; concurrency: number } },
  // What a new agent gets when the web UI's + adds one with no other input. cwd may start with ~.
  spawnDefaults: { preset: 'standard', cwd: '~' } as { preset: string | null; cwd: string | null },
  // When agents mail the human: "necessary" (only when they can't do without the human),
  // "important" (also finished work and findings), or "everything" (follow all work).
  // The texts are the templates human-mail-when-*.md; mail-to-human.md has the style rules.
  // `models` says which models' agents may mail the human at all (Settings › Mail to you): a
  // model missing from the map may, and a parent gets the mail instead when one may not.
  humanMail: { when: 'necessary', models: { 'claude-haiku-5-5': false } } as { when: 'necessary' | 'important' | 'everything'; models: Record<string, boolean> },
  // The human's executive assistant: routes the human's messages, spawns agents, and
  // manages stam. cwd '' means a folder of its own, STAM_HOME/assistant.
  assistant: { harness: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', cwd: '' } as { harness: string; model: string | null; effort: string | null; cwd: string },
  // The assistant the Assistant tab opens on, for a device that hasn't picked one (S-164):
  // 'assistant' for the executive assistant, or the name of a chief of staff's assistant.
  assistantDefault: 'assistant',
  // How much a parent hears about a child's finished turns: "turn" (every turn),
  // "tree-idle" (once, when the child and all its descendants are idle), or "none".
  // Blocked and errored children always reach a parent. A new agent starts with this;
  // a parent can change its own. See org.ts and the `stam child-notices` command.
  childNotices: 'tree-idle' as 'turn' | 'tree-idle' | 'none',
  // Which view the human's web UI opens an agent in (S-82): stam's own view of its
  // conversation where its harness has one (the default), or its terminal, which is also
  // what an agent with no view opens in. An agent's own choice wins.
  agentView: { default: 'conversation' } as { default: 'terminal' | 'conversation' },
  // A 'working' agent with no hook for this many minutes, sitting at an empty input box,
  // missed its end-of-turn signal (a daemon restart, S-188): stam marks it idle so its mail
  // and notices are delivered.
  staleWorkingMinutes: 10,
  // An agent stuck in 'starting' with no harness process for this many minutes never finishes
  // its step (S-578): reconcile marks it stopped, tells its parent, and runs a pending archive
  // at once. A launch normally takes seconds, so this is well above that.
  startingTimeoutMinutes: 10,
  // A harness dialog that went to the agent's parent and the chief of staff (S-520) and that none
  // of them answered within this many minutes goes to the human (S-589). 0 sends it on at the next sweep.
  dialogEscalateMinutes: 10,
  // S-1043: how long an archive waits for the agent's final-round turn end (the wrap-up prompt
  // with the retro round) before archiving anyway. Every archive asks for it, forced or not.
  // S-1393: a shut-down agent is archived once it has been shut down this many hours, when it owns
  // no open ITSA, is not standing, cos, or the assistant, and its worktree is clean and merged.
  archive: { finalRoundMinutes: 3, idleShutdownHours: 12 },
  // The mode the web prompt input starts in: 'mail' (mail from the human) or 'direct' (typed into the
  // agent's terminal). A box switches for itself; a fresh load starts here.
  promptDefaultMode: 'mail' as 'mail' | 'direct',
  // Search by meaning (S-141): 'local' embeds mail with a small model under STAM_HOME/embedder
  // (`stam embedder install`, or the daemon in the background on first need); 'off' keeps the
  // keyword search. Tests set STAM_EMBEDDER=stub instead, which overrides this (src/embed.ts).
  // turnDays (S-1460): how many days of agent turns are indexed for prompt suggestions.
  search: { embedder: 'local', turnDays: 7 } as { embedder: 'local' | 'off'; turnDays: number },
  // Resource warnings (src/machines.ts): mail the recipients when this machine's load per core,
  // free RAM, or swap use crosses its line, then again each repeatMinutes while it stays across.
  // The root disk mails once per crossing of 85%, re-armed below 80% (S-736).
  // Recipients are agent names or "human"; none means the chief of staff.
  resourceWarn: {
    enabled: true,
    loadPerCore: 2.0,
    ramAvailableGb: 2,
    swapPct: 80,
    repeatMinutes: 30,
    recipients: [] as string[],
    // When each kind last mailed (epoch ms, null: never), so a restart doesn't mail it again at once.
    lastWarned: { cpu: null, ram: null, swap: null, disk: null } as Record<'cpu' | 'ram' | 'swap' | 'disk', number | null>,
  },
  // Name of the chief-of-staff agent, if any: reviews permission requests, among others.
  chiefOfStaff: null as string | null,
  // The periodic tree check (S-915): every `everyHours` the chief of staff gets the tree-check template as a
  // recurring wake_me notice (src/tree-check.ts). Off by default.
  treeCheck: { enabled: false, everyHours: 4 },
  // The process runner (S-946, src/process-run.ts): what the daemon does when an ITSA's `stage` enters a
  // script, human or end node, when a start event arrives, and when a review verdict lands. 'off' does nothing;
  // 'dry-run' logs and records what it would do; 'on' creates the ITSA for a start event and moves the stage
  // for a verdict, runs a script node and opens a human node's ask (S-947 to S-950).
  // `maxSpawnsPerHour` caps the agents `on` spawns for agent nodes (S-1038).
  process: { run: 'dry-run' as 'off' | 'dry-run' | 'on', maxSpawnsPerHour: 3 },
  // ITSAs (issue management): every ITSA lives on one home daemon, other daemons proxy to
  // it. `home` names that machine; null means this one. `keyPrefix` starts readable keys
  // (`S-42`). `statuses` is the editable status set: each has a name, one of five fixed
  // categories (backlog, ready, active, review, closed), and a `human` flag for statuses
  // that wait on the human. See docs/itsa-design.md.
  itsa: {
    home: null as string | null,
    keyPrefix: 'S',
    // Branch links (S-40): the repos a branch link names, by name, as a path; and the branch
    // the facts compare against. A link names a repo only by one of these names.
    repos: defaultRepos() as Record<string, string>,
    mainBranch: 'main',
    // The PR relay (S-514, pr-open.ts): the repo a pr_open names (a name in repos above), the storage
    // remote its branch is fetched from (a remote name or URL; '' = `storage` if the checkout has that remote, else the local branch is pushed), the origin it pushes to, and the gh binary
    // and GitHub repo it opens the PR with ('' = the repo `origin` points at). Without a `storage` remote in the checkout, the local branch is pushed. Runs on the ITSA home, where gh is.
    prOpen: { repo: 'stam2', storage: '', origin: 'origin', gh: 'gh', github: '' },
    // Required (default): every agent belongs to at least one open ITSA. A spawn with no
    // `itsa` joins its parent's most recently updated open ITSA as a participant, and the
    // web tree marks agents that are in none. Off: ITSAs are optional again, no joins, no
    // marks. See docs/itsa-design.md, step 10.
    required: true,
    // Whether the owner of a parent ITSA hears (as a notice, not mail) when a child ITSA
    // becomes blocked, waits on the human, or closes, or when its owner stops.
    ownerNotices: 'on' as 'on' | 'off',
    statuses: [
      { name: 'idea', category: 'backlog', human: false },
      { name: 'backlog', category: 'backlog', human: false },
      { name: 'icebox', category: 'backlog', human: false },
      { name: 'todo', category: 'ready', human: false },
      { name: 'ready', category: 'ready', human: false },
      { name: 'scheduled', category: 'ready', human: false },
      { name: 'planning', category: 'active', human: false },
      { name: 'in_progress', category: 'active', human: false },
      { name: 'delegated', category: 'active', human: false },
      { name: 'waiting', category: 'active', human: false },
      { name: 'blocked', category: 'active', human: false },
      { name: 'needs_input', category: 'active', human: true },
      { name: 'needs_approval', category: 'active', human: true },
      { name: 'in_review', category: 'review', human: false },
      { name: 'testing', category: 'review', human: false },
      { name: 'needs_review', category: 'review', human: true },
      { name: 'needs_test', category: 'review', human: true },
      { name: 'ready_to_merge', category: 'review', human: false },
      { name: 'merging', category: 'review', human: false },
      { name: 'deploying', category: 'review', human: false },
      { name: 'done', category: 'closed', human: false },
      { name: 'canceled', category: 'closed', human: false },
      { name: 'duplicate', category: 'closed', human: false },
      { name: 'wont_do', category: 'closed', human: false },
    ] as { name: string; category: string; human: boolean }[],
    // What the human can do to an ITSA waiting on them, per status: each action has an id
    // (`approve`, `changes`, or `answer`), a label, the status it moves the ITSA to, and
    // whether it takes the human's text (`none`, `optional`, `required`). The text is posted
    // as a comment that interrupts the owner. A human status not listed gets Approve (to
    // `done`) and Request changes (to `in_progress`).
    actions: {
      needs_input: [{ id: 'answer', label: 'Answer', to: 'in_progress', text: 'required' }],
      needs_approval: [
        { id: 'approve', label: 'Approve', to: 'in_progress', text: 'optional' },
        { id: 'changes', label: 'Request changes', to: 'in_progress', text: 'required' },
      ],
      needs_review: [
        { id: 'approve', label: 'Approve', to: 'ready_to_merge', text: 'optional' },
        { id: 'changes', label: 'Request changes', to: 'in_progress', text: 'required' },
      ],
      needs_test: [
        { id: 'approve', label: 'Approve', to: 'done', text: 'optional' },
        { id: 'changes', label: 'Request changes', to: 'in_progress', text: 'required' },
      ],
    } as Record<string, { id: string; label: string; to: string; text: 'none' | 'optional' | 'required' }[]>,
  },
  // Requirements (S-461): an optional tree of requirements checked for
  // conformity with the decision model. Fully optional; off by default. The tables live on the
  // ITSA home daemon (settings.itsa.home); other daemons proxy there.
  // `approval` is who may move a requirement from draft to in_force: only the human, the
  // chief of staff (or the human), or anyone. `keyPrefix` starts readable keys (`R-1`).
  requirements: {
    enabled: false,
    approval: 'human' as 'human' | 'cos' | 'any',
    keyPrefix: 'R',
    dailyCapUsd: 1,
    // A requirement drops to observe for false positives only with at least this many `violates` verdicts at its version.
    demoteMinFlags: 5,
    defaultThreshold: 0.8,
    defaultMode: 'observe' as 'observe' | 'inform' | 'enforce',
  },
  // Other machines' daemons: [{ "name": "storage", "url": "http://storage:7878", "token": "..." }].
  // A peer may carry "start": a shell command that starts its machine when it is down; a spawn on
  // that peer runs it, waits for the peer's /api/health, then forwards the spawn (src/peers.ts).
  // "deploy" brings a peer on another release to this one: it runs with STAM_RELEASE and STAM_PEER.
  peers: [] as { name: string; url: string; token: string; peerToken?: string; start?: string; deploy?: string }[],
  // External-event sources (src/sources/github.ts, linear.ts). githubSeconds and linearSeconds
  // are the pollers' intervals, in seconds; 0 disables one. Tests lower them.
  watch: {
    githubSeconds: 60,
    // The Linear poller (src/sources/linear.ts): its interval, and the MCP tool names it calls.
    linearSeconds: 60,
    linearTools: { issue: 'get_issue', comments: 'list_comments' },
  },
  // The retro digest (S-161): mailed to the chief of staff at day and hour, local time. day is
  // 'daily' (the default) or a weekday.
  // lastDigest is when it was last sent (or found nothing to send), so a restart doesn't send it twice.
  // Who a request may claim to be (S-238). With sharedTokenClaims off, the shared token (the
  // human's and the CLI's) may still act as the human, but not name an agent (src/daemon.ts actor).
  // humanStrict (S-543): only trustedHuman is the human; the shared token and x-stam-human aren't. It takes
  // effect whatever legacyPeerToken says: the shared token never passes as a peer (S-1064).
  // Don't enable humanStrict before C3b: relayed human actions (permission answers on another machine's agents,
  // ITSA acts from a machine that isn't the ITSA home, peer agent control) are refused (S-544).
  // legacyPeerToken (S-545) is now ignored (S-1064): the shared token with x-stam-local or x-stam-agent gets a 403;
  // only the peer token (STAM_HOME/peer-token) can act as a peer.
  // localHuman (S-613): on one machine without Tailscale, the web page on 127.0.0.1 becomes the human once root
  // vouches for the code it shows (`sudo /usr/bin/install -D -m 644 /dev/null /run/stam-human/UID/CODE`; coreutils
  // only, never stam's code, as root). Linux only for now. An agent can still wrap sudo via the shell rc or PATH. Off by default; it changes nothing for tailscale serve.
  // Hosts where agents have passwordless sudo or docker gain no protection from it: there agents are root.
  auth: { sharedTokenClaims: true, legacyPeerToken: true, humanStrict: false, localHuman: false },
  // An event-loop stall longer than stallMs ms is logged with what was running (src/stall.ts).
  debug: { stallMs: 100 },
  // The folders the human's Files API may read on this machine (S-1525); null means ~/projects and
  // the mail attachments. A fixed deny list in src/files.ts holds inside them.
  files: { roots: null as string[] | null },
  // The PR diff API (S-1530, src/diff.ts). classes: the file patterns per class, hidden by the viewer's
  // "meat" mode. A pattern ending in `/` names a folder anywhere in the path; one with no other `/`
  // matches the file name anywhere; otherwise it matches the whole path (`*` stays inside one segment,
  // `**` crosses them). The first class that matches wins, in the order tests, lockfiles, generated, docs.
  // fetchSeconds: the longest a git fetch of a PR may run; refreshSeconds: how long a fetched head is reused;
  // maxPrRefs: how many PRs the cache repo keeps (the longest unused is dropped).
  diff: {
    classes: {
      tests: ['test/', 'tests/', '__tests__/', 'fixtures/', '__snapshots__/', '*.test.*', '*.spec.*', '*.snap'],
      lockfiles: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'npm-shrinkwrap.json', 'bun.lock', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'go.sum', 'Gemfile.lock', 'composer.lock'],
      generated: ['dist/', 'build/', 'vendor/', 'node_modules/', '*.min.*', '*.map'],
      docs: ['docs/', '*.md'],
    } as Record<string, string[]>,
    fetchSeconds: 60,
    refreshSeconds: 20,
    maxPrRefs: 100,
  },
  retro: {
    digest: { enabled: true, day: 'daily', hour: 9 },
    lastDigest: null as string | null,
    // The epic retro offer (S-163): a project or initiative closed with retro items from this many
    // reporters gets it, as a ring when its tree's 5-hour share is under maxWindowShare percent.
    epic: { minReporters: 3, maxWindowShare: 50 },
    // The retro loop (S-206): after each digest, a retro steward proposes instruction edits.
    steward: { enabled: true },
    // A short retro reminder in the notices that come before an agent loses context (S-710).
    reminders: { enabled: true },
    // Lessons from similar work (S-725): at spawn and after a compaction, the k retro items nearest the task by meaning.
    lessons: { enabled: true, k: 4 },
    // The early start (S-714): the digest (and so the steward) also goes out before its daily slot
    // when at least newItems open retro items arrived since the last digest, or one open item with
    // at least plusOnes +1s was +1'd again. minHours is the least time between two early digests
    // (S-1059), so a burst can't fire one after another; the daily digest is unaffected.
    early: { enabled: true, newItems: 10, plusOnes: 3, minHours: 3 },
  },
};

// `home` and `itsa.home` are resolved to a machine name on read.
export type Settings = Omit<typeof DEFAULTS, 'home'> & { home: string };

// Settings that belong to this machine only (S-380), as dotted paths. A non-home daemon reads these
// from its own settings.json and every other key from the shared cache.
export const LOCAL_KEYS = ['home', 'peers', 'itsa.home', 'itsa.repos', 'search.embedder', 'debug.stallMs', 'files.roots', 'auth.humanStrict', 'auth.localHuman', 'resourceWarn.lastWarned', 'retro.lastDigest'];

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const hasPath = (o: any, path: string[]): boolean => path.every((k) => ((o = isObj(o) && Object.hasOwn(o, k) ? o[k] : undefined), o !== undefined)) ;
const getPath = (o: any, path: string[]): any => path.reduce((x, k) => x?.[k], o);
function setPath(o: Record<string, any>, path: string[], v: unknown): void {
  for (const k of path.slice(0, -1)) o = isObj(o[k]) ? o[k] : (o[k] = {});
  o[path[path.length - 1]] = v;
}
function delPath(o: any, path: string[]): void {
  for (const k of path.slice(0, -1)) o = isObj(o) ? o[k] : undefined;
  if (isObj(o)) delete o[path[path.length - 1]];
}

// Only the machine-local keys of a settings object, deep paths included.
export function localPart(obj: unknown): Record<string, any> {
  const out: Record<string, any> = {};
  if (!isObj(obj)) return out;
  for (const key of LOCAL_KEYS) {
    const path = key.split('.');
    if (hasPath(obj, path)) setPath(out, path, structuredClone(getPath(obj, path)));
  }
  return out;
}
// Everything but the machine-local keys. An object left empty by that stays as {}.
export function sharedPart(obj: unknown): Record<string, any> {
  if (!isObj(obj)) return {};
  const out = structuredClone(obj);
  for (const key of LOCAL_KEYS) delPath(out, key.split('.'));
  return out;
}

// The days a retro digest can fall on, by Date.getDay() order.
export const DIGEST_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
// Every value settings.retro.digest.day accepts: daily, or one weekday.
export const DIGEST_CADENCES = ['daily', ...DIGEST_DAYS];

// The default human actions, each status's list replaced by the user's when they give one;
// entries that are not {id, label, to} strings are dropped.
function itsaActions(user: unknown): Settings['itsa']['actions'] {
  const out = { ...DEFAULTS.itsa.actions };
  if (!user || typeof user !== 'object') return out;
  for (const [status, list] of Object.entries(user as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    out[status] = list
      .filter((a) => a && typeof a.id === 'string' && typeof a.label === 'string' && typeof a.to === 'string' && a.id && a.to)
      .map((a) => ({ id: a.id, label: a.label, to: a.to, text: ['none', 'optional', 'required'].includes(a.text) ? a.text : 'optional' }));
  }
  return out;
}

// The settings file as it is on disk, or {} when it can't be read.
export function settingsOnDisk(): any {
  try {
    return JSON.parse(readFileSync(file(), 'utf8'));
  } catch {
    return {};
  }
}

// The resource-warning settings with each missing or invalid value replaced by its default.
// A finite number of 0 or more, else the default.
function nonNegative(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d;
}

function resourceWarnOf(u: any): Settings['resourceWarn'] {
  const d = DEFAULTS.resourceWarn;
  const num = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : def);
  const time = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  return {
    enabled: u?.enabled === false ? false : d.enabled,
    loadPerCore: num(u?.loadPerCore, d.loadPerCore),
    ramAvailableGb: num(u?.ramAvailableGb, d.ramAvailableGb),
    swapPct: num(u?.swapPct, d.swapPct),
    repeatMinutes: num(u?.repeatMinutes, d.repeatMinutes),
    recipients: Array.isArray(u?.recipients) ? u.recipients.filter((r: unknown) => typeof r === 'string' && r) : [],
    lastWarned: { cpu: time(u?.lastWarned?.cpu), ram: time(u?.lastWarned?.ram), swap: time(u?.lastWarned?.swap), disk: time(u?.lastWarned?.disk) },
  };
}

// How important a piece of stam's own mail to the human is. `settings.humanMail.when` is the
// least importance the human wants to hear; a mail at a level at or below it is allowed.
// Cost warnings are 'important': under the default 'necessary' the responsible manager
// handles them, not the human (docs/cost-policy.md, build step 11).
const HUMAN_MAIL_RANK: Record<Settings['humanMail']['when'], number> = { necessary: 0, important: 1, everything: 2 };
export function humanMailAllows(level: 'necessary' | 'important' | 'everything'): boolean {
  return HUMAN_MAIL_RANK[settings().humanMail.when] >= HUMAN_MAIL_RANK[level];
}

// Whether an agent on this model may mail the human or move an ITSA to a human status. A null
// or unknown model may; only an explicit false in settings.humanMail.models keeps it from.
export function mayMailHuman(model: string | null): boolean {
  return !model || settings().humanMail.models[model] !== false;
}

// The settings file as an agent (or the OpenCode server) may read it (S-259): every secret redacted,
// so a token held by one agent can't be read from the file and used as another daemon's or the
// human's. Peers' shared tokens, any key named like a credential, and an MCP server's env and
// headers (they hold credentials) become REDACTED. A file that isn't JSON reads as empty.
export const REDACTED = '[redacted]';
export const SECRET_KEY = /(token|secret|password|apikey|api_key|authorization)$/i;
// A parsed settings value with credentials replaced by REDACTED, recursing into arrays.
export function redactValue(parsed: any): any {
  const scrub = (v: any): any => {
    if (Array.isArray(v)) return v.map(scrub);
    if (!v || typeof v !== 'object') return v;
    // A key named like a credential holds one as a value; an object under such a key (a server named
    // remote-secret) is a container, so its own values are checked.
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) && (!x || typeof x !== 'object') ? REDACTED : scrub(x)]));
  };
  const out = scrub(parsed);
  // An MCP server's env and headers may hold credentials under any name: every value is redacted.
  if (out?.mcpServers && typeof out.mcpServers === 'object')
    for (const s of Object.values<any>(out.mcpServers))
      for (const field of ['env', 'headers'])
        if (s?.[field] && typeof s[field] === 'object') for (const k of Object.keys(s[field])) s[field][k] = REDACTED;
  return out;
}
export function redactSettingsText(text: string): string {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return '{}\n';
  }
  return JSON.stringify(redactValue(parsed), null, 2) + '\n';
}

const file = () => join(STAM_HOME, 'settings.json');
const sharedFile = () => join(STAM_HOME, 'settings.shared.json');

// The settings files hold secrets — peers' shared tokens and peer tokens (S-743) — so they are written
// 0600, and chmod'd after every write: a plain write keeps the mode of an existing file, which may be
// 0644 from before this. That stops other users on the machine; a same-user agent still reads them,
// which needs OS isolation (docs/human-auth-design.md tier 2).
function writeSecretFile(p: string, text: string): void {
  writeFileSync(p, text, { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {}
}

// The shared cache a non-home daemon keeps, { rev, settings, registry, instructions }, or null when
// there is none or it isn't valid JSON of that shape. The user registry and the global instructions
// (S-387) are absent from a cache written before they were shared, or from an older home.
export interface SharedCache {
  rev: unknown;
  settings: Record<string, any>;
  registry?: Record<string, any>;
  instructions?: string;
  // The home's web UI origin (S-414), where a peer's UI sends shared writes.
  web?: string;
}
export function readSharedCache(): SharedCache | null {
  try {
    const c = JSON.parse(readFileSync(sharedFile(), 'utf8'));
    if (!isObj(c) || !isObj(c.settings)) return null;
    const out: SharedCache = { rev: c.rev, settings: c.settings };
    if (isObj(c.registry)) out.registry = c.registry;
    if (typeof c.instructions === 'string') out.instructions = c.instructions;
    if (typeof c.web === 'string') out.web = c.web;
    return out;
  } catch {
    return null;
  }
}

// The home's user registry and global instructions as this daemon uses them (S-387): from the cache
// on a non-home daemon that has one with them, else null, and the caller reads its local file. Reads
// only the local settings file and the cache, never settings(), since settings() reads the registry.
// Kept until either file's stat changes.
let peerSharedMemo: { key: string; value: { registry?: Record<string, any>; instructions?: string } | null } | null = null;
export function peerShared(): { registry?: Record<string, any>; instructions?: string } | null {
  const key = fileKey();
  if (peerSharedMemo?.key === key) return peerSharedMemo.value;
  let value: { registry?: Record<string, any>; instructions?: string } | null = null;
  let user: any = null;
  try {
    user = JSON.parse(readFileSync(file(), 'utf8'));
  } catch {}
  if (user && !localHomeIsMe(user)) {
    const c = readSharedCache();
    if (c && (c.registry || c.instructions !== undefined)) value = { registry: c.registry, instructions: c.instructions };
  }
  peerSharedMemo = { key, value };
  return value;
}
// Replaces the cache atomically (tmp + rename), then tells listeners and drops the memo.
export function writeSharedCache(text: string): void {
  mkdirSync(STAM_HOME, { recursive: true });
  const tmp = `${sharedFile()}.${process.pid}.tmp`;
  writeSecretFile(tmp, text);
  renameSync(tmp, sharedFile());
  settingsChanged();
}
// Whether this daemon holds the settings (S-380): `home` names this machine, or no other.
export function isSettingsHome(): boolean {
  return settings().home === MACHINE;
}

// Listeners told after stam writes the settings file, for callers that cache a setting (mail
// titles, S-297). Every write here calls settingsChanged; the daemon's raw save calls it too.
const changeListeners: (() => void)[] = [];
export function onSettingsChange(fn: () => void): void {
  changeListeners.push(fn);
}
export function settingsChanged(): void {
  memo = null;
  for (const fn of changeListeners) {
    try {
      fn();
    } catch (e) {
      console.error(`settings listener: ${e instanceof Error ? e.message : e}`);
    }
  }
}

// Writes the defaults on first start, and adds top-level keys introduced since, so
// every setting is visible in the file.
export function ensureSettings(): void {
  mkdirSync(STAM_HOME, { recursive: true });
  let user: any = {};
  if (existsSync(file())) {
    try {
      user = JSON.parse(readFileSync(file(), 'utf8'));
    } catch {
      return;
    }
  }
  const missing = Object.keys(DEFAULTS).filter((k) => !(k in user));
  if (!missing.length) return;
  // A non-home daemon with a cache gets no shared defaults in its file: the cache holds those.
  const localOnly = !localHomeIsMe(user) && readSharedCache() !== null;
  let added = false;
  for (const k of missing) {
    if (!localOnly) {
      user[k] = (DEFAULTS as any)[k];
      added = true;
      continue;
    }
    const part = localPart({ [k]: (DEFAULTS as any)[k] });
    if (k in part) {
      user[k] = part[k];
      added = true;
    }
  }
  if (!added) return;
  writeSecretFile(file(), JSON.stringify(user, null, 2) + '\n');
  settingsChanged();
}

// The repo stam2 is built from: a release records it in .release.json (deploy.ts), so a
// deployed daemon finds the checkout it came from; a checkout is its own. Nothing else is
// configured by default. (S-40: branch links name repos by these names only.)
export function defaultRepos(root = ROOT): Record<string, string> {
  try {
    const m = JSON.parse(readFileSync(join(root, '.release.json'), 'utf8'));
    if (typeof m.repo === 'string' && m.repo) return { stam2: canonicalPath(m.repo) };
  } catch {}
  return existsSync(join(root, '.git')) ? { stam2: canonicalPath(root) } : {};
}
// A configured repo's real path, so a symlink can't point a name elsewhere later.
function canonicalPath(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

// Changes one top-level setting in the file, keeping everything else as written. A non-home daemon
// never writes shared settings (S-398): it writes the local part only, and drops a changed shared
// part with a warning. Its own bookkeeping (resourceWarn.lastWarned, retro.lastDigest) is local.
export function setSetting(key: keyof Settings, value: unknown): void {
  if (!isSettingsHome()) {
    const { local, shared } = splitSettingsPatch({ [key]: value });
    patchLocalKeys(local);
    // A caller that spreads the current value (resourceWarn, retro) sends the shared part unchanged.
    const same = key in shared && isDeepStrictEqual(shared[key], sharedPart({ [key]: structuredClone(settings()[key]) })[key]);
    if (Object.keys(shared).length && !same) console.warn(`settings: ${key} is shared and lives on ${settings().home}; not changed here`);
    return;
  }
  let user: any = {};
  try {
    user = JSON.parse(readFileSync(file(), 'utf8'));
  } catch {}
  user[key] = value;
  writeSecretFile(file(), JSON.stringify(user, null, 2) + '\n');
  settingsChanged();
}

// Settings whose value is a record of views keyed by id: a patch merges them per id, so two
// pages saving different views both keep theirs (S-293).
const VIEW_RECORDS = ['boardViews', 'workViews', 'sidebarCols', 'sidebarPanes', 'motion'];

// Applies the human's partial change to the settings file, as one read and write, so two
// patches never interleave. A top-level key replaces its value, except a view record, which
// merges per id: a null value deletes that view. With `fill`, a view record only adds the ids
// the file doesn't have yet (a browser's copy moving in), and other keys are left alone.
// Returns the new text, or the cost problem that keeps it from being written.
type PatchProblem = { problem: string; field: 'cost' | 'requirements' };
export function patchSettings(patch: Record<string, unknown>, fill = false): { text: string } | PatchProblem {
  const r = patchedSettingsText(readSettingsText(), patch, fill);
  if ('problem' in r) return r;
  writeSecretFile(file(), r.text);
  settingsChanged();
  return r;
}

// A peer's UI change on the home (S-414): only the shared part of the patch is applied, and the
// home's own machine-local paths stay as they are, so a top-level key that mixes both (itsa) never
// takes the peer's local values. Returns the shared part of the new settings, as text.
export function patchSharedSettings(patch: Record<string, unknown>, fill = false): { text: string } | PatchProblem {
  const current = readSettingsText();
  // A mixed key that held only local paths leaves an empty object: it changes nothing shared.
  const mine = localPart(patch);
  const shared = Object.fromEntries(Object.entries(sharedPart(patch)).filter(([k, v]) => !(k in mine && isObj(v) && !Object.keys(v).length)));
  const r = patchedSettingsText(current, fill ? patch : shared, fill);
  if ('problem' in r) return r;
  let own: unknown = {};
  try {
    own = JSON.parse(current);
  } catch {}
  writeSecretFile(file(), withLocalKeys(r.text, localPart(own)));
  settingsChanged();
  return { text: JSON.stringify(sharedPart(JSON.parse(r.text)), null, 2) + '\n' };
}

// A change on a non-home daemon split in two (S-398): `local` holds the machine-local paths it sets,
// `shared` the top-level shared keys it would change, which a non-home daemon refuses. A top-level
// key mixing both (itsa, retro) goes to each side with only its own sub-keys, and isn't shared at all
// when it held only local ones. A shared key equal to the cached copy is dropped (unless `fill`), so
// saving the merged text back with only local edits is a local change. A `fill` patch changes only
// view records, by adding ids: it is a shared change only when it adds an id the cache lacks. With no
// cache yet, every shared key counts as a change.
export function splitSettingsPatch(patch: Record<string, unknown>, fill = false): { local: Record<string, any>; shared: Record<string, any> } {
  const cached = readSharedCache()?.settings ?? {};
  const shared: Record<string, any> = {};
  if (fill) {
    for (const k of VIEW_RECORDS) {
      const v = patch[k];
      const have = isObj(cached[k]) ? cached[k] : {};
      if (isObj(v) && Object.keys(v).some((id) => !Object.hasOwn(have, id))) shared[k] = v;
    }
    return { local: {}, shared };
  }
  const local = localPart(patch);
  for (const [k, v] of Object.entries(sharedPart(patch))) {
    if (k in local && isObj(v) && !Object.keys(v).length) continue;
    if (Object.hasOwn(cached, k) && isDeepStrictEqual(v, cached[k])) continue;
    shared[k] = v;
  }
  return { local, shared };
}

// Sets the machine-local paths in `local` in this daemon's file, leaving every other path as it is:
// a local key the change doesn't name is kept, never removed (so a peer can't lose its `home`).
export function patchLocalKeys(local: Record<string, any>): void {
  if (!Object.keys(local).length) return;
  writeSecretFile(file(), withLocalKeys(readSettingsText(), local));
  settingsChanged();
}
// `text` with the machine-local paths in `local` set, and every other path as it is.
export function withLocalKeys(text: string, local: Record<string, any>): string {
  let user: any = {};
  try {
    user = JSON.parse(text);
  } catch {}
  if (!isObj(user)) user = {};
  for (const key of LOCAL_KEYS) {
    const path = key.split('.');
    if (hasPath(local, path)) setPath(user, path, structuredClone(getPath(local, path)));
  }
  return JSON.stringify(user, null, 2) + '\n';
}

// The settings as this daemon uses them, as raw text: on the home (or a peer with no cache yet) its
// file; on a peer the cached shared part with its own local keys over it, as settings() merges them.
export function effectiveSettingsText(): string {
  const text = readSettingsText();
  if (isSettingsHome()) return text;
  const cache = readSharedCache();
  if (!cache) return text;
  let user: any = {};
  try {
    user = JSON.parse(text);
  } catch {}
  const merged = sharedPart(cache.settings);
  const local = localPart(user);
  for (const key of LOCAL_KEYS) {
    const path = key.split('.');
    if (hasPath(local, path)) setPath(merged, path, getPath(local, path));
  }
  return JSON.stringify(merged, null, 2) + '\n';
}

// The settings file as it is on disk, or '' when there is none.
export function readSettingsText(): string {
  try {
    return readFileSync(file(), 'utf8');
  } catch {
    return '';
  }
}

// What patchSettings would write over `current`, without writing it (the pure part of the patch,
// so an ask to change the settings can show the change first, S-362).
// The sub-keys the daemon writes itself (retro.lastDigest, resourceWarn.lastWarned); a patch that
// replaces their top-level key keeps the file's value for them.
const DAEMON_OWNED: [string, string][] = [['retro', 'lastDigest'], ['resourceWarn', 'lastWarned']];

export function patchedSettingsText(current: string, patch: Record<string, unknown>, fill = false): { text: string } | PatchProblem {
  let user: any = {};
  try {
    user = JSON.parse(current);
  } catch {}
  const prev = structuredClone(user);
  for (const [k, v] of Object.entries(patch)) {
    if (VIEW_RECORDS.includes(k)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const cur = user[k] && typeof user[k] === 'object' ? user[k] : {};
      const next: Record<string, unknown> = { ...cur };
      for (const [id, x] of Object.entries(v)) {
        if (fill && id in cur) continue;
        if (x === null) delete next[id];
        else next[id] = x;
      }
      user[k] = next;
    } else if (!fill) {
      user[k] = v;
    }
  }
  // The daemon owns its bookkeeping: a page's older copy of it, or none, never replaces the file's.
  if (!fill) for (const [top, sub] of DAEMON_OWNED) {
    if (!(top in patch)) continue;
    const had = isObj(prev[top]) ? prev[top][sub] : undefined;
    if (!isObj(user[top])) continue;
    if (had === undefined) delete user[top][sub];
    else user[top][sub] = had;
  }
  const problem = costProblem(user);
  if (problem) return { problem, field: 'cost' };
  const reqProblem = requirementsProblem(user);
  if (reqProblem) return { problem: reqProblem, field: 'requirements' };
  return { text: JSON.stringify(user, null, 2) + '\n' };
}

// The values a patch would overwrite, as `current` holds them: each top-level key it sets (a view
// record, only the ids it sets), without the sub-keys the daemon owns. A settings_ask keeps its hash,
// so the approval still applies when only keys the patch doesn't touch changed since (S-974).
export function patchTouchedText(current: string, patch: Record<string, unknown>): string {
  let user: any = {};
  try {
    user = JSON.parse(current);
  } catch {}
  const touched: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (VIEW_RECORDS.includes(k) && isObj(v)) touched[k] = Object.fromEntries(Object.keys(v).map((id) => [id, isObj(user[k]) ? user[k][id] : undefined]));
    else {
      const owned = DAEMON_OWNED.filter(([top]) => top === k).map(([, sub]) => sub);
      touched[k] = isObj(user[k]) && owned.length ? Object.fromEntries(Object.entries(user[k]).filter(([sub]) => !owned.includes(sub))) : user[k];
    }
  }
  return JSON.stringify(touched);
}

// Writes settings text the human approved or posted: the one write path for a whole-file save.
export function writeSettingsText(text: string): void {
  writeSecretFile(file(), text);
  settingsChanged();
}

// The cost problem in a settings object about to be saved, or null when it is valid. The
// save route calls this so an invalid cost config never reaches the file.
export function costProblem(user: any): string | null {
  return validate({ ...DEFAULTS.cost, ...(user?.cost ?? {}) });
}

// The key prefix of requirements (`R` in `R-12`): letters only, so a key is never read as a number or a path.
export const REQ_KEY_PREFIX = /^[A-Za-z]+$/;

// The problem with the requirements settings about to be saved, or null when they are valid. An
// empty prefix is allowed: it takes the default.
export function requirementsProblem(user: any): string | null {
  const p = user?.requirements?.keyPrefix;
  if (p === undefined || p === null || p === '') return null;
  return typeof p === 'string' && REQ_KEY_PREFIX.test(p) ? null : 'requirements.keyPrefix must be letters only, such as R';
}

// The last valid cost config, kept so an invalid one is rejected without disturbing the
// running daemon (docs/cost-policy.md). Null until the first valid read.
let lastValidCost: Settings['cost'] | null = null;

// How many times settings.json has been read (a test counts these to check a read isn't repeated per agent).
let reads = 0;
export const settingsReads = (): number => reads;

// settings() is read from many places per request (S-344), so the parsed result is kept until the file's
// mtime or size changes, or a write here or in the daemon calls settingsChanged. A read then costs one stat.
let memo: { key: string; value: Settings } | null = null;
export const statKey = (path: string): string => {
  try {
    // ctime moves on a chmod and inode on a replace, so a same-size change still shows (S-344 review).
    const st = statSync(path, { bigint: true, throwIfNoEntry: false });
    if (!st) return 'missing';
    return `${st.mtimeNs}:${st.ctimeNs}:${st.size}:${st.ino}`;
  } catch {
    return 'missing';
  }
};
// The settings file and the shared cache: a change to either invalidates.
const fileKey = (): string => `${statKey(file())}|${statKey(sharedFile())}`;
// Where the settings live, from the local file alone: home, else itsa.home, else this machine.
export const homeOf = (user: any): string => (typeof user?.home === 'string' && user.home ? user.home : typeof user?.itsa?.home === 'string' && user.itsa.home ? user.itsa.home : MACHINE);
const localHomeIsMe = (user: any): boolean => homeOf(user) === MACHINE;
// The last value read without a problem, which a corrupt cache keeps in place.
let lastGood: Settings | null = null;
// Frozen, so a caller can't change what the next caller reads.
const deepFreeze = <T>(v: T): T => {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
};

export function settings(): Settings {
  const key = fileKey();
  // A cached read still retries a config notice that is waiting for a sender (accounts.ts).
  if (memo && memo.key === key) {
    retryNotices();
    return memo.value;
  }
  const { value, cacheable } = readSettings();
  const frozen = deepFreeze(value);
  // A failed read or parse isn't cached: the next call reads the file again.
  memo = cacheable ? { key, value: frozen } : null;
  if (cacheable) lastGood = frozen;
  return frozen;
}

function readSettings(): { value: Settings; cacheable: boolean } {
  reads++;
  let user: any = {};
  let readError: string | null = null;
  try {
    user = JSON.parse(readFileSync(file(), 'utf8'));
  } catch (e) {
    // A missing file is a normal first start; one that is there but unreadable is not.
    if (existsSync(file())) readError = `settings.json is not valid JSON: ${e instanceof Error ? e.message : e}`;
  }
  // A non-home daemon reads shared keys from the cache, with only its local keys from the file.
  // No cache yet: the file whole, so nothing changes until a cache is written.
  if (!readError && !localHomeIsMe(user) && existsSync(sharedFile())) {
    const cache = readSharedCache();
    // A corrupt cache keeps the last good value (if it was for this home), noted once and memoized
    // under the current stat key, so it isn't re-read and re-parsed on every call.
    if (!cache && lastGood && lastGood.home === homeOf(user)) {
      noteInvalid('settings.shared.json is not valid JSON');
      return { value: lastGood, cacheable: true };
    }
    if (cache) {
      const merged = sharedPart(cache.settings);
      const local = localPart(user);
      for (const key of LOCAL_KEYS) {
        const path = key.split('.');
        if (hasPath(local, path)) setPath(merged, path, getPath(local, path));
      }
      user = merged;
    }
  }
  let cost: Settings['cost'];
  if (readError) {
    // Keep the last valid config rather than falling back to the defaults.
    noteInvalid(readError);
    cost = lastValidCost ?? { ...DEFAULTS.cost };
  } else {
    cost = { ...DEFAULTS.cost, ...user.cost };
    const problem = validate(cost);
    if (problem) {
      // Reject: keep the last valid config and tell the human once per distinct error.
      noteInvalid(problem);
      cost = lastValidCost ?? { ...DEFAULTS.cost };
    } else {
      lastValidCost = cost;
    }
  }
  const home = homeOf(user);
  const value: Settings = {
    home,
    context: { ...DEFAULTS.context, ...user.context },
    idleCompaction: { ...DEFAULTS.idleCompaction, ...user.idleCompaction },
    standing: { ...DEFAULTS.standing, ...user.standing, growth: { ...DEFAULTS.standing.growth, ...user.standing?.growth } },
    exitRecovery: { ...DEFAULTS.exitRecovery, ...user.exitRecovery },
    peers: Array.isArray(user.peers) ? user.peers : [],
    cost,
    mcpServers: user.mcpServers && typeof user.mcpServers === 'object' ? user.mcpServers : {},
    decisions: {
      model: typeof user.decisions?.model === 'string' && user.decisions.model ? user.decisions.model : DEFAULTS.decisions.model,
      mailCheck: user.decisions?.mailCheck === false ? false : DEFAULTS.decisions.mailCheck,
      mailGate: user.decisions?.mailGate === false ? false : DEFAULTS.decisions.mailGate,
      suggestRescore: user.decisions?.suggestRescore === true,
    },
    mail: { titles: { model: typeof user.mail?.titles?.model === 'string' ? user.mail.titles.model.trim() : '' } },
    instructions: { summaries: { model: typeof user.instructions?.summaries?.model === 'string' ? user.instructions.summaries.model.trim() : '' } },
    tiny: {
      toolSummary: {
        enabled: user.tiny?.toolSummary?.enabled === true,
        model: typeof user.tiny?.toolSummary?.model === 'string' && user.tiny.toolSummary.model.trim() ? user.tiny.toolSummary.model.trim() : DEFAULTS.tiny.toolSummary.model,
        instructions: typeof user.tiny?.toolSummary?.instructions === 'string' ? user.tiny.toolSummary.instructions : '',
      },
      mailTitles: {
        titleInstructions: typeof user.tiny?.mailTitles?.titleInstructions === 'string' ? user.tiny.mailTitles.titleInstructions : '',
        summaryInstructions: typeof user.tiny?.mailTitles?.summaryInstructions === 'string' ? user.tiny.mailTitles.summaryInstructions : '',
      },
      blockSummaries: {
        instructions: typeof user.tiny?.blockSummaries?.instructions === 'string' ? user.tiny.blockSummaries.instructions : '',
      },
    },
    activity: {
      classify: {
        enabled: user.activity?.classify?.enabled === true,
        maxUsdPerDay: nonNegative(user.activity?.classify?.maxUsdPerDay, DEFAULTS.activity.classify.maxUsdPerDay),
        concurrency: Math.max(1, Math.floor(nonNegative(user.activity?.classify?.concurrency, DEFAULTS.activity.classify.concurrency))),
      },
    },
    banners: Array.isArray(user.banners) ? user.banners : DEFAULTS.banners,
    chiefOfStaff: typeof user.chiefOfStaff === 'string' ? user.chiefOfStaff : null,
    treeCheck: {
      enabled: user.treeCheck?.enabled === true,
      everyHours: typeof user.treeCheck?.everyHours === 'number' && Number.isFinite(user.treeCheck.everyHours) ? Math.min(TREE_CHECK_MAX_HOURS, Math.max(TREE_CHECK_MIN_HOURS, user.treeCheck.everyHours)) : DEFAULTS.treeCheck.everyHours,
    },
    process: {
      run: ['off', 'dry-run', 'on'].includes(user.process?.run) ? user.process.run : DEFAULTS.process.run,
      maxSpawnsPerHour: Number.isInteger(user.process?.maxSpawnsPerHour) && user.process.maxSpawnsPerHour >= 0 ? user.process.maxSpawnsPerHour : DEFAULTS.process.maxSpawnsPerHour,
    },
    resourceWarn: resourceWarnOf(user.resourceWarn),
    spawnDefaults: { ...DEFAULTS.spawnDefaults, ...user.spawnDefaults },
    assistant: { ...DEFAULTS.assistant, ...user.assistant },
    assistantDefault: typeof user.assistantDefault === 'string' && user.assistantDefault.trim() ? user.assistantDefault.trim() : DEFAULTS.assistantDefault,
    childNotices: ['turn', 'tree-idle', 'none'].includes(user.childNotices) ? user.childNotices : DEFAULTS.childNotices,
    agentView: { default: user.agentView?.default === 'terminal' ? 'terminal' : 'conversation' },
    promptDefaultMode: user.promptDefaultMode === 'direct' ? 'direct' : 'mail',
    staleWorkingMinutes: typeof user.staleWorkingMinutes === 'number' && user.staleWorkingMinutes > 0 ? user.staleWorkingMinutes : DEFAULTS.staleWorkingMinutes,
    startingTimeoutMinutes: typeof user.startingTimeoutMinutes === 'number' && user.startingTimeoutMinutes > 0 ? user.startingTimeoutMinutes : DEFAULTS.startingTimeoutMinutes,
    dialogEscalateMinutes: typeof user.dialogEscalateMinutes === 'number' && user.dialogEscalateMinutes >= 0 ? user.dialogEscalateMinutes : DEFAULTS.dialogEscalateMinutes,
    archive: {
      finalRoundMinutes: typeof user.archive?.finalRoundMinutes === 'number' && user.archive.finalRoundMinutes >= 0 ? user.archive.finalRoundMinutes : DEFAULTS.archive.finalRoundMinutes,
      idleShutdownHours: typeof user.archive?.idleShutdownHours === 'number' && user.archive.idleShutdownHours >= 0 ? user.archive.idleShutdownHours : DEFAULTS.archive.idleShutdownHours,
    },
    search: {
      embedder: user.search?.embedder === 'off' ? 'off' : DEFAULTS.search.embedder,
      turnDays: typeof user.search?.turnDays === 'number' && user.search.turnDays > 0 ? user.search.turnDays : DEFAULTS.search.turnDays,
    },
    auth: { sharedTokenClaims: user.auth?.sharedTokenClaims === false ? false : true, legacyPeerToken: user.auth?.legacyPeerToken === false ? false : true, humanStrict: user.auth?.humanStrict === true, localHuman: user.auth?.localHuman === true },
    debug: { stallMs: Number(user.debug?.stallMs) > 0 ? Number(user.debug?.stallMs) : DEFAULTS.debug.stallMs },
    diff: {
      classes: Object.fromEntries(Object.entries(DEFAULTS.diff.classes).map(([k, d]) => [k, Array.isArray(user.diff?.classes?.[k]) ? user.diff.classes[k].filter((x: unknown) => typeof x === 'string' && x.trim()).map(String) : d])),
      fetchSeconds: Number(user.diff?.fetchSeconds) > 0 ? Number(user.diff.fetchSeconds) : DEFAULTS.diff.fetchSeconds,
      refreshSeconds: Number(user.diff?.refreshSeconds) >= 0 && user.diff?.refreshSeconds !== undefined ? Number(user.diff.refreshSeconds) : DEFAULTS.diff.refreshSeconds,
      maxPrRefs: Number(user.diff?.maxPrRefs) >= 1 ? Math.floor(Number(user.diff.maxPrRefs)) : DEFAULTS.diff.maxPrRefs,
    },
    files: { roots: Array.isArray(user.files?.roots) ? user.files.roots.filter((r: unknown) => typeof r === 'string' && r.trim()).map(String) : null },
    watch: {
      githubSeconds: typeof user.watch?.githubSeconds === 'number' ? user.watch.githubSeconds : DEFAULTS.watch.githubSeconds,
      linearSeconds: typeof user.watch?.linearSeconds === 'number' ? user.watch.linearSeconds : DEFAULTS.watch.linearSeconds,
      linearTools: { ...DEFAULTS.watch.linearTools, ...(user.watch?.linearTools ?? {}) },
    },
    retro: {
      digest: {
        enabled: user.retro?.digest?.enabled === false ? false : true,
        day: DIGEST_CADENCES.includes(user.retro?.digest?.day) ? user.retro.digest.day : DEFAULTS.retro.digest.day,
        hour: Number.isInteger(user.retro?.digest?.hour) && user.retro.digest.hour >= 0 && user.retro.digest.hour <= 23 ? user.retro.digest.hour : DEFAULTS.retro.digest.hour,
      },
      lastDigest: typeof user.retro?.lastDigest === 'string' ? user.retro.lastDigest : null,
      epic: {
        minReporters: Number.isInteger(user.retro?.epic?.minReporters) && user.retro.epic.minReporters >= 1 ? user.retro.epic.minReporters : DEFAULTS.retro.epic.minReporters,
        maxWindowShare: typeof user.retro?.epic?.maxWindowShare === 'number' && user.retro.epic.maxWindowShare >= 0 && user.retro.epic.maxWindowShare <= 100 ? user.retro.epic.maxWindowShare : DEFAULTS.retro.epic.maxWindowShare,
      },
      steward: { enabled: user.retro?.steward?.enabled === false ? false : true },
      reminders: { enabled: user.retro?.reminders?.enabled === false ? false : true },
      lessons: {
        enabled: user.retro?.lessons?.enabled === false ? false : true,
        k: Number.isInteger(user.retro?.lessons?.k) ? Math.min(8, Math.max(1, user.retro.lessons.k)) : DEFAULTS.retro.lessons.k,
      },
      early: {
        enabled: user.retro?.early?.enabled === false ? false : true,
        newItems: Number.isInteger(user.retro?.early?.newItems) && user.retro.early.newItems >= 1 ? user.retro.early.newItems : DEFAULTS.retro.early.newItems,
        plusOnes: Number.isInteger(user.retro?.early?.plusOnes) && user.retro.early.plusOnes >= 1 ? user.retro.early.plusOnes : DEFAULTS.retro.early.plusOnes,
        minHours: nonNegative(user.retro?.early?.minHours, DEFAULTS.retro.early.minHours),
      },
    },
    humanMail: {
      when: ['necessary', 'important', 'everything'].includes(user.humanMail?.when) ? user.humanMail.when : DEFAULTS.humanMail.when,
      // A file from before the map existed, or one that names only some models, keeps the defaults for the rest.
      models: {
        ...DEFAULTS.humanMail.models,
        ...Object.fromEntries(Object.entries(user.humanMail?.models ?? {}).filter((e): e is [string, boolean] => typeof e[1] === 'boolean')),
      },
    },
    itsa: {
      // null in the file means this machine; resolved to its name so callers compare plainly.
      home,
      required: user.itsa?.required === false ? false : true,
      ownerNotices: user.itsa?.ownerNotices === 'off' ? 'off' : 'on',
      keyPrefix: typeof user.itsa?.keyPrefix === 'string' && user.itsa.keyPrefix ? user.itsa.keyPrefix : DEFAULTS.itsa.keyPrefix,
      repos: Object.fromEntries(Object.entries({ ...DEFAULTS.itsa.repos, ...(user.itsa?.repos ?? {}) }).flatMap(([name, p]) => (typeof p === 'string' && p ? [[name, canonicalPath(p)]] : []))),
      mainBranch: typeof user.itsa?.mainBranch === 'string' && user.itsa.mainBranch ? user.itsa.mainBranch : DEFAULTS.itsa.mainBranch,
      prOpen: Object.fromEntries(Object.entries(DEFAULTS.itsa.prOpen).map(([k, d]) => {
        const v = (user.itsa?.prOpen as Record<string, unknown> | undefined)?.[k];
        return [k, typeof v === 'string' && v ? v : d];
      })) as typeof DEFAULTS.itsa.prOpen,
      statuses: Array.isArray(user.itsa?.statuses) && user.itsa.statuses.length ? (user.itsa.statuses as Settings['itsa']['statuses']) : DEFAULTS.itsa.statuses,
      actions: itsaActions(user.itsa?.actions),
    },
    requirements: {
      enabled: user.requirements?.enabled === true,
      approval: ['human', 'cos', 'any'].includes(user.requirements?.approval) ? user.requirements.approval : DEFAULTS.requirements.approval,
      keyPrefix: typeof user.requirements?.keyPrefix === 'string' && REQ_KEY_PREFIX.test(user.requirements.keyPrefix) ? user.requirements.keyPrefix : DEFAULTS.requirements.keyPrefix,
      dailyCapUsd: nonNegative(user.requirements?.dailyCapUsd, DEFAULTS.requirements.dailyCapUsd),
      demoteMinFlags: Number.isInteger(user.requirements?.demoteMinFlags) && user.requirements.demoteMinFlags >= 1 ? user.requirements.demoteMinFlags : DEFAULTS.requirements.demoteMinFlags,
      defaultThreshold:
        typeof user.requirements?.defaultThreshold === 'number' && Number.isFinite(user.requirements.defaultThreshold) && user.requirements.defaultThreshold >= 0 && user.requirements.defaultThreshold <= 1
          ? user.requirements.defaultThreshold
          : DEFAULTS.requirements.defaultThreshold,
      defaultMode: ['observe', 'inform', 'enforce'].includes(user.requirements?.defaultMode) ? user.requirements.defaultMode : DEFAULTS.requirements.defaultMode,
    },
  };
  return { value, cacheable: !readError };
}
