import type { ServerResponse } from 'node:http';
import { schedulePush } from './mail.ts';

// Live push streams, one per connected `stam mcp` shim.
const streams = new Map<string, Set<ServerResponse>>();

export function addStream(agentId: string, res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write(': connected\n\n');
  let set = streams.get(agentId);
  if (!set) streams.set(agentId, (set = new Set()));
  set.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  res.on('close', () => {
    clearInterval(ping);
    set!.delete(res);
  });
  schedulePush(agentId);
}

export function hasStream(agentId: string): boolean {
  return (streams.get(agentId)?.size ?? 0) > 0;
}

export function streamPush(agentId: string, content: string, meta: Record<string, string>): boolean {
  const set = streams.get(agentId);
  if (!set?.size) return false;
  const data = JSON.stringify({ content, meta });
  for (const res of set) res.write(`data: ${data}\n\n`);
  return true;
}

