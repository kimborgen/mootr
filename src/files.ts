// The Files API's local half (S-1525): what a path may name, listing a folder, and serving a file.
// Only the human reaches it (daemon.ts checks), over the roots in `files.roots`; a fixed deny list
// holds even inside a root, and every path is resolved with realpath so `..` and symlinks can't escape.
import { constants, createReadStream, openSync, readSync, closeSync, fstatSync, readdirSync, realpathSync, lstatSync, statSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { STAM_HOME } from './config.ts';

export class FilesError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const TEXT_CAP = 5 * 1024 * 1024;
const SNIFF_BYTES = 4096;

export const TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
};
const TEXT_EXT = /^(txt|md|log|json|ya?ml|toml|csv|tsv|ts|tsx|js|jsx|mjs|py|sh|rs|go|css|html|sql|diff|patch)$/;

// The type an attachment or file is served as, by extension.
export function typeByExt(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return TYPES[ext] ?? (TEXT_EXT.test(ext) ? 'text/plain; charset=utf-8' : 'application/octet-stream');
}

// The headers every served file carries: no script can run from it, whatever its type.
export const SAFE_HEADERS = { 'accept-ranges': 'bytes', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'x-content-type-options': 'nosniff', 'cache-control': 'private' };

export function defaultRoots(): string[] {
  return [join(homedir(), 'projects'), join(STAM_HOME, 'attachments')];
}

const expand = (p: string) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

// The configured roots (null means the defaults) that exist, as real paths.
export function realRoots(configured: string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const r of configured?.length ? configured : defaultRoots()) {
    try {
      const real = realpathSync(resolve(expand(r)));
      // The home folder, or a folder that contains it, would open every credential file in it to the walk.
      if (!inside(resolveSafe(homedir()), real)) out.push(real);
    } catch {}
  }
  return [...new Set(out)];
}

const inside = (child: string, root: string) => child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);

// Folders and files under the home folder that hold credentials, matched case-insensitively.
const HOME_DENIED = ['.claude', '.codex', '.config/gh', '.config/upctl.yaml', '.local/share/opencode/auth.json', '.aws', '.docker/config.json', '.npmrc', '.gnupg'];

// Whether a path is on the fixed deny list: credentials, keys, shell history, and stam's own tokens.
// It is not a setting.
export function denied(abs: string): boolean {
  const low = abs.toLowerCase();
  const parts = low.split(sep).filter(Boolean);
  const name = parts[parts.length - 1] ?? '';
  if (parts.includes('.ssh')) return true;
  if (name.startsWith('.env') || name.endsWith('.pem') || name.endsWith('.key') || name === '.netrc' || name === '.git-credentials') return true;
  if ((name.startsWith('id_') && !name.endsWith('.pub')) || name === '.history' || name.endsWith('_history')) return true;
  const home = resolveSafe(homedir()).toLowerCase();
  if (inside(low, home)) {
    const rel = low.slice(home.length).split(sep).filter(Boolean);
    const relPath = rel.join('/');
    for (const d of HOME_DENIED) {
      // `.claude*` also covers .claude-work and the like.
      if (d === '.claude' ? rel[0]?.startsWith('.claude') : relPath === d || relPath.startsWith(d + '/')) return true;
    }
  }
  // stam's own home holds the tokens (and every agent's): only the mail attachments in it are open.
  const stam = resolveSafe(STAM_HOME).toLowerCase();
  if (inside(low, stam) && !inside(low, join(stam, 'attachments'))) return true;
  return false;
}

function resolveSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

// A requested path as a real path inside a root, or an error. Both the path as given and its real
// target are checked against the deny list, so a harmless-looking link to a secret is refused.
export function resolveIn(requested: string, roots: string[]): string {
  const asked = resolve(expand(requested));
  if (!requested.startsWith('/') && !requested.startsWith('~')) throw new FilesError(400, 'path must be absolute');
  let real: string;
  try {
    real = realpathSync(asked);
  } catch {
    throw new FilesError(404, 'no such file');
  }
  if (!roots.some((r) => inside(real, r))) throw new FilesError(403, 'outside the allowed folders');
  if (denied(asked) || denied(real)) throw new FilesError(403, 'not available');
  return real;
}

export type Entry = { name: string; kind: 'file' | 'dir' | 'symlink'; size: number; mtime: number };

export function listRoots(roots: string[]): { roots: { path: string; name: string }[] } {
  return { roots: roots.map((path) => ({ path, name: basename(path) })) };
}

