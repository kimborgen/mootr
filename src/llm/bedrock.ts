// The Amazon Bedrock adapter (S-2117): the Converse API (`POST /model/MODEL/converse` on
// bedrock-runtime.REGION.amazonaws.com), built from a provider's config in settings.providers. It
// authenticates with a Bedrock API key as a bearer token when the config names one (`apiKey`), else
// with AWS credentials from the chain, signed with SigV4 (src/llm/sigv4.ts): the environment
// (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN), then the profile's static keys in
// ~/.aws/credentials or ~/.aws/config, then the EC2 instance role (IMDSv2). A configured `profile`
// reads only that profile. SSO and assume-role profiles are not read. A JSON-schema request is a
// forced tool call whose input is the answer. Bedrock reports no cost, so a result carries no `costUsd` and `complete` in src/llm/index.ts prices it from its tokens (S-3245).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { checkCredential, retryAfterMs, send, signalFor } from './http.ts';
import { probeKey } from './key-check.ts';
import { resolveKey, type KeyRef } from './openai.ts';
import { sign, type AwsCredentials } from './sigv4.ts';
import { LlmHttpError, type ChatMessage, type CompleteRequest, type CompleteResult, type KeyCheck, type LlmAdapter } from './types.ts';

export interface BedrockConfig {
  kind: 'bedrock';
  region: string;
  // A Bedrock API key, sent as a bearer token. Absent: AWS credentials from the chain, signed with SigV4.
  apiKey?: KeyRef;
  // The AWS profile to read; AWS_PROFILE, else `default`, when absent.
  profile?: string;
  // The runtime endpoint's origin, for a VPC endpoint; bedrock-runtime.REGION.amazonaws.com when absent.
  endpoint?: string;
  temperature?: number;
}

const env = (name: string) => process.env[name]?.trim() || undefined;

function fromEnv(): AwsCredentials | undefined {
  const accessKeyId = env('AWS_ACCESS_KEY_ID');
  const secretAccessKey = env('AWS_SECRET_ACCESS_KEY');
  if (!accessKeyId || !secretAccessKey) return undefined;
  return { accessKeyId, secretAccessKey, ...(env('AWS_SESSION_TOKEN') ? { sessionToken: env('AWS_SESSION_TOKEN') } : {}) };
}

// One INI section's keys; `[name]` in the credentials file, `[profile name]` (or `[default]`) in config.
function iniSection(file: string, names: string[]): Record<string, string> | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  let current: string | null = null;
  const out: Record<string, string> = {};
  let found = false;
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#') || s.startsWith(';')) continue;
    const head = s.match(/^\[\s*(.+?)\s*\]$/);
    if (head) {
      current = head[1].replace(/\s+/g, ' ');
      if (names.includes(current)) found = true;
      continue;
    }
    const kv = s.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (kv && current && names.includes(current)) out[kv[1].toLowerCase()] = kv[2].trim();
  }
  return found ? out : undefined;
}

function fromProfile(name: string): AwsCredentials | undefined {
  const credsFile = env('AWS_SHARED_CREDENTIALS_FILE') ?? join(homedir(), '.aws', 'credentials');
  const configFile = env('AWS_CONFIG_FILE') ?? join(homedir(), '.aws', 'config');
  for (const s of [iniSection(credsFile, [name]), iniSection(configFile, name === 'default' ? ['default', 'profile default'] : [`profile ${name}`])]) {
    if (s?.aws_access_key_id && s.aws_secret_access_key) {
      return { accessKeyId: s.aws_access_key_id, secretAccessKey: s.aws_secret_access_key, ...(s.aws_session_token ? { sessionToken: s.aws_session_token } : {}) };
    }
  }
  return undefined;
}

// The instance role's credentials, kept until five minutes before they expire. A lookup that finds
// none (not on EC2) is not retried for five minutes, so a call off EC2 waits on the metadata service once.
let role: { creds: AwsCredentials | undefined; until: number } | undefined;
const ROLE_MISS_MS = 300_000;

