import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { ROOT, STAM_HOME } from './config.ts';
import { peerShared, statKey } from './settings.ts';

// Harnesses, models, presets, prices, and agent types: the repo's registry/defaults.json, with
// entries in the user registry replacing defaults by key; a null entry removes a shipped one. The
// user registry is STAM_HOME/registry.json on the settings home, and the home's copy from the
// shared cache on a peer that has one (S-387). Kept until a file's stat or the cache changes, so a
// read costs a few stats; each caller gets its own copy, since some change what they get.
let memo: { key: string; shared: unknown; value: any } | null = null;
export function registry(): any {
  const defaultsFile = join(ROOT, 'registry', 'defaults.json');
  const userFile = join(STAM_HOME, 'registry.json');
  const shared = peerShared();
  const key = `${statKey(defaultsFile)}|${statKey(userFile)}`;
  if (memo?.key !== key || memo.shared !== shared) {
    const defaults = JSON.parse(readFileSync(defaultsFile, 'utf8'));
    let user: any = shared?.registry ?? {};
    if (!shared?.registry)
      try {
        user = JSON.parse(readFileSync(userFile, 'utf8'));
      } catch {}
    const out: any = { ...defaults, ...user };
    for (const k of ['harnesses', 'models', 'presets', 'prices', 'types']) {
      out[k] = Object.fromEntries(Object.entries<any>({ ...defaults[k], ...user[k] }).filter(([, v]) => v != null));
    }
    memo = { key, shared, value: out };
  }
  return structuredClone(memo.value);
}

// What an agent can do: its model's inputs plus its harness's tools. A model the
// registry doesn't know yet gets unknown (null) inputs; spawning it still works.
export function capabilitiesFor(harness: string, model: string | null): Record<string, unknown> {
  const r = registry();
  const m = model ? r.models[model] : undefined;
  return {
    inputs: m?.inputs ?? { text: true, image: null, video: null },
    tools: r.harnesses[harness]?.tools ?? {},
    model_known: Boolean(m),
  };
}

export function preset(name: string): { harness: string; model: string | null; effort: string | null } {
  const p = registry().presets[name];
  if (!p) throw new Error(`no preset ${name}; see stam registry`);
  return p;
}
