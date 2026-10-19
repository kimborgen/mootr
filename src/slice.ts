// Sliced synchronous work (S-2094). A heavy report is written as a generator that yields where it can
// pause (`if (due()) yield`); one driver runs it whole (tests, the CLI), the other runs a slice, then
// hands the event loop back with setImmediate, so no slice blocks a request for longer than SLICE_MS.
export const SLICE_MS = 10;

let sliceStart = performance.now();
// True once the running slice has used its time.
export const due = (): boolean => performance.now() - sliceStart >= SLICE_MS;

export function runSync<T>(g: Generator<void, T>): T {
  // A whole run never pauses; the sliced driver sets its own start again before each slice.
  sliceStart = Infinity;
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

// `wrap` runs each slice: the stall watch labels it (timed), a bench or test measures it.
export async function runSliced<T>(g: Generator<void, T>, wrap: <R>(fn: () => R) => R = (fn) => fn()): Promise<T> {
  for (;;) {
    sliceStart = performance.now();
    const r = wrap(() => g.next());
    if (r.done) return r.value;
    await new Promise<void>((res) => setImmediate(res));
  }
}
