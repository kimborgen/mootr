// A pure unified-diff parser: no HTML, no DOM. mailblocks renders its rows; the diff viewer reuses it.
export type PatchRowKind = 'add' | 'del' | 'ctx' | 'hunk';
export interface PatchRow {
  kind: PatchRowKind;
  /** The patch line, verbatim (marker included). */
  text: string;
  /** Leading indent of the code after the marker, a tab counting 4. Zero for hunk headers. */
  ind: number;
}
export interface PatchFile { path: string; rows: PatchRow[]; add: number; del: number }

/** Leading indent in columns, a tab counting 4. */
export function indentOf(code: string): number {
  let n = 0;
  for (const c of code) {
    if (c === ' ') n++;
    else if (c === '\t') n += 4;
    else break;
  }
  return n;
}

export function parsePatch(text: string): PatchFile[] {
  const files: PatchFile[] = [];
  let f!: PatchFile;
  const start = (path: string) => { f = { path, rows: [], add: 0, del: 0 }; files.push(f); };
  // A `+++` header names the file its `---` opened; one without a `---` before it opens its own (S-2084: a hand-written diff of new text).
  let minus = false;
  for (const line of text.replace(/\n$/, '').split('\n')) {
    const was = minus;
    minus = false;
    const g = line.match(/^diff --git a\/(.*?) b\/(.*)$/);
    if (g) { start(g[2]); continue; }
    if (/^(index |new file mode|deleted file mode|similarity index|rename (from|to) )/.test(line) && f) continue;
    if (line.startsWith('--- ')) { if (!f || f.rows.length) start(line.slice(4).replace(/^a\//, '')); minus = true; continue; }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/^b\//, '');
      if (!was && (!f || f.rows.length)) start(p === '/dev/null' ? '' : p);
      else if (p !== '/dev/null') f.path = p;
      continue;
    }
    if (!f) start('');
    const kind: PatchRowKind = line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
    if (kind === 'add') f.add++;
    if (kind === 'del') f.del++;
    f.rows.push({ kind, text: line, ind: kind === 'hunk' ? 0 : indentOf(line.slice(1)) });
  }
  return files;
}
