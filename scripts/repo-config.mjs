// A repo's merge flow as config (S-2202): `.stam/repo.json` in the target repo says which GitHub repo it is, its main
// branch, the gates a PR runs (a command each, picked by a path glob or by name in the PR body's Gates: line), the
// statuses a merge needs, how it merges and what deploys it. The shipped gate and merge scripts read it, so a user changes
// their flow by editing this file, not stam.
// The file is read from a commit (the base branch), never from the working tree or the PR head: a PR can't change the
// gates or the statuses its own merge needs. A settings fallback (`itsa.repoConfig[REPO]`) fills what the file leaves out.
import { spawnSync } from 'node:child_process';
import { matchesGlob } from 'node:path';

export const CONFIG_PATH = '.stam/repo.json';
export const GATES_CONTEXT = 'stam/gates';
export const DEFAULTS = Object.freeze({
  github: null,
  mainBranch: 'main',
  branchPrefix: 'stam/',
  gates: [],
  requiredStatuses: ['stam/review'],
  merge: { method: 'merge', command: null },
  deploy: null,
  home: null,
});
const METHODS = ['merge', 'squash', 'rebase'];
// Gates: tokens with their own meaning, so no gate may take the name.
const RESERVED = ['none', 'auto'];
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const GITHUB = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH = /^[A-Za-z0-9._/-]+$/;
// The largest config file read; a bigger blob is refused, never taken for a missing one.
export const MAX_CONFIG_BYTES = 256 * 1024;

export class RepoConfigError extends Error {}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

// Why GLOB isn't a supported path glob, or null when it is. Supported, matched against a repo-relative path by
// path.matchesGlob: `*` (within a segment), `**` (across segments), `?`, a class `[abc]`, `[a-z]` or `[!a]`, and one
// level of `{a,b}`. Refused: an empty glob, a leading `/`, a `.` or `..` segment, a backslash, an unclosed or empty
// class, a nested or unclosed brace, and a stray `]` or `}`.
export function globError(glob) {
  if (!nonEmpty(glob)) return 'is empty';
  if (glob.startsWith('/')) return 'starts with /; paths are repo-relative';
  if (glob.includes('\\')) return 'has a backslash';
  if (glob.split('/').some((seg) => seg === '.' || seg === '..')) return 'has a . or .. segment';
  let brace = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '[') {
      let j = i + 1;
      if (glob[j] === '!' || glob[j] === '^') j++;
      // The class ends at the first `]`, so `[]` and `[!]` are empty.
      const close = glob.indexOf(']', j);
      if (close < 0) return 'has an unclosed [ class';
      if (close === j) return 'has an empty [] class';
      if (/[[/]/.test(glob.slice(j, close))) return 'has a [ class holding [ or /';
      i = close;
    } else if (c === ']') return 'has a ] with no [';
    else if (c === '{') {
      if (brace) return 'nests { braces';
      brace = true;
    } else if (c === '}') {
      if (!brace) return 'has a } with no {';
      brace = false;
    }
  }
  if (brace) return 'has an unclosed { brace';
  return null;
}

