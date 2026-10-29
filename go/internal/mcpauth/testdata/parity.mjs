// Runs src/mcp-auth.ts on the cases go/internal/mcpauth's parity test gives it, and prints what it answers as JSON:
// privateIp per address, tokenResponse per answer, assertEndpoint per URL (its message, or ok), and the store file that
// writeStore writes for a fixed store. Never the live home: the caller gives a fresh DIR as STAM_HOME.
//
//   node go/internal/mcpauth/testdata/parity.mjs DIR CASES.json
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const [dir, casesFile] = process.argv.slice(2);
if (!dir || !casesFile) {
  console.error('usage: parity.mjs DIR CASES.json');
  process.exit(2);
}
process.env.STAM_HOME = resolve(dir);
process.env.STAM_MACHINE = 'test-machine';
delete process.env.STAM_MCP_AUTH_INSECURE;
delete process.env.MOOTR_MCP_AUTH_INSECURE;

const cases = JSON.parse(readFileSync(casesFile, 'utf8'));
const mcpAuth = await import('../../../../src/mcp-auth.ts');

const out = { privateIp: {}, tokenResponse: [], endpoint: {}, store: null };
for (const ip of cases.ips) out.privateIp[ip] = mcpAuth.privateIp(ip);

for (const tok of cases.tokens) {
  try {
    out.tokenResponse.push({ ok: mcpAuth.tokenResponse(tok) });
  } catch (e) {
    out.tokenResponse.push({ error: e.message });
  }
}

for (const u of cases.urls) {
  try {
    await mcpAuth.assertEndpoint(u);
    out.endpoint[u] = 'ok';
  } catch (e) {
    out.endpoint[u] = e.message;
  }
}

mcpAuth.writeStore(cases.store);
out.store = readFileSync(resolve(dir, 'mcp-auth.json'), 'utf8');
out.storeMode = statSync(resolve(dir, 'mcp-auth.json')).mode & 0o777;
console.log(JSON.stringify(out));
