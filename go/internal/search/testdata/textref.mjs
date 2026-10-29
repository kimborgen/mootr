// The TS answers search_test.go compares: src/search.ts rank, plainText and excerpt, and src/embed.ts embedText and
// stubVector, for the cases on stdin ({texts: [...], queries: [...]}). Prints one JSON object.
import { resolve } from 'node:path';

const root = resolve(new URL('../../../../', import.meta.url).pathname);
const search = await import(root + '/src/search.ts');
const embed = await import(root + '/src/embed.ts');
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { texts, queries } = JSON.parse(input);
const out = { plain: [], embed: [], stub: [], rank: [], excerpt: [] };
for (const t of texts) {
  out.plain.push(search.plainText(t));
  out.embed.push(embed.embedText('Subject', t));
  out.stub.push(Array.from(embed.stubVector(t)));
  for (const q of queries) {
    out.rank.push(search.rank(t, q));
    out.excerpt.push(search.excerpt(t, q));
  }
}
console.log(JSON.stringify(out));
