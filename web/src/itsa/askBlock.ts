// The blocking line of an ask on the human (S-351): what the ask holds, and which agents it
// stops. One definition for the Mail row, the thread's ask bar and the ITSA's header, so they
// agree. An ask is a mail thread. It holds an ITSA in a human status when that ITSA's ask is in
// the thread. It stops an agent only when the agent is tied to the thread: a declared human wait
// whose `thread` is it, or a pending permission dialog in it (S-276). A plain permission request
// leaves its agent a threadless wait while the agent keeps working, so it never counts. Nothing
// else counts, so the line never claims more than the waits say.
import type { Data } from '../store'

export interface AskBlock {
  // The keys of the ITSAs in a human status whose ask is this thread.
  holds: string[]
  // The names of the agents this thread's ask stops.
  stopped: string[]
}

export function askBlock(
  thread: string | null | undefined,
  { attention, agents, perms }: Pick<Data, 'attention' | 'agents' | 'perms'>,
  permThread: (permId: string) => string | undefined,
): AskBlock {
  if (!thread) return { holds: [], stopped: [] }
  const holds = attention.filter((x) => x.ask_thread_id === thread).map((x) => x.key)
  const stopped = agents
    .filter((a) =>
      (a.waits ?? []).some((w) => w.kind === 'human' && w.thread === thread) ||
      perms.some((p) => p.agent_id === a.id && p.status === 'pending' && !!p.dialog && permThread(p.id) === thread))
    .map((a) => a.name)
  return { holds, stopped }
}

// The line's words, or '' when the ask holds and stops nothing. `short` is the Mail row's
// suffix: only who is stopped, since the row already shows the ITSA's key.
export function askBlockText({ holds, stopped }: AskBlock, short = false): string {
  if (short) return stopped.map((n) => `@${n} stopped`).join(' · ')
  return [...holds.map((k) => `Holds ${k}`), ...stopped.map((n) => `@${n} is stopped until you answer`)].join(' · ')
}
