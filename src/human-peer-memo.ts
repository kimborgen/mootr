// The peer fan-out behind the human's lists (S-4356): every load of the human's threads asked each peer for
// its decisions and attention, so a page that polls paid the round trips again and again. Each answer is
// kept for TTL_MS per caller, concurrent loads share one fan-out, and any write this daemon makes (or
// sends a peer) drops the memo, so an answered ask never comes back from the memo.
export const HUMAN_PEER_TTL_MS = 5_000;
// Callers kept: each is the via of one reader (the human, an OpenCode server, an agent); the oldest go past this.
const MEMO_KEYS = 16;

interface Entry<T> {
  at: number;
  value?: T;
  run?: Promise<T>;
  gen: number;
}

export interface HumanPeerMemo<T> {
  get(key: string, load: () => Promise<T>, now?: number): Promise<T>;
  invalidate(): void;
  size(): number;
}

// `keep` says whether an answer may be kept: a partial one (a peer that didn't answer) is handed to its callers, not kept.
export function createHumanPeerMemo<T>(ttlMs = HUMAN_PEER_TTL_MS, keep: (value: T) => boolean = () => true): HumanPeerMemo<T> {
  const memo = new Map<string, Entry<T>>();
  // Bumped by invalidate(): a load that started before a write must not store its (older) answer.
  let gen = 0;
  return {
    get(key, load, now = Date.now()) {
      const have = memo.get(key);
      if (have?.value !== undefined && now - have.at < ttlMs) return Promise.resolve(have.value);
      if (have?.run && have.gen === gen) return have.run;
      const started = gen;
      const entry: Entry<T> = { at: now, gen: started };
      entry.run = load().then(
        (value) => {
          if (started === gen && keep(value)) {
            entry.value = value;
            entry.at = now;
          } else if (memo.get(key) === entry) memo.delete(key);
          entry.run = undefined;
          return value;
        },
        (e) => {
          if (memo.get(key) === entry) memo.delete(key);
          entry.run = undefined;
          throw e;
        },
      );
      memo.set(key, entry);
      while (memo.size > MEMO_KEYS) memo.delete(memo.keys().next().value!);
      return entry.run;
    },
    invalidate() {
      gen++;
      memo.clear();
    },
    size: () => memo.size,
  };
}