async function fromInstanceRole(): Promise<AwsCredentials | undefined> {
  if (env('AWS_EC2_METADATA_DISABLED')?.toLowerCase() === 'true') return undefined;
  if (role && Date.now() < role.until) return role.creds;
  const base = (env('AWS_EC2_METADATA_SERVICE_ENDPOINT') ?? 'http://169.254.169.254').replace(/\/+$/, '');
  const opts = { signal: AbortSignal.timeout(1000), redirect: 'error' as const };
  try {
    const tok = await fetch(`${base}/latest/api/token`, { ...opts, method: 'PUT', headers: { 'x-aws-ec2-metadata-token-ttl-seconds': '21600' } });
    if (!tok.ok) throw new Error('no token');
    const headers = { 'x-aws-ec2-metadata-token': await tok.text() };
    const list = await fetch(`${base}/latest/meta-data/iam/security-credentials/`, { ...opts, headers });
    const name = list.ok ? (await list.text()).split('\n')[0].trim() : '';
    if (!name) throw new Error('no role');
    const res = await fetch(`${base}/latest/meta-data/iam/security-credentials/${encodeURIComponent(name)}`, { ...opts, headers });
    const j: any = res.ok ? await res.json() : {};
    if (typeof j.AccessKeyId !== 'string' || typeof j.SecretAccessKey !== 'string') throw new Error('no credentials');
    const creds = { accessKeyId: j.AccessKeyId, secretAccessKey: j.SecretAccessKey, ...(typeof j.Token === 'string' ? { sessionToken: j.Token } : {}) };
    const expires = Date.parse(j.Expiration);
    role = { creds, until: Number.isFinite(expires) ? expires - 300_000 : Date.now() + ROLE_MISS_MS };
    return creds;
  } catch {
    role = { creds: undefined, until: Date.now() + ROLE_MISS_MS };
    return undefined;
  }
}

// For tests: forget the instance role's cached credentials.
export function resetInstanceRole(): void {
  role = undefined;
}

// A Bedrock API key's check reads a refusal by AWS's error type. AccessDeniedException means the bearer
// request authenticated and IAM denied the action, so the key works and only its permissions are narrow.
// Every other refusal (an unrecognized client, a bad signature, an expired token, an unknown type or an
// unreadable body) is no reading here, so probeKey refuses the key.
function narrowIam(status: number, errorType: string | undefined): KeyCheck | undefined {
  if (status !== 403 || errorType !== 'AccessDeniedException') return undefined;
  return { ok: true, status, detail: 'the key works; its IAM permissions do not allow ListAsyncInvokes (HTTP 403, AccessDeniedException)' };
}

// The chain's credentials known without a network call (environment, profile, a cached role).
function knownCredentials(cfg: BedrockConfig): AwsCredentials | undefined {
  if (cfg.profile) return fromProfile(cfg.profile);
  return fromEnv() ?? fromProfile(env('AWS_PROFILE') ?? 'default') ?? (role && Date.now() < role.until ? role.creds : undefined);
}

async function credentials(cfg: BedrockConfig): Promise<AwsCredentials | undefined> {
  return knownCredentials(cfg) ?? (cfg.profile ? undefined : fromInstanceRole());
}

// Converse takes the system prompt apart and wants the turns to alternate, so consecutive messages of
// one role are joined into one message of several text blocks.
function converseMessages(messages: ChatMessage[]) {
  const system = messages.filter((m) => m.role === 'system').map((m) => ({ text: m.content }));
  const turns: { role: 'user' | 'assistant'; content: { text: string }[] }[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const prev = turns[turns.length - 1];
    if (prev?.role === m.role) prev.content.push({ text: m.content });
    else turns.push({ role: m.role, content: [{ text: m.content }] });
  }
  return { system, turns };
}

function body(req: CompleteRequest, temperature: number | undefined): Record<string, unknown> {
  const { system, turns } = converseMessages(req.messages);
  const t = req.temperature ?? temperature;
  return {
    messages: turns,
    ...(system.length ? { system } : {}),
    inferenceConfig: { maxTokens: req.maxTokens, ...(t !== undefined ? { temperature: t } : {}) },
    ...(req.jsonSchema
      ? { toolConfig: { tools: [{ toolSpec: { name: req.jsonSchema.name, description: 'Give the answer.', inputSchema: { json: req.jsonSchema.schema } } }], toolChoice: { tool: { name: req.jsonSchema.name } } } }
      : {}),
  };
}

function result(data: any, req: CompleteRequest): CompleteResult {
  const usage = data?.usage ?? {};
  const blocks: any[] = Array.isArray(data?.output?.message?.content) ? data.output.message.content : [];
  // An answer cut off at the token limit, or stopped by a guardrail or content filter, is no answer.
  const stop = data?.stopReason;
  const ok = stop === 'end_turn' || stop === 'stop_sequence' || stop === 'tool_use';
  const tool = req.jsonSchema ? blocks.find((b) => b?.toolUse?.name === req.jsonSchema!.name)?.toolUse : undefined;
  const texts = blocks.filter((b) => typeof b?.text === 'string').map((b) => b.text as string);
  let text: string | null = null;
  let json: unknown;
  if (ok && tool && tool.input && typeof tool.input === 'object') {
    json = tool.input;
    text = JSON.stringify(tool.input);
  } else if (ok && texts.length) {
    text = texts.join('');
    // A model that answers a schema in text instead of the tool call.
    if (req.jsonSchema) {
      try {
        json = JSON.parse(text);
      } catch {}
    }
  }
  return {
    text,
    ...(json !== undefined ? { json } : {}),
    model: req.model,
    usage: { inputTokens: Number(usage.inputTokens) || 0, outputTokens: Number(usage.outputTokens) || 0 },
  };
}

