// What the activity_info tool returns (S-1010): the activity summary (src/activity-summary.ts, the same
// answer as GET /api/activity?by=summary) without its labels, and with `compare`, a `typical` block:
// the median per closed work issue (cost, working time, lead time, review rounds) for the caller's
// type and model, over the fleet the caller may see, beside the same medians for the scope.
//
// By default the answer is compact (S-1080): the clock in hours, the tiles, the top bottlenecks and
// categories, the configs and the trees without their leaves, and cost in the caller's display mode
// (settings.cost.display.mode, as usage_info reports it). `detail` returns the whole summary.
//
// The shaping is pure: the tool fetches the summaries, the caller's registry entry and the display
// mode, then passes them here.

export interface Caller {
  type: string | null;
  harness: string | null;
  model: string | null;
}

export type Mode = 'api' | 'five_hour' | 'seven_day' | 'subscription';

// The unit of a cost in each display mode (summary modes: src/cost-display.ts).
export const UNITS: Record<Mode, string> = {
  api: 'USD (API)',
  five_hour: '% of 5-hour window',
  seven_day: '% of 7-day window',
  subscription: 'USD (at subscription price)',
};

type Spread = { n: number; median: number | null; p75: number | null };
type Modes = Record<string, number | null>;
type ModesSpread = Record<string, Spread>;
type ByModelType = { model: string; type: string; n: number; cost_usd: Spread; cost_modes: ModesSpread; working_s: Spread; waiting_s: Spread; lead_s: Spread; review_rounds: Spread };
type Summary = { labels?: unknown; configs?: { n?: number; by_model_type?: ByModelType[] }; [k: string]: unknown };

const TOP = 5;

// The config a closed issue is grouped under: the same label the summary's configs use.
export const configOf = (c: Caller): string => `${c.harness} · ${c.model || 'unknown'}`;

const hours = (s: number | null | undefined) => (s == null ? null : Math.round((s / 3600) * 10) / 10);
const inMode = (m: Modes | undefined | null, mode: Mode) => m?.[mode] ?? null;

// The medians of one (config, type) row; null when no closed issue of that config and type is in the summary.
function medians(s: Summary | null, config: string, type: string) {
  const r = s?.configs?.by_model_type?.find((x) => x.model === config && x.type === type);
  if (!r) return null;
  return { n: r.n, cost_usd: r.cost_usd.median, cost_modes: r.cost_modes, working_s: r.working_s.median, lead_s: r.lead_s.median, review_rounds: r.review_rounds.median };
}

// A row in the compact answer: the cost in the display mode.
function compactRow(m: ReturnType<typeof medians>, mode: Mode) {
  if (!m) return null;
  return { n: m.n, cost_median: inMode(medianModes(m.cost_modes), mode), working_h_median: hours(m.working_s), lead_h_median: hours(m.lead_s), review_rounds_median: m.review_rounds };
}
const medianModes = (cm: ModesSpread): Modes => Object.fromEntries(Object.entries(cm).map(([k, v]) => [k, v.median]));

// `typical`: fleet is the caller's type and model over everything it may see; scope is the same row
// in the answer's own scope (the same as fleet when the scope is everything).
export function typicalOf(caller: Caller | null, scope: Summary, fleet: Summary): unknown {
  if (!caller) return null;
  const config = configOf(caller);
  const type = caller.type ?? 'unknown';
  // The detail shape: the medians without the cost modes (the compact answer's only).
  const plain = (m: ReturnType<typeof medians>) => m && { n: m.n, cost_usd: m.cost_usd, working_s: m.working_s, lead_s: m.lead_s, review_rounds: m.review_rounds };
  return { for: { type, model: config }, fleet: plain(medians(fleet, config, type)), scope: plain(medians(scope, config, type)) };
}

