// The reference for diff_test.go: what src/diff.ts says, pure and over git repos the test built. Run by the test (node,
// no daemon) with HOME and STAM_HOME set in a temp folder whose settings.json names the repo: argv[2] is the input
// file, argv[3] the output file.
import { readFileSync, writeFileSync } from 'node:fs';

const diff = await import('../../../../src/diff.ts');
const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const attempt = async (f) => {
  try {
    return { ok: await f() };
  } catch (e) {
    if (e instanceof diff.DiffError) return { status: e.status, message: e.message };
    throw e;
  }
};
// A response that keeps what serveFile writes.
const fakeRes = () => {
  const r = { status: 0, headers: {}, body: '' };
  return { r, res: { writeHead: (s, h) => ((r.status = s), (r.headers = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), String(v)])))), end: (b) => (r.body = Buffer.from(b ?? '').toString('base64')) } };
};
const out = {
  match: input.match.map(([p, path]) => diff.matchPattern(p, path)),
  classify: input.classify.map((path) => diff.classify(path, input.classes)),
  parse: input.parse.map(([a, b, c]) => diff.parseDiff(a, b, c)),
  slug: input.slug.map((u) => diff.githubSlug(u)),
  review: input.review.map(([s, h]) => diff.reviewOf(s, h)),
  list: [],
  file: [],
};
for (const [repo, pr] of input.list) out.list.push(await attempt(() => diff.list(repo, pr)));
for (const q of input.file) {
  const { r, res } = fakeRes();
  const a = await attempt(() => diff.serveFile(res, q.repo, q.pr, q.path, q.side, q.all, q.want ?? {}));
  out.file.push('status' in a ? a : { ok: r });
}
writeFileSync(process.argv[3], JSON.stringify(out));
