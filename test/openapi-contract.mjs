// Contract check (S-2388): calls every GET route api/openapi.yaml specs on a running daemon and
// validates the status and body of each answer against the spec with ajv. Black-box: HTTP only.
// Env: STAM_URL, STAM_HOME (for the token); test/e2e-openapi-contract.sh sets them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import { bundle } from '../scripts/api-gen.mjs';

const url = process.env.STAM_URL;
const token = readFileSync(join(process.env.STAM_HOME, 'token'), 'utf8').trim();
const spec = bundle(fileURLToPath(new URL('../api/openapi.yaml', import.meta.url)));
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema(spec, 'spec');

const resolveRef = (node) => {
  while (node?.$ref) node = node.$ref.slice(2).split('/').reduce((n, k) => n[k.replaceAll('~1', '/').replaceAll('~0', '~')], spec);
  return node;
};
const pointer = (...parts) => `spec#/${parts.map((p) => p.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
const bodySchema = (response) => resolveRef(response)?.content?.['application/json']?.schema;

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failed++;
};

// Guard: a validator that accepts anything proves nothing.
const health = ajv.compile({ $ref: pointer('components', 'schemas', 'Health') });
check('the Health schema rejects a body missing fields', !health({ ok: true }), 'accepted {ok:true}');

// The open ask an agent row carries (S-3982): the mail and kind, never the text. The list rarely has an open ask, so the
// shape is checked here on its own: a set one passes, a kind outside the labels or an extra field fails.
const askDetail = ajv.compile({ $ref: pointer('components', 'schemas', 'Agent', 'properties', 'open_ask_detail') });
check('open_ask_detail takes a mail and a kind, and nothing else',
  askDetail({ mail: 'm1', kind: 'Permission' }) && askDetail({ mail: null, kind: 'ITSA' }) && askDetail(null)
    && !askDetail({ mail: 'm1', kind: 'Nope' }) && !askDetail({ mail: 'm1', kind: 'Permission', text: 'x' }),
  'the shape is not what src/asks.ts askDetail returns');

const call = async (path, headers) => {
  const res = await fetch(url + path, { headers });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = undefined; }
  return { status: res.status, body, text };
};

const auth = { authorization: `Bearer ${token}` };
for (const [path, item] of Object.entries(spec.paths)) {
  const op = item.get;
  if (!op) continue;
  const { status, body, text } = await call(path, auth);
  const declared = op.responses[String(status)] ?? op.responses.default;
  const schema = bodySchema(declared);
  if (!declared || !schema) { check(`GET ${path} answers a specced status`, false, `HTTP ${status}: ${text.slice(0, 200)}`); continue; }
  const responseKey = op.responses[String(status)] ? String(status) : 'default';
  const direct = declared.$ref ? null : pointer('paths', path, 'get', 'responses', responseKey, 'content', 'application/json', 'schema');
  const validate = ajv.compile(direct ? { $ref: direct } : schema);
  check(`GET ${path} -> ${status} matches its schema`, status === 200 && validate(body), JSON.stringify(validate.errors ?? `status ${status}`).slice(0, 600));
}

// The agent list must exercise the nullable and optional columns, or the schema's closed shape proves little:
// a child (parent_id set), a standing agent (load), and a peer-style call (cost_raw).
const agents = (await call('/api/agents', auth)).body;
check('GET /api/agents has agents to check', Array.isArray(agents) && agents.length >= 2, 'the list has fewer than two agents');
check('an agent has a parent_id', agents.some((a) => a.parent_id !== null), 'every parent_id is null');
check('an agent has a model and effort', agents.some((a) => a.model !== null && a.effort !== null), 'no agent has both');
check('an agent has a last_message', agents.some((a) => a.last_message !== null), 'every last_message is null');
check('a standing agent has load', agents.some((a) => a.load), 'no agent has load');
const peerToken = readFileSync(join(process.env.STAM_HOME, 'peer-token'), 'utf8').trim();
const local = await call('/api/agents', { authorization: `Bearer ${peerToken}`, 'x-stam-local': '1' });
const validateList = ajv.compile({ $ref: pointer('paths', '/api/agents', 'get', 'responses', '200', 'content', 'application/json', 'schema') });
check('GET /api/agents as a peer matches its schema', local.status === 200 && validateList(local.body), JSON.stringify(validateList.errors ?? `status ${local.status}`).slice(0, 600));
check('a peer answer has cost_raw', local.body.every((a) => a.cost_raw && typeof a.cost_raw === 'object'), 'cost_raw missing');

// The error envelope: a call with no token, and a route that does not exist.
const errorSchema = ajv.compile({ $ref: pointer('components', 'schemas', 'Error') });
for (const [label, path, headers, want] of [['no token', '/api/agents', {}, 401], ['unknown route', '/api/no-such-route', auth, 404]]) {
  const r = await call(path, headers);
  check(`error envelope: ${label} -> ${want}`, r.status === want && errorSchema(r.body), `HTTP ${r.status} ${r.text.slice(0, 200)} ${JSON.stringify(errorSchema.errors ?? '')}`);
}

if (failed) { console.log(`FAIL: ${failed} contract checks`); process.exit(1); }
console.log('PASS: all contract checks');
