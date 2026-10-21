// The shape of a push device row that leaves the daemon (S-2539). A push_devices row holds a Web
// Push `endpoint` (a capability URL: whoever has it can push to that device) and the browser's
// p256dh and auth keys next to the columns the page shows. Every route that serves a device (the
// list, subscribe, and the kinds/label update) goes through publicPushDevice, an allowlist: a column
// added to the table later is not served until someone adds it here on purpose. The sender in
// webpush.ts reads the full row from the store and never goes through this.
//
// The page has to know which listed device is the one it holds a subscription for. It gets
// endpoint_hash, the SHA-256 of the endpoint in hex, and hashes its own subscription's endpoint
// the same way; the endpoint itself is on no list.
import { createHash } from 'node:crypto';
import type { PushDevice } from './db.ts';

export interface PublicPushDevice {
  id: string;
  endpoint_hash: string;
  label: string;
  kinds: string[];
  created_at: string;
  last_ok_at: string | null;
  last_error: string | null;
}

export const endpointHash = (endpoint: string): string => createHash('sha256').update(endpoint).digest('hex');

// A push service's error text is stored as it came and may echo the request. Fails closed: any URL goes,
// and so does each secret of the row (endpoint, p256dh, auth) as it is, URL-encoded, and in base64 or
// base64url of the string itself.
export function redactPushError(text: string, d: Pick<PushDevice, 'endpoint' | 'p256dh' | 'auth'>): string {
  let out = text.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]*/gi, '[redacted]');
  // The path and query of the endpoint carry its token, so they go on their own too.
  let tail = '';
  try { const u = new URL(d.endpoint); tail = u.pathname + u.search; } catch { /* not a URL: the whole string is redacted below */ }
  for (const secret of [d.endpoint, tail.length >= 8 ? tail : '', d.p256dh, d.auth]) {
    if (!secret) continue;
    const b = Buffer.from(secret);
    for (const form of new Set([secret, encodeURIComponent(secret), b.toString('base64'), b.toString('base64url'), b.toString('base64').replace(/=+$/, '')])) out = out.split(form).join('[redacted]');
  }
  return out;
}

export function publicPushDevice(d: PushDevice): PublicPushDevice {
  return {
    id: d.id,
    endpoint_hash: endpointHash(d.endpoint),
    label: d.label,
    kinds: [...d.kinds],
    created_at: d.created_at,
    last_ok_at: d.last_ok_at,
    last_error: d.last_error && redactPushError(d.last_error, d),
  };
}
