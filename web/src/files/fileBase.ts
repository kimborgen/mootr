// Where a relative path in rendered text resolves (S-1529): the agent whose writing it is, on its machine, in its cwd.
// A view that shows one agent's writing provides it (OwnView), so every Rendered inside needs no prop; a mail card
// passes its sender's through `Rendered`'s `base`. With none, the host is the machine this page talks to and a relative path stays text.
import { createContext, useContext } from 'react'
import { byId, useData } from '../store'
import type { FileBase } from './pathLinks'

const Ctx = createContext<FileBase | null>(null)
export const FileBaseCtx = Ctx

// The base of an agent (its machine and cwd), or null when it isn't in the registry.
export const agentBase = (id: string | null | undefined): FileBase | null => {
  const a = byId(id)
  return a?.machine ? { host: a.machine, cwd: a.cwd || undefined } : null
}

// `override` undefined: the enclosing provider's base. null: no base (the sender is unknown), so a relative path stays text and the
// provider's agent is not borrowed.
export function useFileBase(override?: FileBase | null): FileBase {
  const ctx = useContext(Ctx)
  const { machine } = useData()
  const none = { host: machine || 'localhost' }
  return override !== undefined ? override ?? none : ctx ?? none
}
