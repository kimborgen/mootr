// Prints src/settings.ts DEFAULTS as settings_defaults.json holds it (S-3782): itsa.repos, which TS derives from the
// checkout it runs in, is left empty. Run from the repo root:
//   node go/internal/config/testdata/gendefaults.mjs > go/internal/config/settings_defaults.json
const { DEFAULTS } = await import(new URL('../../../../src/settings.ts', import.meta.url).href);
const out = structuredClone(DEFAULTS);
out.itsa.repos = {};
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
