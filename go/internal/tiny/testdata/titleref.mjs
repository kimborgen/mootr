// Reads a JSON list of model answers from stdin and writes, for each, what src/mail-title.ts cleanTitle, parseBoth,
// cleanSummary and cutText (at 12 code points) make of it, for go/internal/tiny's parser test (S-4013). Its home is the
// throwaway one in argv[2]: importing mail-title.ts loads the db and settings modules, which open nothing until called.
import { readFileSync } from 'node:fs';

process.env.STAM_HOME = process.argv[2];
const { cleanTitle, parseBoth, cleanSummary, cutText } = await import('../../../../src/mail-title.ts');
const inputs = JSON.parse(readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(inputs.map((raw) => {
  const both = parseBoth(raw);
  return { title: cleanTitle(raw) ?? '', bothTitle: both.title ?? '', bothSummary: both.summary ?? '', summary: cleanSummary(raw) ?? '', cut: cutText(raw, 12) };
})));
