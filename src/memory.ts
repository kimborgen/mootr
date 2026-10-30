import { readFileSync } from 'node:fs';
// Resident memory by kind, read from /proc for `daemon status` (S-4390): anonymous pages are the heap, malloc arenas and
// buffers; file-backed pages are mapped files, such as the database's mmap. Undefined where /proc/self/status isn't there.
export function residentMemory(): { anon: number; file: number } | undefined {
  let text: string;
  try {
    text = readFileSync('/proc/self/status', 'utf8');
  } catch {
    return undefined;
  }
  const kb = (key: string) => Number(text.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'))?.[1]);
  const anon = kb('RssAnon');
  const file = kb('RssFile');
  return Number.isFinite(anon) && Number.isFinite(file) ? { anon: anon * 1024, file: file * 1024 } : undefined;
}
