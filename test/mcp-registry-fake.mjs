#!/usr/bin/env node
// A fake MCP registry for the UI checks (S-53): one page of servers, no network. The daemon
// points STAM_MCP_REGISTRY_URL at it. Env: REGISTRY_PORT, REGISTRY_READY (written once up).
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

const official = (isLatest = true) => ({ 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest } });
const servers = [
  { server: { name: 'com.example/docs', title: 'Example Docs', description: 'Search the example documentation from any agent.', version: '1.0.0', websiteUrl: 'https://docs.example.com', repository: { url: 'https://github.com/example/docs-mcp' }, remotes: [{ type: 'streamable-http', url: 'https://docs.example.com/mcp' }] }, _meta: official() },
  { server: { name: 'com.example/needs-token', title: 'Token Service', description: 'A service that needs an API token to answer.', version: '2.1.0', repository: { url: 'https://github.com/example/token-mcp' }, remotes: [{ type: 'streamable-http', url: 'https://token.example.com/mcp', headers: [{ name: 'Authorization', description: 'A bearer token from the service.', isRequired: true, isSecret: true }] }] }, _meta: official() },
  { server: { name: 'com.example/notes', description: 'Read and write notes in a local folder.', version: '0.3.0', packages: [{ registryType: 'pypi', identifier: 'notes-mcp', version: '0.3.0', environmentVariables: [{ name: 'NOTES_DIR', description: 'Where the notes live.', isRequired: true }] }] }, _meta: official() },
  { server: { name: 'com.example/npm-tool', description: 'A ready-to-run npm server.', version: '4.0.0', packages: [{ registryType: 'npm', identifier: 'npm-tool-mcp', version: '4.0.0', runtimeHint: 'npx', runtimeArguments: [{ value: '-y', type: 'positional' }], environmentVariables: [{ name: 'LOG_LEVEL', default: 'info', description: 'How much to log.' }] }] }, _meta: official() },
  { server: { name: 'com.example/legacy', description: 'An older server that only speaks SSE.', version: '1.5.0', remotes: [{ type: 'sse', url: 'https://legacy.example.com/sse' }] }, _meta: official() },
];
const body = JSON.stringify({ servers, metadata: { count: servers.length } });

// Exits when the process that started it is gone (a script killed hard runs no trap), S-668.
{
  const parent = process.ppid;
  setInterval(() => process.ppid !== parent && process.exit(0), 1000).unref();
}

createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(body);
}).listen(Number(process.env.REGISTRY_PORT), '127.0.0.1', () => writeFileSync(process.env.REGISTRY_READY, String(process.env.REGISTRY_PORT)));
