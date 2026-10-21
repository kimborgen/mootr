// OpenCode provider blocks (S-2118): each provider in settings.providers becomes a `provider` block in
// the opencode.json stam writes, so an OpenCode agent can run on it as `PROVIDER/MODEL`. The block is
// keyed by stam's provider id and names the AI SDK package for its kind: `@ai-sdk/openai-compatible`
// (`@ai-sdk/openai` for api.openai.com), `@ai-sdk/azure` or `@ai-sdk/amazon-bedrock`. OpenCode 2 still
// reads this documented `provider` form and migrates it to its `providers` one (checked on v2.0.26).
//
// A key never lands in the file: the block's apiKey is `{env:STAM_PROVIDER_<ID>_KEY}`, and that
// variable is set only in the OpenCode server's environment. OpenRouter is not configured here: it
// keeps its key in STAM_HOME/opencode.env (OPENROUTER_API_KEY), which OpenCode reads itself.
import { parseBedrockConfig, type BedrockConfig } from '../llm/bedrock.ts';
import { parseProviderConfig, resolveKey, type KeyRef } from '../llm/openai.ts';

// The key an OpenCode agent uses for a provider. One place, so the agent key slot of the secret
// store (S-2114) can take over here; until then it is the provider's own key ref.
export function agentKey(_id: string, ref: KeyRef | undefined): string | undefined {
  return resolveKey(ref);
}

// The environment variable that carries a provider's key into the OpenCode server.
export function keyEnvName(id: string): string {
  return `STAM_PROVIDER_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_KEY`;
}

// The registry's OpenCode models on one provider (`ID/MODEL`), as OpenCode model entries with the
// registry's per-provider price as their cost, so OpenCode's own session cost uses it.
function models(id: string, reg: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [full, m] of Object.entries<any>(reg?.models ?? {})) {
    if (!full.startsWith(`${id}/`) || (m?.harnesses && !m.harnesses.includes('opencode'))) continue;
    const p = reg?.prices?.[full];
    const cost =
      typeof p?.input === 'number' && typeof p?.output === 'number'
        ? { input: p.input, output: p.output, ...(typeof p.cacheRead === 'number' ? { cache_read: p.cacheRead } : {}), ...(typeof p.cacheWrite === 'number' ? { cache_write: p.cacheWrite } : {}) }
        : undefined;
    out[full.slice(id.length + 1)] = { name: typeof m?.name === 'string' && m.name ? m.name : full.slice(id.length + 1), ...(cost ? { cost } : {}) };
  }
  return out;
}

// The `provider` blocks for opencode.json and the server environment that carries their keys. An
// entry that doesn't parse, or the id `openrouter`, is left out; a provider with no key gets none.
// Ids whose key variables would be the same (`my-az`, `my_az`) are all left out and named in
// `collisions`, so one provider never sends another's key to its host.
export function opencodeProviders(raw: Record<string, unknown>, reg: any): { blocks: Record<string, unknown>; env: Record<string, string>; collisions: string[] } {
  const blocks: Record<string, unknown> = {};
  const env: Record<string, string> = {};
  const parsed: [string, NonNullable<ReturnType<typeof parseProviderConfig>> | BedrockConfig][] = [];
  for (const [id, v] of Object.entries(raw ?? {})) {
    if (id === 'openrouter' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) continue;
    const cfg = parseBedrockConfig(v) ?? parseProviderConfig(v);
    if (cfg) parsed.push([id, cfg]);
  }
  const byEnv = new Map<string, string[]>();
  for (const [id] of parsed) byEnv.set(keyEnvName(id), [...(byEnv.get(keyEnvName(id)) ?? []), id]);
  const collisions = [...byEnv.values()].filter((ids) => ids.length > 1).flat();
  for (const [id, cfg] of parsed) {
    if (collisions.includes(id)) continue;
    const key = agentKey(id, cfg.apiKey);
    if (key) env[keyEnvName(id)] = key;
    const apiKey = key ? { apiKey: `{env:${keyEnvName(id)}}` } : {};
    const ms = models(id, reg);
    let npm: string;
    let options: Record<string, unknown>;
    if (cfg.kind === 'openai-compatible') {
      npm = /^https:\/\/api\.openai\.com(\/|$)/.test(cfg.baseUrl) ? '@ai-sdk/openai' : '@ai-sdk/openai-compatible';
      options = { baseURL: cfg.baseUrl.replace(/\/+$/, ''), ...apiKey };
    } else if (cfg.kind === 'azure') {
      // A resource endpoint names the resource; any other endpoint is the base URL, up to /openai.
      const endpoint = cfg.endpoint.replace(/\/+$/, '').replace(/\/openai(\/v1)?$/, '');
      const resource = /^https:\/\/([a-z0-9-]+)\.openai\.azure\.com$/i.exec(endpoint)?.[1];
      const dated = cfg.apiVersion !== 'v1' && !/\/openai\/v1\/*$/.test(cfg.endpoint);
      options = { ...(resource ? { resourceName: resource } : { baseURL: `${endpoint}/openai` }), ...(dated ? { apiVersion: cfg.apiVersion, useDeploymentBasedUrls: true } : {}), ...apiKey };
      npm = '@ai-sdk/azure';
      if (cfg.deployment && !ms[cfg.deployment]) ms[cfg.deployment] = { name: cfg.deployment };
    } else {
      npm = '@ai-sdk/amazon-bedrock';
      options = { region: cfg.region, ...(cfg.profile ? { profile: cfg.profile } : {}), ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}), ...apiKey };
    }
    blocks[id] = { npm, name: id, options, ...(Object.keys(ms).length ? { models: ms } : {}) };
  }
  return { blocks, env, collisions };
}
