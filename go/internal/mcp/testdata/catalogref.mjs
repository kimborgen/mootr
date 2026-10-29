// Prints src/mcp.ts toolCatalog with requirements off and on, as JSON.stringify writes them, for catalog_test.go
// (S-3776). The home is a fresh temp folder, removed after.
//
//   node go/internal/mcp/testdata/catalogref.mjs
import { mkdtempSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'stam-catalogref-'));
// src/env.ts reads MOOTR_X before STAM_X, so the MOOTR_ twins go and the STAM_ names below are the ones read.
for (const k of Object.keys(process.env)) if (k.startsWith('MOOTR_')) delete process.env[k];
process.env.STAM_HOME = home;
process.env.STAM_MACHINE = 'test-machine';
process.env.STAM_EMBEDDER = 'stub';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_RELEASE_ID']) delete process.env[k];
const { toolCatalog } = await import('../../../../src/mcp.ts');
writeSync(1, JSON.stringify([JSON.stringify(toolCatalog({ requirements: false })), JSON.stringify(toolCatalog({ requirements: true }))]));
rmSync(home, { recursive: true, force: true });
process.exit(0);
