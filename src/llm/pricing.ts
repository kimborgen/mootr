// Pricing for a call whose provider reports no cost (S-3245): the OpenAI-compatible, Azure and Bedrock
// adapters return tokens only, so the cost is priced from the registry's prices (USD per million tokens),
// looked up by `provider:model`, then by the bare model id. A model with no price is booked at a
// conservative fallback, never at $0, and the call says so (`priced: 'fallback'`) so it is logged.
import { registry } from '../registry.ts';

// Dearer than any model in the registry, so an unpriced model overstates its spend rather than hides it.
export const FALLBACK_PRICE = { input: 15, output: 75 };

export interface Priced { costUsd: number; priced: 'catalog' | 'fallback' | 'free' }

// `unmetered`: the provider bills nothing (a keyless local server), so an uncatalogued model is free.
export function priceCall(provider: string, model: string, tokensIn: number, tokensOut: number, unmetered = false): Priced {
  const prices = (registry().prices ?? {}) as Record<string, { input?: number | null; output?: number | null } | undefined>;
  const p = prices[`${provider}:${model}`] ?? prices[model];
  const known = typeof p?.input === 'number' && typeof p?.output === 'number';
  if (!known && unmetered) return { costUsd: 0, priced: 'free' };
  const { input, output } = known ? { input: p!.input as number, output: p!.output as number } : FALLBACK_PRICE;
  return { costUsd: (tokensIn * input + tokensOut * output) / 1e6, priced: known ? 'catalog' : 'fallback' };
}
