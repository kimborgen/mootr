// Types for deps-lock.mjs, which src/deploy.ts imports (S-1965). The script is plain JS run by node.
export const LOCK_NAME: string;
export const GONE: number;
export const NODEPS: number;
export function linkLocked(root: string, entry: string, target: string): number;
export function linkLockedAsync(root: string, entry: string, target: string): Promise<number>;
export function tryExclusive(root: string): { release: () => void } | null;
