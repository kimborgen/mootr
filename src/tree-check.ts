// The periodic tree check (S-915): when settings.treeCheck is on, the chief of staff gets a
// recurring wake_me timer whose note is the tree-check template. syncTreeCheck reconciles that
// one timer with the settings, so turning it off, changing the interval, editing the template,
// or naming another chief of staff takes effect without a restart and leaves no duplicate.
import * as db from './db.ts';
import { settings } from './settings.ts';
import { render } from './templates.ts';
import * as org from './org.ts';
import { wake } from './waits.ts';

const TAG = 'tree-check';

function tagged(): { id: string; agentId: string; everyMinutes: unknown; detail: string | null }[] {
  const out = [];
  for (const [agentId, waits] of db.listWaitsByAgent()) {
    for (const w of waits) {
      if (w.source !== 'stam' || w.kind !== 'timer') continue;
      let data: any = {};
      try { data = w.data ? JSON.parse(w.data) : {}; } catch {}
      if (data.tag === TAG) out.push({ id: w.id, agentId, everyMinutes: data.every_minutes, detail: w.detail });
    }
  }
  return out;
}

// Creates the new timer before it clears the old ones, so a failure (or an empty template) keeps
// the schedule that was running.
export function syncTreeCheck(): void {
  const cfg = settings().treeCheck;
  const old = tagged();
  const cos = cfg.enabled ? org.chiefOfStaff() : undefined;
  if (!cos) {
    for (const t of old) db.clearWait(t.id);
    return;
  }
  const everyMinutes = Math.max(1, Math.round(cfg.everyHours * 60));
  const note = render('tree-check', {});
  if (!note) return;
  const keep = old.find((t) => t.agentId === cos.id && t.everyMinutes === everyMinutes && t.detail === note);
  let kept = keep?.id;
  if (!keep) {
    try {
      kept = wake(cos.id, { note, every_minutes: everyMinutes }, TAG).id;
    } catch (e) {
      console.error(`tree check: ${e instanceof Error ? e.message : e}`);
      return;
    }
  }
  for (const t of old) if (t.id !== kept) db.clearWait(t.id);
}
