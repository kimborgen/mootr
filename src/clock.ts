// The daemon's clock (S-3468): Date.now() unless a test sets another. Notices and the agent route's `now` read it, so a
// test can fix the time; the Go daemon has the same clock in go/internal/clock.
let clock = (): number => Date.now();

export const nowMs = (): number => clock();

// Sets the clock, or restores the real one with null (tests only).
export function setClock(fn: (() => number) | null): void {
  clock = fn ?? ((): number => Date.now());
}
