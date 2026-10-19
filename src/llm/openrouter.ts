// The OpenRouter adapter (S-2113): chat completions with usage accounting, the credit and key
// endpoints, the public model catalogue, and the alpha decisions endpoint. The key is the one
// OpenCode uses (opencode.env under STAM_HOME); the base URL is overridable with STAM_OPENROUTER_URL
// so a test can stub every call.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STAM_HOME } from '../config.ts';
import { LlmHttpError, type Balance, type CompleteRequest, type CompleteResult, type KeyLimit, type LlmAdapter, type ModelInfo } from './types.ts';

const base = () => process.env.STAM_OPENROUTER_URL ?? 'https://openrouter.ai/api/v1';
// The decisions endpoint's base; the override, when set, serves every path.
const alphaBase = () => process.env.STAM_OPENROUTER_URL ?? 'https://openrouter.ai/api/alpha';

const RETRY_AFTER_MAX_MS = 300_000;

export function openRouterKey(): string | undefined {
  try {
    return readFileSync(join(STAM_HOME, 'opencode.env'), 'utf8').match(/^OPENROUTER_API_KEY=(.*)$/m)?.[1].trim() || undefined;
  } catch {
    return undefined;
  }
}

// The Retry-After header as milliseconds: seconds, or an HTTP date. Undefined when absent or unreadable.
function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(header) - Date.now();
  if (!Number.isFinite(ms)) return undefined;
  return Math.min(RETRY_AFTER_MAX_MS, Math.max(0, ms));
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// OpenRouter prices are strings in USD per token; a missing or non-numeric one is unknown.
function perMillion(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Number((n * 1e6).toFixed(6)) : null;
}

// A GET that yields the parsed body, or null when the call fails or answers non-2xx.
// `key` is the credential to use; a caller making several calls passes one snapshot, so a key
// rotated in between can't pair one key's answer with another's.
async function get(path: string, key: string | undefined = openRouterKey()): Promise<any | null> {
  if (!key) return null;
  try {
    const res = await fetch(`${base()}${path}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function signalFor(req: { signal?: AbortSignal; timeoutMs?: number }): AbortSignal | undefined {
  const t = req.timeoutMs != null ? AbortSignal.timeout(req.timeoutMs) : undefined;
  return req.signal && t ? AbortSignal.any([req.signal, t]) : req.signal ?? t;
}

export const openrouter: LlmAdapter = {
  id: 'openrouter',
  apiKey: openRouterKey,

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const key = openRouterKey();
    if (!key) throw new Error('no API key');
    const res = await fetch(`${base()}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        ...(req.jsonSchema
          ? { response_format: { type: 'json_schema', json_schema: { name: req.jsonSchema.name, strict: req.jsonSchema.strict ?? true, schema: req.jsonSchema.schema } } }
          : {}),
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        usage: { include: true },
      }),
      signal: signalFor(req),
    });
    if (!res.ok) throw new LlmHttpError(res.status, retryAfterMs(res.headers.get('retry-after')));
    const data: any = await res.json();
    const usage = data?.usage ?? {};
    const content = data?.choices?.[0]?.message?.content;
    const text = typeof content === 'string' ? content : null;
    let json: unknown;
    if (req.jsonSchema && text != null) {
      try {
        json = JSON.parse(text);
      } catch {}
    }
    return {
      text,
      ...(json !== undefined ? { json } : {}),
      model: String(data?.model ?? req.model),
      usage: { inputTokens: Number(usage.prompt_tokens) || 0, outputTokens: Number(usage.completion_tokens) || 0 },
      costUsd: Number(usage.cost) || 0,
    };
  },

  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch(`${base()}/models`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000), redirect: 'manual' });
    if (!res.ok) throw new Error(`OpenRouter answered HTTP ${res.status} for its models`);
    const json: any = await res.json().catch(() => ({}));
    const data: any[] = Array.isArray(json?.data) ? json.data : [];
    return data
      .filter((m) => typeof m?.id === 'string')
      .map((m) => ({ id: m.id, name: typeof m.name === 'string' && m.name ? m.name : m.id, in: perMillion(m.pricing?.prompt), out: perMillion(m.pricing?.completion) }));
  },

  async balance(key?: string): Promise<Balance | null> {
    const c = await get('/credits', key);
    return c ? { total: num(c.data?.total_credits), used: num(c.data?.total_usage) } : null;
  },

  async keyLimit(key?: string): Promise<KeyLimit | null> {
    const k = await get('/key', key);
    return k ? { limit: num(k.data?.limit), remaining: num(k.data?.limit_remaining) } : null;
  },

  async decisions(body, opts): Promise<any> {
    const key = openRouterKey();
    if (!key) throw new Error('no API key');
    const res = await fetch(`${alphaBase()}/decisions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!res.ok) throw new LlmHttpError(res.status, retryAfterMs(res.headers.get('retry-after')));
    return res.json().catch(() => null);
  },
};
