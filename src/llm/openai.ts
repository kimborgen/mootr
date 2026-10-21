// The OpenAI-compatible and Azure OpenAI adapters (S-2116): chat completions with a key and a base
// URL, built from a provider's config (settings.providers, keyed by provider id). One OpenAI-compatible
// adapter covers OpenAI itself and every server that speaks its chat-completions API (Ollama, vLLM,
// LiteLLM, Groq, Together, Gemini's compatible endpoint); Azure differs in its URL, its `api-key`
// header and its `api-version`. Neither has a credit or key endpoint; a bill is not read back, so a
// result carries no `costUsd`.
import { getSecret } from '../secrets.ts';
import { checkCredential, retryAfterMs, send, signalFor } from './http.ts';
import { probeKey } from './key-check.ts';
import { LlmHttpError, type CompleteRequest, type KeyCheck, type CompleteResult, type LlmAdapter, type ModelInfo } from './types.ts';

// Where a key comes from: `{ env: NAME }`, an environment variable, or `{ secret: NAME }`, a name in
// this machine's secret store (S-2114, src/secrets.ts); `resolveKey` is the one place to read it.
export interface KeyRef {
  env?: string;
  secret?: string;
}

export interface OpenAiCompatibleConfig {
  kind: 'openai-compatible';
  // Up to and including the version path, e.g. https://api.openai.com/v1 or http://localhost:11434/v1.
  baseUrl: string;
  // Absent: the server takes no key (a local Ollama).
  apiKey?: KeyRef;
  // Sent as the temperature when a request sets none; otherwise none is sent.
  temperature?: number;
  // The token-limit field; `max_tokens` unless the server wants `max_completion_tokens` (OpenAI's newer models).
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
}

export interface AzureConfig {
  kind: 'azure';
  // The resource endpoint, e.g. https://RESOURCE.openai.azure.com. One ending in /openai/v1 selects the v1 API.
  endpoint: string;
  // The deployment that answers; the request's model when absent.
  deployment?: string;
  // The `api-version` query value. `v1` (or an endpoint ending in /openai/v1) uses the version-less v1 path,
  // where the model rides in the body and no query is sent.
  apiVersion: string;
  apiKey?: KeyRef;
  temperature?: number;
}

export type ProviderConfig = OpenAiCompatibleConfig | AzureConfig;

// The key a config names, or undefined when it names none. A set variable overrides the stored
// secret when a config names both, as environment variables override the store everywhere.
export function resolveKey(ref: KeyRef | undefined): string | undefined {
  return (ref?.env && process.env[ref.env]?.trim()) || (ref?.secret && getSecret(ref.secret)) || undefined;
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

// The body fields both APIs share: messages, the JSON-schema constraint, the token limit.
function body(req: CompleteRequest, model: string | undefined, tokensParam: string, temperature: number | undefined): Record<string, unknown> {
  return {
    ...(model ? { model } : {}),
    messages: req.messages,
    ...(req.jsonSchema
      ? { response_format: { type: 'json_schema', json_schema: { name: req.jsonSchema.name, strict: req.jsonSchema.strict ?? true, schema: req.jsonSchema.schema } } }
      : {}),
    [tokensParam]: req.maxTokens,
    ...(req.temperature ?? temperature) !== undefined ? { temperature: req.temperature ?? temperature } : {},
  };
}

async function post(url: string, headers: Record<string, string>, payload: unknown, req: CompleteRequest): Promise<any> {
  const res = await send(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: signalFor(req), redirect: 'error' });
  if (!res.ok) throw new LlmHttpError(res.status, retryAfterMs(res.headers.get('retry-after')));
  return res.json();
}

function result(data: any, req: CompleteRequest): CompleteResult {
  const usage = data?.usage ?? {};
  const choice = data?.choices?.[0];
  const content = choice?.message?.content;
  // A refusal, a filtered answer or one cut off at the token limit is no answer: its text may be partial.
  const cut = !!choice?.message?.refusal || choice?.finish_reason === 'length' || choice?.finish_reason === 'content_filter';
  const text = typeof content === 'string' && !cut ? content : null;
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
  };
}

