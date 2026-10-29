#!/usr/bin/env node
// The Amazon Bedrock adapter (S-2117, src/llm/bedrock.ts) and its SigV4 signer (src/llm/sigv4.ts),
// against the stub (test/decide-stub.mjs): the signer on AWS's published test vectors, the Converse
// URL, body and parsed answer, a Bedrock API key as a bearer token, AWS credentials from the
// environment, a profile file and the instance role (the stub's IMDSv2), redirect refusal, the failure
// paths, and decide() through a forced tool call. Free, no network, no daemon.
// `node --test test/llm-bedrock.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-llm-bedrock-');
const stubDir = join(home, 'stub');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `llm-bedrock-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE', 'OPENROUTER_API_KEY']) delete process.env[k];
for (const k of Object.keys(process.env)) if (k.startsWith('AWS_')) delete process.env[k];
mkdirSync(home, { recursive: true });
// The credential files are the test's own, so the machine's ~/.aws is never read.
const credsFile = join(home, 'aws-credentials');
const configFile = join(home, 'aws-config');
process.env.AWS_SHARED_CREDENTIALS_FILE = credsFile;
process.env.AWS_CONFIG_FILE = configFile;
writeFileSync(credsFile, '[default]\n[work]\naws_access_key_id = AKIDPROFILE\naws_secret_access_key = profile-secret\n');
writeFileSync(configFile, '[profile cfgonly]\naws_access_key_id=AKIDCONFIG\naws_secret_access_key=config-secret\naws_session_token=config-session\n');
process.env.STUB_BR_KEY = 'br-key';
delete process.env.STUB_MISSING_KEY;

let stub, llm, settings, decide, sigv4, bedrockMod, base;
const last = () => JSON.parse(readFileSync(join(stubDir, 'last-request'), 'utf8'));
const setKey = (k) => (k ? writeFileSync(join(stubDir, 'key'), k) : rmSync(join(stubDir, 'key'), { force: true }));
const imdsCalls = () => (existsSync(join(stubDir, 'imds')) ? Number(readFileSync(join(stubDir, 'imds'), 'utf8')) : 0);
const providers = () => ({
  br: { kind: 'bedrock', region: 'us-east-1', endpoint: `${base}/`, apiKey: { env: 'STUB_BR_KEY' } },
  brtemp: { kind: 'bedrock', region: 'us-east-1', endpoint: base, apiKey: { env: 'STUB_BR_KEY' }, temperature: 0.2 },
  brnokey: { kind: 'bedrock', region: 'us-east-1', endpoint: base, apiKey: { env: 'STUB_MISSING_KEY' } },
  aws: { kind: 'bedrock', region: 'eu-west-1', endpoint: base },
  awsprof: { kind: 'bedrock', region: 'eu-west-1', endpoint: base, profile: 'work' },
  awscfg: { kind: 'bedrock', region: 'eu-west-1', endpoint: base, profile: 'cfgonly' },
  awsnone: { kind: 'bedrock', region: 'eu-west-1', endpoint: base, profile: 'missing' },
  noregion: { kind: 'bedrock', endpoint: base },
  badregion: { kind: 'bedrock', region: 'evil.example.com/x', endpoint: base },
});
const ask = (model, text = 'q', extra = {}) => llm.complete({ model, messages: [{ role: 'user', content: text }], maxTokens: 20, ...extra });
const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
const vectorTime = new Date('2015-08-30T12:36:00Z');

before(async () => {
  stub = spawn(process.execPath, [join(import.meta.dirname, 'decide-stub.mjs'), stubDir], { stdio: 'ignore' });
  process.on('exit', () => stub.kill());
  for (let i = 0; !existsSync(join(stubDir, 'url')); i++) {
    if (i > 500) throw new Error('the stub did not start');
    await new Promise((r) => setTimeout(r, 10));
  }
  base = readFileSync(join(stubDir, 'url'), 'utf8');
  process.env.STAM_OPENROUTER_URL = base;
  process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT = base;
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ providers: providers(), decisions: { mailCheck: false } }));
  settings = await import('../src/settings.ts');
  llm = await import('../src/llm/index.ts');
  decide = await import('../src/decide.ts');
  sigv4 = await import('../src/llm/sigv4.ts');
  bedrockMod = await import('../src/llm/bedrock.ts');
});
after(() => { stub.kill(); rmSync(home, { recursive: true, force: true }); });

test('sigv4: AWS published test vectors (get-vanilla, IAM ListUsers)', () => {
  const vanilla = sigv4.sign({ method: 'GET', url: 'https://example.amazonaws.com/', headers: {}, body: '', service: 'service', region: 'us-east-1', credentials, now: vectorTime });
  assert.equal(vanilla['x-amz-date'], '20150830T123600Z');
  assert.equal(vanilla.authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  const iam = sigv4.sign({
    method: 'GET',
    url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body: '',
    service: 'iam',
    region: 'us-east-1',
    credentials,
    now: vectorTime,
  });
  assert.equal(iam.authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
  // A Converse POST whose model id has a colon (signed double-encoded), checked against botocore 1.40.72's
  // SigV4Auth at the same fixed clock, without and with a session token.
  const converse = (sessionToken) =>
    sigv4.sign({
      method: 'POST',
      url: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-haiku-20240307-v1%3A0/converse',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: '{"messages":[{"role":"user","content":[{"text":"hi"}]}],"inferenceConfig":{"maxTokens":5}}',
      service: 'bedrock',
      region: 'us-east-1',
      credentials: { ...credentials, ...(sessionToken ? { sessionToken } : {}) },
      now: vectorTime,
    }).authorization;
  assert.equal(converse(), 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/bedrock/aws4_request, SignedHeaders=accept;content-type;host;x-amz-date, Signature=d40a49ab2ebe9dcd453b401ae9402e5dc7e40e896075d592aa9ef349e97cee63');
  assert.equal(converse('session-token-example'), 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/bedrock/aws4_request, SignedHeaders=accept;content-type;host;x-amz-date;x-amz-security-token, Signature=2924b6a0c86c55b3236144a01348b8a433e89ddc1e171c229cb85ec29d3ba03b');
  // A session token is sent and signed.
  const session = sigv4.sign({ method: 'GET', url: 'https://example.amazonaws.com/', headers: {}, body: '', service: 'service', region: 'us-east-1', credentials: { ...credentials, sessionToken: 'tok' }, now: vectorTime });
  assert.equal(session['x-amz-security-token'], 'tok');
  assert.match(session.authorization, /SignedHeaders=host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
  assert.notEqual(session.authorization, vanilla.authorization);
});

test('bedrock: Converse URL, bearer API key, body without temperature, parsed answer', async () => {
  setKey('br-key');
  const r = await llm.complete({
    model: 'br:anthropic.claude-3-haiku-20240307-v1:0',
    messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hello' }, { role: 'user', content: 'again' }],
    maxTokens: 20,
  });
  const req = last();
  // The model id's colon is encoded in the path.
  assert.equal(req.url, '/model/anthropic.claude-3-haiku-20240307-v1%3A0/converse');
  assert.equal(req.authorization, 'Bearer br-key');
  assert.equal(req.amzDate, undefined);
  // The system prompt rides apart, and consecutive turns of one role are one message.
  assert.deepEqual(req.body, { messages: [{ role: 'user', content: [{ text: 'hello' }, { text: 'again' }] }], system: [{ text: 'be brief' }], inferenceConfig: { maxTokens: 20 } });
  assert.equal(r.model, 'anthropic.claude-3-haiku-20240307-v1:0');
  assert.deepEqual(r.usage, { inputTokens: 31, outputTokens: 5 });
  // The adapter reports no cost; complete prices it from its tokens (S-3245), here at the fallback for a model the registry does not price.
  assert.equal(r.priced, 'fallback');
  assert.ok(r.costUsd > 0);
  assert.equal(typeof r.text, 'string');
  setKey('');
});

test('bedrock: temperature from the request, else the provider, else none', async () => {
  await ask('br:m', 'q', { temperature: 0 });
  assert.equal(last().body.inferenceConfig.temperature, 0);
  await ask('brtemp:m');
  assert.equal(last().body.inferenceConfig.temperature, 0.2);
  await ask('br:m');
  assert.equal('temperature' in last().body.inferenceConfig, false);
});

test('bedrock: no API key means no call; a wrong key is a 401, a server error a 500', async () => {
  assert.equal(llm.hasKey('brnokey:m'), false);
  await assert.rejects(ask('brnokey:m'), /no API key/);
  assert.equal(llm.hasKey('br:m'), true);
  setKey('other');
  await assert.rejects(ask('br:m'), (e) => e instanceof llm.LlmHttpError && e.status === 401);
  setKey('');
  await assert.rejects(ask('br:m', 'STUB:FAIL'), (e) => e instanceof llm.LlmHttpError && e.status === 500);
});

test('bedrock: environment credentials sign the request with SigV4 for the region', async () => {
  process.env.AWS_ACCESS_KEY_ID = 'AKIDENV';
  process.env.AWS_SECRET_ACCESS_KEY = 'env-secret';
  try {
    setKey('AKIDENV');
    assert.equal(llm.provider('aws').apiKey(), 'AKIDENV');
    await ask('aws:amazon.nova-lite-v1:0', 'signed');
    const req = last();
    const day = req.amzDate.slice(0, 8);
    assert.match(req.amzDate, /^\d{8}T\d{6}Z$/);
    assert.match(req.authorization, new RegExp(`^AWS4-HMAC-SHA256 Credential=AKIDENV/${day}/eu-west-1/bedrock/aws4_request, SignedHeaders=accept;content-type;host;x-amz-date, Signature=[0-9a-f]{64}$`));
    assert.equal(req.securityToken, undefined);
    // The signature covers what was sent: re-signing the received request at its date gives the same one.
    const again = sigv4.sign({
      method: 'POST',
      url: `${base}${req.url}`,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(req.body),
      service: 'bedrock',
      region: 'eu-west-1',
      credentials: { accessKeyId: 'AKIDENV', secretAccessKey: 'env-secret' },
      now: new Date(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T${req.amzDate.slice(9, 11)}:${req.amzDate.slice(11, 13)}:${req.amzDate.slice(13, 15)}Z`),
    });
    assert.equal(again.authorization, req.authorization);
    process.env.AWS_SESSION_TOKEN = 'env-session';
    await ask('aws:m');
    assert.equal(last().securityToken, 'env-session');
    assert.match(last().authorization, /SignedHeaders=accept;content-type;host;x-amz-date;x-amz-security-token,/);
  } finally {
    for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) delete process.env[k];
    setKey('');
  }
});

