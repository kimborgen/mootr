#!/usr/bin/env node
// Checks test/run.sh's LIGHT names (S-3660): each is a `node --test` entry in cmd(), in FREE, and passes the shared rule in
// light-rules.mjs. Run `node test/light-check.mjs NAME` before adding a name to LIGHT; no args checks every LIGHT name.
// `--root DIR` checks another tree (a fixture). No daemon, slot or build: it reads run.sh and the test files, so it
// finishes in well under a second.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { lightHit, lightMessage } from './light-rules.mjs';

const defaultRoot = fileURLToPath(new URL('..', import.meta.url));

// The LIGHT and FREE name lists and the cmd() file of each name, read from test/run.sh's text.
export function readLists(runSh) {
  const light = (runSh.match(/^LIGHT="\n([^"]*)"/m)?.[1] ?? '').split('\n').filter(Boolean);
  const free = new Set((runSh.match(/^FREE="\n([^"]*)"/m)?.[1] ?? '').split('\n').filter(Boolean));
  const cmdFile = (name) => runSh.match(new RegExp(`^    ${name}\\) echo "node --test (test/[\\w.-]+)"`, 'm'))?.[1];
  return { light, free, cmdFile };
}

// Every problem with the named LIGHT entries under `root`, as lines. An empty array means all pass.
export function lightProblems(root = defaultRoot, names) {
  const { light, free, cmdFile } = readLists(readFileSync(join(root, 'test', 'run.sh'), 'utf8'));
  const problems = [];
  if (light.length === 0) problems.push('no LIGHT names in test/run.sh');
  if (JSON.stringify(light) !== JSON.stringify([...new Set(light)].sort())) problems.push('LIGHT is not sorted with no repeats');
  for (const name of names ?? light) {
    if (!free.has(name)) {
      problems.push(`${name} isn't in FREE`);
      continue;
    }
    const file = cmdFile(name);
    if (!file) {
      problems.push(`${name} isn't a plain node --test file in cmd()`);
      continue;
    }
    const token = lightHit(readFileSync(join(root, file), 'utf8'));
    if (token !== null) problems.push(lightMessage(name, file, token));
  }
  return problems;
}

// `--root DIR` takes the value after it; every other argument is a name to check.
function parseArgs(argv) {
  const rootAt = argv.indexOf('--root');
  if (rootAt === -1) return { root: defaultRoot, names: argv };
  return { root: argv[rootAt + 1], names: argv.filter((_, i) => i !== rootAt && i !== rootAt + 1) };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const { root, names } = parseArgs(process.argv.slice(2));
  const problems = lightProblems(root, names.length ? names : undefined);
  for (const line of problems) console.log(line);
  process.exit(problems.length ? 1 : 0);
}
