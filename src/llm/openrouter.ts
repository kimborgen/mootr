// The OpenRouter adapter (S-2113): chat completions with usage accounting, the credit and key
// endpoints, the public model catalogue, and the alpha decisions endpoint. The key is stam's own
// (the secret store's `stam` slot, src/secrets.ts); the base URL is overridable with STAM_OPENROUTER_URL
// so a test can stub every call.
import { keyFor } from '../secrets.ts';
import { checkCredential, retryAfterMs, send, signalFor } from './http.ts';
import { probeKey } from './key-check.ts';
import { LlmHttpError, type Balance, type CompleteRequest, type CompleteResult, type KeyCheck, type KeyLimit, type LlmAdapter, type ModelInfo } from './types.ts';
import { envVar } from '../env.ts';

const base = () => envVar('OPENROUTER_URL') ?? 'https://openrouter.ai/api/v1';
// The decisions endpoint's base; the override, when set, serves every path.
const alphaBase = () => envVar('OPENROUTER_URL') ?? 'https://openrouter.ai/api/alpha';

// stam's own OpenRouter key: the environment, the secret store's `stam` slot, or opencode.env (S-2114).
export function openRouterKey(): string | undefined {
  return keyFor('OPENROUTER_API_KEY', 'stam');
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

export const openrouter: LlmAdapter = {
  id: 'openrouter',
  apiKey: openRouterKey,

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const key = openRouterKey();
    if (!key) throw new Error('no API key');
    const res = await send(`${base()}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${checkCredential(key, 'API key')}`, 'content-type': 'application/json' },
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

  // GET /key: free, and answers 401 for a key OpenRouter doesn't know.
  checkKey(key: string): Promise<KeyCheck> {
    return probeKey(`${base()}/key`, { authorization: `Bearer ${key}` });
  },

  async keyLimit(key?: string): Promise<KeyLimit | null> {
    const k = await get('/key', key);
    return k ? { limit: num(k.data?.limit), remaining: num(k.data?.limit_remaining) } : null;
  },

  async decisions(body, opts): Promise<any> {
    const key = opts.key ?? openRouterKey();
    if (!key) throw new Error('no API key');
    const res = await send(`${alphaBase()}/decisions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${checkCredential(key, 'API key')}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!res.ok) throw new LlmHttpError(res.status, retryAfterMs(res.headers.get('retry-after')));
    return res.json().catch(() => null);
  },
};
