import { parseArgs } from 'node:util';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { MACHINE, PORT, RELEASES, ROOT, STAM_HOME, rotateLeaseToken } from './config.ts';
import { api, SWITCH_CALL_MS } from './client.ts';
import { statuslineTtl, throttled } from './statusline-cache.ts';
import * as tmux from './tmux.ts';
import { SERVICE, UNIT, checkService, systemctl, waitHealthy } from './deploy.ts';
import { unitText } from './unit.ts';
import { installService as installServiceWith } from './service-install.ts';
import { AGENT_IDENTITY, envVar, setEnvVar, withMootrTwins } from './env.ts';
import { serviceEnv } from './test-env.ts';
import { holdersText } from './developer-cap.ts';
import { fieldsChange } from './itsa-fields-line.ts';
import { windowLine } from './usage-line.ts';

// The name the user invoked (bin/mootr or bin/stam sets it); help and usage text print it.
const CLI = envVar('CLI_NAME') === 'stam' ? 'stam' : 'mootr';
// Not passed on: the daemon, its tmux server and every agent pane would inherit it (the CLI they run says its own name).
setEnvVar('CLI_NAME', undefined);
// Rewrites the `stam` command name in usage text to the invoked name.
const named = (text: string) => text.replace(/^( *)stam /gm, `$1${CLI} `).replace(/(\| |usage: |see: |with: |run |: )stam (?=[a-z])/g, `$1${CLI} `);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// `stam janitor` waits this long for the daemon's sweep: a sweep walks every test folder on the
// machine, so the CLI's own 10 s default is too short on a busy machine (S-764).
const JANITOR_TIMEOUT_MS = Number(envVar('JANITOR_TIMEOUT_MS')) || 2 * 60_000;

// The spawn lines of USAGE, printed alone when spawn gets no NAME or --help.
const SPAWN_USAGE = named(`  stam spawn NAME [--type T] [--var KEY=VALUE]... [--role TEXT] [--preset P | --harness claude|opencode|codex --model M --effort E] [--cwd DIR] [--parent AGENT] [--itsa ID|KEY] [--machine M] [--urgent red-main|deploy-hold|approved-pr|incident]
             [--worktree [--branch B] [--base REF] | --workspace-script CMD | --workspace-instructions TEXT] [--standing] [--workspace[=NAME]  (the name only with "=", never a separate word)] [PROMPT]
`);

const USAGE = named(`${CLI}: run and coordinate coding agents

  stam daemon [run|start|stop|restart|status|install [--replace-stamd]]
  stam deploy [REF] [--repo DIR]    build a committed ref (default HEAD) into a release, check it, and switch to it
                  [--build-only]    build and check only, and print the release folder
  stam prune                        remove releases beyond the newest five, current, previous, and any a process runs from
  stam rollback [RELEASE]           switch to the previous release, or a named one
  stam releases                     list releases
  stam deps relink [--force]        relink this worktree's node_modules from the lockfile cache (after a rebase changes package-lock.json); deps check only reports
${SPAWN_USAGE}  stam ls [--all]   live agents; --all adds stopped and archived ones
  stam registry                     agent types, presets, harnesses, and models
  stam doctor [--json]              check this machine for a first run (Node, tmux, git, a harness, STAM_HOME, the port), with no daemon needed; a fix line per problem; exits 1 on a failure
  stam onboarding                   what a fresh install still lacks, as JSON: harness logins, keys, network mode, repos, chief of staff
  stam registry migrate-reviewers [--apply]   turn the old reviewer settings into agent types (dry run by default)
  stam show AGENT
  stam events AGENT [--type GLOB] [--limit N]   the latest 50 events, or the latest N of a type (e.g. input:screen), however old
  stam wait AGENT [--until idle,blocked] [--timeout SECONDS]
  stam attach AGENT
  stam web [serve]                  print the web UI links; serve: HTTPS on the tailnet
  stam pause|unpause AGENT
  stam shutdown AGENT [--now]       quit the harness when the agent finishes its step
  stam archive AGENT [--force] [--discard] [--force-unpushed]  shut down and remove the agent's worktree (--discard throws away uncommitted changes; --force also skips the wait for its current step; --force-unpushed archives although its branch has commits on no remote)
  stam resume AGENT [NOTE]          bring a shut-down or archived agent back
  stam restart AGENT [REASON]       quit and resume when the agent finishes its step
  stam reconnect-mcp AGENT
  stam rename AGENT NAME
  stam reparent AGENT [PARENT...]   set its parents; none makes it top-level
  stam child-notices AGENT turn|tree-idle|none
                                    how much it hears about its children's finished turns
  stam compact AGENT [INSTRUCTIONS] compact the conversation when the agent finishes its step
  stam kill AGENT                   quit the harness now
  stam forget AGENT                 remove a stopped agent from the registry
  stam stats comms [--days N] [--json]  counts of mail, asks and waits over 1-30 days (default 7), never their text; an agent's token is refused
  stam retro --search WORDS | --plus-one S-N --details T | --kind K --title T --summary T --details T [--target T] [--evidence K] [--when T] | --final --effort reading=50,... | --digest   retro items: search first, +1 a match, or file one; --final records the effort split when archived (as an agent); --digest mails the digest now to the Retros owner (or the chief of staff), not from an agent
  stam ring [NAME [TOPIC]]          list rings, show one, or start one:
      --format rounds|fire|debate --members a,b --spawn PRESET_OR_MODEL,... [--moderator M [--decide]] [--rounds N]
  stam pr open BRANCH --title T --body-file FILE [--itsa REF]   open or update a branch's PR on the ITSA home (gh runs there)
  stam itsa ls [--parent REF|root] [--subtree REF] [--status S] [--category C] [--owner REF] [--participant REF] [--since T] [--json] [TEXT]
  stam itsa mails REF               JSON of the mails in an ITSA's own thread on this daemon
  stam itsa about-mails REF         JSON of the mails about an ITSA in other threads on this daemon
  stam itsa incident REF            JSON {"marked":bool}: whether the ITSA or a parent is marked an incident
  stam itsa show REF                an ITSA: parent chain, children with roll-ups, links, participants
  stam itsa new TITLE [--parent REF] [--kind K] [--status S] [--owner REF] [--participant REF] [--summary T] [--body T] [--link URL]
  stam itsa set REF [--title T] [--summary T] [--body T] [--kind K] [--status S] [--owner REF] [--participant REF]... (replaces the whole participant set) [--add-participant REF]... (adds each, keeping the others) [--parent REF] [--field key=value]... [--system NAME]
  stam itsa field ls|new KEY LABEL --type T [--option VALUE]... [--description T]|set KEY [--label T] [--type T] [--description T] [--option V]... (replaces the options, keeping label and tone of those you name again)|rm KEY|order KEY...   shared Work page columns
  stam itsa post REF BODY [--update HEALTH] [--to REF]... [--override WHY] [--system NAME]   comment, or update (on_track|at_risk|off_track), in the ITSA's thread
  stam itsa thread REF              the ITSA's thread: mails and status/owner events by time
  stam itsa link REF URL [--system S] [--external-id ID] | stam itsa link REF --system branch --external-id BRANCH --repo REPO | stam itsa link REF --remove N
  stam req ls [--status S] [--parent REF|root] [TEXT]   requirements (off unless enabled in settings)
  stam req check [--keys R-1,R-2] (--text TEXT | mail:ID | itsa:KEY | branch:REPO/NAME)  a check now; verdicts, no notice
  stam req show REF                 a requirement: parent chain, children, links, last verdicts
  stam req new TITLE [--parent REF] [--level L] [--text T] [--rationale T] [--source T]
      [--severity info|minor|major|critical] [--mode observe|inform|enforce] [--threshold N]
      [--status S] [--owner REF] [--verify METHOD[:DETAIL]]... [--scope field=a,b]...
  stam req set REF [--title T] [--parent REF] [--level L] [--text T] [--rationale T] [--source T]
      [--severity S] [--mode M] [--threshold N] [--status S] [--owner REF] [--verify ...]... [--scope ...]...
  stam req link REF TARGET [--kind K] [--role R] | stam req link REF --remove ID
  stam req seed FILE                drafts from a JSON file (a list, or {requirements: [...]}), parents first; one approval ask
  stam subscribe [--source S] [--subject GLOB]... [--type GLOB]... [--actor A]... [--exclude-actor A]...
                 [--itsa REF] [--for AGENT|human] [--note N] [--expires-in MINUTES]
                                    hear about external events (GitHub, Linear, Slack, ...)
  stam unsubscribe ID               remove an event subscription
  stam subscriptions                list event subscriptions
  stam settings migrate [--apply] [--json]   strip this peer's settings.json to its local keys (dry run by default; safest with the daemon stopped)
  stam usage [DAYS]                 spend, tokens, and subscription windows
  stam activity --ingest [--agent AGENT]   read agents' transcripts into the activity timeline now
  stam activity [--by agent|itsa|model|type] [--days N] [--closed]   working and waiting time, cost, review rounds
  stam activity --classify [--agent AGENT]  fill activity categories the rules settle (S-213)
  stam activity --classify-model [--since ISO]  label the open items with the decision model (S-214; capped per day)
  stam embedder [status|install]    search by meaning: the local model's state, rows indexed, or install it
  stam allocate TREE [--account A] --window W --percent P [--note N] | --amount Y --period day|week|month | --clear [--id ID]
                                    set or clear a tree's cost allocation, and list them
  stam cost-pause TREE [--until reset|ISO] [--account A] [--window W] [--reason R]
  stam cost-pause TREE --clear      pause a tree until its window resets or a time, or clear early
  stam cost-switch AGENT PRESET [--soft-stop-minutes N]
                                    move an agent's work to a successor on another preset
  stam cos [AGENT]                  name the chief of staff, or clear it (also: spawn --chief-of-staff)
  stam janitor [--dry-run] [--only DIR]  clean up test daemons, tmux servers, and systemd units whose test is gone
  stam permissions                  pending permission requests
  stam archive-resolved [--all] [--apply]   the human's threads someone else resolved (S-637): lists them; --apply archives
                                    them; --all takes in those resolved before auto-archive was on (the one-off sweep)
  stam authorize|deny ID [NOTE]     answer one (NOTE defaults to "I authorize")
  stam upgrade-harness claude|opencode|codex [--command CMD]
                                    upgrade, then restart its agents as each finishes its step
  stam mail send --to AGENT [--to AGENT] --subject TEXT [--from AGENT] [--override WHY] BODY
  stam mail inbox AGENT|human
  stam mail read [AGENT|human] [MAIL_ID...]
  stam mcp login|logout|status NAME   manage a remote MCP server's shared OAuth login
  stam mcp lease-rotate               a new lease token for peers' MCP leases; the old one is refused at once
  stam mcp                            the MCP server agents talk to (stdio)

The command is called mootr; its old name, stam, is still accepted as an alias.`);

