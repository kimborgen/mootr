#!/usr/bin/env node
// S-3807: src/agent-class.ts over a throwaway home with the given registry.json. Argv: registry.json's text, the
// filter inputs as JSON, the typeOf cases as JSON ({agent, cos}). Prints {filters: [sorted types | null | "error: ..."],
// types: [type]}.
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

const root = new URL('../../../../', import.meta.url);
const { tempHome } = await import(new URL('test/tmphome.mjs', root));
const home = tempHome('stam-agentclass-ref-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `agentclass-ref-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
const [registryJSON, filtersJSON, typesJSON] = process.argv.slice(2);
writeFileSync(join(home, 'registry.json'), registryJSON);
const { parseAgentFilter, typeOf, filterKey } = await import(new URL('src/agent-class.ts', root));

const filters = JSON.parse(filtersJSON).map((raw) => {
  try {
    const keep = parseAgentFilter(raw);
    return keep ? `${filterKey(keep)}` : null;
  } catch (e) {
    return `error: ${e.message}`;
  }
});
const types = JSON.parse(typesJSON).map((c) => typeOf(c.agent, c.cos));
console.log(JSON.stringify({ filters, types }));
process.exit(0);
