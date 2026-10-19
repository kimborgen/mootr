// The declaration index's worker thread (S-1532): reads a commit's source blobs with one `git cat-file --batch`,
// parses each with its Lezer grammar and walks the tree (src/decl-walk.ts), off the daemon's event loop.
// One build per worker: src/decl.ts starts it, posts the file list, and it exits after answering.
import { spawn } from 'node:child_process';
import { parentPort, workerData } from 'node:worker_threads';
import { parser as jsParser } from '@lezer/javascript';
import { parser as pyParser } from '@lezer/python';
import { parser as rustParser } from '@lezer/rust';
import { parser as goParser } from '@lezer/go';
import type { LRParser } from '@lezer/lr';
import { declLangOf, walkDecls, walkImports, type DeclLang } from './decl-walk.ts';

export type WorkFile = { path: string; blob: string };
// Per file: its declarations as [name, line, col, kind, line text], and the relative imports it names.
export type WorkResult = { path: string; decls: [string, number, number, string, string][]; imports: string[] };

const LINE_TEXT = 160;
const parsers = new Map<string, LRParser>();
function parserFor(lang: DeclLang, dialect?: string): LRParser {
  const key = `${lang}:${dialect ?? ''}`;
  let p = parsers.get(key);
  if (!p) {
    p = lang === 'js' ? (dialect ? jsParser.configure({ dialect }) : jsParser) : lang === 'python' ? pyParser : lang === 'rust' ? rustParser : goParser;
    parsers.set(key, p);
  }
  return p;
}

// Reads the blobs in order through one `git cat-file --batch`: each answer is `<sha> blob <size>\n<bytes>\n`.
async function* blobs(dir: string, ids: string[]): AsyncGenerator<Buffer> {
  const p = spawn('git', ['cat-file', '--batch'], { cwd: dir, stdio: ['pipe', 'pipe', 'ignore'] });
  p.stdin.end(ids.join('\n') + '\n');
  let buf: Buffer = Buffer.alloc(0);
  let want = -1;
  for await (const chunk of p.stdout as AsyncIterable<Buffer>) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (want < 0) {
        const nl = buf.indexOf(10);
        if (nl < 0) break;
        const head = buf.subarray(0, nl).toString();
        buf = buf.subarray(nl + 1);
        const m = / blob (\d+)$/.exec(head);
        // `<id> missing`: nothing follows, so the file reads as empty.
        if (!m) { yield Buffer.alloc(0); continue; }
        want = Number(m[1]);
      }
      if (buf.length < want + 1) break;
      yield buf.subarray(0, want);
      buf = buf.subarray(want + 1);
      want = -1;
    }
  }
}

export function parseOne(path: string, text: string): WorkResult | null {
  const lang = declLangOf(path);
  if (!lang) return null;
  const tree = parserFor(lang.lang, lang.dialect).parse(text);
  // Line starts, to turn offsets into 1-based lines and columns.
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  const at = (pos: number) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const decls = walkDecls(lang.lang, tree.topNode, text).map((d): WorkResult['decls'][number] => {
    const i = at(d.from);
    const end = text.indexOf('\n', starts[i]);
    const line = text.slice(starts[i], end < 0 ? text.length : end).trim().slice(0, LINE_TEXT);
    return [d.name, i + 1, d.from - starts[i] + 1, d.kind, line];
  });
  return { path, decls, imports: walkImports(lang.lang, tree.topNode, text) };
}

async function run(dir: string, files: WorkFile[]): Promise<WorkResult[]> {
  const out: WorkResult[] = [];
  let i = 0;
  for await (const b of blobs(dir, files.map((f) => f.blob))) {
    const f = files[i++];
    if (!f) break;
    // A NUL in the first 8 KB: a binary in a source file's clothes.
    if (b.subarray(0, 8192).includes(0)) continue;
    try {
      const r = parseOne(f.path, b.toString('utf8'));
      if (r && (r.decls.length || r.imports.length)) out.push(r);
    } catch {}
  }
  return out;
}

if (parentPort && workerData?.decl) {
  const { dir, files } = workerData as { dir: string; files: WorkFile[]; decl: true };
  run(dir, files).then((results) => parentPort!.postMessage({ results }), (e) => parentPort!.postMessage({ error: e instanceof Error ? e.message : String(e) }));
}
