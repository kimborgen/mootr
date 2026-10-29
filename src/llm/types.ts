// The LLM provider layer's types (S-2113): what a caller asks of any provider, and the small
// interface an adapter implements. A provider is one adapter in the registry (src/llm/index.ts),
// keyed by id; a model is named `provider:model`, and `openrouter` is the provider when none is named.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// A JSON-schema constraint on the answer (structured output).
export interface JsonSchema {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

export interface CompleteRequest {
  // The model, as `provider:model` or a bare model id (the default provider's).
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  // Left out of the request when absent (some reasoning models reject any temperature).
  temperature?: number;
  jsonSchema?: JsonSchema;
  // Aborts the call; `timeoutMs` bounds it.
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface CompleteResult {
  text: string | null;
  // The text parsed as JSON, when a schema was asked for and the answer parses.
  json?: unknown;
  // The model the provider says answered; the requested model when it says nothing.
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  // Billed cost in USD, when the provider reports one.
  costUsd?: number;
  // Set when stam priced the call itself (src/llm/pricing.ts): from the registry's prices, or the dearer fallback for a model with none.
  priced?: 'catalog' | 'fallback' | 'free';
}

export interface ModelInfo {
  id: string;
  name: string;
  // USD per million tokens; null when not known.
  in: number | null;
  out: number | null;
}

// The account's credit: total bought and used, in USD.
export interface Balance {
  total: number | null;
  used: number | null;
}

// The key's own spending cap, when it has one (limit null: no cap).
export interface KeyLimit {
  limit: number | null;
  remaining: number | null;
}

// Whether a provider accepts a key (S-2115). `detail` is fixed text: a status or a transport error's code.
export interface KeyCheck {
  ok: boolean;
  status?: number;
  detail: string;
}

// A call that answered non-2xx. `retryAfterMs` is the Retry-After header in ms, capped at 5 minutes.
export class LlmHttpError extends Error {
  status: number;
  retryAfterMs?: number;
  constructor(status: number, retryAfterMs?: number, message = `HTTP ${status}`) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

// A provider. `complete` is the one required method. Failures throw: an `LlmHttpError` for a non-2xx
// answer, any other error for a network error, a timeout or an abort. The optional methods are
// absent where a provider has no such thing; a missing key is `apiKey()` returning undefined.
export interface LlmAdapter {
  id: string;
  apiKey(): string | undefined;
  // A provider that takes no key (a local Ollama): `hasKey` is true without one.
  keyless?: boolean;
  // A server that bills nothing (a local Ollama or vLLM, S-3245): a model with no catalogue price books $0, not the fallback.
  unmetered?: boolean;
  complete(req: Omit<CompleteRequest, 'model'> & { model: string }): Promise<CompleteResult>;
  listModels?(): Promise<ModelInfo[]>;
  // The account's credit. Null when the call fails or answers non-2xx.
  // `key` is a credential snapshot to use instead of rereading the key source.
  balance?(key?: string): Promise<Balance | null>;
  // The key's own cap. Null when the call fails or answers non-2xx, which is also the key probe.
  keyLimit?(key?: string): Promise<KeyLimit | null>;
  // The decision-model endpoint (OpenRouter only): POSTs the body and returns the parsed answer
  // (null when the body is not JSON). Throws like `complete`. `key` is the caller's credential
  // snapshot, used instead of rereading the key source.
  decisions?(body: Record<string, unknown>, opts: { timeoutMs: number; key?: string }): Promise<any>;
  // Whether the provider accepts `key` (S-2115): one authenticated read, never a billed call.
  // Absent where a provider has no cheap way to check one.
  checkKey?(key: string): Promise<KeyCheck>;
}
