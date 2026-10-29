// Runs src/mcp-auth.ts leaseFor on one case, for go/internal/mcpauth's parity test: writes the case's settings.json and
// mcp-auth.json into DIR, then prints what leaseFor answers as JSON: the lease's url and bearer, or the refusal's status
// and message. Never the live home: the caller gives a fresh DIR as STAM_HOME. The test only, so loopback http is allowed.
//
//   node go/internal/mcpauth/testdata/lease.mjs DIR CASE.json
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [dir, caseFile] = process.argv.slice(2);
if (!dir || !caseFile) {
  console.error('usage: lease.mjs DIR CASE.json');
  process.exit(2);
}
process.env.STAM_HOME = resolve(dir);
process.env.STAM_MACHINE = 'test-machine';
process.env.STAM_MCP_AUTH_INSECURE = '1';

const c = JSON.parse(readFileSync(caseFile, 'utf8'));
writeFileSync(resolve(dir, 'settings.json'), JSON.stringify({ mcpServers: c.servers }));
if (c.grant !== null) writeFileSync(resolve(dir, 'mcp-auth.json'), JSON.stringify({ prov: c.grant }));
const mcpAuth = await import('../../../../src/mcp-auth.ts');
try {
  const l = await mcpAuth.leaseFor(c.name, { refresh: c.force });
  console.log(JSON.stringify({ ok: { url: l.url, access_token: l.access_token, expires_at: l.expires_at } }));
} catch (e) {
  console.log(JSON.stringify({ status: e.status ?? null, message: e.message }));
}
