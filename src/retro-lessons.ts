// Lessons from similar work (S-725), wired to the daemon: the embedding search over the retro items
// (src/vectors.ts, src/embed.ts, as `search` uses them) for an agent's task, rendered for the system
// prompt and for the prompt after a compaction. The query itself is lessonsFor in src/retro.ts.
import * as db from './db.ts';
import { embed } from './embed.ts';
import { nearest } from './vectors.ts';
import { settings } from './settings.ts';
import { lessonsFor, renderLessons, PARENT_KIND, PARENT_TITLE, RETRO_KIND, type LessonDeps } from './retro.ts';

// Spawn never waits longer than this for the lessons; a slow embedder gives none.
export const LESSONS_TIMEOUT_MS = 1500;
// The task text: type and role first, then the first prompt, capped (the embedder reads about 250 tokens).
const TEXT_CHARS = 1500;

export const deps: LessonDeps = {
  items() {
    const d = db.open();
    const parent = d.prepare('SELECT id FROM itsas WHERE kind = ? AND title = ?').get(PARENT_KIND, PARENT_TITLE) as { id: string } | undefined;
    if (!parent) return [];
    const rows = d.prepare('SELECT id, key, title, summary, body, status FROM itsas WHERE parent_id = ? AND kind = ?').all(parent.id, RETRO_KIND) as any[];
    return rows.map((x) => ({ id: x.id, key: x.key, summary: x.summary || x.title, body: x.body, status: x.status }));
  },
  async similar(text, ids) {
    const vec = (await embed([text]))?.[0];
    return vec ? nearest('itsa', vec, ids, Infinity).map((n) => ({ id: n.ref, score: n.score })) : null;
  },
};

export const taskText = (a: db.Agent): string => [a.type, a.role, a.first_prompt].filter(Boolean).join('\n').slice(0, TEXT_CHARS);

// The block for an agent, empty when lessons are off, nothing is similar, or the embedder is down or slow.
export async function lessonsPrompt(a: db.Agent): Promise<string> {
  const s = settings().retro.lessons;
  if (!s.enabled) return '';
  const t0 = Date.now();
  try {
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), LESSONS_TIMEOUT_MS).unref());
    const hits = await Promise.race([lessonsFor(deps, taskText(a), s.k), timeout]);
    const text = hits ? renderLessons(hits) : '';
    db.addEvent(a.id, 'retro:lessons', { items: hits?.map((h) => h.key) ?? [], ms: Date.now() - t0, ...(hits ? {} : { timedOut: true }) });
    return text;
  } catch {
    return '';
  }
}

// The block last computed for an agent, for the places that render a prompt without waiting.
const cache = new Map<string, string>();
export async function warmLessons(a: db.Agent): Promise<string> {
  const text = await lessonsPrompt(a);
  cache.set(a.id, text);
  return text;
}
// undefined when none was computed, so an agent whose block is empty isn't recomputed on every read.
export const cachedLessons = (id: string): string | undefined => cache.get(id);
export const forgetLessons = (id: string): void => void cache.delete(id);
