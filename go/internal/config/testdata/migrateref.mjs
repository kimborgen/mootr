#!/usr/bin/env node
// S-3782 6e: src/settings-migrate.ts runMigrate on one case of settings_migrate_test.go. Argv: the home folder, the
// machine, and --apply or not; the home holds the case's settings.json, settings.shared.json and backups. Prints
// {code, text, result} as JSON.
const [home, machine, apply] = process.argv.slice(2);
const root = new URL('../../../../', import.meta.url);
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `migrate-ref-${process.pid}`;
process.env.STAM_EMBEDDER = 'stub';
process.env.STAM_MACHINE = machine;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'MOOTR_HOME', 'MOOTR_MACHINE']) delete process.env[k];
console.log = console.warn = () => {};
const { runMigrate } = await import(new URL('src/settings-migrate.ts', root));
process.stdout.write(JSON.stringify(runMigrate(apply === '--apply')));
