// Runs one peer operation of src/mcp-auth.ts on a case, for go/internal/mcpauth's peer parity test: writes the case's
// settings.json (a peer whose home is home-machine, reached at the case's home url) and mcp-auth.json into DIR, runs
// tokenFor, status or logout, and prints the answer as one line starting with RESULT: the lease's url, bearer and expiry,
// the status, or the refusal's status and message. Never the live home: the caller gives a fresh DIR as STAM_HOME.
// The test only, so loopback http is allowed.
//
//   node go/internal/mcpauth/testdata/peer.mjs DIR CASE.json
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [dir, caseFile] = process.argv.slice(2);
if (!dir || !caseFile) {
  console.error('usage: peer.mjs DIR CASE.json');
  process.exit(2);
}
process.env.STAM_HOME = resolve(dir);
process.env.STAM_MACHINE = 'peer-machine';
process.env.STAM_MCP_AUTH_INSECURE = '1';

const c = JSON.parse(readFileSync(caseFile, 'utf8'));
writeFileSync(
  resolve(dir, 'settings.json'),
  JSON.stringify({
    home: 'home-machine',
    peers: [{ name: 'home-machine', url: c.home, leaseToken: 'LEASE-SECRET' }],
    mcpServers: c.servers,
  }),
);
if (c.grant !== null) writeFileSync(resolve(dir, 'mcp-auth.json'), JSON.stringify({ prov: c.grant }));
const mcpAuth = await import('../../../../src/mcp-auth.ts');
const out = (v) => console.log('RESULT ' + JSON.stringify(v));
try {
  if (c.op === 'token') {
    const b = await mcpAuth.tokenFor(c.name, { refresh: c.force });
    out({ ok: { name: b.name, url: b.url, token: b.token, expires_at: b.expires_at } });
  } else if (c.op === 'status') {
    const s = await mcpAuth.status();
    out({ ok: { servers: s.servers, home: s.home } });
  } else if (c.op === 'logout') {
    mcpAuth.logout(c.name);
    out({ ok: { logged_out: c.name } });
  } else {
    throw new Error('unknown op ' + c.op);
  }
} catch (e) {
  out({ status: e.status ?? null, message: e.message });
}
