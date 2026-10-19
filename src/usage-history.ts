// Usage history (docs/cost-policy.md, build step 9): how much of a subscription window is used
// per hour, by hour of day and weekday, overall and per agent and tree, and a projection that
// follows that usual pattern for the coming hours. Built from attribution.ts's calibration (the
// same intervals and agent shares), never a second attribution path. Everything is an estimate;
// it never sets or clears a blocker.
//
//   slot        (weekday, hour) in the daemon's local time
//   piece       each calibration interval [a, b] is cut at local hour boundaries; a piece of
//               length t gets change × t / (b − a), and each agent's share likewise
//   rate        percent per hour of a slot = Σ piece change / Σ piece hours, so only time the
//               readings covered counts (an hour the daemon was down is not a zero)
//   hour, day   the same rate over every slot with that hour of day, or with that weekday
//   agent, tree an agent's rate uses its share of each piece over the same covered hours; a
//               tree's is the sum over its members, each once
//   pattern     from now: the rest of this hour at the current rate (the 30-minute projection's
//               percent_per_hour), then each later hour at its slot's rate, or the hour of
//               day's when the slot has under MIN_HOURS covered, or the current rate when
//               neither has; 100% where the running sum reaches 100 − used, or null when the
//               window resets first or the horizon (the reset, else the window's length) ends
//
// The scan is the caller's calibration: windowSummary's 14 days (BY_DAY_DAYS), so it is bounded.
import type { Calibration, Projection } from './attribution.ts';

const HOUR_MS = 3_600_000;
// A slot needs this many covered hours before the pattern trusts its rate over the hour of day's.
const MIN_HOURS = 1;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const round = (n: number) => Math.round(n * 100) / 100;

// The start of the next local hour after `t`: the time left in this local hour, in real
// milliseconds. Unlike setting the clock fields, it keeps the hour a fall-back repeats and
// moves across a spring-forward gap (offset changes fall on whole hours).
export function nextHour(t: number): number {
  const d = new Date(t);
  return t - (d.getMinutes() * 60_000 + d.getSeconds() * 1000 + d.getMilliseconds()) + HOUR_MS;
}

interface Cell {
  hours: number;
  change: number;
  agents: Map<string, number>;
}
const cell = (): Cell => ({ hours: 0, change: 0, agents: new Map() });

export interface Hourly {
  from: number;
  // Keyed by weekday × 24 + hour.
  slots: Cell[];
}

// Cuts each interval ending after `from` into local-hour pieces and sums them per slot.
export function hourly(cal: Calibration, from: number): Hourly {
  const slots = Array.from({ length: 7 * 24 }, cell);
  for (const iv of cal.intervals) {
    const a = Math.max(Date.parse(iv.from), from);
    const b = Date.parse(iv.to);
    const len = b - Date.parse(iv.from);
    if (b <= a || len <= 0) continue;
    for (let t = a; t < b; ) {
      const end = Math.min(nextHour(t), b);
      const f = (end - t) / len;
      const d = new Date(t);
      const c = slots[d.getDay() * 24 + d.getHours()];
      c.hours += (end - t) / HOUR_MS;
      c.change += iv.change * f;
      for (const [id, p] of Object.entries(iv.agents)) c.agents.set(id, (c.agents.get(id) ?? 0) + p * f);
      t = end;
    }
  }
  return { from, slots };
}

// The rate over a set of slots: Σ change (or the members' share) / Σ covered hours.
function rate(cells: Cell[], members?: Set<string>): { percent_per_hour: number | null; hours: number } {
  let hours = 0;
  let change = 0;
  for (const c of cells) {
    hours += c.hours;
    if (!members) change += c.change;
    else for (const [id, p] of c.agents) if (members.has(id)) change += p;
  }
  return { percent_per_hour: hours > 0 ? round(change / hours) : null, hours: round(hours) };
}

const byHourCells = (h: Hourly, hour: number) => DAYS.map((_, d) => h.slots[d * 24 + hour]);
const byDayCells = (h: Hourly, day: number) => h.slots.slice(day * 24, day * 24 + 24);

// The window's rate per hour of day and per weekday, overall or for one agent set.
export function profile(h: Hourly, members?: Set<string>) {
  return {
    by_hour: Array.from({ length: 24 }, (_, hour) => ({ hour, ...rate(byHourCells(h, hour), members) })),
    by_weekday: DAYS.map((day, d) => ({ day, ...rate(byDayCells(h, d), members) })),
  };
}

// One agent set's rate per hour of day, as 24 numbers (null where nothing was covered).
export function hourRates(h: Hourly, members: Set<string>): (number | null)[] {
  return Array.from({ length: 24 }, (_, hour) => rate(byHourCells(h, hour), members).percent_per_hour);
}