// Where a provider's calls go: its endpoint, else the region's runtime. A settings ask names it (S-2115).
export function bedrockBase(cfg: BedrockConfig): string {
  return (cfg.endpoint ?? `https://bedrock-runtime.${cfg.region}.amazonaws.com`).replace(/\/+$/, '');
}

export function bedrock(id: string, cfg: BedrockConfig): LlmAdapter {
  const base = bedrockBase(cfg);
  const key = () => resolveKey(cfg.apiKey);
  return {
    id,
    // The API key, or the chain's access key id when it is known without a call.
    apiKey: () => (cfg.apiKey ? key() : knownCredentials(cfg)?.accessKeyId),
    // The chain may find an instance role only by asking, so `hasKey` holds without a known key.
    keyless: !cfg.apiKey && !cfg.profile,
    // A Bedrock API key is tested with a read-only list call on the same runtime (S-2115). A key whose IAM
    // role may not list async invokes still works, so AccessDeniedException reads as valid (narrowIam).
    // AWS credentials from the chain are not a stored key, so there is nothing to test.
    ...(cfg.apiKey ? { checkKey: (k: string): Promise<KeyCheck> => probeKey(`${base}/async-invoke?maxResults=1`, { authorization: `Bearer ${k}` }, undefined, narrowIam) } : {}),

    async complete(req: CompleteRequest): Promise<CompleteResult> {
      const url = `${base}/model/${encodeURIComponent(req.model)}/converse`;
      const payload = JSON.stringify(body(req, cfg.temperature));
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
      if (cfg.apiKey) {
        const k = key();
        if (!k) throw new Error('no API key');
        headers.authorization = `Bearer ${checkCredential(k, 'API key')}`;
      } else {
        const creds = await credentials(cfg);
        if (!creds) throw new Error(`no AWS credentials for provider ${id} (region ${cfg.region})`);
        checkCredential(creds.accessKeyId, 'AWS access key id');
        if (creds.sessionToken !== undefined) checkCredential(creds.sessionToken, 'AWS session token');
        Object.assign(headers, sign({ method: 'POST', url, headers, body: payload, service: 'bedrock', region: cfg.region, credentials: creds }));
      }
      const res = await send(url, { method: 'POST', headers, body: payload, signal: signalFor(req), redirect: 'error' });
      // A dead or revoked key answers 401 or 403, as does a model whose access isn't granted: fixed text that quotes nothing.
      if (res.status === 401 || res.status === 403) throw new LlmHttpError(res.status, undefined, `key invalid or access denied (HTTP ${res.status})`);
      if (!res.ok) throw new LlmHttpError(res.status, retryAfterMs(res.headers.get('retry-after')));
      return result(await res.json(), req);
    },
  };
}

// An endpoint as an origin: https with no userinfo, path, query or fragment (plain http only on the
// loopback, for a local proxy or a test). Undefined when it is anything else.
function endpointOrigin(v: string): string | undefined {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return undefined;
  }
  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && loopback))) return undefined;
  if (u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return undefined;
  return u.origin;
}

// A bedrock provider config read from settings: a region is required, and an endpoint, when set, must
// be an origin (endpointOrigin). Null for anything else.
export function parseBedrockConfig(v: any): BedrockConfig | null {
  if (!v || typeof v !== 'object' || v.kind !== 'bedrock') return null;
  const str = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim() : undefined);
  const region = str(v.region);
  if (!region || !/^[a-z0-9-]+$/.test(region)) return null;
  const endpoint = str(v.endpoint);
  if (endpoint && !endpointOrigin(endpoint)) return null;
  const apiKey = v.apiKey && typeof v.apiKey === 'object' && (str(v.apiKey.env) || str(v.apiKey.secret)) ? { ...(str(v.apiKey.env) ? { env: str(v.apiKey.env) } : {}), ...(str(v.apiKey.secret) ? { secret: str(v.apiKey.secret) } : {}) } : undefined;
  return {
    kind: 'bedrock',
    region,
    ...(apiKey ? { apiKey } : {}),
    ...(str(v.profile) ? { profile: str(v.profile) } : {}),
    ...(endpoint ? { endpoint: endpointOrigin(endpoint) } : {}),
    ...(typeof v.temperature === 'number' && Number.isFinite(v.temperature) ? { temperature: v.temperature } : {}),
  };
}
