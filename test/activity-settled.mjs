// The activity summary's answer once it is whole. A cold answer (the first after a daemon start or a reset) can be
// partial while the first refresh runs: it comes back `warming: true` and is not cached (S-1206). This asks again
// until it is not warming; the refresh is shared, so each ask waits on it, not on time. Bounded, so a stuck refresh
// fails the caller's assertions rather than hanging.
export async function settled(opts) {
  const summary = await import('../src/activity-summary.ts');
  let s;
  for (let i = 0; i < 100 && (s === undefined || s.warming); i++) s = await summary.activitySummary(opts);
  return s;
}
