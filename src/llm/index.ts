// The LLM provider layer (S-2113): one place stam's own model calls go through. `complete` asks
// a model for text (or JSON); `listModels`, `balance` and `keyLimit` are the optional extras a
// provider may have. A provider is an adapter registered under its id; more adapters
// (OpenAI-compatible, Azure, Bedrock) register with `registerProvider`.
//
// A model is named `provider:model`. With no provider named, or a prefix that is no registered
// provider (OpenRouter ids such as `meta-llama/llama-3:free` contain colons), the default
// provider, `openrouter`, takes the whole string, so settings written before the layer keep working.
import { openrouter } from './openrouter.ts';
import type { CompleteRequest, CompleteResult, LlmAdapter } from './types.ts';

export * from './types.ts';

export const DEFAULT_PROVIDER = 'openrouter';

const providers = new Map<string, LlmAdapter>([[openrouter.id, openrouter]]);

export function registerProvider(adapter: LlmAdapter): void {
  providers.set(adapter.id, adapter);
}

export function provider(id: string): LlmAdapter | undefined {
  return providers.get(id);
}

// Splits a model name into its provider and model id.
export function parseModelRef(ref: string): { provider: string; model: string } {
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
  return !!resolve(ref).adapter.apiKey();
}

export function complete(req: CompleteRequest): Promise<CompleteResult> {
  const { adapter, model } = resolve(req.model);
  return adapter.complete({ ...req, model });
}