test('bedrock: a configured profile reads the credentials file, then the config file', async () => {
  process.env.AWS_ACCESS_KEY_ID = 'AKIDENV';
  process.env.AWS_SECRET_ACCESS_KEY = 'env-secret';
  try {
    // A named profile wins over the environment.
    await ask('awsprof:m');
    assert.match(last().authorization, /Credential=AKIDPROFILE\//);
    await ask('awscfg:m');
    assert.match(last().authorization, /Credential=AKIDCONFIG\//);
    assert.equal(last().securityToken, 'config-session');
    // A named profile that is missing has no credentials, and asks no instance role.
    const before = imdsCalls();
    assert.equal(llm.hasKey('awsnone:m'), false);
    await assert.rejects(ask('awsnone:m'), /^Error: no AWS credentials for provider awsnone \(region eu-west-1\)$/);
    assert.equal(imdsCalls(), before);
    // AWS_PROFILE picks the profile when none is configured and the environment holds no keys.
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_PROFILE = 'work';
    await ask('aws:m');
    assert.match(last().authorization, /Credential=AKIDPROFILE\//);
  } finally {
    for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_PROFILE']) delete process.env[k];
  }
});

test('bedrock: with no environment or profile keys, the instance role signs, and is cached', async () => {
  bedrockMod.resetInstanceRole();
  rmSync(join(stubDir, 'imds'), { force: true });
  // hasKey holds before any lookup: the role is found only by asking.
  assert.equal(llm.hasKey('aws:m'), true);
  await ask('aws:m');
  assert.match(last().authorization, /Credential=AKIDROLE\//);
  assert.equal(last().securityToken, 'role-session');
  assert.equal(imdsCalls(), 3);
  assert.equal(llm.provider('aws').apiKey(), 'AKIDROLE');
  await ask('aws:m');
  assert.equal(imdsCalls(), 3, 'the cached role asks the metadata service no more');
  bedrockMod.resetInstanceRole();
  process.env.AWS_EC2_METADATA_DISABLED = 'true';
  try {
    await assert.rejects(ask('aws:m'), /no AWS credentials for provider aws \(region eu-west-1\)/);
    assert.equal(imdsCalls(), 3);
  } finally {
    delete process.env.AWS_EC2_METADATA_DISABLED;
    bedrockMod.resetInstanceRole();
  }
});

test('bedrock: a redirect is an error, so neither key nor signature reaches the other origin', async () => {
  const got = [];
  const target = createServer((req, res) => { got.push(req.headers); res.writeHead(200, { 'content-type': 'application/json' }).end('{}'); });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const other = `http://127.0.0.1:${target.address().port}`;
  const hop = createServer((req, res) => res.writeHead(307, { location: `${other}/stolen` }).end());
  await new Promise((r) => hop.listen(0, '127.0.0.1', r));
  const from = `http://127.0.0.1:${hop.address().port}`;
  process.env.AWS_ACCESS_KEY_ID = 'AKIDENV';
  process.env.AWS_SECRET_ACCESS_KEY = 'env-secret';
  try {
    settings.patchSettings({
      providers: {
        ...providers(),
        r307: { kind: 'bedrock', region: 'us-east-1', endpoint: from, apiKey: { env: 'STUB_BR_KEY' } },
        r308: { kind: 'bedrock', region: 'us-east-1', endpoint: from },
      },
    });
    await assert.rejects(ask('r307:m'));
    await assert.rejects(ask('r308:m'));
    assert.deepEqual(got, [], 'the second server saw no request');
  } finally {
    for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) delete process.env[k];
    target.close();
    hop.close();
    settings.patchSettings({ providers: providers() });
  }
});

// A key check's refusal, answered by a stubbed fetch: the error type comes as a header or in the body.
test('bedrock key check: AccessDeniedException is a working key with narrow IAM; other refusals reject', async () => {
  const realFetch = globalThis.fetch;
  const check = async (reply) => {
    globalThis.fetch = async () => reply();
    try {
      return await llm.provider('br307').checkKey('br-key');
    } finally {
      globalThis.fetch = realFetch;
    }
  };
  const denied = (body = '{"message":"not allowed"}', headers = {}) => () => new Response(body, { status: 403, headers });
  const refused = (body = '{}', headers = {}) => () => new Response(body, { status: 403, headers });
  settings.patchSettings({ providers: { ...providers(), br307: { kind: 'bedrock', region: 'us-east-1', apiKey: { env: 'STUB_BR_KEY' } } } });
  // Valid with narrow IAM, by the error type in the header or in the body (AWS sends either).
  for (const reply of [
    denied('', { 'x-amzn-errortype': 'AccessDeniedException:http://internal.amazon.com/coral/com.amazon.coral.service/' }),
    denied('{"__type":"com.amazonaws.bedrock#AccessDeniedException","message":"no"}'),
  ]) {
    const r = await check(reply);
    assert.equal(r.ok, true);
    assert.equal(r.status, 403);
    assert.match(r.detail, /the key works/);
  }
  // Each bad-key class still rejects.
  for (const type of ['UnrecognizedClientException', 'InvalidSignatureException', 'ExpiredTokenException']) {
    const r = await check(refused('', { 'x-amzn-errortype': `${type}:http://x/` }));
    assert.equal(r.ok, false, type);
    assert.equal(r.detail, 'the provider refused the key (HTTP 403)', type);
  }
  // Fail closed: an unknown type, an unreadable body, and no body at all all reject.
  assert.equal((await check(refused('{"__type":"SomeNewException"}'))).ok, false);
  assert.equal((await check(refused('<html>not json</html>'))).ok, false);
  assert.equal((await check(refused(''))).ok, false);
  // A denial without a valid status is not read as a key that works.
  assert.equal((await check(() => new Response('{"__type":"AccessDeniedException"}', { status: 401 }))).ok, false);
  // Nothing of the key or the body reaches the detail.
  const r = await check(denied('{"__type":"AccessDeniedException","message":"br-key echoed"}'));
  assert.ok(!r.detail.includes('br-key'));
  settings.patchSettings({ providers: providers() });
});

test('bedrock: a config without a valid region is ignored', () => {
  assert.equal(llm.provider('noregion'), undefined);
  assert.equal(llm.provider('badregion'), undefined);
  assert.ok(llm.provider('aws'));
  assert.deepEqual(bedrockMod.parseBedrockConfig({ kind: 'bedrock', region: 'us-west-2', apiKey: { env: 'X' } }), { kind: 'bedrock', region: 'us-west-2', apiKey: { env: 'X' } });
});

test('bedrock: an endpoint is accepted only as an https origin (http on the loopback)', () => {
  const ep = (endpoint) => bedrockMod.parseBedrockConfig({ kind: 'bedrock', region: 'us-east-1', endpoint })?.endpoint ?? null;
  assert.equal(ep('https://vpce-1.bedrock-runtime.us-east-1.vpce.amazonaws.com/'), 'https://vpce-1.bedrock-runtime.us-east-1.vpce.amazonaws.com');
  assert.equal(ep('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  assert.equal(ep('http://localhost:8080/'), 'http://localhost:8080');
  for (const bad of ['http://bedrock.example.com', 'https://user:pw@bedrock.example.com', 'https://bedrock.example.com/path', 'https://bedrock.example.com/?q=1', 'https://bedrock.example.com/#f', 'ftp://bedrock.example.com', 'not a url']) {
    assert.equal(ep(bad), null, bad);
  }
});

const questions = {
  yes: { type: 'noul', instructions: 'Is it fine?' },
  pick: { type: 'choice', instructions: 'Which?', criteria: { a: 'first', b: 'second' } },
};

test('decide: bedrock is asked through a forced tool call and parsed like the endpoint', async () => {
  settings.patchSettings({ decisions: { model: 'br:anthropic.claude-3-haiku-20240307-v1:0' } });
  const r = await decide.decide('state P=0.7 CHOICE=b', questions, { purpose: 'decide:test' });
  assert.equal(r.answers.yes.noul, 0.7);
  assert.equal(r.answers.pick.choice, 'b');
  assert.equal(r.answers.pick.probabilities.b, 0.9);
  const tc = last().body.toolConfig;
  assert.equal(tc.toolChoice.tool.name, 'decisions');
  assert.equal(tc.tools[0].toolSpec.name, 'decisions');
  assert.deepEqual(tc.tools[0].toolSpec.inputSchema.json.required, ['yes', 'pick']);
  assert.match(last().body.system[0].text, /^You answer questions about a piece of state/);
  assert.equal(r.usage.input_tokens, 31);
});

test('decide: bedrock refusal, truncation and a non-JSON answer each yield no answer', async () => {
  settings.patchSettings({ decisions: { model: 'br:m' } });
  for (const marker of ['STUB:BADJSON', 'STUB:REFUSAL', 'STUB:TRUNC']) {
    const r = await decide.decideWithFailure(`P=0.6 ${marker}`, { q: questions.yes }, { purpose: 'decide:test' });
    assert.equal(r.result, null, marker);
    assert.equal(r.failure.error, 'no answers in the response');
  }
  settings.patchSettings({ decisions: { model: 'brnokey:m' } });
  assert.equal((await decide.decideWithFailure('x', { q: questions.yes }, { purpose: 'decide:test' })).failure.error, 'no API key');
});

// The events decide() logged of a type, newest last.
const events = async (type) => (await import('../src/db.ts')).open().prepare('SELECT data FROM events WHERE agent_id = ? AND type = ?').all('stam', type).map((r) => JSON.parse(r.data));

test('a malformed key or session token never reaches the failure or decide:error', async () => {
  const secret = 'leaked-secret-value';
  const check = async (model, error) => {
    settings.patchSettings({ decisions: { model } });
    const r = await decide.decideWithFailure('P=0.5', { q: questions.yes }, { purpose: 'decide:test' });
    assert.equal(r.result, null, model);
    assert.equal(r.failure.error, error, model);
    const logged = JSON.stringify((await events('decide:error')).at(-1));
    assert.ok(!logged.includes(secret), `${model}: ${logged}`);
    assert.match(logged, new RegExp(error));
  };
  process.env.STUB_BR_KEY = `br\n${secret}`;
  try {
    await check('br:m', 'invalid API key');
  } finally {
    process.env.STUB_BR_KEY = 'br-key';
  }
  process.env.AWS_ACCESS_KEY_ID = 'AKIDENV';
  process.env.AWS_SECRET_ACCESS_KEY = 'env-secret';
  process.env.AWS_SESSION_TOKEN = `tok\r\n${secret}`;
  try {
    await check('aws:m', 'invalid AWS session token');
    process.env.AWS_SESSION_TOKEN = 'tok';
    process.env.AWS_ACCESS_KEY_ID = `AKID\n${secret}`;
    await check('aws:m', 'invalid AWS access key id');
  } finally {
    for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) delete process.env[k];
  }
});

test('send: a transport failure is rethrown without the request\'s header values', async () => {
  const http = await import('../src/llm/http.ts');
  await assert.rejects(http.send(`${base}/x`, { headers: { authorization: 'Bearer a\nleaked-secret-value' } }), (e) => !String(e).includes('leaked') && /^request failed: /.test(e.message));
  // A refused connection keeps its code.
  const closed = createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const port = closed.address().port;
  await new Promise((r) => closed.close(r));
  await assert.rejects(http.send(`http://127.0.0.1:${port}/`, {}), /request failed: ECONNREFUSED/);
  assert.throws(() => http.checkCredential('a b', 'API key'), /^Error: invalid API key$/);
  assert.equal(http.checkCredential('sk-ok_1/+=', 'API key'), 'sk-ok_1/+=');
});
