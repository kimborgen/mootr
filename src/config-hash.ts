// The sha256 hex of the model and prompt a summary is asked with, stored beside the summary, so an
// edit to either asks again (S-1684 for block summaries, S-1843 for tool-call summaries and mail titles).
import { createHash } from 'node:crypto';

export function configHash(...parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');
}
