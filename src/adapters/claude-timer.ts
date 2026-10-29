// The next time a one-shot cron with fixed minute and hour fires (Claude Code writes
// ScheduleWakeup and one-shot CronCreate that way), in this machine's local time.
export function nextCronFire(schedule: string, from = new Date()): string | null {
  const [min, hour, dom, mon] = schedule.trim().split(/\s+/);
  if (!/^\d+$/.test(min ?? '') || !/^\d+$/.test(hour ?? '')) return null;
  const t = new Date(from);
  t.setSeconds(0, 0);
  t.setHours(Number(hour), Number(min));
  if (/^\d+$/.test(mon ?? '')) t.setMonth(Number(mon) - 1, /^\d+$/.test(dom ?? '') ? Number(dom) : t.getDate());
  else if (/^\d+$/.test(dom ?? '')) t.setDate(Number(dom));
  if (t <= from && !/^\d+$/.test(dom ?? '')) t.setDate(t.getDate() + 1);
  return t.toISOString();
}

// The detail of a harness timer wait (S-3391). A one-shot (ScheduleWakeup, or a one-shot cron) shows
// when it fires, in UTC, since its cron text reads as a daily repeat; `until` is that fire time, with
// its date when it is a day or more away (`12-25 14:30Z`), so it doesn't read as today. A recurring
// one keeps its cron. Both say it is the harness's own timer, not a stam wake_me, so nobody tries
// wait_done on it.
export function harnessTimerDetail(c: { schedule?: unknown; recurring?: unknown }, until: string | null, now = Date.now()): string {
  const schedule = String(c.schedule ?? '');
  if (c.recurring) return `harness cron ${schedule}`;
  if (until) {
    const day = Date.parse(until) - now >= 86_400_000 ? `${until.slice(5, 10)} ` : '';
    return `harness timer at ${day}${until.slice(11, 16)}Z`;
  }
  return `harness timer ${schedule}`;
}
