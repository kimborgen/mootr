#!/usr/bin/env node
// S-3782 6h: the pure parts of src/tool-summaries.ts, src/tool-names.ts, src/tool-name-labels.ts, src/block-summaries.ts
// and src/config-hash.ts on the cases of the Go parity test. Stdin: {home, summaries, labels, cleans, calls, callLists,
// nameLists, splits, configs}. Prints each op's results as JSON, with {error} for a call that throws.
const input = JSON.parse((await import('node:fs')).readFileSync(0, 'utf8'));
for (const k of Object.keys(process.env)) if (/^(STAM|MOOTR)_/.test(k)) delete process.env[k];
process.env.STAM_HOME = input.home;
process.env.STAM_EMBEDDER = 'stub';
process.env.STAM_MACHINE = 'test';
console.log = console.warn = console.error = () => {};

const root = new URL('../../../../', import.meta.url);
const ts = await import(new URL('src/tool-summaries.ts', root));
const tn = await import(new URL('src/tool-names.ts', root));
const labels = await import(new URL('src/tool-name-labels.ts', root));
const bs = await import(new URL('src/block-summaries.ts', root));
const { configHash } = await import(new URL('src/config-hash.ts', root));
const settle = (fn) => {
  try {
    return fn();
  } catch (e) {
    return { error: e.message };
  }
};
// A call as the Go test sends it: {id, name, input} with input absent when the case has none.
process.stdout.write(
  JSON.stringify({
    summaries: input.summaries.map((r) => ts.parseToolSummary(r, 12)),
    labels: input.labels.map((r) => tn.parseToolLabel(r)),
    cleans: input.cleans.map((r) => bs.cleanSummary(r)),
    hashes: input.calls.map((c) => ts.callHash(c)),
    texts: input.calls.map((c) => ts.callText(c)),
    callLists: input.callLists.map((l) => settle(() => ts.readCalls(l).map((c) => ({ id: c.id, name: c.name, hasInput: c.input !== undefined, input: c.input ?? null })))),
    nameLists: input.nameLists.map((l) => settle(() => tn.readNames(l))),
    splits: input.splits.map(([name, harness]) => {
      const { server, tool } = labels.splitTool(name, harness);
      return { server: server ?? '', tool, seeded: labels.seededLabel(harness, tool) ?? '' };
    }),
    configs: input.configs.map((parts) => configHash(...parts)),
    texthashes: input.cleans.filter((r) => typeof r === 'string').map((r) => bs.textHash(r)),
  }),
);
process.exit(0);
