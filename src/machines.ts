// Each computer's load, for the sidebar's meters: CPU (total and per core), RAM, and swap,
// sampled from /proc, with a one-minute rolling average beside the latest raw values. Cheap:
// only /proc reads, no child processes. The daemon samples this machine every 5 s; a peer
// answers GET /api/machines with its own reading (x-stam-local), so the route fans out the
// way the other list routes do, and a peer that doesn't answer shows as offline.
import { readFileSync, statfsSync } from 'node:fs';
import { MACHINE } from './config.ts';
import { peers, peerCall } from './peers.ts';
import { settings, setSetting, type Settings } from './settings.ts';
import * as db from './db.ts';

export interface CpuCounters {
  // Busy and total jiffies since boot; the difference between two reads is the load.
  busy: number;
  total: number;
}

export interface Sample {
  ts: number;
  cpuPct: number;
  cores: number[];
  ramPct: number;
  swapPct: number;
  // The root filesystem's used share, as df shows it (used over used plus available to users);
  // null when statfs failed, which is no reading at all and must not re-arm the warning.
  diskPct: number | null;
  ramUsed: number;
  ramTotal: number;
  swapUsed: number;
  swapTotal: number;
  load: number[];
}

// Stam's agents on one machine by state: paused; and the active ones working, waiting (waiting
// or blocked), or idle (everything else, errored and unknown included).
export interface AgentCounts {
  working: number;
  waiting: number;
  idle: number;
  paused: number;
}

export interface MachineReading {
  name: string;
  online: boolean;
  ts: number;
  cpu: { pct: number; cores: number[]; count: number };
  ram: { pct: number; used: number; total: number };
  swap: { pct: number; used: number; total: number };
  load: number[];
  agents: AgentCounts;
}

export const SAMPLE_MS = 5_000;
export const WINDOW_MS = 60_000;

const clampPct = (n: number) => Math.max(0, Math.min(100, n));
const round1 = (n: number) => Math.round(n * 10) / 10;

// /proc/stat: `cpu` and `cpu0`… lines of jiffies (user nice system idle iowait irq softirq
// steal …). Busy is everything but idle and iowait.
export function parseStat(text: string): { total: CpuCounters; cores: CpuCounters[] } {
  const cores: CpuCounters[] = [];
  let total: CpuCounters | undefined;
  for (const line of text.split('\n')) {
    const m = line.match(/^cpu(\d*)\s+(.+)$/);
    if (!m) continue;
    const nums = m[2].trim().split(/\s+/).map(Number);
    const sum = nums.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
    const idle = (nums[3] ?? 0) + (nums[4] ?? 0);
    const c = { busy: sum - idle, total: sum };
    if (m[1] === '') total = c;
    else cores[Number(m[1])] = c;
  }
  return { total: total ?? { busy: 0, total: 0 }, cores };
}

// The share of the jiffies between two reads that were busy.
export function cpuPct(now: CpuCounters, prev: CpuCounters): number {
  const dt = now.total - prev.total;
  if (dt <= 0) return 0;
  return clampPct((100 * (now.busy - prev.busy)) / dt);
}

