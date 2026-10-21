// AWS Signature Version 4 (S-2117), written on node:crypto rather than pulled from the AWS SDK: the
// one request kind stam signs (a Bedrock Converse POST) needs only the header form. Signs the method,
// URL, the given headers plus host and x-amz-date, and the body hash; returns the headers to add.
// Never log what it returns: the authorization header carries a signature.
import { createHash, createHmac } from 'node:crypto';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (key: string | Buffer, s: string) => createHmac('sha256', key).update(s, 'utf8').digest();

// RFC 3986 encoding: everything but A-Z a-z 0-9 - _ . ~ as %XX.
const encode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// The amz date (20150830T123600Z) of a time.
export const amzDate = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export function sign(opts: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  service: string;
  region: string;
  credentials: AwsCredentials;
  now?: Date;
}): Record<string, string> {
  const url = new URL(opts.url);
  const date = amzDate(opts.now ?? new Date());
  const day = date.slice(0, 8);
  const added: Record<string, string> = { 'x-amz-date': date, ...(opts.credentials.sessionToken ? { 'x-amz-security-token': opts.credentials.sessionToken } : {}) };
  const all: Record<string, string> = { host: url.host };
  for (const [k, v] of Object.entries({ ...opts.headers, ...added })) all[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  const names = Object.keys(all).sort();
  // Services other than S3 sign each path segment encoded once more than it is sent.
  const path = url.pathname.split('/').map(encode).join('/') || '/';
  const query = [...url.searchParams].map(([k, v]) => [encode(k), encode(v)]).sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
  const signed = names.join(';');
  const canonical = [opts.method.toUpperCase(), path, query, names.map((n) => `${n}:${all[n]}\n`).join(''), signed, sha256(opts.body)].join('\n');
  const scope = `${day}/${opts.region}/${opts.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${opts.credentials.secretAccessKey}`, day), opts.region), opts.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign, 'utf8').digest('hex');
  return { ...added, authorization: `AWS4-HMAC-SHA256 Credential=${opts.credentials.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}` };
}
