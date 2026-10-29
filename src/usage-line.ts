// (S-1361) One `stam usage` line for a window of the shown Codex entry: live with its age, or reset.
export function windowLine(name: string, w: string, v: any): string | null {
  const hm = (sec: number) => new Date(sec * 1000).toISOString().slice(11, 16);
  const old = (ms: number) => (ms >= 3_600_000 ? `${Math.round(ms / 3_600_000)}h` : `${Math.round(ms / 60_000)}m`);
  if (v?.reset === true && Number.isFinite(v.resets_at)) return `${name} ${w}: reset at ${hm(v.resets_at)}Z (reading ${old(v.age_ms)} old)`;
  if (typeof v?.used_percentage !== 'number') return null;
  const age = typeof v.age_ms === 'number' ? `, reading ${old(v.age_ms)} old` : '';
  const at = typeof v.resets_at === 'number' ? new Date(v.resets_at * 1000) : null;
  const resets = at && Number.isFinite(at.getTime()) ? `resets ${at.toISOString().slice(0, 16)}Z` : '';
  const note = [resets, age.replace(/^, /, '')].filter(Boolean).join(', ');
  return `${name} ${w}: ${v.used_percentage}%${note ? ` (${note})` : ''}`;
}
