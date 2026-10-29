// Which web pages are live (S-1626's image tabs). A page is one page load, named by its id in the
// `x-stam-page` header of its layout stream. It is live while it holds a stream, and for PAGE_GRACE after
// its last one closed, which a reload's reconnect beats. A page this daemon hasn't seen since it started
// counts as seen at the start, so after a restart the pages get PAGE_GRACE to reconnect (their backoff is
// at most 10 s). Time comes in as `now`, so a test can drive it.
export const PAGE_GRACE = 60_000;

export class PageLiveness {
  private streams = new Map<string, number>();
  private lastSeen = new Map<string, number>();
  private started: number;
  constructor(started: number) { this.started = started; }

  open(page: string): void {
    this.streams.set(page, (this.streams.get(page) ?? 0) + 1);
  }
  close(page: string, now: number): void {
    const left = (this.streams.get(page) ?? 0) - 1;
    if (left > 0) this.streams.set(page, left);
    else { this.streams.delete(page); this.lastSeen.set(page, now); }
  }
  live(page: string, now: number): boolean {
    return (this.streams.get(page) ?? 0) > 0 || now - (this.lastSeen.get(page) ?? this.started) < PAGE_GRACE;
  }
  // Forgets the pages whose grace is over. A page with an open stream is never forgotten. A forgotten page
  // counts as seen at the start, which is no later than its last close, so it is still dead.
  prune(now: number): void {
    for (const [page, t] of this.lastSeen) if (!this.streams.has(page) && now - t >= PAGE_GRACE) this.lastSeen.delete(page);
  }
  // The pages this keeps a record of, for tests.
  get size(): number {
    return this.streams.size + this.lastSeen.size;
  }
}