// Commands that harnesses or services call with their own argv, so `--help` keeps their meaning (S-1236).
const NO_HELP_CMDS = new Set(['hook', 'statusline', 'mcp', 'mcp-proxy', 'daemon']);

// `--help` or `-h` as a standalone argument, before any `--`, asks for usage and nothing runs (S-1236).
// `-h` is never a value here: the parseArgs calls are strict and already refuse it after an option.
function wantsHelp(args: string[]): boolean {
  const end = args.indexOf('--');
  const flags = end < 0 ? args : args.slice(0, end);
  return flags.includes('--help') || flags.includes('-h');
}

// The USAGE lines for one subcommand: its `mootr NAME` line and the indented lines under it.
// Empty when none match, so the caller prints all of USAGE.
function usageFor(cmd: string): string {
  const out: string[] = [];
  let on = false;
  for (const line of USAGE.split('\n')) {
    const m = new RegExp(`^  ${CLI} ([^ ]+)`).exec(line);
    if (m) on = m[1].split('|').includes(cmd);
    else if (!/^\s{3,}\S/.test(line)) on = false;
    if (on) out.push(line);
  }
  return out.join('\n');
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function age(iso: string): string {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

function k(n: number | null): string {
  return n == null ? '-' : `${Math.round(n / 1000)}k`;
}

// Settings a test instance runs with; the unit keeps them.
const SERVICE_ENV = ['STAM_HOME', 'STAM_PORT', 'STAM_TMUX_SOCKET', 'STAM_BIND', 'STAM_MACHINE', 'STAM_OPENCODE_PORT', 'STAM_OPENCODE_BIN', 'STAM_CODEX_BIN', 'STAM_CLAUDE_BIN', 'STAM_FAKE_CLAUDE_SCRIPT'];

// Installs stamd as a systemd user service that starts at boot and restarts if it
// crashes. KillMode=process keeps the agents' tmux server alive across restarts. It runs
// the deployed release (releases/current), or this checkout before the first deploy.
// `stam activity`: the activity baseline (S-212) as a table on the terminal.
async function printActivity(by: string, days: string | undefined, closed: boolean | undefined) {
  const q = new URLSearchParams({ by });
  if (days) q.set('days', days);
  if (closed) q.set('closed', '1');
  const r = await api<{ note: string; rows: Record<string, any>[] }>('GET', `/api/activity?${q}`);
  const rows = r.rows;
  const t = (n: number | null | undefined) => (n == null ? '?' : n < 60 ? `${n}s` : n < 3600 ? `${Math.round(n / 60)}m` : `${(n / 3600).toFixed(1)}h`);
  const usd = (n: number | null | undefined) => (n == null ? '?' : `$${n.toFixed(2)}`);
  const pct = (s: { median: number | null; p75: number | null } | undefined, f: (n: number | null) => string) => (s ? `${f(s.median)} / ${f(s.p75)}` : '');
  if (!rows.length) return console.log('no activity');
  if (by === 'agent') {
    console.log(['AGENT', 'MODEL', 'TYPE', 'WALL', 'WORKING', 'WAITING', 'COST', 'ITEM EST'].join('\t'));
    for (const a of rows) console.log([a.agent, a.model ?? '-', a.type ?? '-', t(a.wall_s), t(a.working_s), t(a.waiting_s), usd(a.cost_usd), usd(a.item_est_cost_usd)].join('\t'));
  } else if (by === 'itsa') {
    console.log(['ITSA', 'STATUS', 'WORKING', 'WAITING', 'COST', 'ROLL-UP COST', 'REVIEWS', 'LEAD'].join('\t'));
    for (const x of rows) console.log([`${x.key} ${x.title}`, x.status, t(x.own.working_s), t(x.own.waiting_s), usd(x.own.cost_usd), usd(x.total.cost_usd), x.review_rounds, t(x.lead_s)].join('\t'));
  } else {
    console.log([by.toUpperCase(), 'N', 'WORKING med / p75', 'WAITING med / p75', 'COST med / p75', 'REVIEWS med / p75'].join('\t'));
    for (const g of rows) console.log([g[by], g.n, pct(g.working_s, t), pct(g.waiting_s, t), pct(g.cost_usd, usd), pct(g.review_rounds, (n) => String(n ?? '?'))].join('\t'));
  }
  console.log(`\n${r.note}`);
}

// `stam activity --summary` (S-1010): the summary the Activity tab and activity_info read. --json prints
// it whole; otherwise the clock split, the top five bottlenecks, and the top five trees.
async function printSummary(scope: string | undefined, days: string | undefined, json: boolean | undefined) {
  const q = new URLSearchParams({ by: 'summary' });
  if (days) q.set('days', days);
  if (scope) q.set('scope', scope);
  const s = await api<any>('GET', `/api/activity?${q}`);
  if (json) return console.log(JSON.stringify(s, null, 2));
  const h = (sec: number) => `${(sec / 3600).toFixed(1)} h`;
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const pct = (sec: number) => `${s.clock.total_s > 0 ? Math.round((sec / s.clock.total_s) * 100) : 0}%`;
  const who = s.scope.kind === 'all' ? 'everything' : `${s.scope.kind} ${s.scope.name ?? s.scope.key}`;
  console.log(`${who} · ${s.days} days · ${s.agents} agents`);
  console.log(`clock ${h(s.clock.total_s)}: ${s.clock.groups.map((g: any) => `${g.label} ${h(g.seconds)} (${pct(g.seconds)})`).join(' · ')}`);
  console.log('\nBottlenecks');
  if (!s.bottlenecks.length) console.log('  none');
  for (const b of s.bottlenecks.slice(0, 5)) console.log(`  ${b.label}  ${h(b.seconds)} · ${b.agents} agent${b.agents === 1 ? '' : 's'}${b.top[0] ? ` · most ${b.top[0].name}` : ''}`);
  console.log('\nTrees');
  if (!s.trees.length) console.log('  none');
  for (const t of s.trees.slice(0, 5)) console.log(`  ${t.name}  ${t.agents} agent${t.agents === 1 ? '' : 's'} · working ${h(t.working_s)} · ${usd(t.cost_usd)}`);
}

async function installService(replace = false) {
  // mootrd.service with Alias=stamd.service (S-3349); the choices and their refusals are src/service-install.ts.
  const path = [...new Set([join(homedir(), '.opencode', 'bin'), ...(process.env.PATH ?? '').split(':')])].join(':');
  const current = join(RELEASES, 'current');
  const deployed = existsSync(current);
  await installServiceWith({
    unitDir: dirname(UNIT),
    home: STAM_HOME,
    own: envVar('SERVICE'),
    replace,
    text: (service) => {
      if (!deployed) console.log(`no release yet, so ${service} runs this checkout; run stam deploy to switch it to a release`);
      // A test's STAM_SERVICE names its own unit, which has no alias.
      return unitText({ dir: deployed ? current : ROOT, node: process.execPath, path, env: serviceEnv(SERVICE_ENV, process.env), log: join(STAM_HOME, 'daemon.log'), alias: service === 'mootrd' ? 'stamd.service' : undefined });
    },
    systemctl,
    checkService,
    // Without linger, user services stop when the user's last login ends.
    linger: () => void spawnSync('loginctl', ['enable-linger', process.env.USER ?? ''], { stdio: 'ignore' }),
    killPidFile: () => {
      try {
        process.kill(Number(readFileSync(join(STAM_HOME, 'daemon.pid'), 'utf8')));
        rmSync(join(STAM_HOME, 'daemon.pid'));
      } catch {}
    },
    healthy: waitHealthy,
    log: (line) => console.log(line),
  });
}

async function daemon(sub = 'run', replaceStamd = false) {
  const pidFile = join(STAM_HOME, 'daemon.pid');
  if (sub === 'install') return installService(replaceStamd);
  // A daemon with its own home or port (a test instance) never touches the user's service,
  // unless it names its own service (STAM_SERVICE).
  const own = Boolean(envVar('SERVICE')) || (!envVar('HOME') && !envVar('PORT'));
  // Before the existsSync: an EACCES on the unit dir must fail, not fall into the unmanaged daemon path below.
  if (own && ['start', 'stop', 'restart'].includes(sub)) checkService();
  if (own && existsSync(UNIT) && ['start', 'stop', 'restart'].includes(sub)) {
    systemctl(sub, SERVICE);
    if (sub !== 'stop' && !(await waitHealthy())) throw new Error(`${SERVICE} not answering; see daemon.log`);
    return console.log(`${SERVICE} ${sub === 'stop' ? 'stopped' : 'running'} (user service)`);
  }
  if (sub === 'run') {
    const { runDaemon } = await import('./daemon.ts');
    return runDaemon();
  }
  if (sub === 'start') {
    mkdirSync(STAM_HOME, { recursive: true });
    const log = openSync(join(STAM_HOME, 'daemon.log'), 'a');
    // A daemon an agent starts is no agent's: without its identity, an archive's sweep
    // (src/proctree.ts) never takes it for the agent's own, nor do its tmux server and agents.
    const env = { ...process.env };
    for (const k of withMootrTwins(AGENT_IDENTITY)) delete env[k];
    const child = spawn(process.execPath, ['--no-warnings', process.argv[1], 'daemon', 'run'], {
      detached: true,
      stdio: ['ignore', log, log],
      env,
    });
    writeFileSync(pidFile, String(child.pid));
    child.unref();
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        await api('GET', '/api/health', undefined, 500);
        return console.log(`stamd started, pid ${child.pid}`);
      } catch {}
    }
    throw new Error(`stamd didn't answer; see ${join(STAM_HOME, 'daemon.log')}`);
  }
  if (sub === 'stop') {
    try {
      process.kill(Number(readFileSync(pidFile, 'utf8')));
      rmSync(pidFile);
      return console.log('stamd stopped');
    } catch {
      return console.log('stamd not running');
    }
  }
  if (sub === 'status') {
    try {
      console.log(await api('GET', '/api/health', undefined, 1000));
    } catch {
      console.log('stamd not running');
      process.exitCode = 1;
    }
    return;
  }
  throw new Error(`unknown daemon command ${sub}`);
}

