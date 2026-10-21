// A pure unified-diff parser: no HTML, no DOM. mailblocks renders its rows; the diff viewer reuses it.
export type PatchRowKind = 'add' | 'del' | 'ctx' | 'hunk';
export interface PatchRow {
  kind: PatchRowKind;
  /** The patch line, verbatim (marker included). */
  text: string;
  /** Leading indent of the code after the marker, a tab counting 4. Zero for hunk headers. */
  ind: number;
}
export interface PatchFile {
  path: string;
  /** The path a rename (or a deletion) came from, when the patch names one other than `path`. */
  oldPath?: string;
  /** The patch opened this file with a `diff --git` header, so its own headers, not the hunks, say what it did. */
  header?: true;
  /** The patch's own headers say it creates the file (`new file mode`, `--- /dev/null`). */
  created?: true;
  /** And that it removes it (`deleted file mode`, `+++ /dev/null`). */
  removed?: true;
  rows: PatchRow[];
  add: number;
  del: number;
}

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

// What the patch did to a file. Only its own headers say a file is created or removed: a `-U0` insertion at the top of
// an existing file carries the very same `@@ -0,0 +1 @@` header a new file's first hunk does (S-2104 review), so the
// hunk header is only a fallback for a hand-written patch that leaves the headers out.
export function patchKind(p: PatchFile): 'added' | 'deleted' | 'modified' {
  if (p.created) return 'added';
  if (p.removed) return 'deleted';
  // Only a hand-written patch (no `diff --git`) needs the hunk header, and only for a deletion: `@@ -1 +0,0 @@` is how
  // any whole-file deletion ends, while a `-U0` insertion at the top of an existing file carries a new file's
  // `@@ -0,0 +1 @@` header too, so that one never says a file is created (S-2104 and S-2105 reviews).
  if (!p.header && /\+0,0 @@/.test(p.rows.find((r) => r.kind === 'hunk')?.text ?? '')) return 'deleted';
  return 'modified';
}

export function parsePatch(text: string): PatchFile[] {
  const files: PatchFile[] = [];
  let f!: PatchFile;
  const start = (path: string) => { f = { path, rows: [], add: 0, del: 0 }; files.push(f); };
  // A `+++` header names the file its `---` opened; one without a `---` before it opens its own (S-2084: a hand-written diff of new text).
  let minus = false;
  // The path the previous line's `---` named, for a rename's old side.
  let old: string | null = null;
  for (const line of text.replace(/\n$/, '').split('\n')) {
    const was = minus;
    const oldWas = old;
    minus = false;
    old = null;
    const g = line.match(/^diff --git a\/(.*?) b\/(.*)$/);
    if (g) { start(g[2]); f.header = true; if (g[1] !== g[2]) f.oldPath = g[1]; continue; }
    if (/^(index |similarity index|rename (from|to) )/.test(line) && f) continue;
    if (/^new file mode /.test(line) && f) { f.created = true; continue; }
    if (/^deleted file mode /.test(line) && f) { f.removed = true; continue; }
    if (line.startsWith('--- ')) { old = line.slice(4).replace(/^a\//, ''); if (!f || f.rows.length) start(old === '/dev/null' ? '' : old); if (old === '/dev/null') f.created = true; minus = true; continue; }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/^b\//, '');
      if (!was && (!f || f.rows.length)) start(p === '/dev/null' ? '' : p);
      else if (p !== '/dev/null') f.path = p;
      if (p === '/dev/null') f.removed = true;
      if (oldWas && oldWas !== '/dev/null' && oldWas !== f.path) f.oldPath = oldWas;
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