export function parseMeminfo(text: string): { memTotalKb: number; memAvailableKb: number; swapTotalKb: number; swapFreeKb: number } {
  const get = (key: string) => Number((text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm')) ?? [])[1] ?? 0);
  return { memTotalKb: get('MemTotal'), memAvailableKb: get('MemAvailable'), swapTotalKb: get('SwapTotal'), swapFreeKb: get('SwapFree') };
}

export function parseLoadavg(text: string): number[] {
  return text.trim().split(/\s+/).slice(0, 3).map(Number);
}

// The used share of a filesystem as df reports it: blocks in use over those plus the ones
// users can still get (bavail, so the root-only reserve doesn't count).
export function diskPct(st: { blocks: number; bfree: number; bavail: number }): number {
  const used = st.blocks - st.bfree;
  const denom = used + st.bavail;
  return denom > 0 ? clampPct((100 * used) / denom) : 0;
}

const kB = 1024;
const GB = 2 ** 30;

// The reading for one set of samples: each percentage is the mean over the samples in the
// window, the raw used and total bytes and the load average come from the latest one.
export function summarize(samples: Sample[], name: string, now = Date.now(), windowMs = WINDOW_MS): MachineReading {
  const win = samples.filter((s) => now - s.ts <= windowMs);
  const use = win.length ? win : samples.slice(-1);
  const last = use[use.length - 1];
  if (!last) return offline(name, now);
  const mean = (f: (s: Sample) => number) => use.reduce((a, s) => a + f(s), 0) / use.length;
  const count = last.cores.length;
  return {
    name,
    online: true,
    ts: last.ts,
    cpu: { pct: round1(mean((s) => s.cpuPct)), cores: Array.from({ length: count }, (_, i) => round1(mean((s) => s.cores[i] ?? 0))), count },
    ram: { pct: round1(mean((s) => s.ramPct)), used: last.ramUsed, total: last.ramTotal },
    swap: { pct: round1(mean((s) => s.swapPct)), used: last.swapUsed, total: last.swapTotal },
    load: last.load,
    agents: noAgents(),
  };
}

export function offline(name: string, now = Date.now()): MachineReading {
  return { name, online: false, ts: now, cpu: { pct: 0, cores: [], count: 0 }, ram: { pct: 0, used: 0, total: 0 }, swap: { pct: 0, used: 0, total: 0 }, load: [], agents: noAgents() };
}

const noAgents = (): AgentCounts => ({ working: 0, waiting: 0, idle: 0, paused: 0 });

// The agents on this machine by state. Shut-down and archived agents don't count.
export function countAgents(list: { lifecycle: string; activity: string }[]): AgentCounts {
  const c = noAgents();
  for (const a of list) {
    if (a.lifecycle === 'paused') c.paused++;
    else if (a.lifecycle !== 'active') continue;
    else if (a.activity === 'starting' || a.activity === 'working') c.working++;
    else if (a.activity === 'waiting' || a.activity === 'blocked') c.waiting++;
    else c.idle++;
  }
  return c;
}

// The compact form usage_info carries: no per-core arrays, GB instead of bytes, and the
// one-minute load average (null when the machine hasn't answered).
export function compact(r: MachineReading) {
  return {
    name: r.name,
    online: r.online,
    cores: r.cpu.count,
    cpu_pct: r.cpu.pct,
    ram_pct: r.ram.pct,
    ram_used_gb: round1(r.ram.used / GB),
    ram_total_gb: round1(r.ram.total / GB),
    swap_pct: r.swap.pct,
    load_1m: r.load[0] ?? null,
    // A peer on an older release sends no agent counts: null, not a missing key.
    agents: r.agents ?? null,
  };
}

// This machine's sampler: the counters of the previous read, so each tick's load is the
// share of the jiffies since it, and the samples of the last minute.
let prev: { total: CpuCounters; cores: CpuCounters[] } | null = null;
let buffer: Sample[] = [];

// STAM_PROC_DIR reads the /proc files from another folder: the web checks seed a fixed reading
// this way (web/check/daemon.sh), so no check depends on this machine's live load. Unset, /proc.
const PROC = process.env.STAM_PROC_DIR || '/proc';

// statfs is injected by the tests; the daemon reads the real root filesystem.
export function tick(now = Date.now(), statfs: (path: string) => { blocks: number; bfree: number; bavail: number } = statfsSync): Sample | null {
  let stat: string, meminfo: string, loadavg: string;
  try {
    stat = readFileSync(`${PROC}/stat`, 'utf8');
    meminfo = readFileSync(`${PROC}/meminfo`, 'utf8');
    loadavg = readFileSync(`${PROC}/loadavg`, 'utf8');
  } catch {
    return null;
  }
  const cpu = parseStat(stat);
  const mem = parseMeminfo(meminfo);
  const ramTotal = mem.memTotalKb * kB;
  const ramUsed = Math.max(0, mem.memTotalKb - mem.memAvailableKb) * kB;
  const swapTotal = mem.swapTotalKb * kB;
  const swapUsed = Math.max(0, mem.swapTotalKb - mem.swapFreeKb) * kB;
  let disk: number | null = null;
  try {
    disk = diskPct(statfs('/'));
  } catch {
    disk = null;
  }
  const sample: Sample = {
    ts: now,
    cpuPct: prev ? cpuPct(cpu.total, prev.total) : 0,
    cores: prev ? cpu.cores.map((c, i) => cpuPct(c, prev!.cores[i] ?? c)) : cpu.cores.map(() => 0),
    ramPct: ramTotal ? clampPct((100 * ramUsed) / ramTotal) : 0,
    swapPct: swapTotal ? clampPct((100 * swapUsed) / swapTotal) : 0,
    diskPct: disk,
    ramUsed,
    ramTotal,
    swapUsed,
    swapTotal,
    load: parseLoadavg(loadavg),
  };
  prev = cpu;
  buffer = [...buffer.filter((s) => now - s.ts <= WINDOW_MS), sample];
  return sample;
}

// This machine's current reading: one tick if nothing has been sampled yet.
export function snapshot(now = Date.now()): MachineReading {
  if (!buffer.length) tick(now);
  return summarize(buffer, MACHINE, now);
}

// This machine plus each peer's. `local` is true for a peer's own request, which gets only
// this machine's reading (never a fan-out of its own). A peer that doesn't answer is offline.
export async function all(local = false): Promise<MachineReading[]> {
  const here = { ...snapshot(), agents: countAgents(db.listAgents()) };
  if (local) return [here];
  const rest = await Promise.all(
    peers().map(async (p) => {
      try {
        const r = await peerCall(p, 'GET', '/api/machines', undefined, 4000);
        const list: MachineReading[] = Array.isArray(r.data) ? r.data : [];
        return list.find((x) => x.name === p.name) ?? list[0] ?? offline(p.name);
      } catch {
        return offline(p.name);
      }
    }),
  );
  return [here, ...rest];
}

// Resource warnings (settings.resourceWarn): each kind that is across its line mails, then not
// again for repeatMinutes, even if it recovers and crosses again in that time. CPU load is the
// 5-minute load average per core, so a short spike doesn't warn.
// disk is the root filesystem (S-736), which mails by crossing rather than by the repeat interval.
export type WarnKind = 'cpu' | 'ram' | 'swap' | 'disk';
const WARN_KINDS: WarnKind[] = ['cpu', 'ram', 'swap'];

// The kinds across their lines in one sample, each with the sentence that says why.
export function overLines(s: Sample, cfg: Settings['resourceWarn']): Partial<Record<WarnKind, string>> {
  const out: Partial<Record<WarnKind, string>> = {};
  const cores = s.cores.length;
  const perCore = cores ? (s.load[1] ?? 0) / cores : 0;
  if (cores && perCore > cfg.loadPerCore) out.cpu = `The 5-minute load is ${perCore.toFixed(2)} per core on ${cores} cores (line ${cfg.loadPerCore}).`;
  const availGb = (s.ramTotal - s.ramUsed) / GB;
  if (s.ramTotal && availGb < cfg.ramAvailableGb) out.ram = `${availGb.toFixed(1)} GB of RAM is available (line ${cfg.ramAvailableGb} GB).`;
  if (s.swapTotal && s.swapPct > cfg.swapPct) out.swap = `Swap is ${Math.round(s.swapPct)}% used (line ${cfg.swapPct}%).`;
  return out;
}

const WARN_LABEL: Record<WarnKind, string> = { cpu: 'CPU load', ram: 'RAM', swap: 'swap', disk: 'disk' };

// The root disk (S-736) mails once per crossing: when it goes over the line (settings diskPct,
// default DISK_WARN_PCT), then not again until it drops DISK_CLEAR_MARGIN below it and crosses once
// more. The armed state lives in lastWarned.disk (null: armed), so a restart keeps it.
export const DISK_WARN_PCT = 85;
export const DISK_CLEAR_MARGIN = 5;

// Calls send for each kind that mails now. Returns the kinds sent, for tests.
export function warnResources(s: Sample, cfg: Settings['resourceWarn'], send: (subject: string, body: string) => void, now = Date.now()): WarnKind[] {
  const sent: WarnKind[] = [];
  const lines = cfg.enabled ? overLines(s, cfg) : {};
  // When each kind last mailed, from settings so a restart keeps the repeat interval (S-196).
  const last = { ...settings().resourceWarn.lastWarned };
  for (const kind of WARN_KINDS) {
    const line = lines[kind];
    if (!line) continue;
    // Quiet for the repeat interval after each mail, whether or not the kind recovered since.
    if (now - (last[kind] ?? -Infinity) < cfg.repeatMinutes * 60_000) continue;
    last[kind] = now;
    sent.push(kind);
    send(`Resource warning on ${MACHINE}: ${WARN_LABEL[kind]}`, `${line}\n\nStam mails this again every ${cfg.repeatMinutes} minutes while it stays across. Settings > Resources sets the lines.`);
  }
  // No reading (a failed statfs) leaves the armed state as it was.
  if (cfg.enabled && s.diskPct != null) {
    const line = cfg.diskPct ?? DISK_WARN_PCT;
    const clear = line - DISK_CLEAR_MARGIN;
    if (s.diskPct < clear) last.disk = null;
    else if (s.diskPct > line && last.disk == null) {
      last.disk = now;
      sent.push('disk');
      send(`Resource warning on ${MACHINE}: disk`, `The root filesystem is ${Math.round(s.diskPct)}% used (line ${line}%).\n\nStam mails this once, and again only after it drops below ${clear}% and crosses ${line}% once more.`);
    }
  }
  if (sent.length || last.disk !== settings().resourceWarn.lastWarned.disk) setSetting('resourceWarn', { ...settings().resourceWarn, lastWarned: last });
  return sent;
}

// Mails the configured recipients (agent names or "human"; none means the chief of staff), from
// the system sender `system:resources` rather than a stand-in agent, so no agent seems to report it.
async function mailWarning(subject: string, body: string): Promise<void> {
  const cfg = settings();
  const to = cfg.resourceWarn.recipients.length ? cfg.resourceWarn.recipients : [cfg.chiefOfStaff].filter((n): n is string => !!n);
  if (!to.length) return;
  const { sendMail } = await import('./mail.ts');
  await sendMail({ from: '', system: 'resources', to, subject, body, new_thread: true });
}

export function startSampler(): void {
  tick();
  setInterval(() => {
    const s = tick();
    if (s) warnResources(s, settings().resourceWarn, (subject, body) => void mailWarning(subject, body).catch(() => {}));
  }, SAMPLE_MS);
}