// Writes the hook's text and resolves once it is out; a closed or full stdout rejects (S-3923: no ack for text that didn't
// print). On a pipe the write is async, so the callback is what says it went.
function writeStdout(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // A failed write also emits 'error', after the callback; the listener stays so that event isn't unhandled.
    process.stdout.once('error', reject);
    process.stdout.write(text, (err) => (err ? reject(err) : resolve()));
  });
}

// Called by harness hooks. Must never fail the agent, so errors exit 0 silently. While the
// daemon is down (a deploy restarts it) the hook retries for up to 30 s: a lost Stop left an
// idle agent 'working', and its mail undelivered, for hours (S-188). Only a refused
// connection retries; a timeout may mean the daemon took the event, and must not repeat it.
async function hook(harness: string) {
  try {
    const input = await readStdin();
    const id = envVar('AGENT_ID');
    if (!id) return;
    for (let deadline = Date.now() + 30_000; ; ) {
      try {
        const r = await api('POST', `/api/hook/${harness}/${id}`, JSON.parse(input), 3000);
        if (r.stdout) await writeStdout(r.stdout);
        // The response is printed in full, so the notices it carried reached the agent: the daemon may delete their answer
        // rows (S-3923). A failed write throws before this line and sends no ack. A failed acknowledgement keeps the rows,
        // and a restart replays them.
        for (const row of r.ack ?? []) await api('POST', `/api/notices/${id}/ack/${row}`, undefined, 3000).catch(() => {});
        return;
      } catch (e: any) {
        if (e?.cause?.code !== 'ECONNREFUSED' || Date.now() > deadline) return;
        await sleep(500);
      }
    }
  } catch {}
}

