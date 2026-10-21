// The LLM provider layer (S-2113): one place stam's own model calls go through. `complete` asks
// a model for text (or JSON); `listModels`, `balance` and `keyLimit` are the optional extras a
// provider may have. A provider is an adapter registered under its id; the OpenAI-compatible, Azure
// (S-2116) and Bedrock (S-2117) ones are built from `settings.providers`, others register with `registerProvider`.
//
// A model is named `provider:model`. With no provider named, or a prefix that is no registered
// provider (OpenRouter ids such as `meta-llama/llama-3:free` contain colons), the default
// provider, `openrouter`, takes the whole string, so settings written before the layer keep working.
import { settings } from '../settings.ts';
import * as secrets from '../secrets.ts';
import { bedrock, parseBedrockConfig } from './bedrock.ts';
import { adapterFor, parseProviderConfig } from './openai.ts';
import { openrouter } from './openrouter.ts';
import type { CompleteRequest, CompleteResult, KeyCheck, LlmAdapter } from './types.ts';

export * from './types.ts';

export const DEFAULT_PROVIDER = 'openrouter';

const providers = new Map<string, LlmAdapter>([[openrouter.id, openrouter]]);

export function registerProvider(adapter: LlmAdapter): void {
  providers.set(adapter.id, adapter);
}

// The adapters built from settings.providers, rebuilt when that setting changes. A configured id
// never replaces a registered adapter of the same id (openrouter stays as it is).
let configured = new Map<string, LlmAdapter>();
let configuredKey = '';
function sync(): void {
  let raw: Record<string, unknown> = {};
  try {
    raw = settings().providers;
  } catch {}
  const key = JSON.stringify(raw);
  if (key === configuredKey) return;
  configuredKey = key;
  for (const [id, a] of configured) if (providers.get(id) === a) providers.delete(id);
  configured = new Map();
  for (const [id, v] of Object.entries(raw)) {
    if (providers.has(id)) continue;
    const cfg = parseProviderConfig(v);
    const br = cfg ? null : parseBedrockConfig(v);
    const a = cfg ? adapterFor(id, cfg) : br ? bedrock(id, br) : null;
    if (!a) continue;
    configured.set(id, a);
    providers.set(id, a);
  }
}

export function provider(id: string): LlmAdapter | undefined {
  sync();
  return providers.get(id);
}

// Splits a model name into its provider and model id.
export function parseModelRef(ref: string): { provider: string; model: string } {
  sync();
  const i = ref.indexOf(':');
  if (i > 0) {
    const id = ref.slice(0, i);
    if (providers.has(id)) return { provider: id, model: ref.slice(i + 1) };
  }
  return { provider: DEFAULT_PROVIDER, model: ref };
}

// The adapter and bare model id for a `provider:model` name.
export function resolve(ref: string): { adapter: LlmAdapter; model: string } {
  const r = parseModelRef(ref);
  return { adapter: providers.get(r.provider)!, model: r.model };
}

// Whether the model's provider has a key, so a caller can skip a call that cannot be made.
export function hasKey(ref: string): boolean {
  const { adapter } = resolve(ref);
  return !!adapter.apiKey() || !!adapter.keyless;
}

export function complete(req: CompleteRequest): Promise<CompleteResult> {
  const { adapter, model } = resolve(req.model);
  return adapter.complete({ ...req, model });
}

export class KeyTestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// The providers a secret's Test may run against (S-2115): the configured ones whose apiKey names the
// secret, first by id, and OpenRouter for the secret that stands for its key. A `providers.openrouter`
// entry is not one: sync() never replaces the built-in adapter, so its apiKey is never used. Only these, so a Test
// sends a key only where the settings already send it: a provider the human named that doesn't use
// the secret is refused, never tested.
function testTargets(name: string, env: string | undefined): string[] {
  let raw: Record<string, any> = {};
  try {
    raw = settings().providers as Record<string, any>;
  } catch {}
  const ids = Object.keys(raw).sort().filter((k) => k !== DEFAULT_PROVIDER && raw[k]?.apiKey?.secret === name);
  return env === 'OPENROUTER_API_KEY' ? [...ids, DEFAULT_PROVIDER] : ids;
}

// Tests a stored secret against a provider and records the result on the secret. The stored value
// is tested, not an environment override; the result never holds the value.
export async function testSecret(name: string, named?: string): Promise<KeyCheck & { provider: string }> {
  const s = secrets.stored(name);
  if (!s) throw new KeyTestError(404, `no secret ${name}`);
  const targets = testTargets(name, s.env);
  if (named && !targets.includes(named)) throw new KeyTestError(400, `${named} doesn't use ${name}, so it isn't tested there`);
  // Unnamed, the first target that can test a key, so one that can't never hides one that can.
  const id = named ?? targets.find((t) => provider(t)?.checkKey) ?? targets[0];
  if (!id) throw new KeyTestError(400, `no provider uses ${name}`);
  const adapter = provider(id);
  if (!adapter) throw new KeyTestError(400, `no provider ${id}`);
  if (!adapter.checkKey) throw new KeyTestError(400, `${id} can't test a key`);
  const r = await adapter.checkKey(s.value);
  secrets.recordTest(name, { ok: r.ok, detail: `${id}: ${r.detail}` });
  return { provider: id, ...r };
}