// Checks a parsed config and returns it with every default filled in. `partial` skips the defaults (a settings
// fallback is checked alone, then merged). Throws RepoConfigError naming every problem, prefixed by `source`.
export function validateRepoConfig(raw, source = CONFIG_PATH, partial = false) {
  const errors = [];
  if (!isObject(raw)) throw new RepoConfigError(`${source}: must be a JSON object`);
  for (const key of Object.keys(raw)) if (!Object.hasOwn(DEFAULTS, key)) errors.push(`unknown key ${key}`);
  const out = {};
  const has = (k) => Object.hasOwn(raw, k);
  if (has('github')) {
    if (raw.github !== null && !(typeof raw.github === 'string' && GITHUB.test(raw.github))) errors.push('github must be OWNER/NAME or null');
    else out.github = raw.github;
  }
  for (const k of ['mainBranch', 'branchPrefix']) {
    if (!has(k)) continue;
    const v = raw[k];
    const ok = typeof v === 'string' && (k === 'branchPrefix' ? v === '' || BRANCH.test(v) : BRANCH.test(v) && !v.startsWith('-'));
    if (ok) out[k] = v;
    else errors.push(`${k} must be a branch name${k === 'branchPrefix' ? ' prefix' : ''}`);
  }
  if (has('gates')) {
    if (!Array.isArray(raw.gates)) errors.push('gates must be a list');
    else {
      const seen = new Set();
      out.gates = raw.gates.map((g, i) => {
        const at = `gates[${i}]`;
        if (!isObject(g)) return void errors.push(`${at} must be an object`);
        for (const key of Object.keys(g)) if (!['name', 'command', 'when'].includes(key)) errors.push(`${at}: unknown key ${key}`);
        if (!(typeof g.name === 'string' && NAME.test(g.name))) errors.push(`${at}: name must be letters, digits, _ and -`);
        else if (RESERVED.includes(g.name)) errors.push(`${at}: name ${g.name} is reserved`);
        else if (seen.has(g.name)) errors.push(`${at}: name ${g.name} is used twice`);
        else seen.add(g.name);
        if (!nonEmpty(g.command)) errors.push(`${at}: command must be a non-empty string`);
        // No `when` runs the gate on every PR; a glob or list of globs runs it when a changed path matches one, and an
        // empty list only when the Gates: line names it.
        const when = g.when === undefined || g.when === null ? null : Array.isArray(g.when) ? g.when : [g.when];
        if (when && !when.every((w) => typeof w === 'string')) errors.push(`${at}: when must be a path glob, a list of them, or null`);
        else for (const w of when ?? []) {
          const why = globError(w);
          if (why) errors.push(`${at}: when glob ${JSON.stringify(w)} ${why}`);
        }
        return { name: g.name, command: g.command, when };
      });
    }
  }
  if (has('requiredStatuses')) {
    if (Array.isArray(raw.requiredStatuses) && raw.requiredStatuses.every(nonEmpty)) out.requiredStatuses = [...raw.requiredStatuses];
    else errors.push('requiredStatuses must be a list of status contexts');
  }
  if (has('merge')) {
    const m = raw.merge;
    if (!isObject(m)) errors.push('merge must be an object');
    else {
      for (const key of Object.keys(m)) if (!['method', 'command'].includes(key)) errors.push(`merge: unknown key ${key}`);
      if (m.method !== undefined && !METHODS.includes(m.method)) errors.push(`merge.method must be one of ${METHODS.join(', ')}`);
      if (m.command !== undefined && m.command !== null && !nonEmpty(m.command)) errors.push('merge.command must be a non-empty string or null');
      out.merge = { ...(m.method !== undefined ? { method: m.method } : {}), ...(m.command !== undefined ? { command: m.command } : {}) };
    }
  }
  for (const k of ['deploy', 'home']) {
    if (!has(k)) continue;
    if (raw[k] === null || nonEmpty(raw[k])) out[k] = raw[k];
    else errors.push(`${k} must be a non-empty string or null`);
  }
  if (errors.length) throw new RepoConfigError(`${source}: ${errors.join('; ')}`);
  return partial ? out : withDefaults(out);
}

// The config with each key the file left out taken from `fallback`, then the defaults. `merge` merges per field.
function withDefaults(file, fallback = {}) {
  const out = { ...DEFAULTS, ...fallback, ...file };
  out.merge = { ...DEFAULTS.merge, ...fallback.merge, ...file.merge };
  out.gates = out.gates.map((g) => ({ ...g, when: g.when && [...g.when] }));
  out.requiredStatuses = [...out.requiredStatuses];
  return out;
}

function gitOut(repo, args, what) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: MAX_CONFIG_BYTES * 2 });
  if (r.status !== 0 || r.error) throw new RepoConfigError(`${what}: ${(r.stderr || r.error?.message || `git exit ${r.status}`).trim()}`);
  return r.stdout;
}