export function listDir(real: string): Entry[] {
  let names: string[];
  try {
    names = readdirSync(real);
  } catch {
    throw new FilesError(400, 'not a folder');
  }
  const out: Entry[] = [];
  for (const name of names) {
    const full = join(real, name);
    if (denied(full)) continue;
    let l: Stats;
    try {
      l = lstatSync(full);
    } catch {
      continue;
    }
    let st = l;
    if (l.isSymbolicLink()) {
      try {
        st = statSync(full);
      } catch {}
    }
    out.push({ name, kind: l.isSymbolicLink() ? 'symlink' : l.isDirectory() ? 'dir' : 'file', size: st.isDirectory() ? 0 : st.size, mtime: Math.floor(st.mtimeMs) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Streams an open file: a read that fails midway (a racing delete, an I/O error) ends the response
// and never reaches the daemon as an uncaught error.
function send(res: ServerResponse, fd: number, range?: { start: number; end: number }): void {
  const stream = createReadStream('', { fd, ...range });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

// The first bytes decide whether the file is text, and name a few binary types the extension missed.
function sniff(fd: number): { text: boolean; type?: string } {
  const buf = Buffer.alloc(SNIFF_BYTES);
  const n = readSync(fd, buf, 0, SNIFF_BYTES, 0);
  const b = buf.subarray(0, n);
  if (b.subarray(0, 4).toString('latin1') === '%PDF') return { text: false, type: 'application/pdf' };
  if (b.subarray(1, 4).toString('latin1') === 'PNG') return { text: false, type: 'image/png' };
  if (b[0] === 0xff && b[1] === 0xd8) return { text: false, type: 'image/jpeg' };
  if (b.subarray(0, 3).toString('latin1') === 'GIF') return { text: false, type: 'image/gif' };
  if (b.includes(0)) return { text: false };
  // A cut-off multi-byte character at the end of the sample isn't invalid: drop up to 3 trailing bytes.
  for (let cut = 0; cut <= 3 && cut < n; cut++) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(0, n - cut));
      return { text: true };
    } catch {}
  }
  return { text: false };
}

// Serves a file's bytes: Range, text capped at TEXT_CAP unless `all`, binaries as attachments. The file
// is opened once and everything else reads that handle; the handle's real path is checked against the
// roots and the deny list again, so a link swapped in after resolveIn can't redirect the read.
export function serve(req: IncomingMessage, res: ServerResponse, real: string, all: boolean, roots: string[]): void {
  // Non-blocking, so a FIFO planted in a root can't hang the daemon until a writer shows up; fstat then refuses it.
  const fd = openSync(real, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  let handed = false;
  try {
    try {
      const now = realpathSync(`/proc/self/fd/${fd}`);
      if (!roots.some((r) => inside(now, r)) || denied(now)) throw new FilesError(403, 'the file moved');
    } catch (e) {
      if (e instanceof FilesError) throw e;
      // No /proc (not Linux): the check made before the open stands.
    }
    const st = fstatSync(fd);
    if (!st.isFile()) throw new FilesError(400, 'not a file');
    const size = st.size;
    let type = typeByExt(real);
    const sn = sniff(fd);
    if (type.startsWith('text/') && !sn.text) type = sn.type ?? 'application/octet-stream';
    else if (type === 'application/octet-stream' && sn.text) type = 'text/plain; charset=utf-8';
    else if (type === 'application/octet-stream' && sn.type) type = sn.type;
    const isText = type.startsWith('text/');
    const head: Record<string, string | number> = { ...SAFE_HEADERS, 'content-type': type, 'x-stam-size': size };
    if (!isText && !/^(image|video|audio)\//.test(type) && type !== 'application/pdf') head['content-disposition'] = `attachment; filename="${basename(real).replace(/[^\w. -]/g, '_')}"`;
    const r = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (r && (r[1] || r[2])) {
      const start = r[1] ? Number(r[1]) : Math.max(0, size - Number(r[2]));
      const end = r[1] && r[2] ? Math.min(Number(r[2]), size - 1) : size - 1;
      if (start >= size || start > end) {
        res.writeHead(416, { 'content-range': `bytes */${size}` });
        res.end();
        return;
      }
      res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
      handed = true;
      send(res, fd, { start, end });
      return;
    }
    if (size === 0) {
      res.writeHead(200, { ...head, 'content-length': 0 });
      res.end();
      return;
    }
    if (isText && !all && size > TEXT_CAP) {
      res.writeHead(200, { ...head, 'x-stam-truncated': '1', 'content-length': TEXT_CAP });
      handed = true;
      send(res, fd, { start: 0, end: TEXT_CAP - 1 });
      return;
    }
    res.writeHead(200, { ...head, 'content-length': size });
    handed = true;
    send(res, fd);
  } finally {
    if (!handed) closeSync(fd);
  }
}
