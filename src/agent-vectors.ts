// Agents in the embedding index (S-1459): the `agent` source, its text (name, role, task brief)
// and its pending refs. Only this daemon's own agents are indexed; a peer indexes its own. A new
// agent, and a change to its name, role, brief or lifecycle, is queued; the backfill picks up the rest.
import * as db from './db.ts';
import { embedText } from './embed.ts';
import { enqueue, source } from './vectors.ts';

// How much of the brief the embedding reads: the role and name carry the topic, the brief adds detail.
const BRIEF_CHARS = 600;

export function agentText(a: Pick<db.Agent, 'name' | 'role' | 'first_prompt'>): string {
  return embedText(`${a.name} ${a.role ?? ''}`, (a.first_prompt ?? '').slice(0, BRIEF_CHARS));
}

// Up to `limit` agents with no vector from `model`, or changed since their vector was last checked
// (the flush marks an unchanged text current, so it isn't listed again).
function pendingAgents(model: string, limit: number): string[] {
  const rows = db
    .open()
    .prepare(
      `SELECT a.id FROM agents a LEFT JOIN embeddings e ON e.source = 'agent' AND e.ref = a.id
       WHERE e.ref IS NULL OR e.model != ? OR a.updated_at > e.updated_at
       ORDER BY a.created_at DESC LIMIT ?`,
    )
    .all(model, limit) as { id: string }[];
  return rows.map((r) => r.id);
}

source(
  'agent',
  (id) => {
    const a = db.getAgent(id);
    return a ? agentText(a) : undefined;
  },
  pendingAgents,
);

db.onAgentText((id) => {
  enqueue('agent', id);
});
