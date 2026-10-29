// How the Codex subscription reading is shown (S-1361). Codex's limits refresh only through an
// app-server connection on the machine that runs a Codex agent, so a daemon with no Codex agent
// (a machine whose Codex agents run on a peer) kept its last reading for days. Shown, a reading
// is the newest of this machine's and the peers' (peer-readings.ts), and a window whose reset
// time has passed is never shown as its old percentage: it is `reset` with the age of the
// reading, so cost pacing can't trust it. Only Codex's `codex` entry goes through here.
import { peerWindows } from './peer-readings.ts';
import { settings } from './settings.ts';

// A window whose reset time has passed: no percentage, only when it reset and how old the reading is.
export interface ResetWindow {
  reset: true;
  resets_at: number;
  age_ms: number;
}

export interface CodexView {
  // Windows still in force, and the extra keys (credits, planType) as stored.
  live: Record<string, any>;
  reset: Record<string, ResetWindow>;
  // The entry's time and age: the OLDEST window reading, so a fresh window never makes an old one look fresh.
  updated_at: string | null;
  age_ms: number | null;
}

// The configured Codex account, for its peers' readings.
function codexAccount(): { name: string; match: { harness: string; model?: string } } | null {
  for (const [name, acct] of Object.entries(settings().cost.accounts ?? {})) if (acct?.match?.harness === 'codex') return { name, match: acct.match };
  return null;
}

export function codexView(data: Record<string, any> | null, updatedAt: string | null, now: number = Date.now()): CodexView {
  const local = Date.parse(updatedAt ?? '');
  let oldest: number | null = null;
  const acct = codexAccount();
  const peer = acct ? peerWindows(acct.name, acct.match, now) : {};
  const live: Record<string, any> = {};
  const reset: Record<string, ResetWindow> = {};
  // A peer's `ID/window` key belongs to a `codex:ID` bucket, not to this entry.
  const names = new Set([...Object.keys(data ?? {}), ...Object.keys(peer).filter((k) => !k.includes('/'))]);
  for (const name of names) {
    const own = data?.[name];
    const ownPct = typeof own?.used_percentage === 'number' ? own.used_percentage : null;
    const p = peer[name];
    if (ownPct == null && !p) {
      live[name] = own;
      continue;
    }
    // The newer of the two readings of this window.
    const usePeer = p != null && (ownPct == null || !Number.isFinite(local) || p.at > local);
    const pct = usePeer ? p.pct : ownPct!;
    const resets = usePeer ? p.resets_at : typeof own.resets_at === 'number' ? own.resets_at : null;
    const at = usePeer ? p.at : local;
    if (Number.isFinite(at) && (oldest == null || at < oldest)) oldest = at;
    if (resets != null && resets * 1000 <= now) reset[name] = { reset: true, resets_at: resets, age_ms: Math.max(0, now - (Number.isFinite(at) ? at : now)) };
    else live[name] = { used_percentage: pct, resets_at: resets ?? undefined, ...(Number.isFinite(at) ? { at: new Date(at).toISOString(), age_ms: Math.max(0, now - at) } : {}) };
  }
  if (oldest == null && Number.isFinite(local)) oldest = local;
  return { live, reset, updated_at: oldest == null ? null : new Date(oldest).toISOString(), age_ms: oldest == null ? null : Math.max(0, now - oldest) };
}
