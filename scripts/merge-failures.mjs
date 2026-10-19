#!/usr/bin/env node
// Lists the merge train failures that scripts/merge-pr.mjs logged (S-1071) in $STAM_HOME/merge-train-failures.jsonl:
// `node scripts/merge-failures.mjs [--since 7d] [--json]`. A table of time, PRs, failing step/test and culprit, then a
// count line. --since takes a number and a unit: m, h, d or w.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const UNITS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

export function parseSince(text) {
  const m = /^(\d+)([mhdw])$/.exec(text ?? '');
  if (!m) throw new Error(`--since wants a number and a unit (m, h, d, w), like 7d; got ${text}`);
  return Number(m[1]) * UNITS[m[2]];
}

// The log's entries at or after SINCE (a Date or null), skipping lines that are not JSON.
export function readFailures(file, since = null) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  }).filter((e) => !since || new Date(e.at) >= since);
}

// The outcome kinds of an entry other than merged, each once, in order: `gate`, `preflight`.
const kinds = (e) => [...new Set((e.outcomes ?? []).map((o) => o.kind).filter((k) => k && k !== 'merged'))];
const prList = (e) => e.prs.map((p) => `#${p.pr}`).join(' ');
const failingText = (e) => (e.failing ?? []).map((f) => (f.tests?.length ? `${f.step}: ${f.tests.join(', ')}` : f.step)).join('; ') || '-';
const culprit = (e) => (e.isolated === null ? 'unknown' : e.isolated.length ? e.isolated.map((p) => `#${p}`).join(' ') : '-');

export function render(entries, sinceText) {
  const rows = entries.map((e) => [e.at.slice(0, 16).replace('T', ' '), prList(e), kinds(e).join(',') || '-', failingText(e), culprit(e)]);
  const head = ['time', 'prs', 'kind', 'failing', 'culprit'];
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => c.padEnd(width[i])).join('  ').trimEnd();
  const culprits = entries.reduce((n, e) => n + (e.isolated?.length ?? 0), 0);
  const since = sinceText ? `the last ${sinceText}` : 'the start of the log';
  const failed = entries.filter((e) => e.gateFailed === true);
  const others = entries.filter((e) => e.gateFailed !== true);
  const count = {};
  for (const e of others) for (const k of kinds(e)) count[k] = (count[k] ?? 0) + 1;
  const extra = others.length ? `; ${others.length} without a gate failure (${Object.entries(count).map(([k, n]) => `${n} ${k}`).join(', ') || 'no outcome kind'})` : '';
  return [...(rows.length ? [line(head), ...rows.map(line)] : []), `${failed.length} failed trains, ${culprits} culprit PRs, since ${since}${extra}`].join('\n');
}

function main(args, env = process.env) {
  let sinceText = null;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if (args[i] === '--since' && args[i + 1]) sinceText = args[++i];
    else throw new Error('usage: node scripts/merge-failures.mjs [--since 7d] [--json]');
  }
  const since = sinceText ? new Date(Date.now() - parseSince(sinceText)) : null;
  const file = join(env.STAM_HOME || join(homedir(), '.local/share/stam'), 'merge-train-failures.jsonl');
  const entries = readFailures(file, since);
  console.log(json ? JSON.stringify(entries, null, 2) : render(entries, sinceText));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
