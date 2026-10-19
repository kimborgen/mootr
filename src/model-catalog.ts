// The models a Settings model field can pick (S-379). OpenRouter's public catalogue, cached in
// memory for six hours, and the harness models the registry knows, with the prices it holds.
// The catalogue is fetched asynchronously; a failed refresh keeps the last one it got.
import { registry } from './registry.ts';

const TTL_MS = 6 * 3600_000;

export interface CatalogModel {
  id: string;
  name: string;
  // USD per million tokens; null when not known.
  in: number | null;
  out: number | null;
}

let cache: { at: number; models: CatalogModel[] } | null = null;
let inflight: Promise<CatalogModel[]> | null = null;

// The base URL is overridable so a test can stub the call (STAM_OPENROUTER_URL, as credits.ts).
const base = () => process.env.STAM_OPENROUTER_URL ?? 'https://openrouter.ai/api/v1';

// OpenRouter prices are strings in USD per token; a missing or non-numeric one is unknown.
function perMillion(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Number((n * 1e6).toFixed(6)) : null;
}

async function fetchOpenRouter(): Promise<CatalogModel[]> {
  const res = await fetch(`${base()}/models`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000), redirect: 'manual' });
  if (!res.ok) throw new Error(`OpenRouter answered HTTP ${res.status} for its models`);
  const json: any = await res.json().catch(() => ({}));
  const data: any[] = Array.isArray(json?.data) ? json.data : [];
  return data
    .filter((m) => typeof m?.id === 'string')
    .map((m) => ({ id: m.id, name: typeof m.name === 'string' && m.name ? m.name : m.id, in: perMillion(m.pricing?.prompt), out: perMillion(m.pricing?.completion) }));
}

// The OpenRouter catalogue: from memory while it is under six hours old, else fetched once
// for every caller that asks meanwhile. When the fetch fails, the last catalogue stands.
export async function openRouterModels(now = Date.now()): Promise<CatalogModel[]> {
  if (cache && now - cache.at < TTL_MS) return cache.models;
  inflight ??= fetchOpenRouter()
    .then((models) => {
      cache = { at: Date.now(), models };
      return models;
    }, (err) => {
      if (cache) return cache.models;
      throw err;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

// The registry's models that run on a harness (all of them when none is named), priced from
// the registry's prices where it has them.
export function harnessModels(harness = ''): CatalogModel[] {
  const r = registry();
  return Object.entries<any>(r.models)
    .filter(([, m]) => !harness || !m.harnesses || m.harnesses.includes(harness))
    .map(([id, m]) => ({ id, name: typeof m.name === 'string' && m.name ? m.name : id, in: r.prices?.[id]?.input ?? null, out: r.prices?.[id]?.output ?? null }));
}
