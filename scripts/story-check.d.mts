// Types for story-check.mjs, which src/pr-open.ts imports (S-914). The script is plain JS run by node.
export function storiesUnchangedLine(body: string | null | undefined): string | undefined;
export function storiesUnchanged(body: string | null | undefined): boolean;
export const STORIES_FORM: string;
export function checkRange(base: string, head: string, opts?: { cwd?: string; body?: string; mode?: string }): string[];
export function checkRangeAsync(base: string, head: string, opts?: { cwd?: string; body?: string; mode?: string; timeoutMs?: number }): Promise<string[]>;
