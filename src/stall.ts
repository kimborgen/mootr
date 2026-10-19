// Event-loop stall watch (S-322). Labelled synchronous calls (timed) are measured on their own: a call's
// time, less the labelled calls nested in it, is its exclusive time, logged under its label when it is over
// the threshold. A 10 ms timer checks how late it fires; the lateness that no labelled call accounts for
// is logged as unlabelled. A request's label covers only its synchronous part, so an awaiting request is
// never blamed for another's block.
import { PerformanceObserver } from 'node:perf_hooks';

const TICK_MS = 10;
const KEEP = 20;
const EVERY_MS = 10_000;
// The GC entries kept for matching against a stall (a stall's line says which GC overlapped it).
const GC_KEEP = 8;
// V8's GC kinds (node's perf_hooks constants): major, minor, incremental marking, weak callbacks.
const GC_KINDS: Record<number, string> = { 1: 'minor', 4: 'major', 8: 'incremental', 16: 'weak' };

export interface Stall {
  at: string;
  ms: number;
  label: string;
}

export class StallMeter {
  threshold = Infinity;
  readonly recent: Stall[] = [];
  // Time of labelled calls nested in the call now running, so the outer call logs only its own.
  private childMs = 0;
  // Since the last tick: the exclusive time of the calls logged as stalls, and of the shorter ones,
  // counted by label so a run of them can be named.
  private recordedMs = 0;
  private shortMs = 0;
  private shortN = 0;
  // Per label, the short calls' ms and count in the current window: the lines name the top three.
  private readonly shortBy = new Map<string, { ms: number; n: number }>();
  private lastTick: number;
  private suppressed = 0;
  private lastLine = -Infinity;
  private gcs: { start: number; end: number; kind: string }[] = [];
  // Where the GC entries come from: the observer's buffer, read with takeRecords. Its entries arrive
  // asynchronously, after the block that logs a stall, so they're drained before each line.
  gcSource: { takeRecords(): GcEntry[] } | null = null;
  // Runs the GC part of a line later. perf_hooks queues GC entries in the check phase, so a line that
  // waits for them is written from a setImmediate (only when there's a gcSource).
  defer: (fn: () => void) => void = (fn) => {
    setImmediate(fn);
  };

  private readonly write: (line: string) => void;
  private readonly now: () => number;

  constructor(write: (line: string) => void, now: () => number = () => performance.now()) {
    this.write = write;
    this.now = now;
    this.lastTick = now();
  }

  timed<T>(label: string, fn: () => T): T {
    const outerChild = this.childMs;
    this.childMs = 0;
    const t0 = this.now();
    try {
      return fn();
    } finally {
      const d = this.now() - t0;
      const own = d - this.childMs;
      this.childMs = outerChild + d;
      if (own >= this.threshold) {
        this.recordedMs += own;
        this.log(own, label, t0, d + t0);
      } else {
        this.shortMs += own;
        this.shortN++;
        const by = this.shortBy.get(label) ?? { ms: 0, n: 0 };
        by.ms += own;
        by.n++;
        this.shortBy.set(label, by);
      }
    }
  }

  // The timer's check: the lateness since the last tick, less the stalls already logged. If the rest is
  // over the threshold, it is named for the short calls that ran in the window when they explain it,
  // and 'unlabelled' otherwise.
  tick(now: number): void {
    const rest = now - this.lastTick - TICK_MS - this.recordedMs;
    if (rest >= this.threshold) {
      if (this.shortN > 0 && this.shortMs >= rest) {
        // The three labels with the most ms, each with its ms and call count: "a 60 ms/3, b 40 ms/4, c 20 ms/1".
        const top = [...this.shortBy]
          .sort((x, y) => y[1].ms - x[1].ms)
          .slice(0, 3)
          .map(([label, by]) => `${label} ${Math.round(by.ms)} ms/${by.n}`)
          .join(', ');
        this.log(rest, `many short calls (n=${this.shortN}, top: ${top})`, this.lastTick, now);
      } else this.log(rest, 'unlabelled', this.lastTick, now);
    }
    this.lastTick = now;
    this.recordedMs = 0;
    this.shortMs = 0;
    this.shortN = 0;
    this.shortBy.clear();
  }

  // A GC entry from the perf_hooks observer (startStallWatch): its window and kind, the last few kept.
  drainGc(): void {
    for (const e of this.gcSource?.takeRecords() ?? []) this.noteGc(e);
  }

  noteGc(e: GcEntry): void {
    this.gcs.push({ start: e.startTime, end: e.startTime + e.duration, kind: GC_KINDS[e.detail?.kind ?? 0] ?? 'gc' });
    if (this.gcs.length > GC_KEEP) this.gcs.shift();
  }

  // Every stall is kept for the health route; the log line is rate-limited to one per EVERY_MS, and
  // the stalls between lines are counted into the next one.
  private log(ms: number, label: string, start: number, end: number): void {
    this.drainGc();
    this.recent.push({ at: new Date().toISOString(), ms: Math.round(ms), label });
    if (this.recent.length > KEEP) this.recent.shift();
    const t = this.now();
    if (t - this.lastLine < EVERY_MS) {
      this.suppressed++;
      return;
    }
    const more = this.suppressed ? ` (${this.suppressed} more since the last line)` : '';
    // The line carries its own time: daemon.log's other lines have none.
    const text = `${new Date().toISOString()} event loop stalled ${Math.round(ms)} ms during ${label}`;
    this.lastLine = t;
    this.suppressed = 0;
    // The GC that overlapped the stall, if any: its time and kinds, so a stall in a big heap shows as one.
    const emit = () => {
      this.drainGc();
      const over = this.gcs.filter((g) => g.end >= start && g.start <= end);
      const gc = over.length ? ` (gc ${Math.round(over.reduce((n, g) => n + g.end - g.start, 0))} ms, ${[...new Set(over.map((g) => g.kind))].join(', ')})` : '';
      this.write(text + gc + more);
    };
    if (this.gcSource) this.defer(emit);
    else emit();
  }
}

export const stalls = new StallMeter((line) => console.error(line));

// A GC entry as the perf_hooks observer reports it.
interface GcEntry {
  startTime: number;
  duration: number;
  detail?: { kind?: number };
}

export function timed<T>(label: string, fn: () => T): T {
  return stalls.timed(label, fn);
}

// Starts the timer that measures the loop. It fires every TICK_MS and allocates nothing per tick.
const watched = new WeakSet<StallMeter>();
export function startStallWatch(thresholdMs: number, meter: StallMeter = stalls): void {
  meter.threshold = thresholdMs;
  // One timer and one observer per meter, however often this is called.
  if (watched.has(meter)) return;
  watched.add(meter);
  const observer = new PerformanceObserver(() => meter.drainGc());
  observer.observe({ entryTypes: ['gc'] });
  meter.gcSource = observer;
  setInterval(() => meter.tick(performance.now()), TICK_MS).unref();
}