// The compact `typical`: the caller's row for the scope, and the fleet's only when its numbers differ
// from the scope's (a manager's visible fleet is its own tree, so the fleet is dropped there).
function compactTypical(caller: Caller | null, scope: Summary, fleet: Summary, mode: Mode): unknown {
  if (!caller) return null;
  const config = configOf(caller);
  const type = caller.type ?? 'unknown';
  const s = compactRow(medians(scope, config, type), mode);
  const f = compactRow(medians(fleet, config, type), mode);
  const same = JSON.stringify(f) === JSON.stringify(s);
  return { for: { type, model: config }, scope: s, ...(same ? {} : { fleet: f }) };
}

// Said in the answer while the daemon is still building its digests after a restart (S-1206).
const WARMING_NOTE = 'Still warming: the daemon is rebuilding its activity digests after a restart, so these figures are partial. Call again in a few seconds for the full answer.';

// The compact answer (default): the summary's figures in hours and in the display mode.
function compactOf(s: Summary, mode: Mode, typical: unknown): Record<string, unknown> {
  const x = s as Record<string, any>;
  const cost = (t: { cost_usd: number; modes: Modes }) => ({ value: inMode(t.modes, mode), unit: UNITS[mode], api_usd: t.cost_usd });
  return {
    scope: x.scope,
    days: x.days,
    agents: x.agents,
    ...(x.missing !== undefined ? { missing: x.missing } : {}),
    ...(x.warming ? { warming: true, warming_note: WARMING_NOTE } : {}),
    unit: UNITS[mode],
    clock: {
      total_h: hours(x.clock.total_s),
      working_h: hours(x.clock.working_s),
      friction_h: hours(x.clock.friction_s),
      others_h: hours(x.clock.others_s),
      you_h: hours(x.clock.you_s),
      idle_h: hours(x.clock.idle_s),
    },
    tiles: {
      cost: cost(x.tiles.cost),
      cost_per_working_hour: x.tiles.cost_per_working_hour ? cost(x.tiles.cost_per_working_hour) : null,
    },
    bottlenecks: (x.bottlenecks as any[]).slice(0, TOP).map((b) => ({
      label: b.label,
      hours: hours(b.seconds),
      agents: b.agents,
      top: b.top.slice(0, 2).map((t: any) => [t.name, hours(t.seconds)]),
      longest_h: b.longest ? hours(b.longest.seconds) : null,
    })),
    categories: (x.working_by_category as any[]).slice(0, TOP).map((c) => ({ label: c.label, hours: hours(c.seconds), cost: inMode(c.modes, mode) })),
    configs: {
      n: x.configs.n,
      by_model_type: (x.configs.by_model_type as ByModelType[]).map((r) => ({
        model: r.model,
        type: r.type,
        n: r.n,
        cost_median: inMode(medianModes(r.cost_modes), mode),
        working_h_median: hours(r.working_s.median),
        lead_h_median: hours(r.lead_s.median),
        review_rounds_median: r.review_rounds.median,
      })),
    },
    trees: (x.trees as any[]).map((t) => ({ name: t.name, agents: t.agents, working_h: hours(t.working_s), cost: inMode(t.modes, mode) })),
    ...(typical !== undefined ? { typical } : {}),
  };
}

// The result: by default the compact answer; with `detail`, the summary without labels and, with
// `fleet` (the everything summary), the `typical` block in full. `mode` is the caller's display mode.
export function activityInfoOf(
  scope: Summary,
  opts: { fleet?: Summary; caller?: Caller | null; detail?: boolean; mode?: Mode } = {},
): Record<string, unknown> {
  const { labels: _labels, display_mode: _display, ...rest } = scope;
  if (opts.detail && rest.warming) (rest as Record<string, unknown>).warming_note = WARMING_NOTE;
  if (opts.detail) return opts.fleet ? { ...rest, typical: typicalOf(opts.caller ?? null, scope, opts.fleet) } : rest;
  const mode = opts.mode ?? 'api';
  const typical = opts.fleet ? compactTypical(opts.caller ?? null, scope, opts.fleet, mode) : undefined;
  return compactOf(scope, mode, typical);
}
