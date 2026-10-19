#!/usr/bin/env node
// The process editor's model against the real files (S-1083): applying a one-field edit to
// processes/dev-change.yaml changes that line only and keeps its comments. The model is the web's
// (web/src/process/edit.ts), which runs here without a browser. Run with `node --test test/process-edit.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProcessText } from '../src/process-validate.ts';
import { addEdge, addLane, addNode, deleteEdge, deleteNode, mergeIntoSource, updateEdge, updateNode } from '../web/src/process/edit.ts';

const file = join(import.meta.dirname, '..', 'processes', 'dev-change.yaml');
const source = readFileSync(file, 'utf8');
const statuses = new Set(['in_progress', 'in_review', 'needs_approval', 'ready_to_merge', 'merging', 'deploying', 'todo', 'blocked', 'testing', 'needs_input', 'needs_review', 'needs_test', 'planning', 'delegated', 'waiting', 'done', 'canceled', 'wont_do', 'backlog', 'ready', 'scheduled', 'idea', 'icebox', 'duplicate']);
const load = () => {
  const { process, errors } = parseProcessText(source, { file: 'dev-change.yaml', knownStatuses: statuses });
  assert.deepEqual(errors, []);
  return process;
};
const changedLines = (a, b) => {
  const x = a.split('\n');
  const y = b.split('\n');
  return { same: x.length === y.length, diff: x.map((l, i) => (l === y[i] ? null : [l, y[i]])).filter(Boolean) };
};

test('an unchanged draft leaves the file byte for byte', () => {
  assert.equal(mergeIntoSource(source, load()), source);
});

test('a label edit changes exactly one line and keeps the comments', () => {
  const d = updateNode(load(), 'code', { label: 'Implement and test' });
  const out = mergeIntoSource(source, d);
  const { same, diff } = changedLines(source, out);
  assert.ok(same);
  assert.equal(diff.length, 1);
  assert.match(diff[0][1], /label: Implement and test/);
  assert.ok(out.includes('# Drawn only in step 1'));
  assert.ok(out.includes('# `example: true` triggers are drawn only'));
  assert.equal(parseProcessText(out, { file: 'dev-change.yaml', knownStatuses: statuses }).errors.length, 0);
});

test('an edge label edit is one line, and so is a trigger edit', () => {
  const d = load();
  const i = d.edges.findIndex((e) => e.label);
  const out = mergeIntoSource(source, updateEdge(d, i, { label: 'renamed' }));
  assert.equal(changedLines(source, out).diff.length, 1);
  const triggers = load().nodes.request.triggers.map((x) => (x.source === 'timer' ? { ...x, cron: '0 7 * * *' } : x));
  const out2 = mergeIntoSource(source, updateNode(load(), 'request', { triggers }));
  assert.equal(changedLines(source, out2).diff.length, 1);
});

test('adding a status to a node rewrites only its statuses line', () => {
  const out = mergeIntoSource(source, updateNode(load(), 'code', { statuses: ['in_progress', 'blocked', 'testing'] }));
  const { same, diff } = changedLines(source, out);
  assert.ok(same);
  assert.equal(diff.length, 1);
  assert.match(diff[0][1], /statuses: \[in_progress, blocked, testing\]/);
});

test('deleting a node and adding a lane keep the rest as written', () => {
  const d = addLane(deleteNode(load(), 'plan'), 'auditor', 'Auditor').draft;
  const out = mergeIntoSource(source, d);
  const p = parseProcessText(out, { file: 'dev-change.yaml', knownStatuses: statuses });
  assert.deepEqual(p.errors.filter((e) => !/unknown ITSA status|statuses/.test(e)), []);
  assert.ok(out.includes('  human:     { type: human }'), 'the lane alignment stays');
  assert.ok(!/^  plan:/m.test(out));
  assert.ok(/auditor: \{ type: auditor, label: Auditor \}/.test(out));
});

test('adding a node and an edge keeps every other line, comments included', () => {
  const a = addNode(load(), 'script', 'manager', 'Notify the channel');
  const out = mergeIntoSource(source, addEdge(a.draft, 'merge', a.id));
  const lost = source.split('\n').filter((l) => l.trim() && !out.split('\n').includes(l));
  assert.deepEqual(lost, [], 'no original line is rewritten');
  assert.ok(out.includes('# `example: true` triggers are drawn only'));
  assert.equal(parseProcessText(out, { file: 'dev-change.yaml', knownStatuses: statuses }).errors.length, 0);
});

test('deleting an edge removes that edge and keeps the comments', () => {
  const d = load();
  const out = mergeIntoSource(source, deleteEdge(d, 0));
  assert.ok(out.includes('# Drawn only in step 1'));
  assert.equal(parseProcessText(out, { file: 'dev-change.yaml', knownStatuses: statuses }).process.edges.length, d.edges.length - 1);
});

test('two added edges are patched in order, with every other line as written', () => {
  let d = addEdge(load(), 'plan', 'review');
  d = addEdge(d, 'request', 'merge');
  const out = mergeIntoSource(source, d);
  const lost = source.split('\n').filter((l) => l.trim() && !out.split('\n').includes(l));
  assert.deepEqual(lost, [], 'no original line is rewritten');
  const p = parseProcessText(out, { file: 'dev-change.yaml', knownStatuses: statuses }).process;
  assert.deepEqual(p.edges.slice(-2).map((e) => `${e.from}>${e.to}`), ['plan>review', 'request>merge']);
  assert.ok(out.includes('  human:     { type: human }'));
});

test('three edits at once (a label, a new edge, a removed edge) change just those lines', () => {
  let d = updateNode(load(), 'code', { label: 'Build it' });
  d = addEdge(d, 'plan', 'review');
  d = deleteEdge(d, 0);
  const out = mergeIntoSource(source, d);
  const { same, diff } = changedLines(source, out);
  assert.ok(!same || diff.length >= 1);
  const lost = source.split('\n').filter((l) => l.trim() && !out.split('\n').includes(l));
  assert.equal(lost.length, 2, `only the relabelled line and the removed edge differ: ${lost.join(' | ')}`);
});