export function openAiCompatible(id: string, cfg: OpenAiCompatibleConfig): LlmAdapter {
  const base = trimSlash(cfg.baseUrl);
  const key = () => resolveKey(cfg.apiKey);
  const auth = (k: string | undefined): Record<string, string> => (k ? { authorization: `Bearer ${checkCredential(k, 'API key')}` } : {});
  return {
    id,
    apiKey: key,
    keyless: !cfg.apiKey,

    async complete(req: CompleteRequest): Promise<CompleteResult> {
      const k = key();
      if (!k && cfg.apiKey) throw new Error('no API key');
      return result(await post(`${base}/chat/completions`, auth(k), body(req, req.model, cfg.maxTokensParam ?? 'max_tokens', cfg.temperature), req), req);
    },

    async listModels(): Promise<ModelInfo[]> {
      const res = await send(`${base}/models`, { headers: { accept: 'application/json', ...auth(key()) }, signal: AbortSignal.timeout(10_000), redirect: 'error' });
      if (!res.ok) throw new Error(`${id} answered HTTP ${res.status} for its models`);
      const json: any = await res.json().catch(() => ({}));
      const data: any[] = Array.isArray(json?.data) ? json.data : [];
      return data.filter((m) => typeof m?.id === 'string').map((m) => ({ id: m.id, name: m.id, in: null, out: null }));
    },

    // probeKey reports a refused header as a result, so the key goes as it is, not through auth's check.
    checkKey(k: string): Promise<KeyCheck> {
      return probeKey(`${base}/models`, { authorization: `Bearer ${k}` });
    },
  };
}

export function azure(id: string, cfg: AzureConfig): LlmAdapter {
  const endpoint = trimSlash(cfg.endpoint);
  const v1 = cfg.apiVersion === 'v1' || /\/openai\/v1$/.test(endpoint);
  const key = () => resolveKey(cfg.apiKey);
  return {
    id,
    apiKey: key,

    async complete(req: CompleteRequest): Promise<CompleteResult> {
      const k = key();
      if (!k) throw new Error('no API key');
      const headers = { 'api-key': checkCredential(k, 'API key') };
      const model = cfg.deployment ?? req.model;
      // The v1 API names the model in the body; the dated API names the deployment in the path.
      const data = v1
        ? await post(`${/\/openai\/v1$/.test(endpoint) ? endpoint : `${endpoint}/openai/v1`}/chat/completions`, headers, body(req, model, 'max_completion_tokens', cfg.temperature), req)
        : await post(`${endpoint}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${encodeURIComponent(cfg.apiVersion)}`, headers, body(req, undefined, 'max_completion_tokens', cfg.temperature), req);
      return result(data, req);
    },

    // The models list, on the same API the calls use.
    checkKey(k: string): Promise<KeyCheck> {
      const url = v1
        ? `${/\/openai\/v1$/.test(endpoint) ? endpoint : `${endpoint}/openai/v1`}/models`
        : `${endpoint}/openai/models?api-version=${encodeURIComponent(cfg.apiVersion)}`;
      return probeKey(url, { 'api-key': k });
    },
  };
}

export function adapterFor(id: string, cfg: ProviderConfig): LlmAdapter {
  return cfg.kind === 'azure' ? azure(id, cfg) : openAiCompatible(id, cfg);
}

// A provider config read from settings: the supported kinds with their required strings, else null.
export function parseProviderConfig(v: any): ProviderConfig | null {
  if (!v || typeof v !== 'object') return null;
  const str = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim() : undefined);
  const apiKey = v.apiKey && typeof v.apiKey === 'object' && (str(v.apiKey.env) || str(v.apiKey.secret)) ? { ...(str(v.apiKey.env) ? { env: str(v.apiKey.env) } : {}), ...(str(v.apiKey.secret) ? { secret: str(v.apiKey.secret) } : {}) } : undefined;
  const temperature = typeof v.temperature === 'number' && Number.isFinite(v.temperature) ? { temperature: v.temperature } : {};
  if (v.kind === 'openai-compatible' && str(v.baseUrl)) {
    const p = v.maxTokensParam === 'max_completion_tokens' ? 'max_completion_tokens' : undefined;
    return { kind: 'openai-compatible', baseUrl: str(v.baseUrl)!, ...(apiKey ? { apiKey } : {}), ...(p ? { maxTokensParam: p } : {}), ...temperature };
  }
  if (v.kind === 'azure' && str(v.endpoint) && str(v.apiVersion)) {
    return { kind: 'azure', endpoint: str(v.endpoint)!, apiVersion: str(v.apiVersion)!, ...(str(v.deployment) ? { deployment: str(v.deployment) } : {}), ...(apiKey ? { apiKey } : {}), ...temperature };
  }
  return null;
}
