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
// answers mail titles and tool summaries (see chat below). It also stands in for an OpenAI-compatible
// server (any */chat/completions, GET */models, and GET */key for a key check) and an Azure OpenAI resource (/openai/deployments/NAME/
// chat/completions?api-version=V and /openai/v1/chat/completions): each chat call writes its method, url,
// auth headers and body to DIR/last-request; an Azure path without the right `api-key` header, or any other
// path with a `Bearer` key other than `sk-bad`, gets 401 when DIR/key holds a key and it differs. A
// complete()-based decision (the prompt starts "You answer questions about a piece of state") is answered
// as the decisions endpoint would: P=0.NN gives a noul, CHOICE=<key> a choice, a score is P.
// It also stands in for Amazon Bedrock (S-2117): POST /model/MODEL/converse records its url, auth and
// x-amz-* headers and body in DIR/last-request and answers in the Converse shape (a forced tool call for
// a decision); with DIR/key it gets 401 unless the bearer key or the SigV4 access key id is that key. And
// for the EC2 instance metadata service (IMDSv2): PUT /latest/api/token, then the role `stub-role` with
// access key id AKIDROLE under /latest/meta-data/iam/security-credentials/; each call bumps DIR/imds.
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
    const path = (req.url ?? '').split('?')[0];
    // A key check (S-2115): a GET that carries a key other than DIR/key's gets 401, like a chat call;
    // one with no key is answered as before. GET */key is OpenRouter's key endpoint.
    if (req.method === 'GET' && /\/(models|key)$/.test(path)) {
      const want = existsSync(join(dir, 'key')) ? readFileSync(join(dir, 'key'), 'utf8').trim() : '';
      const got = path.startsWith('/openai/') ? req.headers['api-key'] : req.headers.authorization?.replace(/^Bearer /, '');
      if (want && got !== undefined && got !== want) return res.writeHead(401).end('{}');
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(path.endsWith('/key') ? { data: { limit: null, limit_remaining: null } } : { data: [{ id: 'stub-model-a' }, { id: 'stub-model-b' }] }));
    }
    if (path.startsWith('/latest/')) return imds(req, res, path);
    if (req.method === 'POST' && /^\/model\/[^/]+\/converse$/.test(path)) {
      const raw = Buffer.concat(chunks).toString();
      const h = req.headers;
      writeFileSync(join(dir, 'last-request'), JSON.stringify({ method: req.method, url: req.url, authorization: h.authorization, amzDate: h['x-amz-date'], securityToken: h['x-amz-security-token'], body: raw ? JSON.parse(raw) : null }));
      const want = existsSync(join(dir, 'key')) ? readFileSync(join(dir, 'key'), 'utf8').trim() : '';
      const got = h.authorization?.match(/^Bearer (.*)$/)?.[1] ?? h.authorization?.match(/^AWS4-HMAC-SHA256 Credential=([^/]+)\//)?.[1];
      if (want && got !== want) return res.writeHead(401).end('{}');
      // A file DIR/revoked makes every Converse call answer 403, as a dead or revoked Bedrock key does (S-3245).
      if (existsSync(join(dir, 'revoked'))) return res.writeHead(403, { 'x-amzn-errortype': 'UnrecognizedClientException' }).end('{"message":"The security token included in the request is invalid. sk-leak"}');
      // The Converse body as a chat body, for chat() to answer.
      const b = raw ? JSON.parse(raw) : {};
      const flat = (blocks) => (blocks ?? []).map((x) => x.text ?? '').join('\n');
      const messages = [...(b.system?.length ? [{ role: 'system', content: flat(b.system) }] : []), ...(b.messages ?? []).map((m) => ({ role: m.role, content: flat(m.content) }))];
      res.converse = { tool: b.toolConfig?.toolChoice?.tool?.name };
      return chat(res, JSON.stringify({ messages }));
    }
    if (req.method === 'POST' && /\/chat\/completions$/.test(path)) {
      const raw = Buffer.concat(chunks).toString();
      writeFileSync(join(dir, 'last-request'), JSON.stringify({ method: req.method, url: req.url, authorization: req.headers.authorization, apiKey: req.headers['api-key'], body: raw ? JSON.parse(raw) : null }));
      const want = existsSync(join(dir, 'key')) ? readFileSync(join(dir, 'key'), 'utf8').trim() : '';
      const got = path.startsWith('/openai/') ? req.headers['api-key'] : req.headers.authorization?.replace(/^Bearer /, '');
      if (want && got !== want) return res.writeHead(401).end('{}');
      return chat(res, raw);
    }
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
  if (text.startsWith('You answer questions about a piece of state')) {
    // Failure markers: STUB:BADJSON (not JSON), STUB:REFUSAL, STUB:TRUNC (finish_reason length), and for a
    // choice STUB:NOPROBS (no probabilities), STUB:BADPROB (one out of range), STUB:SKEW (sums to 0.5).
    if (text.includes('STUB:BADJSON')) return answer(res, 'not json');
    if (text.includes('STUB:REFUSAL')) return answer(res, JSON.stringify(decisionAnswers(text)), { refusal: 'I cannot help with that.' });
    if (text.includes('STUB:TRUNC')) return answer(res, JSON.stringify(decisionAnswers(text)), {}, 'length');
    const out = decisionAnswers(text);
    for (const a of Object.values(out)) {
      if (!a.probabilities) continue;
      const keys = Object.keys(a.probabilities);
      if (text.includes('STUB:NOPROBS')) delete a.probabilities;
      else if (text.includes('STUB:BADPROB')) a.probabilities[keys[0]] = 1.5;
      else if (text.includes('STUB:SKEW')) for (const k of keys) a.probabilities[k] = 0.25;
    }
    return answer(res, JSON.stringify(out));
  }
  // Held like a decision with STUB:HANG, until DIR/release.
  if (text.includes('STUB:HANG') && existsSync(join(dir, 'hang'))) return void held.push(res);
  // A tool summary (S-1481) answers the URL-decoded TOOLSUM=... marker as it is, so a test can seed
  // bad answers, else valid JSON naming the call's tool: {"tool": "stub NAME", "doing": "..."}.
  if (text.includes('You summarise one tool call')) {
    const seeded = text.match(/TOOLSUM=([\w%.!~*'()-]+)/)?.[1];
    const name = text.match(/^Tool: (\S+)/m)?.[1] ?? 'tool';
    return answer(res, seeded ? decodeURIComponent(seeded) : JSON.stringify({ tool: `stub ${name}`.slice(0, 40), doing: `doing the stub work of ${name}` }));
  }
  // A tool name (S-1933) answers the URL-decoded TOOLNAME=... marker as it is, else {"label": "Stub NAME"}.
  if (text.includes('You name one tool')) {
    const seeded = text.match(/TOOLNAME=([\w%.!~*'()-]+)/)?.[1];
    const name = text.match(/^Tool: (\S+)/m)?.[1] ?? 'tool';
    return answer(res, seeded ? decodeURIComponent(seeded) : JSON.stringify({ label: `Stub ${name}`.slice(0, 30) }));
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
// A decision by completion (askByCompletion in src/decide.ts): one entry per `- name (type)` line.
function decisionAnswers(text) {
  const p = Number(text.match(/P=(0\.\d+)/)?.[1] ?? 0.1);
  const out = {};
  for (const m of text.matchAll(/^- (\S+) \((noul|choice|score)\)/gm)) {
    const [, name, type] = m;
    if (type === 'noul') out[name] = { noul: p };
    else if (type === 'score') out[name] = { score: p, confidence: 0.9 };
    else {
      const block = text.slice(m.index).split(/\n- /)[0];
      const keys = [...block.matchAll(/^ {4}(\S+): /gm)].map((k) => k[1]);
      const picked = text.match(/CHOICE=([\w.-]+)/)?.[1];
      const choice = keys.includes(picked) ? picked : keys[0];
      out[name] = { choice, probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? 0.9 : 0.1 / Math.max(1, keys.length - 1)])), confidence: 0.9 };
    }
  }
  return out;
}
function answer(res, content, message = {}, finish = 'stop') {
  res.setHeader('content-type', 'application/json');
  if (res.converse) {
    // A refusal reads as a content filter, a truncated answer as max_tokens; a decision is a tool call.
    let input;
    try {
      input = res.converse.tool ? JSON.parse(content) : undefined;
    } catch {}
    const stopReason = message.refusal ? 'content_filtered' : finish === 'length' ? 'max_tokens' : input ? 'tool_use' : 'end_turn';
    const block = input ? { toolUse: { toolUseId: 'tooluse-stub', name: res.converse.tool, input } } : { text: content };
    return res.end(JSON.stringify({ output: { message: { role: 'assistant', content: [block] } }, stopReason, usage: { inputTokens: 31, outputTokens: 5, totalTokens: 36 } }));
  }
  res.end(
    JSON.stringify({
      model: 'google/gemma-3-4b-it-stub',
      choices: [{ message: { role: 'assistant', content, ...message }, finish_reason: finish }],
      usage: { prompt_tokens: 30, completion_tokens: 4, cost: 0.000002 },
    }),
  );
}

// The EC2 instance metadata service, IMDSv2: a token first, then the role and its credentials.
function imds(req, res, path) {
  const file = join(dir, 'imds');
  writeFileSync(file, String((existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0) + 1));
  if (req.method === 'PUT' && path === '/latest/api/token') return res.end('imds-token');
  if (req.headers['x-aws-ec2-metadata-token'] !== 'imds-token') return res.writeHead(401).end();
  if (path === '/latest/meta-data/iam/security-credentials/') return res.end('stub-role\n');
  if (path === '/latest/meta-data/iam/security-credentials/stub-role') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ Code: 'Success', AccessKeyId: 'AKIDROLE', SecretAccessKey: 'role-secret', Token: 'role-session', Expiration: new Date(Date.now() + 3600_000).toISOString() }));
  }
  res.writeHead(404).end();
}

// Exits when the process that started it is gone (a test killed hard runs no trap), S-668.
// Every test starts it as its own child, so the parent is the test itself.
{
  const parent = process.ppid;
  setInterval(() => process.ppid !== parent && process.exit(0), 1000).unref();
}
server.listen(0, '127.0.0.1', () => writeFileSync(join(dir, 'url'), `http://127.0.0.1:${server.address().port}`));
