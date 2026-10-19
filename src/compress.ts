// Compresses what the daemon sends over HTTP: JSON API responses and the web UI's static
// files. Brotli when the client takes it, else gzip, from node:zlib. Streams (SSE, the
// agent view, terminal sockets) never come through here.
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';

// A body under this is sent as it is: compressing it saves less than the header costs.
const MIN_BYTES = 1024;

// The encoding the client accepts, brotli first, or null when it takes neither (or q=0).
export function acceptedEncoding(req: IncomingMessage): 'br' | 'gzip' | null {
  const accept = new Map<string, number>();
  for (const part of String(req.headers['accept-encoding'] ?? '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    accept.set(name, q === undefined ? 1 : Number(q.slice(2)));
  }
  const ok = (name: string) => (accept.get(name) ?? 0) > 0;
  if (ok('br')) return 'br';
  if (ok('gzip')) return 'gzip';
  return null;
}

// A body over this is compressed at the fastest level: it blocks the loop while it runs (S-391), and JSON
// shrinks most of the way even at level 1.
export const FAST_BYTES = 256 * 1024;

export function encodeBody(body: Buffer, enc: 'br' | 'gzip'): Buffer {
  const fast = body.length >= FAST_BYTES;
  return enc === 'br'
    ? brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: fast ? 1 : 4 } })
    : gzipSync(body, { level: fast ? 1 : 6 });
}

// Writes BODY with HEADERS, compressed when the request takes it and the body is big enough.
// `encoded`, when given, is the body already compressed for this encoding (a static file's
// cache), so it isn't compressed again.
export function sendCompressed(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  headers: Record<string, string | number>,
  body: Buffer,
  encoded?: (enc: 'br' | 'gzip') => Buffer,
): void {
  const enc = body.length >= MIN_BYTES ? acceptedEncoding(req) : null;
  // Vary is set either way: a cache must not hand a compressed copy to a client that can't read it.
  const base = { ...headers, vary: 'accept-encoding' };
  if (!enc) {
    res.writeHead(status, { ...base, 'content-length': body.length });
    return void res.end(body);
  }
  const out = encoded ? encoded(enc) : encodeBody(body, enc);
  res.writeHead(status, { ...base, 'content-encoding': enc, 'content-length': out.length });
  res.end(out);
}
