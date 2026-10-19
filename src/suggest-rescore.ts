// The Decision Model pass over prompt suggestions (S-1465), behind decisions.suggestRescore (off by
// default). The client asks after a pause in typing, once it has shown the embedding order: this takes
// the top RESCORE_TOP candidates scoring at least RESCORE_FLOOR (more than /api/suggest's floor), makes
// ONE decide call with a score question per candidate, and returns the ones at RESCORE_SHOW or more,
// best first, with the model's score as their score. Off, or no candidates, or a failed call: nothing
// is asked, and the client keeps its first order.
import { decideWithFailure, type Question } from './decide.ts';
import type { Result } from './search.ts';
import { settings } from './settings.ts';
import { suggest, type SuggestOpts } from './suggest.ts';

export const RESCORE_FLOOR = 0.2;
export const RESCORE_TOP = 30;
export const RESCORE_SHOW = 0.5;
const RESCORE_TIMEOUT_MS = 5_000;

export async function rescoreSuggest(q: string, opts: Pick<SuggestOpts, 'recent' | 'local' | 'humanMail'>): Promise<Result[] | null> {
  const text = String(q ?? '').trim();
  if (!text || !settings().decisions.suggestRescore) return null;
  const cands = await suggest(text, { ...opts, limit: RESCORE_TOP, floor: RESCORE_FLOOR });
  if (!cands.length) return [];
  const state = { text, candidates: cands.map((c, i) => ({ id: `c${i}`, kind: c.kind, title: c.title, snippet: c.snippet ?? '' })) };
  const questions: Record<string, Question> = Object.fromEntries(
    cands.map((c, i) => [
      `c${i}`,
      {
        type: 'score',
        instructions: `How well does candidate c${i}, "${c.title}", fit what the human's text asks for? 0 is not at all, 1 is exactly.`,
        criteria: ['not what the text asks for', 'what the text asks for'],
      },
    ]),
  );
  const { result } = await decideWithFailure(state, questions, { purpose: 'decide:suggest-rescore', timeoutMs: RESCORE_TIMEOUT_MS });
  if (!result) return null;
  return cands
    .flatMap((c, i): Result[] => {
      const score = result.answers[`c${i}`]?.score;
      return typeof score === 'number' && Number.isFinite(score) && score >= RESCORE_SHOW ? [{ ...c, score }] : [];
    })
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}
