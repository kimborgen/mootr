// Where a tiny-model step's call is asked and booked (S-3228, S-3245): shared by tool names, tool summaries,
// mail titles and block summaries. A call through `provider:model` is asked only when that provider has a key
// and its system budget is not spent, and its spend is booked to <provider>-system, never to OpenRouter's
// credit (openrouter-system, the default, takes no `to`).
import { providerHeld } from './budgets.ts';
import type { SpendTo } from './decide.ts';
import { hasKey, parseModelRef, DEFAULT_PROVIDER } from './llm/index.ts';

// The held reason when the model's provider can't be asked now, else null: no key, or its system budget spent.
export function askBlocked(model: string): string | null {
  if (!hasKey(model)) return 'no API key';
  return providerHeld(parseModelRef(model).provider);
}

export function spendTo(provider: string): SpendTo | undefined {
  return provider === DEFAULT_PROVIDER ? undefined : { provider, account: `${provider}-system` };
}
