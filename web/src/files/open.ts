// Opening the file viewers (S-1526): a file in the main world like any view, and the Files world at a folder.
import { openWorld } from '../actions'
import * as shell from '../shell/layout'
import { fileKey } from './fileKey'
import { diffKey } from '../diff/diffKey'

export function openFile(host: string, path: string, line?: number): void {
  shell.open('main', fileKey(host, path, line))
}

// A PR's diff (S-1531), `diff:REPO#N`, in the main world like a file. The entry points that call it are S-1533.
export function openDiff(repo: string, pr: number): void {
  shell.open('main', diffKey(repo, pr))
}

// A click on a line number: the file view's key takes the new `#L` in place, in the same pane. The same line again changes nothing.
export function gotoLine(viewKey: string, host: string, path: string, line: number): void {
  const k = fileKey(host, path, line)
  if (k !== viewKey) shell.swap(viewKey, k)
}

// The Files world asks to browse a folder (a breadcrumb part, a `#file=` link to a folder); it reads this on mount and on each ask.
type Goto = { host: string; path: string }
let pending: Goto | null = null
const listeners = new Set<() => void>()
export const takeGoto = (): Goto | null => { const g = pending; pending = null; return g }
export const onGoto = (fn: () => void): (() => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
export function openFiles(host?: string, path?: string): void {
  pending = host && path ? { host, path } : null
  openWorld('files')
  // A file tab may be on top in that world: bring the Files tab back (or make it, if it was closed).
  shell.open('main', 'files')
  for (const fn of listeners) fn()
}
