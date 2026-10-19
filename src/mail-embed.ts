// Attaches the files a mail names by their path on this machine (S-718). An ```embed block (or video,
// audio, image, file) whose first line is such a path gets the file attached, and the line becomes
// "attachment: NAME", so the human sees the file without the agent attaching it by hand. A compare
// block's before or after line may name one the same way; that line becomes the attachment's name.
// Files over 100 MB stay a path. Kept apart from mail.ts so it can be tested without a daemon.
import { join, basename, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { statSync } from 'node:fs';

export interface Attached {
  name?: string;
  path?: string;
}

const EMBED_MAX = 100 * 1024 * 1024;

// The attachment's name for a path on this machine, adding the file to `attachments` unless it is
// there already (a before and after of one file attach it once). Undefined when the path isn't an
// existing file under the size cap, so the line stays as it was.
function attachPath(raw: string, attachments: Attached[]): string | undefined {
  let path = raw.trim();
  if (path.startsWith('~/')) path = join(homedir(), path.slice(2));
  if (!isAbsolute(path)) return undefined;
  const same = attachments.find((a) => a.path === path);
  if (same) return same.name ?? basename(path);
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > EMBED_MAX) return undefined;
  } catch {
    return undefined;
  }
  const taken = new Set(attachments.map((a) => a.name ?? (a.path ? basename(a.path) : '')));
  let name = basename(path);
  for (let i = 2; taken.has(name); i++) name = basename(path).replace(/(\.[^.]*)?$/, `-${i}$1`);
  attachments.push({ name, path });
  return name;
}

export function embedFiles(input: { body?: string; attachments?: Attached[] }): { body: string; attachments: Attached[] } {
  const attachments: Attached[] = [...(input.attachments ?? [])];
  let body = (input.body ?? '').replace(/```(embed|video|audio|image|file)[^\S\n]*\n([^\n]+)\n/g, (all, kind: string, first: string) => {
    const name = attachPath(first, attachments);
    return name ? '```' + kind + '\nattachment: ' + name + '\n' : all;
  });
  body = body.replace(/```compare\n([\s\S]*?)```/g, (_all, inner: string) => '```compare\n' + inner.replace(/^([^\S\n]*(?:before|after)[^\S\n]*:[^\S\n]*)(.+?)[^\S\n]*$/gim, (line, pre: string, ref: string) => {
    const name = attachPath(ref, attachments);
    return name ? pre + name : line;
  }) + '```');
  return { body, attachments };
}
