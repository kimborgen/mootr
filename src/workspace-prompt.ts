import { opendirSync, openSync, readSync, closeSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { render } from './templates.ts';
import { grantsFor, sharesOf } from './workspace-share.ts';

// The "Your workspace" block (S-895): the agent's personal workspace folder and an index of
// it, for the system prompt and the prompt after a compaction. Computed fresh on each call
// (the files change), synchronously and without a model.
export const WORKSPACE_INDEX_MAX_CHARS = 1200; // about 300 tokens
const MAX_ENTRIES = 500; // the directory walk stops here
const MAX_DEPTH = 4;
const LINE_MAX = 160;

function firstLine(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(512);
    const n = readSync(fd, buf, 0, 512, 0);
    let text = buf.subarray(0, n).toString('utf8');
    if (/[\0-\x08\x0e-\x1f\x7f]/.test(text)) return ''; // binary
    if (n === buf.length) text = text.replace(/\ufffd$/, ''); // a character cut at the buffer's end
    const line = text.split('\n').find((l) => l.trim()) ?? '';
    if (line.includes('\ufffd')) return ''; // not UTF-8 text
    return line.trim().slice(0, LINE_MAX);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

// Symlinks are never followed (lstat), so nothing outside the folder is read. Entries are
// read one at a time, so a huge directory stops at the cap instead of being listed whole.
function walk(root: string, dir: string, depth: number, out: string[]): void {
  if (out.length >= MAX_ENTRIES) return;
  const subdirs: string[] = [];
  let d;
  try {
    d = opendirSync(join(root, dir));
  } catch {
    return;
  }
  try {
    let e;
    while (out.length < MAX_ENTRIES && (e = d.readSync())) {
      if (e.name.startsWith('.')) continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      let st;
      try { st = lstatSync(join(root, rel)); } catch { continue; }
      if (st.isDirectory()) subdirs.push(rel);
      else if (st.isFile()) out.push(rel);
    }
  } catch {} finally {
    try { d.closeSync(); } catch {}
  }
  if (depth >= MAX_DEPTH) return;
  for (const sub of subdirs.sort()) walk(root, sub, depth + 1, out);
}

// Each file's relative path and first line, sorted, within the cap, with a "+N more files" tail.
export function workspaceIndex(path: string, max = WORKSPACE_INDEX_MAX_CHARS): string {
  const files: string[] = [];
  walk(path, '', 0, files);
  files.sort();
  if (!files.length) return '(empty)';
  const lines: string[] = [];
  let used = 0;
  for (let i = 0; i < files.length; i++) {
    const fl = firstLine(join(path, files[i]));
    const line = `- \`${files[i]}\`${fl ? `: ${fl}` : ''}`;
    const rest = files.length - i;
    const tail = `+${rest} more files`;
    if (used + line.length + 1 + tail.length > max && i > 0 || used + line.length + 1 > max && i === 0) {
      lines.push(tail);
      return lines.join('\n');
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

// The block for an agent: its own folder and index, then the folders shared with it (S-896);
// empty when it has neither.
export function workspacePrompt(a: { id?: string; personal_workspace?: string | null }): string {
  let own = a.personal_workspace ? render('workspace', { path: a.personal_workspace, index: workspaceIndex(a.personal_workspace) }) : '';
  const out = a.personal_workspace ? sharesOf(a.personal_workspace) : [];
  if (out.length) own += `\n\nYou share this folder with: ${out.map((o) => `${o.name} (${o.access})`).join(', ')}.`;
  const grants = a.id ? grantsFor(a.id) : [];
  if (!grants.length) return own;
  const list = grants.map((g) => `- ${g.owner}: \`${g.path}\` (${g.access})`).join('\n');
  return render('workspace-shared', { intro: own ? `${own}\n\n` : '# Your workspace\n\nYou have no folder of your own.\n\n', list });
}
