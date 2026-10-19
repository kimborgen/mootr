// ITSAs in the embedding index (S-142): the `itsa` source, its text (key, title, summary, body)
// and its pending refs. Only the home daemon holds an ITSA, so only it indexes one; a new ITSA and
// an edit to its text are queued here, and the backfill picks up the rest.
import * as db from './db.ts';
import { MACHINE } from './config.ts';
import * as itsa from './itsa.ts';
import { embedText } from './embed.ts';
import { settings } from './settings.ts';
import { enqueue, source } from './vectors.ts';

const onHome = () => settings().itsa.home === MACHINE;

// The text an ITSA is embedded from: the same cleaning and cap as mail.
export function itsaText(x: Pick<itsa.Itsa, 'key' | 'title' | 'summary' | 'body'>): string {
  return embedText(`${x.key} ${x.title}`, `${x.summary ?? ''}\n${x.body ?? ''}`);
}

// Up to `limit` ITSAs on this daemon with no vector from `model`, or one updated since its vector
// was last checked (the flush marks an unchanged text current, so it isn't listed again).
function pendingItsas(model: string, limit: number): string[] {
  if (!onHome()) return [];
  const rows = db
    .open()
    .prepare(
      `SELECT i.id FROM itsas i LEFT JOIN embeddings e ON e.source = 'itsa' AND e.ref = i.id
       WHERE e.ref IS NULL OR e.model != ? OR i.updated_at > e.updated_at
       ORDER BY i.created_at DESC LIMIT ?`,
    )
    .all(model, limit) as { id: string }[];
  return rows.map((r) => r.id);
}

source(
  'itsa',
  (id) => {
    const x = itsa.find(id);
    return x ? itsaText(x) : undefined;
  },
  pendingItsas,
);

// A new ITSA, or an edit to its text, is queued; the hash skips a text the index already has.
itsa.onChange((c) => {
  if ((c.type === 'created' || c.type === 'edit') && onHome()) enqueue('itsa', c.itsa.id);
});