// Each agent's average and hour-of-day rates in one pass over the slots: the numbers average(h, {id}) and
// hourRates(h, {id}) give, without a pass per agent (S-344).
export function agentRates(h: Hourly, ids: Iterable<string>): Map<string, { percent_per_hour: number | null; by_hour: (number | null)[] }> {
  const want = new Set(ids);
  const change = new Map<string, number>();
  const changeByHour = Array.from({ length: 24 }, () => new Map<string, number>());
  const hoursByHour = Array.from({ length: 24 }, () => 0);
  let hours = 0;
  h.slots.forEach((c, i) => {
    const hour = i % 24;
    hours += c.hours;
    hoursByHour[hour] += c.hours;
    for (const [id, p] of c.agents) {
      if (!want.has(id)) continue;
      change.set(id, (change.get(id) ?? 0) + p);
      changeByHour[hour].set(id, (changeByHour[hour].get(id) ?? 0) + p);
    }
  });
  const out = new Map<string, { percent_per_hour: number | null; by_hour: (number | null)[] }>();
  for (const id of want) {
    out.set(id, {
      percent_per_hour: hours > 0 ? round((change.get(id) ?? 0) / hours) : null,
      by_hour: Array.from({ length: 24 }, (_, hour) => (hoursByHour[hour] > 0 ? round((changeByHour[hour].get(id) ?? 0) / hoursByHour[hour]) : null)),
    });
  }
  return out;
}

// The overall average over every covered hour, for one agent set.
export function average(h: Hourly, members?: Set<string>): number | null {
  return rate(h.slots, members).percent_per_hour;
}

export interface PatternProjection {
  estimate: true;
  reaches_100_at: string | null;
  note?: string;
}

// The rate the pattern uses for the hour starting at `t`: its slot's, else its hour of day's.
function slotRate(h: Hourly, t: number): number | null {
  const d = new Date(t);
  const slot = h.slots[d.getDay() * 24 + d.getHours()];
  if (slot.hours >= MIN_HOURS) return slot.change / slot.hours;
  const r = rate(byHourCells(h, d.getHours()));
  return r.hours >= MIN_HOURS ? r.percent_per_hour : null;
}

// When the window reaches 100% at the current rate for the rest of this hour and the usual
// rate for each hour after it (see `pattern` in the header).
export function patternProjection(h: Hourly, p: Projection, windowMs: number, now: number): PatternProjection {
  const base: PatternProjection = { estimate: true, reaches_100_at: null };
  if (p.used_percentage == null) return { ...base, note: 'no readings' };
  if (p.used_percentage >= 100) return { ...base, reaches_100_at: p.reaches_100_at };
  const current = p.percent_per_hour;
  const resets = p.resets_at ? Date.parse(p.resets_at) : null;
  const horizon = resets ?? now + windowMs;
  let left = 100 - p.used_percentage;
  for (let t = now, first = true; t < horizon; first = false) {
    const end = Math.min(nextHour(t), horizon);
    const r = (first ? current : null) ?? slotRate(h, t) ?? current ?? 0;
    const add = (r * (end - t)) / HOUR_MS;
    // Reaching 100% only at the horizon is not reaching it, as in project().
    if (r > 0 && add >= left) {
      const at = t + (left / r) * HOUR_MS;
      if (at < horizon) return { ...base, reaches_100_at: new Date(at).toISOString() };
      break;
    }
    left -= add;
    t = end;
  }
  return { ...base, note: resets != null ? 'resets before reaching 100% at the usual pattern' : 'does not reach 100% within the window at the usual pattern' };
}

// Two flat-rate forecasts (S-1523): the window's average rate over the last 7 days and over the
// last 24 hours, each over the hours the readings covered, so a busy day shows next to what a
// normal week looks like. A pace needs enough covered hours to mean something; else it is null.
const PACE_MIN_HOURS = { pace_7d: 24, pace_24h: 2 };

export interface Pace {
  estimate: true;
  percent_per_hour: number;
  covered_hours: number;
  // Where the window stands at its reset at this rate, capped at 100; null when the reset is unknown.
  at_reset: number | null;
  reaches_100_at: string | null;
}

export interface Paces {
  pace_7d: Pace | null;
  pace_24h: Pace | null;
}

function paceAt(h: Hourly, min: number, p: Projection, now: number): Pace | null {
  const r = rate(h.slots);
  if (r.percent_per_hour == null || r.hours < min || p.used_percentage == null) return null;
  const used = p.used_percentage;
  const perHour = r.percent_per_hour;
  const resets = p.resets_at ? Date.parse(p.resets_at) : null;
  const base = { estimate: true as const, percent_per_hour: perHour, covered_hours: r.hours };
  if (used >= 100) return { ...base, at_reset: 100, reaches_100_at: p.reaches_100_at };
  const at = perHour > 0 ? now + ((100 - used) / perHour) * HOUR_MS : null;
  // Reaching 100% only at the reset is not reaching it, as in project().
  if (at != null && (resets == null || at < resets)) return { ...base, at_reset: resets == null ? null : 100, reaches_100_at: new Date(at).toISOString() };
  const atReset = resets == null ? null : Math.min(100, round(used + (perHour * Math.max(0, resets - now)) / HOUR_MS));
  return { ...base, at_reset: atReset, reaches_100_at: null };
}

// The 7-day and 24-hour paces from the calibration that feeds the hourly history.
export function paces(cal: Calibration, p: Projection, now: number): Paces {
  return {
    pace_7d: paceAt(hourly(cal, now - 7 * 24 * HOUR_MS), PACE_MIN_HOURS.pace_7d, p, now),
    pace_24h: paceAt(hourly(cal, now - 24 * HOUR_MS), PACE_MIN_HOURS.pace_24h, p, now),
  };
}