// The file's text at REF (a commit, branch or tag) of the git repo at REPO, or null only when the commit's tree has no
// entry at that path. Every other outcome throws RepoConfigError: an unknown ref, an entry that isn't a plain file, a
// blob over MAX_CONFIG_BYTES, and a blob git can't read (a missing or corrupt object), so a failed read never passes
// for "no config" and drops the gates and statuses.
export function configText(repo, ref) {
  const commit = gitOut(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], `${repo}: no commit ${ref}`).trim();
  const entry = gitOut(repo, ['ls-tree', '-z', commit, '--', CONFIG_PATH], `${CONFIG_PATH} at ${ref}: can't list the tree`);
  if (entry === '') return null;
  const [mode, type, oid] = entry.split('\t')[0].split(' ');
  if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw new RepoConfigError(`${CONFIG_PATH} at ${ref}: not a plain file (${type} ${mode})`);
  const size = Number(gitOut(repo, ['cat-file', '-s', oid], `${CONFIG_PATH} at ${ref}: can't read blob ${oid}`).trim());
  if (!(size <= MAX_CONFIG_BYTES)) throw new RepoConfigError(`${CONFIG_PATH} at ${ref}: ${size} bytes, over the ${MAX_CONFIG_BYTES}-byte limit`);
  return gitOut(repo, ['cat-file', 'blob', oid], `${CONFIG_PATH} at ${ref}: can't read blob ${oid}`);
}

// The repo's config at REF, with `fallback` (settings.itsa.repoConfig[NAME], or null) under it; null when neither the
// commit has the file nor a fallback is given. Throws RepoConfigError for a file or fallback that doesn't parse or check.
export function readRepoConfig(repo, ref, fallback = null) {
  const fb = fallback == null ? null : validateRepoConfig(fallback, 'settings itsa.repoConfig', true);
  const text = configText(repo, ref);
  if (text === null) return fb ? withDefaults({}, fb) : null;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new RepoConfigError(`${CONFIG_PATH} at ${ref}: not JSON: ${e.message}`);
  }
  return withDefaults(validateRepoConfig(raw, `${CONFIG_PATH} at ${ref}`, true), fb ?? {});
}

// The gate names a PR body's Gates: line asks for, beside the ones the config runs anyway: [] for `auto` or `none`, which
// mean the same here (the body format keeps `none`). Throws RepoConfigError
// for a missing line, an empty one, `none` beside other tokens, or a name the config has no gate for.
export function parseRepoGates(body, config) {
  const line = String(body ?? '').split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith('Gates:'));
  if (line === undefined) throw new RepoConfigError('the PR body has no Gates: line');
  const items = line.slice('Gates:'.length).split(';').map((s) => s.trim()).filter(Boolean);
  if (items.length === 0) throw new RepoConfigError('the Gates: line names no gates; write Gates: auto or Gates: none');
  if (items.includes('none') && items.length > 1) throw new RepoConfigError('Gates: none stands alone; drop the other gates');
  const names = items.filter((i) => !RESERVED.includes(i));
  const known = new Set(config.gates.map((g) => g.name));
  const unknown = names.filter((n) => !known.has(n));
  if (unknown.length) {
    const have = known.size ? `; ${CONFIG_PATH} has ${[...known].join(', ')}` : `; ${CONFIG_PATH} has no gates`;
    throw new RepoConfigError(`unknown gate${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}${have}`);
  }
  return [...new Set(names)];
}

// The gates a PR runs, in config order: each one with no `when`, each one named in `named`, and each whose `when` glob
// matches one of the changed `paths`.
export function selectGates(config, named, paths) {
  const want = new Set(named);
  return config.gates.filter((g) => !g.when || want.has(g.name) || g.when.some((glob) => paths.some((p) => matchesGlob(p, glob))));
}
