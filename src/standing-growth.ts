// A standing agent proposes its own growth (S-920, step 2c of S-874). When its load (agent-load.ts)
// is over a standing.growth threshold and it has no open growth proposal, it gets one notice per
// crossing, from templates/standing-growth.md, saying how to file the proposal: an ITSA of kind
// `proposal` whose body starts `Growth: helpers|split|team`, in needs_approval. The retro loop's
// gate holds it there until your user approves (the chief of staff may approve helpers too).
import * as db from './db.ts';
import * as itsa from './itsa.ts';
import { cachedLoadOf, type AgentLoad } from './agent-load.ts';
import { queueNotice } from './mail.ts';
import { settings } from './settings.ts';
import { render } from './templates.ts';
import { PROPOSAL_KIND, growthKind } from './retro-loop.ts';

export interface GrowthThresholds {
  openItsas: number;
  leadHours: number;
  contextPct: number;
}

// The thresholds a load is over, as text for the notice; empty when it is under all of them.
export function crossings(load: AgentLoad, t: GrowthThresholds): string[] {
  const out: string[] = [];
  if (load.open_itsas > t.openItsas) out.push(`open ITSAs ${load.open_itsas} (over ${t.openItsas})`);
  if (load.median_lead_s != null && load.median_lead_s / 3600 > t.leadHours) out.push(`median lead time ${(load.median_lead_s / 3600).toFixed(1)} h over its last ${load.lead_n} closed ITSAs (over ${t.leadHours} h)`);
  if (load.context_ratio != null && load.context_ratio * 100 > t.contextPct) out.push(`context ${Math.round(load.context_ratio * 100)}% of the compaction threshold (over ${t.contextPct}%)`);
  return out;
}

// The agents already told for their current crossing; cleared when the load falls under every threshold
// or a proposal exists. A daemon restart forgets it, so a crossing is announced again at most once more.
const told = new Set<string>();

async function hasOpenGrowth(agentId: string): Promise<boolean> {
  return (await itsa.list({ kind: PROPOSAL_KIND })).some((x) => !x.closed_at && x.created_by === agentId && growthKind(x.body) !== null);
}

// Runs every minute. Only an active agent hears it: a resting one would be woken by a notice, and its
// load doesn't change while it rests.
export async function growthSweep(opts: { thresholds?: GrowthThresholds; enabled?: boolean; now?: number } = {}): Promise<string[]> {
  const g = settings().standing.growth;
  if (!(opts.enabled ?? g.enabled)) return [];
  const t = opts.thresholds ?? g;
  const sent: string[] = [];
  for (const a of db.listAgents()) {
    if (!a.standing || a.lifecycle !== 'active') continue;
    const load = cachedLoadOf(a, opts.now);
    const over = load ? crossings(load, t) : [];
    if (!over.length) {
      told.delete(a.id);
      continue;
    }
    if (told.has(a.id)) continue;
    if (await hasOpenGrowth(a.id)) continue;
    told.add(a.id);
    db.addEvent(a.id, 'standing:growth-notice', { over });
    queueNotice(a.id, render('standing-growth', { numbers: over.map((x) => `- ${x}`).join('\n'), name: a.name }));
    sent.push(a.id);
  }
  return sent;
}

export const resetGrowthTold = () => told.clear();
