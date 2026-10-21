// A key check (S-2115): one authenticated GET that proves a provider accepts a key, for the
// Settings page's Test button. The result is fixed text only: a status code or a transport error's
// code, never a response body or fetch's own message, which can quote a header and so the key.
// Redirects are refused, so the key never reaches another origin.
import type { KeyCheck } from './types.ts';

// A provider's reading of a 401 or 403 by its error type (AWS's `AccessDeniedException`, say). Undefined
// keeps the default reading: the key is refused.
export type RefusalReading = (status: number, errorType: string | undefined) => KeyCheck | undefined;

export async function probeKey(url: string, headers: Record<string, string>, timeoutMs = 10_000, reading?: RefusalReading): Promise<KeyCheck> {
  // A header carries printable ASCII only; fetch would refuse anything else with an error naming the
  // header, so a malformed key is named as such here and never sent.
  if (!Object.values(headers).every((v) => /^[\x20-\x7e]*$/.test(v))) return { ok: false, detail: 'invalid API key (it holds a character a header cannot carry)' };
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  } catch (e: any) {
    const code = typeof e?.cause?.code === 'string' && /^[A-Z0-9_]+$/.test(e.cause.code) ? e.cause.code : e?.name === 'TimeoutError' ? 'timeout' : 'network error';
    return { ok: false, detail: `could not reach the provider (${code})` };
  }
  const read = reading && (res.status === 401 || res.status === 403) ? reading(res.status, await errorType(res)) : undefined;
  await res.body?.cancel().catch(() => {});
  if (read) return read;
  if (res.ok) return { ok: true, detail: `HTTP ${res.status}` };
  if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, detail: `the provider refused the key (HTTP ${res.status})` };
  return { ok: false, status: res.status, detail: `the provider answered HTTP ${res.status}` };
}

// The AWS error type of a refused call, without its message or URL: the x-amzn-errortype header, else
// the body's __type. Undefined when neither is readable, so the reading fails closed.
async function errorType(res: Response): Promise<string | undefined> {
  const header = res.headers.get('x-amzn-errortype');
  if (header) return header.split(':')[0].split('#').pop();
  try {
    const type = JSON.parse(await res.text())?.__type;
    return typeof type === 'string' ? type.split('#').pop() : undefined;
  } catch {
    return undefined;
  }
}