// Reports context size to the daemon, then runs the user's own statusline, if any.
async function statusline(harness: string) {
  const input = await readStdin();
  const id = envVar('AGENT_ID');
  const reply = id ? await api('POST', `/api/statusline/${harness}/${id}`, JSON.parse(input), 1000).catch(() => undefined) : undefined;
  // The user's status line runs at most once per 30 s per agent, and never again while nobody views it (statusline-cache.ts, S-171, S-274, S-1055).
  const user = envVar('USER_STATUSLINE');
  const run = () => (user ? spawnSync(user, { input, shell: true, encoding: 'utf8', timeout: 5000 }).stdout ?? '' : '');
  const own = user && id ? throttled(join(STAM_HOME, `statusline-${id}.out`), run, Date.now(), statuslineTtl(reply?.viewed)) : run();
  process.stdout.write(`[stam ${id ?? '?'}] ${own}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!NO_HELP_CMDS.has(cmd) && wantsHelp(process.argv.slice(2))) return console.log(usageFor(cmd) || USAGE);
  switch (cmd) {
    case 'daemon':
      return daemon(rest[0], rest.includes('--replace-stamd'));
    case 'hook':
      return hook(rest[0]);
    case 'deploy': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { repo: { type: 'string' }, 'build-only': { type: 'boolean' } } });
      const { deploy, buildRelease } = await import('./deploy.ts');
      // --build-only (S-1749): the release folder on the last line, for the deploy watcher's canary, after a
      // `build-only: created NAME` or `build-only: reused NAME` line (S-1750).
      if (values['build-only']) {
        const built = await buildRelease(positionals[0], values.repo);
        console.log(`build-only: ${built.created ? 'created' : 'reused'} ${built.dir.split('/').pop()}`);
        return console.log(built.dir);
      }
      if (!(await deploy(positionals[0], values.repo))) process.exitCode = 1;
      return;
    }
    case 'rollback': {
      const { rollback } = await import('./deploy.ts');
      if (!(await rollback(rest[0]))) process.exitCode = 1;
      return;
    }
    case 'prune': {
      const { pruneLocked } = await import('./deploy.ts');
      return pruneLocked();
    }
    case 'releases': {
      const { listReleases } = await import('./deploy.ts');
      return listReleases();
    }
    case 'statusline':
      return statusline(rest[0]);
    case 'mcp': {
      const [sub, name] = rest;
      // `stam mcp` alone is the stdio server agents talk to; the subcommands manage a remote
      // server's shared login (S-50).
      if (sub === 'status') {
        const page = await api<any>('GET', '/api/mcp/status');
        // A peer's old grant from before the lease is a local login on this machine, not a logout (S-3177).
        for (const s of page.servers)
          console.log(`${s.name.padEnd(16)} ${s.type.padEnd(6)} ${s.local_grant ? 'local login on this machine' : s.logged_in ? 'logged in' : 'not logged in'}${s.expires_at ? ` (expires ${new Date(s.expires_at).toISOString()})` : ''}`);
        // On a peer the home's logins are not listed while it is down: say so, and name it (S-3178).
        if (page.home && !page.home.reachable) console.log(`${page.home.name} is unreachable: its MCP logins are not listed. ${page.home.error ?? ''}`.trimEnd());
        return;
      }
      if (sub === 'login') {
        if (!name) throw new Error('usage: stam mcp login NAME');
        try {
          const r = await api<any>('POST', `/api/mcp/${name}/login`);
          return console.log(r.url);
        } catch {
          // The login route accepts only the human through `tailscale serve`, which the CLI
          // is not; the web UI (S-51) gets the button.
          return console.log(`Log in to ${name} from the web UI's Settings.`);
        }
      }
      // A new lease token (S-3176): the old one is refused at once, the peers' copies stop working, and the
      // peer token is unchanged. The token is written to the file only, never printed.
      if (sub === 'lease-rotate') {
        rotateLeaseToken();
        return console.log(`rotated the MCP lease token (STAM_HOME/mcp-lease-token). Peers that lease from this home need the new value in settings.peers[].leaseToken.`);
      }
      if (sub === 'logout') {
        if (!name) throw new Error('usage: stam mcp logout NAME');
        // The daemon's answer is the reason: a refusal, such as a peer's logout, prints as the daemon wrote it (S-3178).
        await api('POST', `/api/mcp/${name}/logout`);
        return console.log(`logged out of ${name}`);
      }
      const { runMcp } = await import('./mcp.ts');
      return runMcp();
    }
    case 'mcp-proxy': {
      const { runMcpProxy } = await import('./mcp-proxy.ts');
      return runMcpProxy(rest[0]);
    }
    case 'settings': {
      if (rest[0] !== 'migrate') throw new Error('usage: stam settings migrate [--apply] [--json]');
      const { values: v } = parseArgs({ args: rest.slice(1), options: { apply: { type: 'boolean' }, json: { type: 'boolean' } } });
      const { runMigrate } = await import('./settings-migrate.ts');
      const r = runMigrate(!!v.apply);
      console.log(v.json ? JSON.stringify(r.result, null, 2) : r.text);
      if (r.code) process.exitCode = r.code;
      return;
    }
    case 'stats': {
      if (rest[0] !== 'comms') throw new Error('usage: stam stats comms [--days N] [--json]');
      const { values: v } = parseArgs({ args: rest.slice(1), options: { days: { type: 'string' }, json: { type: 'boolean' } } });
      const r = await api<any>('GET', `/api/stats/comms${v.days ? `?days=${encodeURIComponent(v.days)}` : ''}`);
      if (v.json) return console.log(JSON.stringify(r, null, 2));
      const table = (title: string, head: string[], rows: (string | number)[][]) => {
        console.log(`\n${title}`);
        if (!rows.length) return console.log('  none');
        const widths = head.map((h, i) => Math.max(h.length, ...rows.map((x) => String(x[i]).length)));
        for (const x of [head, ...rows]) console.log('  ' + x.map((c, i) => String(c).padEnd(widths[i])).join('  '));
      };
      const kv = (c: Record<string, number>) => Object.entries(c).map(([k, n]) => `${k} ${n}`).join(', ') || '-';
      console.log(`Comms stats, last ${r.days} days (since ${r.since})`);
      table('Mail deliveries by recipient', ['RECIPIENT', 'TYPE', 'TOTAL', 'UNREAD', 'KINDS', 'TOP SENDERS'],
        r.deliveries.map((x: any) => [x.name, x.type, x.total, x.unread, kv(x.kinds), (x.topSenders ?? []).map((s: any) => `${s.sender} ${s.n}`).join(', ')]));
      console.log(`\nMail to the human: ${r.human.received.total} (by sender: ${kv(r.human.received.bySender)}; by kind: ${kv(r.human.received.byKind)})`);
      console.log(`Human threads: ${r.human.threads.total}, the human wrote in ${r.human.threads.repliedByHuman}`);
      table('Permission requests', ['KIND', 'TOTAL', 'AUDIENCE', 'STATUS', 'DECIDED BY', 'DECIDED', 'P50 MIN', 'P90 MIN'],
        r.permissions.map((x: any) => [x.kind, x.total, kv(x.audience), kv(x.status), kv(x.decidedBy), x.decidedMinutes.n, x.decidedMinutes.p50 ?? '-', x.decidedMinutes.p90 ?? '-']));
      table('Pending asks now', ['KIND', 'COUNT', 'OLDEST MIN'], r.open.pendingAsks.map((x: any) => [x.kind, x.n, x.oldestMinutes ?? '-']));
      table('ITSAs waiting on the human', ['KEY', 'STATUS', 'IN STATUS MIN'], r.open.itsasInHumanStatus.map((x: any) => [x.key, x.status, x.inStatusMinutes ?? '-']));
      console.log(`\nOpen decision mails: ${r.open.decisionMails}; deferred threads: ${r.open.threadsDeferred}`);
      console.log(`Waits on the human: ${r.waitsOnHuman.open} open (${r.waitsOnHuman.openedInWindow} opened in the window), mean open ${r.waitsOnHuman.meanOpenMinutes ?? '-'} min`);
      const a = r.answers;
      const sp = (x: any) => `${x.n} (p50 ${x.p50 ?? '-'} min, p90 ${x.p90 ?? '-'} min)`;
      console.log(`Waits on the human closed: ${a.waitsClosed.total} (${kv(a.waitsClosed.byOutcome)}), time waited ${sp(a.waitsClosed.minutes)}`);
      console.log(`Decisions: ${a.decisions.answered} answered (${a.decisions.withChoice} with a recorded choice), ${a.decisions.deferred} deferred; time to answer ${sp(a.decisions.answeredMinutes)}; all outcomes: ${kv(a.decisions.byOutcome)}`);
      console.log(`Escalations to the human: ${a.escalations.total}, ask to escalation ${sp(a.escalations.minutesToEscalate)}`);
      return;
    }
    case 'retro': {
      const { values: v } = parseArgs({
        args: rest,
        options: {
          search: { type: 'string' }, 'plus-one': { type: 'string' }, kind: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string' }, details: { type: 'string' }, target: { type: 'string' },
          evidence: { type: 'string' }, 'evidence-detail': { type: 'string' }, when: { type: 'string' },
          final: { type: 'boolean' }, effort: { type: 'string' }, digest: { type: 'boolean' },
        },
      });
      // The digest now (S-161), mailed to the Retros owner and participants (S-1059); the human or the shared token only, an agent's token is refused (S-587).
      if (v.digest) {
        const r = await api<{ sent: boolean; to: string | null; reason: string }>('POST', '/api/retros/digest', {});
        return console.log(r.sent ? `Mailed the retro digest to ${r.to}.` : `No retro digest sent: ${r.reason}.`);
      }
      // A retro item is the agent's own, so the CLI runs as the agent it is inside (STAM_AGENT_ID).
      const by = envVar('AGENT_ID');
      if (!by) throw new Error('stam retro files as an agent: run it inside one (STAM_AGENT_ID is not set)');
      const { runRetro } = await import('./retro.ts');
      // --effort reading=50,implementing=30 for the final round (--final).
      const effort = v.effort ? Object.fromEntries(v.effort.split(',').map((kv) => { const [k, n] = kv.split('='); return [k.trim(), Number(n)]; })) : undefined;
      return console.log(await runRetro(api, by, { search: v.search, plus_one: v['plus-one'], final: v.final, effort, kind: v.kind, title: v.title, summary: v.summary, details: v.details, target: v.target, evidence: v.evidence, evidence_detail: v['evidence-detail'], when: v.when }));
    }
    case 'mail': {
      const [sub, ...args] = rest;
      if (sub === 'send') {
        const { values, positionals } = parseArgs({
          args,
          allowPositionals: true,
          options: { to: { type: 'string', multiple: true }, subject: { type: 'string' }, from: { type: 'string', default: 'human' }, system: { type: 'string' }, itsa: { type: 'string' }, override: { type: 'string' } },
        });
        // --system NAME sends as a local script (no agent behind it); it replaces --from.
        // --itsa links a script's notice to an ITSA, so it can count as read when it closes (S-717).
        const sender = values.system ? { system: values.system } : { from: values.from };
        const m = await api('POST', '/api/mail', { ...sender, to: values.to, subject: values.subject, body: positionals.join(' '), itsa: values.itsa, override: values.override });
        if (m.queued) return console.log(`queued ${m.id}: storage is unreachable; it is delivered when storage answers`);
        return console.log(`sent ${m.id}`);
      }
      if (sub === 'inbox') {
        for (const m of await api<any[]>('GET', `/api/agents/${args[0]}/inbox?unread=0`))
          console.log(`${m.id}  ${m.read_at ? 'read  ' : 'UNREAD'}  ${m.from_id}  ${m.subject}`);
        return;
      }
      if (sub === 'read') {
        for (const m of await api<any[]>('POST', `/api/agents/${args[0] ?? 'human'}/read`, { ids: args.slice(1) }))
          console.log(`## ${m.id}: ${m.subject}\nFrom: ${m.from_id} · ${m.created_at}\n\n${m.body}${m.note ? `\n\n[stam] ${m.note}` : ''}\n`);
        return;
      }
      throw new Error('usage: stam mail send --to AGENT [--to AGENT] --subject TEXT BODY | stam mail inbox AGENT');
    }
    case 'spawn': {
      // --workspace, --workspace=NAME: a personal workspace (bare means the agent's own name).
      // Node's parseArgs can't take an optional value, so it is scanned out by hand first.
      let personalWorkspace: boolean | string | undefined;
      const spawnArgs: string[] = [];
      for (const [i, arg] of rest.entries()) {
        if (arg === '--workspace') {
          // `--workspace NAME` would make NAME the prompt and the workspace the agent's own name.
          if (/^[a-z0-9-]+$/.test(rest[i + 1] ?? '') && !rest[i + 1].startsWith('-')) throw new Error(`--workspace takes its name with '=': use --workspace=${rest[i + 1]} (a bare --workspace uses the agent's name)`);
          personalWorkspace = true;
          continue;
        }
        if (arg.startsWith('--workspace=')) { personalWorkspace = arg.slice('--workspace='.length); continue; }
        spawnArgs.push(arg);
      }
      const { values, positionals } = parseArgs({
        args: spawnArgs,
        allowPositionals: true,
        options: {
          role: { type: 'string' },
          harness: { type: 'string' },
          model: { type: 'string' },
          effort: { type: 'string' },
          cwd: { type: 'string' },
          parent: { type: 'string' },
          preset: { type: 'string' },
          type: { type: 'string' },
          var: { type: 'string', multiple: true },
          itsa: { type: 'string' },
          machine: { type: 'string' },
          urgent: { type: 'string' },
          'chief-of-staff': { type: 'boolean' },
          worktree: { type: 'boolean' },
          branch: { type: 'string' },
          base: { type: 'string' },
          'workspace-script': { type: 'string' },
          'workspace-instructions': { type: 'string' },
          standing: { type: 'boolean' },
          help: { type: 'boolean', short: 'h' },
        },
      });
      // Without a NAME, spawn would make a random agent with no task: print the usage instead.
      if (values.help) return console.log(SPAWN_USAGE);
      if (!positionals.length) {
        console.error(SPAWN_USAGE);
        process.exit(1);
      }
      const [name, ...prompt] = positionals;
      // --var KEY=VALUE fills a placeholder in the type's brief.
      const { var: vars, help, ...opts } = values;
      // A spawn on another machine may wait for that peer to start and deploy (S-234, S-236).
      const remote = values.machine !== undefined && values.machine !== MACHINE;
      const a = await api('POST', '/api/agents', {
        name,
        ...opts,
        brief_vars: vars && Object.fromEntries(vars.map((v) => (v.includes('=') ? [v.slice(0, v.indexOf('=')), v.slice(v.indexOf('=') + 1)] : [v, '']))),
        workspace_script: values['workspace-script'],
        workspace: personalWorkspace,
        chief_of_staff: values['chief-of-staff'],
        workspace_instructions: values['workspace-instructions'],
        cwd: values.cwd ?? process.cwd(),
        prompt: prompt.join(' ') || undefined,
      }, remote ? 960_000 : undefined);
      if (a.warning) console.error(`warning: ${a.warning}`);
      if (a.kind === 'ring') {
        const who = (x: { name: string }) => x.name;
        return console.log(`started ring ${a.ring.name} (${a.ring.id}); members ${a.members.map(who).join(', ')}${a.moderator ? `; moderator ${a.moderator.name}` : ''}; result by mail; see: stam ring ${a.ring.name}`);
      }
      if (a.queued) return console.log(`queued ${a.name}: place ${a.place} of ${a.queue_length} for a developer slot on ${a.machine} (${a.cap} in use: ${holdersText(a.holders, a.holder_info)}); it starts when a slot frees`);
      return console.log(`spawned ${a.name} (${a.id}); attach with: stam attach ${a.name}`);
    }
    case 'ls': {
      // Live agents; `stam ls --all` adds stopped and archived ones (S-3816).
      const agents = await api<any[]>('GET', rest.includes('--all') ? '/api/agents?state=all' : '/api/agents');
      const rows = agents.map((a) => [
        a.id,
        a.name,
        a.machine,
        a.harness + (a.model ? `/${a.model}` : ''),
        a.resting ? 'resting' : a.lifecycle === 'active' ? a.activity : a.lifecycle,
        (a.activity_detail ?? '').slice(0, 40),
        k(a.context_tokens),
        age(a.updated_at),
      ]);
      const head = ['ID', 'NAME', 'MACHINE', 'HARNESS', 'STATE', 'DETAIL', 'CTX', 'AGE'];
      const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
      for (const r of [head, ...rows]) console.log(r.map((c, i) => String(c).padEnd(widths[i])).join('  '));
      return;
    }
    case 'show':
      return console.log(JSON.stringify(await api('GET', `/api/agents/${rest[0]}`), null, 2));
    case 'events': {
      // `stam events AGENT --type 'input:*' --limit 20`: the latest events of that type (a GLOB), else the latest 50 (S-2451).
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { type: { type: 'string' }, limit: { type: 'string' } },
      });
      const query = new URLSearchParams();
      if (values.type) query.set('type', values.type);
      if (values.limit) query.set('limit', values.limit);
      const qs = query.size ? `?${query}` : '';
      for (const e of await api<any[]>('GET', `/api/agents/${positionals[0]}/events${qs}`)) console.log(e.ts, e.type, e.data ?? '');
      return;
    }
    case 'wait': {
      // Polls until the agent's state matches one of the given states, for example
      // `stam wait worker --until idle,blocked --timeout 120`.
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { until: { type: 'string', default: 'idle' }, timeout: { type: 'string', default: '120' } },
      });
      const want = values.until.split(',');
      const deadline = Date.now() + Number(values.timeout) * 1000;
      while (Date.now() < deadline) {
        const a = await api('GET', `/api/agents/${positionals[0]}`);
        const state = a.resting ? 'resting' : a.lifecycle === 'active' ? a.activity : a.lifecycle;
        if (want.includes(state)) return console.log(`${a.name}: ${state} ${a.activity_detail ?? ''}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
      console.error(`timed out waiting for ${values.until}`);
      process.exitCode = 2;
      return;
    }
    case 'web': {
      const { bindAddresses } = await import('./daemon.ts');
      const { readToken, PORT } = await import('./config.ts');
      const { hasTailscale } = await import('./tailscale.ts');
      const tailscale = hasTailscale();
      if (rest[0] === 'serve' && !tailscale) {
        console.error('stam web serve needs tailscale on PATH (https://tailscale.com/download); without it, use the addresses `stam web` prints');
        process.exitCode = 1;
        return;
      }
      if (rest[0] === 'serve') {
        // HTTPS on the tailnet through `tailscale serve`; the owner's devices need no token.
        const args = ['serve', '--bg', '--https=443', `http://127.0.0.1:${PORT}`];
        if (spawnSync('tailscale', args, { stdio: 'inherit' }).status !== 0) spawnSync('sudo', ['tailscale', ...args], { stdio: 'inherit' });
      }
      // With local login on (S-2121), the token-less page on this machine logs in as the human, so it is the
      // first address; a token link isn't the human, so it can look but not approve.
      const { settings } = await import('./settings.ts');
      const local = settings().auth.localHuman && process.platform === 'linux';
      if (local) console.log(`http://127.0.0.1:${PORT}/   (this machine: log in as the human with a one-time command)`);
      if (tailscale) try {
        const s = JSON.parse(spawnSync('tailscale', ['serve', 'status', '--json'], { encoding: 'utf8' }).stdout);
        for (const host of Object.keys(s.Web ?? {}))
          if (JSON.stringify(s.Web[host]).includes(`127.0.0.1:${PORT}`)) console.log(`https://${host.replace(/:443$/, '')}/   (your Tailscale devices, no token)`);
      } catch {}
      for (const addr of bindAddresses()) console.log(`http://${addr}:${PORT}/#token=${readToken()}${local ? '   (token link: not the human, so approvals and settings are refused)' : ''}`);
      return;
    }
    case 'attach': {
      const a = await api('GET', `/api/agents/${rest[0]}`);
      spawnSync('tmux', tmux.attachArgs(a.id), { stdio: 'inherit' });
      return;
    }
    case 'cancel': {
      // A developer spawn still queued for a slot, by its name (S-2134).
      const r = await api('POST', `/api/slot-queue/${rest[0]}/cancel`, {});
      return console.log(`${r.name}: queued spawn cancelled on ${r.machine}`);
    }
    case 'pause':
    case 'unpause':
    case 'shutdown':
    case 'archive':
    case 'resume':
    case 'restart':
    case 'reconnect-mcp':
    case 'compact': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { now: { type: 'boolean' }, force: { type: 'boolean' }, discard: { type: 'boolean' }, 'force-unpushed': { type: 'boolean' } },
      });
      const [ref, ...words] = positionals;
      const text = words.join(' ') || undefined;
      const r = await api('POST', `/api/agents/${ref}/${cmd}`, { ...values, force_unpushed: values['force-unpushed'], note: text, reason: text, instructions: text });
      return console.log(`${r.agent.name}: ${r.result}`);
    }
    case 'rename':
    case 'reparent': {
      // reparent AGENT [PARENT...]: no parent makes it top-level.
      const [ref, ...args] = rest;
      const body = cmd === 'rename' ? { name: args[0] } : { parent: args };
      const r = await api('POST', `/api/agents/${ref}/${cmd === 'rename' ? 'rename' : 'set-parent'}`, body);
      return console.log(r.result);
    }
    case 'child-notices': {
      const [ref, value] = rest;
      const r = await api('POST', `/api/agents/${ref}/set-child-notices`, { child_notices: value });
      return console.log(`${r.agent?.name ?? ref}: ${r.result}`);
    }
    case 'doctor': {
      const { values: v } = parseArgs({ args: rest, options: { json: { type: 'boolean' } } });
      const { doctor, formatReport } = await import('./doctor.ts');
      const report = await doctor({ stamHome: STAM_HOME, port: PORT, packageJson: join(ROOT, 'package.json'), health: () => api('GET', '/api/health', undefined, 3000), onboarding: () => api('GET', '/api/onboarding') });
      console.log(v.json ? JSON.stringify(report, null, 2) : formatReport(report));
      if (!report.ok) process.exitCode = 1;
      return;
    }
    case 'onboarding':
      return console.log(JSON.stringify(await api('GET', '/api/onboarding'), null, 2));
    case 'registry': {
      if (rest[0] === 'migrate-reviewers') {
        const { values: v } = parseArgs({ args: rest.slice(1), options: { apply: { type: 'boolean' } } });
        const { runMigrateReviewers } = await import('./reviewer-migrate.ts');
        const m = runMigrateReviewers(!!v.apply);
        console.log(m.text);
        if (m.code) process.exitCode = m.code;
        return;
      }
      const r = await api('GET', '/api/registry');
      console.log('Agent types (stam spawn NAME --type T):');
      for (const [n, t] of Object.entries<any>(r.types ?? {})) console.log(`  ${n.padEnd(16)} ${t.harness ? `${t.harness}/${t.model ?? 'default'}${t.effort ? ` (${t.effort})` : ''}` : 'ring'}: ${t.description}`);
      console.log('Presets:');
      for (const [n, p] of Object.entries<any>(r.presets)) console.log(`  ${n.padEnd(16)} ${p.harness}/${p.model ?? 'default'}${p.effort ? ` (${p.effort})` : ''}: ${p.description}`);
      console.log('Harnesses:');
      for (const [n, h] of Object.entries<any>(r.harnesses)) console.log(`  ${n.padEnd(16)} ${h.version ?? 'not installed'}`);
      console.log('Models:');
      for (const [n, m] of Object.entries<any>(r.models)) console.log(`  ${n.padEnd(48)} ${m.harnesses.join(', ')}`);
      return console.log('Any other model name also works; it passes straight to the harness.');
    }
    case 'upgrade-harness': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { command: { type: 'string' } } });
      const r = await api('POST', `/api/harness/${positionals[0]}/upgrade`, { command: values.command }, 660_000);
      console.log(`${positionals[0]}: ${r.from} -> ${r.to}`);
      return console.log(r.agents.length ? `restarting when idle: ${r.agents.join(', ')}` : 'no running agents to restart');
    }
    case 'archive-resolved': {
      if (envVar('AGENT_ID')) throw new Error("only the human, or cos with approval, archives the human's threads from the CLI");
      const r = await api<{ dry: boolean; count: number; threads: { thread_id: string; subject: string }[] }>('POST', '/api/mail/resolved', { dry: !rest.includes('--apply'), all: rest.includes('--all') });
      console.log(`${r.count} thread(s) ${r.dry ? 'would be archived (dry run; --apply archives them)' : 'archived'}:`);
      for (const t of r.threads) console.log(`${t.thread_id}  ${t.subject}`);
      return;
    }
    case 'permissions': {
      for (const r of await api<any[]>('GET', '/api/permissions?status=pending&audience=human'))
        console.log(`${r.id}  ${r.agent_id}  ${r.action}\n        why: ${r.reason}${r.details ? `\n        details: ${r.details}` : ''}`);
      // Harness dialogs still with the agent's parent or the chief of staff (S-594): they deny one or
      // send it on to you; `stam authorize` still approves one, since only the human approves a dialog.
      const delegated = (await api<any[]>('GET', '/api/permissions?status=pending&audience=delegate')).filter((r) => r.dialog);
      if (delegated.length) console.log('\nWith a parent or the chief of staff, who deny it or send it on to you:');
      for (const r of delegated) console.log(`${r.id}  ${r.agent_id}  ${r.action}\n        with: ${(r.with ?? []).map((n: string) => '@' + n).join(', ') || 'its reviewers'}`);
      return;
    }
    case 'authorize':
    case 'deny': {
      if (envVar('AGENT_ID')) throw new Error('only the human answers permission requests from the CLI');
      const [id, ...note] = rest;
      const r = await api('POST', `/api/permissions/${id}/answer`, { approve: cmd === 'authorize', note: note.join(' ') });
      return console.log(`${r.id}: ${r.status}${r.typed ? ', typed into the agent\'s input as yours' : r.status === 'approved' ? '; the agent was busy or had a draft, so it got a notice instead' : ''}`);
    }
    case 'ring': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          format: { type: 'string', default: 'rounds' },
          members: { type: 'string' },
          spawn: { type: 'string' },
          moderator: { type: 'string' },
          decide: { type: 'boolean' },
          rounds: { type: 'string' },
          cwd: { type: 'string' },
        },
      });
      const [name, ...topic] = positionals;
      if (!name) {
        for (const r of await api<any[]>('GET', '/api/rings')) console.log(`${r.id}  ${r.name}  ${r.format}  ${r.status}  round ${r.round}/${r.max_rounds}`);
        return;
      }
      if (!topic.length) return console.log(JSON.stringify(await api('GET', `/api/rings/${name}`), null, 2));
      // --spawn takes presets or models, comma-separated: "fast,second-opinion" or "openrouter/deepseek/deepseek-v4.1-flash".
      const spawn = (values.spawn ?? '').split(',').filter(Boolean).map((s) => (s.includes('/') || s.startsWith('claude-') ? { harness: s.includes('/') ? 'opencode' : 'claude', model: s } : { preset: s }));
      const r = await api(
        'POST',
        '/api/rings',
        {
          name,
          topic: topic.join(' '),
          format: values.format,
          members: (values.members ?? '').split(',').filter(Boolean),
          spawn,
          moderator: values.moderator,
          moderator_decides: values.decide,
          max_rounds: values.rounds,
          cwd: values.cwd ?? process.cwd(),
        },
        180_000,
      );
      return console.log(`ring ${r.name} (${r.id}) started; the result arrives in your inbox`);
    }
    case 'pr': {
      // The PR relay (S-514), as the pr_open tool: stam pr open BRANCH --title T --body-file F [--itsa REF]; --predict is its dry run (S-3287).
      const [sub, ...args] = rest;
      if (sub === 'review') {
        // The verdict relay (S-1061), as the pr_review tool: stam pr review N approve|request_changes "SUMMARY" --head SHA.
        const { values: rv, positionals: rp } = parseArgs({ args, allowPositionals: true, options: { head: { type: 'string' } } });
        if (rp.length !== 3 || !rv.head) throw new Error('usage: stam pr review N approve|request_changes "SUMMARY" --head SHA');
        const [pr, verdict, summary] = rp;
        const r = await api<any>('POST', '/api/pr/review', { pr, verdict, summary, head: rv.head, by: envVar('AGENT_ID') });
        return console.log(`Posted ${r.verdict} on PR #${r.pr} at ${String(r.head).slice(0, 7)}: ${r.line}`);
      }
      const { values: v, positionals } = parseArgs({ args, allowPositionals: true, options: { title: { type: 'string' }, 'body-file': { type: 'string' }, itsa: { type: 'string' }, predict: { type: 'boolean' } } });
      if (sub === 'open' && v.predict) {
        // The dry run (S-3287): the NAME: PASS lines the body must carry; needs no title or body, pushes nothing to GitHub.
        if (positionals.length !== 1) throw new Error('usage: stam pr open BRANCH --predict');
        const { formatPrediction } = await import('./pr-predict-format.ts');
        return console.log(formatPrediction(await api<any>('POST', '/api/pr/predict', { branch: positionals[0], by: envVar('AGENT_ID') }, 360_000)));
      }
      if (sub !== 'open' || positionals.length !== 1 || !v.title || !v['body-file']) throw new Error('usage: stam pr open BRANCH --title "TITLE" --body-file FILE [--itsa REF] | stam pr open BRANCH --predict');
      const r = await api<any>('POST', '/api/pr/open', { branch: positionals[0], title: v.title, body: readFileSync(v['body-file'], 'utf8'), itsa: v.itsa, by: envVar('AGENT_ID') });
      console.log(`${r.created ? 'Opened' : 'Updated'} PR #${r.number}: ${r.url}`);
      return r.warning ? console.log(`WARNING: ${r.warning}`) : undefined;
    }
    case 'deps': {
      // S-1662: stam deps relink [--force] relinks this worktree's node_modules from the lockfile-keyed cache; stam deps check only reports.
      const [sub, ...args] = rest;
      const { values: v } = parseArgs({ args, allowPositionals: true, options: { force: { type: 'boolean' } } });
      const { depsStatus, relinkDeps, relinkRefusal } = await import('./workspace.ts');
      const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();
      if (!top) throw new Error('stam deps: run it inside a git worktree');
      if (sub === 'relink') {
        const why = relinkRefusal(top, v.force);
        if (why) throw new Error(why);
      }
      if (sub === 'check') {
        for (const s of depsStatus(top)) console.log(`${s.dir}: ${s.state}${s.detail ? ` (${s.detail})` : ''}`);
        return;
      }
      if (sub !== 'relink') throw new Error('usage: stam deps relink [--force] | stam deps check');
      for (const r of await relinkDeps(top, v.force)) {
        console.log(`${r.dir}: ${r.event === 'ok' ? 'already matches package-lock.json (--force to relink)' : r.event}${r.key ? ` (lockfile ${r.key})` : ''}${r.aside ? `; old node_modules moved to ${r.aside}` : ''}`);
      }
      return;
    }
    case 'itsa': {
      const [sub, ...args] = rest;
      const { values: v, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
          parent: { type: 'string' }, subtree: { type: 'string' }, status: { type: 'string' }, category: { type: 'string' }, since: { type: 'string' }, json: { type: 'boolean' },
          owner: { type: 'string' }, participant: { type: 'string', multiple: true }, 'add-participant': { type: 'string', multiple: true }, kind: { type: 'string' },
          title: { type: 'string' }, summary: { type: 'string' }, body: { type: 'string' },
          link: { type: 'string', multiple: true }, update: { type: 'string' }, to: { type: 'string', multiple: true }, system: { type: 'string' }, override: { type: 'string' }, 'external-id': { type: 'string' }, repo: { type: 'string' }, remove: { type: 'string' },
          field: { type: 'string', multiple: true }, 'if-status': { type: 'string' }, type: { type: 'string' }, label: { type: 'string' }, description: { type: 'string' }, option: { type: 'string', multiple: true }, hint: { type: 'string' }, width: { type: 'string' }, align: { type: 'string' }, card: { type: 'string' },
        },
      });
      // An ITSA action is the agent's own when the CLI runs inside one (STAM_AGENT_ID);
      // otherwise it is the human's. The daemon resolves `by`, local or on a peer.
      const by = envVar('AGENT_ID');
      if (sub === 'ls') {
        const q = new URLSearchParams();
        for (const key of ['parent', 'subtree', 'status', 'category', 'owner', 'kind'] as const) if (v[key]) q.set(key, String(v[key]));
        if (v.participant?.length) q.set('participant', v.participant[0]);
        if (positionals.length) q.set('text', positionals.join(' '));
        // --since is passed as typed; the daemon reads it (an age or an ISO time) and refuses a bad one (S-1396).
        if (v.since !== undefined) q.set('since', v.since);
        const rows = await api<any[]>('GET', `/api/itsas${q.toString() ? '?' + q : ''}`);
        if (v.json) return console.log(JSON.stringify(rows, null, 2));
        for (const x of rows)
          console.log(`${x.key.padEnd(6)} ${x.status.padEnd(14)} ${(x.owner ?? '-').padEnd(16)} ${x.title}`);
        return;
      }
      if (sub === 'show') {
        if (!positionals[0]) throw new Error('usage: stam itsa show REF');
        return console.log(JSON.stringify(await api('GET', `/api/itsas/${positionals[0]}`), null, 2));
      }
      if (sub === 'new') {
        const title = positionals.join(' ');
        if (!title) throw new Error('usage: stam itsa new TITLE [--parent REF] ...');
        const x = await api<any>('POST', '/api/itsas', {
          title, parent: v.parent, kind: v.kind, status: v.status, owner: v.owner, summary: v.summary, body: v.body,
          participants: v.participant, links: (v.link ?? []).map((url) => ({ url })), by, as_system: v.system,
        });
        return console.log(`${x.key}  ${x.title}`);
      }
      if (sub === 'set') {
        const ref = positionals[0];
        const patch: any = {};
        for (const key of ['title', 'summary', 'body', 'kind', 'status', 'owner', 'parent'] as const) if (v[key] !== undefined) patch[key] = v[key];
        if (v.participant) patch.participants = v.participant;
        if (v['add-participant']?.length) patch.addParticipants = v['add-participant'];
        // Compare-and-set (S-3802): refused, as "status changed", unless the ITSA is still in this status.
        if (v['if-status'] !== undefined) patch.ifStatus = v['if-status'];
        if (v.field?.length) {
          // Values are typed by their field: a number field takes a finite number, a check true or false, the rest strings.
          const defs = await api<any[]>('GET', '/api/itsas/fields');
          patch.fields = Object.fromEntries(v.field.map((kv) => {
            const i = kv.indexOf('=');
            if (i < 1) throw new Error(`--field takes key=value (key= clears), got ${kv}`);
            const key = kv.slice(0, i);
            const raw = kv.slice(i + 1);
            if (raw === '') return [key, null];
            const type = defs.find((f) => f.key === key || f.id === key)?.type;
            if (type === 'number') {
              const n = Number(raw);
              if (!Number.isFinite(n)) throw new Error(`field ${key} is a number: ${raw} isn't one`);
              return [key, n];
            }
            if (type === 'check') {
              if (raw !== 'true' && raw !== 'false') throw new Error(`field ${key} is a check: use true or false, not ${raw}`);
              return [key, raw === 'true'];
            }
            return [key, raw];
          }));
        }
        if (!ref || !Object.keys(patch).length) throw new Error('usage: stam itsa set REF [--status S] [--owner REF] ...');
        // --system NAME acts as a local script (the deploy watcher, S-474), not as the human.
        const r = await api<any>('PATCH', `/api/itsas/${ref}`, { ...patch, by, as_system: v.system });
        const changed = Object.entries(r.changes).map(([f, c]: [string, any]) => (f === 'fields' ? fieldsChange(c) : `${f}: ${c.from ?? '-'} -> ${c.to ?? '-'}`));
        console.log(`${r.itsa.key}: ${changed.join('; ') || 'nothing changed'}`);
        if (r.retro_offer) console.log(`\n${r.retro_offer}`);
        return;
      }
      if (sub === 'field') {
        const [op, ...rest2] = positionals;
        const show = (f: any) => `${f.key.padEnd(12)} ${f.type.padEnd(7)} ${f.label}${f.options ? ` (${f.options.map((o: any) => o.value).join('|')})` : ''}${f.description ? ` — ${f.description}` : ''}`;
        const body: any = { by };
        for (const k of ['label', 'type', 'description', 'hint', 'width', 'align', 'card'] as const) if (v[k] !== undefined) body[k] = v[k];
        // Options named again keep their label and tone; new ones start bare. On `set`, the list given replaces the old one.
        if (v.option?.length) {
          const old = op === 'set' && rest2[0] ? ((await api<any[]>('GET', '/api/itsas/fields')).find((f) => f.key === rest2[0] || f.id === rest2[0])?.options ?? []) : [];
          body.options = v.option.map((value) => old.find((o: any) => o.value === value) ?? { value });
        }
        if (!op || op === 'ls') {
          for (const f of await api<any[]>('GET', '/api/itsas/fields')) console.log(show(f));
          return;
        }
        if (op === 'new') {
          const [key, ...label] = rest2;
          if (!key || (!label.length && !v.label) || !v.type) throw new Error('usage: stam itsa field new KEY LABEL --type text|number|choice|link|date|check [--option VALUE]... [--description T]');
          return console.log(show(await api<any>('POST', '/api/itsas/fields', { ...body, key, label: v.label ?? label.join(' ') })));
        }
        if (op === 'set') {
          if (!rest2[0]) throw new Error('usage: stam itsa field set KEY [--label T] [--type T] [--description T] [--option V]...');
          return console.log(show(await api<any>('PATCH', `/api/itsas/fields/${rest2[0]}`, body)));
        }
        if (op === 'rm') {
          if (!rest2[0]) throw new Error('usage: stam itsa field rm KEY');
          await api('DELETE', `/api/itsas/fields/${rest2[0]}`, { by });
          return console.log(`removed field ${rest2[0]} and its values`);
        }
        if (op === 'order') {
          for (const f of await api<any[]>('POST', '/api/itsas/fields/order', { order: rest2, by })) console.log(show(f));
          return;
        }
        throw new Error('usage: stam itsa field ls|new|set|rm|order');
      }
      if (sub === 'post') {
        const [ref, ...text] = positionals;
        const body = text.join(' ');
        if (!ref || !body) throw new Error('usage: stam itsa post REF BODY [--update HEALTH] [--to REF]...');
        const m = await api<any>('POST', `/api/itsas/${ref}/post`, { body, kind: v.update ? 'update' : 'comment', health: v.update, to: v.to, override: v.override, by, as_system: v.system });
        return console.log(`posted ${m.id} in thread ${m.thread_id}`);
      }
      if (sub === 'thread') {
        if (!positionals[0]) throw new Error('usage: stam itsa thread REF');
        const t = await api<any>('GET', `/api/itsas/${positionals[0]}/thread`);
        for (const i of t.items)
          console.log(i.type === 'event' ? `${i.ts}  -- ${i.text}` : `${i.ts}  ${i.mail.from_name}${i.mail.kind === 'update' ? ` [update ${i.mail.health}]` : ''}: ${i.mail.body.split('\n')[0]}`);
        return;
      }
      // The mails of an ITSA's own thread (not the caller's part of it), as this daemon holds it (no peer fan-out), as JSON: scripts/merge-pr.mjs reads the user's mailed yes (S-1490). Fails when the thread can't be read.
      if (sub === 'mails') {
        if (!positionals[0]) throw new Error('usage: stam itsa mails REF');
        const t = await api<any>('GET', `/api/itsas/${positionals[0]}/thread?local=1`);
        const pick = (m: any) => ({ id: m.id, thread_id: m.thread_id, from_id: m.from_id, kind: m.kind ?? null, created_at: m.created_at, reply_to: m.reply_to ?? null, subject: m.subject, body: m.body });
        return console.log(JSON.stringify(t.items.filter((i: any) => i.type === 'mail').map((i: any) => pick(i.mail))));
      }
      // The mails about an ITSA from other threads (its chip asks) on this daemon, as JSON: scripts/merge-pr.mjs counts a yes to one (S-1819).
      if (sub === 'about-mails') {
        if (!positionals[0]) throw new Error('usage: stam itsa about-mails REF');
        return console.log(JSON.stringify(await api<any>('GET', `/api/itsas/${positionals[0]}/about-mails`)));
      }
      // Whether an ITSA or a parent is marked an incident, as JSON {"marked":bool}: scripts/merge-pr.mjs puts such a PR first in the queue (S-3324).
      if (sub === 'incident') {
        if (!positionals[0]) throw new Error('usage: stam itsa incident REF');
        return console.log(JSON.stringify(await api<any>('GET', `/api/itsas/${positionals[0]}/incident`)));
      }
      if (sub === 'link') {
        const ref = positionals[0];
        if (!ref) throw new Error('usage: stam itsa link REF URL | stam itsa link REF --system branch --external-id BRANCH --repo REPO | stam itsa link REF --remove N');
        if (v.remove) {
          await api('DELETE', `/api/itsas/${ref}/links/${v.remove}`, { by });
          return console.log(`removed link ${v.remove}`);
        }
        const url = positionals[1] ?? '';
        if (!url && v.system !== 'branch') throw new Error('usage: stam itsa link REF URL | stam itsa link REF --system branch --external-id BRANCH --repo REPO');
        const r = await api<any>('POST', `/api/itsas/${ref}/links`, { url, system: v.system, external_id: v['external-id'], repo: v.repo, by });
        return console.log(`link ${r.link.n}: ${r.link.system} ${r.link.url}`);
      }
      throw new Error('usage: stam itsa ls|show|new|set|field|post|thread|link');
    }
    case 'req': {
      const [sub, ...args] = rest;
      const { values: v, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
          parent: { type: 'string' }, status: { type: 'string' }, level: { type: 'string' },
          title: { type: 'string' }, text: { type: 'string' }, rationale: { type: 'string' }, source: { type: 'string' },
          severity: { type: 'string' }, mode: { type: 'string' }, threshold: { type: 'string' }, owner: { type: 'string' },
          verify: { type: 'string', multiple: true }, scope: { type: 'string', multiple: true },
          kind: { type: 'string' }, role: { type: 'string' }, remove: { type: 'string' }, keys: { type: 'string' },
        },
      });
      // As for itsa: the CLI acts as the agent when run inside one (STAM_AGENT_ID), else the human.
      const by = envVar('AGENT_ID');
      // `--verify test:npm test` -> {method, detail}; a bare `pattern` -> {method}.
      const verifications = v.verify?.map((s) => {
        const i = s.indexOf(':');
        return i < 0 ? s : { method: s.slice(0, i), detail: s.slice(i + 1) };
      });
      // `--scope paths=src/**,docs/** --scope repos=stam2` -> { paths: [...], repos: [...] }.
      const scope = v.scope?.length
        ? Object.fromEntries(
            v.scope.map((s) => {
              const i = s.indexOf('=');
              if (i < 1) throw new Error(`--scope takes field=a,b (got ${s})`);
              return [s.slice(0, i), s.slice(i + 1).split(',').map((x) => x.trim()).filter(Boolean)];
            }),
          )
        : undefined;
      const threshold = v.threshold === undefined ? undefined : Number(v.threshold);
      const fields = (): Record<string, unknown> => {
        const patch: Record<string, unknown> = {};
        for (const key of ['title', 'text', 'rationale', 'source', 'level', 'severity', 'mode', 'status', 'owner', 'parent'] as const)
          if (v[key] !== undefined) patch[key] = v[key];
        if (threshold !== undefined) patch.threshold = threshold;
        if (verifications) patch.verification = verifications;
        if (scope) patch.scope = scope;
        return patch;
      };
      if (sub === 'check') {
        const r = await api<any>('POST', '/api/requirements/check', { text: v.text, subject: positionals[0], keys: v.keys });
        console.log(`${r.subject}${r.results.length ? '' : ': no requirement in scope, or no answer'}`);
        for (const x of r.results) console.log(`${x.key}\t${x.verdict}\tp(violates) ${x.p_violates?.toFixed(2) ?? '-'}${x.cached ? '\t(cached)' : ''}`);
        return;
      }
      if (sub === 'ls') {
        const q = new URLSearchParams();
        if (v.status) q.set('status', v.status);
        if (v.parent) q.set('parent', v.parent);
        if (positionals.length) q.set('text', positionals.join(' '));
        for (const x of await api<any[]>('GET', `/api/requirements${q.toString() ? '?' + q : ''}`))
          console.log(`${x.key.padEnd(6)} ${String(x.status).padEnd(10)} ${(x.owner ?? '-').padEnd(16)} ${x.title}`);
        return;
      }
      if (sub === 'show') {
        if (!positionals[0]) throw new Error('usage: stam req show REF');
        return console.log(JSON.stringify(await api('GET', `/api/requirements/${positionals[0]}`), null, 2));
      }
      if (sub === 'new') {
        const title = positionals.join(' ');
        if (!title) throw new Error('usage: stam req new TITLE [--parent REF] ...');
        const x = await api<any>('POST', '/api/requirements', { ...fields(), title, by });
        return console.log(`${x.key}  ${x.title}`);
      }
      if (sub === 'set') {
        const ref = positionals[0];
        const patch = fields();
        if (!ref || !Object.keys(patch).length) throw new Error('usage: stam req set REF [--status S] [--text T] ...');
        const r = await api<any>('PATCH', `/api/requirements/${ref}`, { ...patch, by });
        const changed = Object.entries(r.changes).map(([f, c]: [string, any]) => `${f}: ${c.from ?? '-'} -> ${c.to ?? '-'}`);
        console.log(`${r.requirement.key}: ${changed.join('; ') || 'nothing changed'}`);
        return;
      }
      if (sub === 'seed') {
        // A JSON file of drafts, a list or {requirements: [...]} (docs/requirements-seed.json).
        if (!positionals[0]) throw new Error('usage: stam req seed FILE');
        const raw = JSON.parse(readFileSync(positionals[0], 'utf8'));
        const r = await api<any>('POST', '/api/requirements/batch', { requirements: Array.isArray(raw) ? raw : raw.requirements, by });
        for (const x of r.requirements) console.log(`${x.key.padEnd(6)} ${x.title}`);
        console.log(`${r.requirements.length} drafts${r.approval?.itsa ? `; approval ask ${r.approval.itsa} (to ${r.approval.to})` : r.approval?.error ? `; no ask: ${r.approval.error}` : ''}`);
        return;
      }
      if (sub === 'link') {
        const ref = positionals[0];
        if (!ref) throw new Error('usage: stam req link REF TARGET [--kind K] [--role R] | stam req link REF --remove ID');
        if (v.remove) {
          await api('DELETE', `/api/requirements/${ref}/links/${v.remove}`);
          return console.log(`removed link ${v.remove}`);
        }
        const target = positionals[1];
        if (!target) throw new Error('usage: stam req link REF TARGET [--kind K] [--role R]');
        const r = await api<any>('POST', `/api/requirements/${ref}/links`, { target, target_kind: v.kind, role: v.role });
        return console.log(`link ${r.id}: ${r.target_kind} ${r.role} ${r.target}`);
      }
      throw new Error('usage: stam req ls|show|new|set|link|check|seed');
    }
    case 'subscribe': {
      const { values } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          source: { type: 'string' }, subject: { type: 'string', multiple: true }, type: { type: 'string', multiple: true },
          actor: { type: 'string', multiple: true }, 'exclude-actor': { type: 'string', multiple: true },
          itsa: { type: 'string' }, for: { type: 'string' }, note: { type: 'string' }, 'expires-in': { type: 'string' },
        },
      });
      // Run inside an agent the subscription is its own; otherwise it is the human's.
      const by = envVar('AGENT_ID');
      const kind = values.itsa ? 'itsa' : values.for === 'human' || (!values.for && !by) ? 'human' : 'agent';
      const id = values.itsa ?? (kind === 'human' ? 'human' : values.for ?? by);
      const r = await api<any>('POST', '/api/subscriptions', {
        subscriber_kind: kind,
        subscriber_id: id,
        filter: { source: values.source, subjects: values.subject, types: values.type, actors: values.actor, exclude_actors: values['exclude-actor'] },
        note: values.note,
        expires_in_minutes: values['expires-in'] ? Number(values['expires-in']) : undefined,
        by,
      });
      return console.log(`subscribed ${r.id}`);
    }
    case 'unsubscribe': {
      const id = rest[0];
      if (!id) throw new Error('usage: stam unsubscribe ID');
      await api('DELETE', `/api/subscriptions/${id}`, { by: envVar('AGENT_ID') });
      return console.log(`removed ${id}`);
    }
    case 'subscriptions': {
      const by = envVar('AGENT_ID') ?? 'human';
      for (const s of await api<any[]>('GET', `/api/subscriptions?by=${encodeURIComponent(by)}`))
        console.log(`${s.id}  ${s.subscriber_kind}:${s.subscriber_id}  ${JSON.stringify(s.filter)}${s.note ? '  ' + s.note : ''}`);
      return;
    }
    case 'allocate': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          tree: { type: 'string' }, account: { type: 'string' }, kind: { type: 'string' }, window: { type: 'string' },
          percent: { type: 'string' }, amount: { type: 'string' }, period: { type: 'string' },
          note: { type: 'string' }, clear: { type: 'boolean' }, id: { type: 'string' },
        },
      });
      // Run inside an agent (STAM_AGENT_ID) the allocation is its own; otherwise it is the human's.
      const by = envVar('AGENT_ID');
      const tree = positionals[0] ?? values.tree;
      if (!tree && !values.id) {
        const r = await api<{ allocations: any[] }>('GET', '/api/cost/allocations');
        if (!r.allocations.length) return console.log('no allocations');
        for (const a of r.allocations) {
          const scope = a.kind === 'usd' ? `$${a.amount}/${a.period}` : `${a.percent}% of ${a.account} ${String(a.window).replace('_', '-')}`;
          const use = a.kind === 'usd' ? `$${a.used}` : `${a.used}%`;
          console.log(`${a.id}  ${a.root.padEnd(16)} ${scope.padEnd(34)} used ${use} (${Math.round(a.used_percent ?? 0)}%)`);
        }
        return;
      }
      const kind = values.kind ?? (values.amount !== undefined ? 'usd' : 'window');
      const r = await api<any>('POST', '/api/cost/allocate', {
        tree, id: values.id, account: values.account, kind, window: values.window,
        percent: values.percent !== undefined ? Number(values.percent) : undefined,
        amount: values.amount !== undefined ? Number(values.amount) : undefined,
        period: values.period, note: values.note, clear: values.clear, by,
      });
      if (r.cleared !== undefined) return console.log(`cleared ${r.cleared} allocation${r.cleared === 1 ? '' : 's'}`);
      console.log(`allocation ${r.allocation.id} on ${tree}`);
      return r.warning ? console.log(r.warning) : undefined;
    }
    case 'usage': {
      const u = await api('GET', `/api/usage?days=${rest[0] ?? 14}`);
      for (const s of u.subscriptions)
        for (const [w, v] of Object.entries<any>(s.windows))
          if (windowLine(s.name, w, v)) console.log(windowLine(s.name, w, v));
      console.log(`today: $${u.today.cost_usd ?? 0}, ${u.today.tokens_in ?? 0} tokens in, ${u.today.tokens_out ?? 0} out`);
      console.log('by model:');
      for (const r of u.by_model) console.log(`  ${`${r.harness}/${r.model}`.padEnd(56)} $${r.cost_usd}`);
      console.log('by agent:');
      for (const r of u.by_agent) console.log(`  ${r.agent.padEnd(30)} $${r.cost_usd}`);
      return console.log(u.note);
    }
    case 'activity': {
      const { values } = parseArgs({
        args: rest,
        options: { ingest: { type: 'boolean' }, classify: { type: 'boolean' }, 'classify-model': { type: 'boolean' }, since: { type: 'string' }, agent: { type: 'string' }, by: { type: 'string' }, days: { type: 'string' }, closed: { type: 'boolean' }, summary: { type: 'boolean' }, scope: { type: 'string' }, json: { type: 'boolean' } },
      });
      if (values.summary) return await printSummary(values.scope, values.days, values.json);
      if (values['classify-model']) {
        // The backfill runs in the daemon (S-252): start it, then poll its progress until it stops.
        const human = (e: Error): never => {
          if (/only the human/.test(e.message)) throw new Error('a backfill spends OpenRouter credit, so only the human can start it: Settings › Mail to you › Classify since…');
          throw e;
        };
        await api('POST', '/api/activity/classify-model', { since: values.since }).catch(human);
        console.log('started');
        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          const p = await api<{ running: boolean; labelled: number; remaining: number; stopped: 'done' | 'capped' | 'stalled' | null; lastError: string | null }>('GET', '/api/activity/classify-model').catch(human);
          const counts = `${p.labelled} labelled · ${p.remaining} left`;
          if (!p.running) {
            const why = p.stopped === 'capped' ? 'capped' : p.stopped === 'done' ? 'done' : /HTTP 429/.test(p.lastError ?? '') ? 'rate limited' : `failing${p.lastError ? ` (${p.lastError})` : ''}`;
            console.log(`${counts} · stopped: ${why}`);
            return;
          }
          console.log(counts);
        }
      }
      if (values.classify) {
        const c = await api<{ agent: string; items: number }[]>('POST', '/api/activity/classify', { agent: values.agent });
        for (const x of c) console.log(`${x.agent}: ${x.items} item${x.items === 1 ? '' : 's'} classified`);
        return;
      }
      if (!values.ingest) return await printActivity(values.by ?? 'agent', values.days, values.closed);
      const r = await api<{ agent: string; items: number; error?: string }[]>('POST', '/api/activity/ingest', { agent: values.agent });
      for (const x of r) console.log(`${x.agent}: ${x.error ? `error: ${x.error}` : `${x.items} item${x.items === 1 ? '' : 's'}`}`);
      return;
    }
    case 'cost-pause': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { until: { type: 'string' }, account: { type: 'string' }, window: { type: 'string' }, clear: { type: 'boolean' }, reason: { type: 'string' } },
      });
      const [tree, maybeUntil] = positionals;
      if (!tree) throw new Error('usage: stam cost-pause TREE [--until reset|ISO] [--account A] [--window W] [--reason R] | TREE --clear');
      // The CLI runs inside an agent (STAM_AGENT_ID); outside, the daemon sees the human.
      const r = await api('POST', '/api/cost/pause', { tree, until: values.until ?? maybeUntil, account: values.account, window: values.window, clear: values.clear, reason: values.reason, by: envVar('AGENT_ID') });
      const acked = r.acked?.length ? `; acknowledged ${r.acked.length} notice(s)` : '';
      if (r.action === 'cleared') return console.log(`cleared the cost pause on ${r.root}'s tree (${r.agents.length} agents${acked})`);
      return console.log(`${r.root}'s tree paused: ${r.until} (${r.agents.length} agents${acked})`);
    }
    case 'cost-switch': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { 'soft-stop-minutes': { type: 'string' } } });
      const [agent, preset] = positionals;
      if (!agent || !preset) throw new Error('usage: stam cost-switch AGENT PRESET [--soft-stop-minutes N]');
      const m = values['soft-stop-minutes'];
      const r = await api('POST', '/api/cost/switch', { agent, preset, soft_stop_minutes: m != null ? Number(m) : undefined, by: envVar('AGENT_ID') }, SWITCH_CALL_MS);
      if (r.status === 'quiescing') return console.log(`${r.from} is finishing its step (up to ${r.minutes} min); then it continues as ${r.to} on ${r.preset}`);
      return console.log(`${r.from} now continues as ${r.to} on ${r.preset}${r.interrupted ? ' (interrupted)' : ''}; moved ${r.moved.children.length} children, ${r.moved.threads} threads, ${r.moved.unread} unread`);
    }
    case 'cos': {
      // Names the chief of staff; it takes the role in its prompt at its next restart.
      const r = await api('POST', '/api/chief-of-staff', { agent: rest[0] ?? null });
      return console.log(r.chiefOfStaff ? `chief of staff: ${r.chiefOfStaff}` : 'no chief of staff');
    }
    case 'janitor': {
      // Sweeps leftovers of tests whose owner is gone; see src/janitor.ts. The daemon does the
      // work and logs the event when it is up; otherwise a sweep of named folders runs here.
      const { values } = parseArgs({ args: rest, allowPositionals: true, options: { only: { type: 'string', multiple: true }, 'dry-run': { type: 'boolean' } } });
      const dryRun = Boolean(values['dry-run']) || rest.includes('-n');
      const only = values.only;
      let r: any;
      try {
        // A sweep walks every test folder on the machine and asks tmux and systemctl about
        // each, so on a busy machine it answers well past the CLI's 10 s default (33 s on a
        // loaded machine, S-764): wait for it.
        r = await api('POST', '/api/janitor', { dry_run: dryRun, only }, JANITOR_TIMEOUT_MS);
      } catch (e) {
        // Only the daemon holds the registry the sweep's rules read: an unscoped sweep keeps a
        // fresh folder whose owner the registry doesn't know (S-190). Swept here instead, with no
        // registry, a sweep that reaches past one folder could clean a running test's fixture, and
        // a failed call doesn't mean the daemon is absent: a timeout, a reset socket, a terminated
        // response, and a refused connection all arrive here. So this sweep must stay inside the
        // concrete test folders --only names, and refuses an empty `--only` (which sweep() drops),
        // a root or the test base, a stam-test.* symlink to a wider folder, and a path that isn't
        // there.
        const { sweep, testFolderScope } = await import('./janitor.ts');
        const raw = only ?? [];
        const scopes = await Promise.all(raw.map((p) => testFolderScope(p)));
        const named = scopes.filter((p): p is string => Boolean(p));
        const unnamed = raw.filter((_, i) => !scopes[i]);
        if (!named.length || unnamed.length) {
          const what = unnamed.length ? `--only ${unnamed.map((p) => `'${p}'`).join(', ')} is not a concrete test folder` : 'an unscoped sweep';
          throw new Error(
            `${what}, and the daemon didn't answer (${e instanceof Error ? e.message : e}). A sweep here has no registry, so it must stay inside concrete stam-test.* folders: a wider one could clean a fresh folder whose owner this process can't look up (S-190). Start the daemon, or name a stam-test.* folder with --only DIR`,
          );
        }
        r = await sweep({ dryRun, only: named });
      }
      for (const a of r.actions) console.log(`${dryRun ? 'would clean' : 'cleaned'} ${a.kind} ${a.target}${a.detail ? ` (${a.detail})` : ''}`);
      for (const k of r.kept) console.log(`kept ${k.path}: ${k.why}`);
      if (r.disk) console.log(`${dryRun ? 'would free' : 'freed'} ${r.disk.freed_bytes} bytes: ${r.disk.gzipped.length} transcript(s) gzipped, ${r.disk.compile_cache.removed.length} compile cache folder(s)`);
      return console.log(`${dryRun ? 'dry run: ' : ''}${r.actions.length} cleaned, ${r.kept.length} kept, ${r.dirs} test folder(s)`);
    }
    case 'forget': {
      // The agent-control route answers {agent, result}; result is the "forgot NAME" line.
      const r = await api('POST', `/api/agents/${rest[0]}/forget`);
      return console.log(r.result);
    }
    case 'kill': {
      const a = await api('POST', `/api/agents/${rest[0]}/kill`);
      return console.log(`killed ${a.name}`);
    }
    case 'embedder': {
      // Runs here, not on the daemon: the install is one npm run and the status reads the db.
      const { install, embedderInfo } = await import('./embed.ts');
      if (!rest[0] || rest[0] === 'status') {
        const info = embedderInfo();
        console.log(`provider: ${info.provider}${info.model ? ` (${info.model}${info.dim ? `, ${info.dim} dims` : ''})` : ''}`);
        console.log(`state: ${info.state}`);
        console.log(`indexed: ${info.indexed.length ? info.indexed.map((r) => `${r.source}: ${r.n}`).join(', ') : 'nothing yet'}`);
        return;
      }
      if (rest[0] === 'install') return install();
      throw new Error('usage: stam embedder [status|install]');
    }
    default:
      console.log(USAGE);
  }
}

main().catch((e) => {
  console.error(`${CLI}: ${named(String(e.message))}`);
  process.exit(1);
});
