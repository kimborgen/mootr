// Runs the TS daemon's OpenCode config code (src/adapters/opencode.ts, opencode-providers.ts) for
// go/internal/adapters/opencode's golden test (S-4237). DIR is a test home (never the live home) and FAKEHOME the user
// home. The cases come as JSON on stdin:
//
//   {"permissions": [{"mode": "bypass", "cwd": "/path"}, ...], "classify": [EVENT, ...]}
//
// It prints the session permissions per case, the MCP servers (or the error TS throws), the provider blocks with their
// env and collisions, each event's class, stam's own command, and the config folder writeConfig leaves: opencode.json's
// text, the plugin's text and mode, and the skills folder's entries (null for what isn't there), with the error a step
// threw. writeConfig isn't exported, and the adapter's calls that run it (start, afterUpgrade) start or kill the server,
// so its steps are run here in its order.
//
//   node go/internal/adapters/opencode/testdata/ts-config.mjs DIR FAKEHOME < cases.json
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [dir, fakeHome] = process.argv.slice(2);
if (!dir || !fakeHome) {
  console.error('usage: ts-config.mjs DIR FAKEHOME');
  process.exit(2);
}
process.env.STAM_HOME = resolve(dir);
process.env.HOME = resolve(fakeHome);
process.env.STAM_MACHINE = 'test-machine';
process.env.STAM_EMBEDDER = 'stub';
delete process.env.STAM_RELEASE_ID;
const config = await import('../../../../../src/config.ts');
if (config.LIVE_HOME) {
  console.error('ts-config: refusing the live home');
  process.exit(2);
}
// Through the index, as the daemon loads it: an adapter imported first meets an import cycle.
const { adapters } = await import('../../../../../src/adapters/index.ts');
const { sessionPermissions, opencodeMcpServers } = await import('../../../../../src/adapters/opencode.ts');
const { opencodeProviders } = await import('../../../../../src/adapters/opencode-providers.ts');
const { settings } = await import('../../../../../src/settings.ts');
const { registry } = await import('../../../../../src/registry.ts');
const { linkSkills } = await import('../../../../../src/instructions.ts');

const input = JSON.parse(readFileSync(0, 'utf8'));
const out = { bin: config.STAM_BIN };
out.permissions = (input.permissions ?? []).map((c) => sessionPermissions(c.mode, c.cwd || undefined));
out.classify = (input.classify ?? []).map((e) => adapters.opencode.classifyError(e));
try {
  out.mcp = opencodeMcpServers();
} catch (e) {
  out.mcpError = String(e.message);
}
// opencode.ts providers(): a throw reads as no providers.
let providers;
try {
  providers = opencodeProviders(settings().providers, registry());
} catch {
  providers = { blocks: {}, env: {}, collisions: [] };
}
out.providers = providers;

// writeConfig, step by step in its order (src/adapters/opencode.ts): a step that throws leaves the folder as the steps
// before it made it.
const cfgDir = join(config.STAM_HOME, 'opencode');
try {
  mkdirSync(join(cfgDir, 'plugins', 'stam'), { recursive: true });
  copyFileSync(join(config.ROOT, 'src/adapters/opencode-plugin/index.ts'), join(cfgDir, 'plugins/stam/index.ts'));
  let blocks;
  try {
    blocks = opencodeProviders(settings().providers, registry()).blocks;
  } catch {
    blocks = {};
  }
  writeFileSync(
    join(cfgDir, 'opencode.json'),
    JSON.stringify({ $schema: 'https://opencode.ai/config.json', ...(Object.keys(blocks).length ? { provider: blocks } : {}), mcp: { servers: opencodeMcpServers() } }, null, 2),
  );
  linkSkills(join(cfgDir, 'skills'));
} catch (e) {
  out.writeError = String(e.message);
}
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const plugin = join(cfgDir, 'plugins/stam/index.ts');
let skills = null;
if (existsSync(join(cfgDir, 'skills'))) {
  skills = {};
  for (const n of readdirSync(join(cfgDir, 'skills')).sort()) {
    const p = join(cfgDir, 'skills', n);
    skills[n] = lstatSync(p).isSymbolicLink() ? { link: readlinkSync(p) } : { file: true };
  }
}
out.files = { config: read(join(cfgDir, 'opencode.json')), plugin: read(plugin), pluginMode: existsSync(plugin) ? statSync(plugin).mode & 0o777 : 0, skills };
writeSync(1, JSON.stringify(out));
process.exit(0);
