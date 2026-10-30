// One build in flight per key, shared by the reads that arrive while it runs (S-4356). A web refresh asks for the
// human's active, archived and deferred threads at once, and each answer came from its own build of the same whole
// list. Nothing is kept once a build settles, so a mail stored on a peer is in the next read as before. A read joins
// only a build that started under the same mark: any write since (src/db.ts changeMark, or a write request this
// daemon handled) starts a new build, so a read after the human answers never gets lists from before the answer.
export interface SharedBuild<T> {
  get(key: string, build: () => Promise<T>): Promise<T>;
  size(): number;
}

export function createSharedBuild<T>(mark: () => string): SharedBuild<T> {
  const running = new Map<string, { mark: string; run: Promise<T> }>();
  return {
    get(key, build) {
      const m = mark();
      const have = running.get(key);
      if (have && have.mark === m) return have.run;
      const run: Promise<T> = build().finally(() => {
        if (running.get(key)?.run === run) running.delete(key);
      });
      running.set(key, { mark: m, run });
      return run;
    },
    size: () => running.size,
  };
}

// The write requests a daemon takes, counted when each starts and again when its handler completes, with success or an
// error. A write forwarded to a peer writes nothing here, so the database's mark alone can't see it; and a build that
// starts while the write is pending reads the old state under the count the start left, so the completion must move
// the count again before any read can join that build. The response's close is not the completion: a client that
// disconnects leaves the handler awaiting its peer write.
export interface WriteCount {
  begin(): () => void;
  mark(): string;
}

export function createWriteCount(): WriteCount {
  let n = 0;
  return {
    begin() {
      n++;
      let settled = false;
      return () => {
        if (settled) return;
        settled = true;
        n++;
      };
    },
    mark: () => String(n),
  };
}

// A request handler that counts its write requests (any method but GET and HEAD) in `count`: at the start, and when the
// handler's promise settles.
export function countingWrites<Req extends { method?: string }, Res>(count: WriteCount, handler: (req: Req, res: Res) => Promise<unknown>): (req: Req, res: Res) => Promise<unknown> {
  return (req, res) => {
    if (req.method === 'GET' || req.method === 'HEAD') return handler(req, res);
    const settle = count.begin();
    return handler(req, res).finally(settle);
  };
}

// The key of one mailbox list read: the whole caller (its kind, agent, boss and assistant marks, scope, review role)
// and every argument the build reads, so a read never gets a list built for another reader or another page.
export function boxThreadsKey(reader: object, args: { box: string; limit: number; withId?: string; via?: object; viaDecisions?: object }): string {
  return JSON.stringify({ reader, box: args.box, limit: args.limit, withId: args.withId ?? null, via: args.via ?? null, viaDecisions: args.viaDecisions ?? null });
}
