#!/usr/bin/env node
// A stub OpenRouter decisions endpoint for tests (free): answers the four mail-check noul
// questions, any other noul question from a P=0.NN marker, a score question the score DIR/scores.json
// (title to score, S-1465) gives the title its instructions name, and any choice question with the key
// a CHOICE=<key> marker names (else the first criteria key), a choice question named N the key a
// REQ:N=<key> marker names (a requirement check: REQ:R-1=violates gives P 0.9 violates, 0.05 for the
// other two), and counts calls.
// `node decide-stub.mjs DIR` listens on a free port and writes DIR/url; each POST /decisions
// rewrites DIR/count. The mail check's mail gets `follows` below 0.5 when its state carries
// the marker MAILCHECK:NO, so a test can seed both verdicts. A file DIR/rate429 holding N makes
// the next N requests get 429 (Retry-After: 0), then the file is decremented, so a test can seed
// a rate limit that clears (S-252). A STUB:FAIL state gets 500 with Retry-After: 0, and a STUB:WAIT
// state gets 500 with Retry-After: 3600 (S-253: a run asleep on a retry). POST /chat/completions
// answers mail titles and tool summaries (see chat below).
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? '.';
mkdirSync(dir, { recursive: true });
let count = 0;
const held = [];
setInterval(() => {
  if (held.length && existsSync(join(dir, 'release'))) {
    for (const r of held.splice(0)) r.writeHead(500, { 'retry-after': '0' }).end('{}');
    rmSync(join(dir, 'release'));
  }
}, 10).unref();

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (req.method === 'POST' && /\/chat\/completions$/.test(req.url ?? '')) return chat(res, Buffer.concat(chunks).toString());
    if (req.method !== 'POST' || !/\/decisions$/.test(req.url ?? '')) {
      res.writeHead(404).end('{}');
      return;
    }
    count++;
    writeFileSync(join(dir, 'count'), String(count));
    let state = '';
    let questions = {};
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      state = typeof body.state === 'string' ? body.state : JSON.stringify(body.state ?? '');
      questions = body.questions ?? {};
    } catch {}
    // A state with STUB:HANG is held while DIR/hang exists, until DIR/release is written: then the held
    // calls get a 500 (S-253).
    if (state.includes('STUB:HANG') && existsSync(join(dir, 'hang'))) {
      held.push(res);
      return;
    }
    // The last decision state is kept in DIR/state, for a test to see what the model was given (S-985).
    writeFileSync(join(dir, 'state'), state);
    const no = state.includes('MAILCHECK:NO');
    // A state with NEEDS_CONTEXT reads as an unneeded update unless it carries the human's message from
    // the thread (S-985: the gate gives the model that context).
    // NEEDS_QUESTION reads as an update unless the state says the human asked the sender a question.
    const lacksContext = (state.includes('NEEDS_CONTEXT') && !state.includes("The human's latest message in the thread")) || (state.includes('NEEDS_QUESTION') && !state.includes('a question addressed to the sender'));
    // A rate limit that clears after N requests (rate429 counts down in the file).
    const limitFile = join(dir, 'rate429');
    const limited = existsSync(limitFile) ? Number(readFileSync(limitFile, 'utf8')) : 0;
    if (limited > 0) {
      writeFileSync(limitFile, String(limited - 1));
      res.writeHead(429, { 'retry-after': '0' }).end('{}');
      return;
    }
    // Any other noul question (a decision step's) answers P(yes) from a `P=0.NN` marker in
    // the state, 0.1 without one; a state with STUB:FAIL gets a 500.
    if (state.includes('STUB:FAIL') || state.includes('STUB:WAIT')) {
      res.writeHead(500, { 'retry-after': state.includes('STUB:WAIT') ? '3600' : '0' }).end('{}');
      return;
    }
    const p = Number(state.match(/P=(0\.\d+)/)?.[1] ?? 0.1);
    // A choice question (the activity classifier, S-214) picks the key a CHOICE=<key> marker
    // names, else the question's first criteria key; its probability is 0.9 for that key.
    // A REQ:<question name>=<key> marker answers that one question (a requirement check, S-503:
    // the questions are named by requirement key, as REQ:R-1=violates), whatever CHOICE says.
    const choiceAnswer = (q, name) => {
      const keys = Object.keys(q.criteria ?? {});
      const ctxPick = lacksContext && keys.includes('update') ? 'update' : undefined;
      const marker = ctxPick ?? state.match(new RegExp(`REQ:${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([\\w.-]+)`))?.[1] ?? state.match(/CHOICE=([\w.-]+)/)?.[1];
      const picked = keys.includes(marker) ? marker : keys[0];
      const probabilities = Object.fromEntries(keys.map((k) => [k, k === picked ? 0.9 : 0.1 / Math.max(1, keys.length - 1)]));
      return { type: 'choice', choice: picked, probabilities, confidence: 0.9 };
    };
    // A score question (the suggestion rescoring, S-1465) gets the score that DIR/scores.json (a map of
    // title to score) gives the title its instructions name, else P; its legend names the two ends.
    const scoreAnswer = (q) => {
      const file = join(dir, 'scores.json');
      const map = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
      const title = Object.keys(map).find((t) => q.instructions?.includes(t));
      const score = title ? map[title] : p;
      return { type: 'score', score, legend: { 0: 'not what the text asks for', 1: 'what the text asks for' }, probabilities: { 0: 1 - score, 1: score }, confidence: 0.9 };
    };
    const extra = Object.fromEntries(
      Object.entries(questions).map(([k, q]) => [k, q?.type === 'choice' ? choiceAnswer(q, k) : q?.type === 'score' ? scoreAnswer(q) : { type: 'noul', noul: p }]),
    );
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        model: 'microsoft/microsoft-decision-1-stub',
        answers: {
          ...extra,
          follows: { type: 'noul', noul: no ? 0.12 : 0.94 },
          concise: { type: 'noul', noul: 0.9 },
          fluff: { type: 'noul', noul: no ? 0.85 : 0.1 },
          value: { type: 'noul', noul: no ? 0.2 : lacksContext ? 0.05 : 0.8 },
        },
        usage: { input_tokens: 40, output_tokens: 2, cost: 0.02 },
        id: 'gen-dec-stub',
        provider: 'stub',
      }),
    );
  });
});
// A chat completion, for mail titles (S-297): each POST rewrites DIR/titles with the call count.
// The answer is the words of a TITLE=Some_Words marker in the prompt, else the subject's first
// four words, labelled and padded for the caller to clean ("**Title: Four words of subject.**");
// STUB:FAIL gets a 500, and STUB:HANG is held while DIR/hang exists. When the prompt asks for a
// summary too (S-1001), a second line "Summary: ..." follows (STUB:NOTITLE leaves the title out): the words of a SUMMARY=Some_Words
// marker (a double underscore starts a new line; a marker with %XX escapes is URL-decoded instead, for text with punctuation), else "Summary of <subject>"; STUB:NOSUMMARY leaves the line out.
let titles = 0;
function chat(res, raw) {
  titles++;
  writeFileSync(join(dir, 'titles'), String(titles));
  let text = '';
  try {
    text = (JSON.parse(raw).messages ?? []).map((m) => m.content).join('\n');
    // DIR/last-system: the system prompt of the latest chat call, for a test of an overridden prompt.
    writeFileSync(join(dir, 'last-system'), String((JSON.parse(raw).messages ?? []).find((m) => m.role === 'system')?.content ?? ''));
  } catch {}
  if (text.includes('STUB:FAIL')) return res.writeHead(500).end('{}');
  // Held like a decision with STUB:HANG, until DIR/release.
  if (text.includes('STUB:HANG') && existsSync(join(dir, 'hang'))) return void held.push(res);
  // A tool summary (S-1481) answers the URL-decoded TOOLSUM=... marker as it is, so a test can seed
  // bad answers, else valid JSON naming the call's tool: {"tool": "stub NAME", "doing": "..."}.
  if (text.includes('You summarise one tool call')) {
    const seeded = text.match(/TOOLSUM=([\w%.!~*'()-]+)/)?.[1];
    const name = text.match(/^Tool: (\S+)/m)?.[1] ?? 'tool';
    return answer(res, seeded ? decodeURIComponent(seeded) : JSON.stringify({ tool: `stub ${name}`.slice(0, 40), doing: `doing the stub work of ${name}` }));
  }
  const marked = text.match(/TITLE=([\w-]+)/)?.[1];
  const subject = (text.match(/^Subject: (.*)$/m)?.[1] ?? 'Stub mail title words').replace(/^Check:\s*/, '');
  let content = marked ? marked.replace(/_/g, ' ') : `**Title: ${subject.split(/\s+/).slice(0, 4).join(' ')}.**`;
  if (text.includes('and summarize mail') && !text.includes('STUB:NOSUMMARY')) {
    const sm = text.match(/SUMMARY=([\w%.:,;()#@'\/-]+)/)?.[1];
    const line = `Summary: ${sm ? (sm.includes('%') ? decodeURIComponent(sm) : sm.replace(/__/g, '\n').replace(/_/g, ' ')) : `Summary of ${subject}`}`;
    // STUB:NOTITLE leaves the title out: a summary-only answer.
    if (text.includes('STUB:NOTITLE')) content = line;
    else content = `${marked ? `Title: ${content}` : content}\n${line}`;
  }
  answer(res, content);
}
function answer(res, content) {
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({
      model: 'google/gemma-3-4b-it-stub',
      choices: [{ message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 30, completion_tokens: 4, cost: 0.000002 },
    }),
  );
}

// Exits when the process that started it is gone (a test killed hard runs no trap), S-668.
// Every test starts it as its own child, so the parent is the test itself.
{
  const parent = process.ppid;
  setInterval(() => process.ppid !== parent && process.exit(0), 1000).unref();
}
server.listen(0, '127.0.0.1', () => writeFileSync(join(dir, 'url'), `http://127.0.0.1:${server.address().port}`));
