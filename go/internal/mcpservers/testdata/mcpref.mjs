#!/usr/bin/env node
// S-3782 6e2: src/mcp-config.ts, src/mcp-import.ts and src/mcp-registry.ts run on the cases of the Go parity tests.
// Stdin: {op, ...}: {op: 'parse', texts}, {op: 'scan', home, cwds, existing}, {op: 'browse', base, calls: [{search,
// cursor}]}, {op: 'probe', urls} or {op: 'check', servers: [[name, server]]}. Prints the results as JSON, with
// {error} for a call that throws. No network is reached but the loopback fakes the Go test starts.
const root = new URL('../../../../', import.meta.url);
const { tempHome } = await import(new URL('test/tmphome.mjs', root));
const { readFileSync } = await import('node:fs');
process.env.STAM_HOME = tempHome('stam-mcp-ref-');
process.env.STAM_TMUX_SOCKET = `mcp-ref-${process.pid}`;
process.env.STAM_EMBEDDER = 'stub';
process.env.STAM_MACHINE = 'test';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'MOOTR_MCP_REGISTRY_URL', 'STAM_MCP_REGISTRY_URL']) delete process.env[k];
console.log = console.warn = () => {};

const input = JSON.parse(readFileSync(0, 'utf8'));
const config = await import(new URL('src/mcp-config.ts', root));
const settle = async (fn) => {
  try {
    return await fn();
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
};
let out;
if (input.op === 'parse') {
  out = [];
  for (const t of input.texts) out.push(await settle(() => config.parseMcpConfig(t)));
} else if (input.op === 'scan') {
  const { scanHarnesses } = await import(new URL('src/mcp-import.ts', root));
  out = scanHarnesses({ home: input.home, cwds: input.cwds, existing: input.existing });
} else if (input.op === 'browse') {
  process.env.STAM_MCP_REGISTRY_URL = input.base;
  const { browseRegistry } = await import(new URL('src/mcp-registry.ts', root));
  out = [];
  for (const c of input.calls) out.push(await settle(() => browseRegistry(c)));
} else if (input.op === 'probe') {
  const { remoteAuth } = await import(new URL('src/mcp-registry.ts', root));
  out = [];
  for (const u of input.urls) out.push(await remoteAuth(u));
} else if (input.op === 'check') {
  out = [];
  for (const [name, server] of input.servers) out.push(await config.testServer(name, server));
}
process.stdout.write(JSON.stringify(out));
process.exit(0);
