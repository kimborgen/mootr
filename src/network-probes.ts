// The network check recovery waits on after a boot (src/lifecycle.ts waitForNetwork): any answer from one
// of these means the network is up, which the harnesses need to resume. A test home may point the probes
// at its own URLs, or skip them with `none`, through STAM_TEST_NETWORK_PROBES (a comma-separated list,
// src/test-env.ts), so a test of recovery never calls out. Elsewhere the variable is ignored.
import { testOnlyEnv } from './test-env.ts';

export const NETWORK_PROBES = ['https://api.anthropic.com', 'https://api.openai.com', 'https://openrouter.ai'];

// The URLs to probe; none means the network counts as up without asking.
export function networkProbes(override = testOnlyEnv('STAM_TEST_NETWORK_PROBES')): string[] {
  if (!override) return NETWORK_PROBES;
  if (override.trim() === 'none') return [];
  const urls = override.split(',').map((u) => u.trim()).filter(Boolean);
  return urls.length ? urls : NETWORK_PROBES;
}

export async function networkUp(probes = networkProbes(), fetchFn: typeof fetch = fetch): Promise<boolean> {
  if (!probes.length) return true;
  return Promise.any(probes.map((url) => fetchFn(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) }))).then(() => true, () => false);
}
