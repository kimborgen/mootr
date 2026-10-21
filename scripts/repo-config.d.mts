// Types for repo-config.mjs, which src/pr-open.ts imports (S-2202). The script is plain JS run by node.
export interface RepoGate {
  name: string;
  command: string;
  // null: every PR; a list: a changed path matches one; []: only when the Gates: line names it.
  when: string[] | null;
}
export interface RepoConfig {
  github: string | null;
  mainBranch: string;
  branchPrefix: string;
  gates: RepoGate[];
  requiredStatuses: string[];
  merge: { method: 'merge' | 'squash' | 'rebase'; command: string | null };
  deploy: string | null;
  home: string | null;
}
export const CONFIG_PATH: string;
export class RepoConfigError extends Error {}
// The config at REF of the repo at REPO with the settings fallback under it; null when neither exists.
export function readRepoConfig(repo: string, ref: string, fallback?: Record<string, unknown> | null): RepoConfig | null;
// The gate names the body's Gates: line asks for; throws RepoConfigError for a line it refuses.
export function parseRepoGates(body: string | null | undefined, config: RepoConfig): string[];
