// Small HTTP helpers the adapters share (S-2113, S-2116).

const RETRY_AFTER_MAX_MS = 300_000;

// The Retry-After header as milliseconds: seconds, or an HTTP date. Undefined when absent or unreadable.
export function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(header) - Date.now();
  if (!Number.isFinite(ms)) return undefined;
  return Math.min(RETRY_AFTER_MAX_MS, Math.max(0, ms));
}

export function signalFor(req: { signal?: AbortSignal; timeoutMs?: number }): AbortSignal | undefined {
  const t = req.timeoutMs != null ? AbortSignal.timeout(req.timeoutMs) : undefined;
  return req.signal && t ? AbortSignal.any([req.signal, t]) : req.signal ?? t;
}

// A credential fit for a header: printable ASCII with no spaces. Anything else (an internal newline,
// a NUL) would make fetch throw an error that quotes the header, key and all, so it is refused here
// with fixed text that names only what it is (S-2117).
export function checkCredential(value: string, what: string): string {
  if (!/^[\x21-\x7e]+$/.test(value)) throw new Error(`invalid ${what}`);
  return value;
}

// fetch, with a transport failure rethrown as fixed text: fetch's own errors can quote a header value,
// a key among them, and callers log the message (S-2117). The cause's code (ECONNREFUSED) or the
// error's name stays; an abort or a timeout keeps its name.
export async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e: any) {
    const name = typeof e?.name === 'string' && /^\w+$/.test(e.name) ? e.name : 'Error';
    const code = typeof e?.cause?.code === 'string' && /^[A-Z0-9_]+$/.test(e.cause.code) ? e.cause.code : undefined;
    const err = new Error(`request failed: ${code ?? name}`);
    if (name === 'AbortError' || name === 'TimeoutError') err.name = name;
    throw err;
  }
}
