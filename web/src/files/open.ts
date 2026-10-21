// Opening the file viewers (S-1526): a file in the main world like any view, and the Files world at a folder.
import { openWorld } from '../actions'
import * as shell from '../shell/layout'
import { fileKey } from './fileKey'
import { diffKey, patchKey } from '../diff/diffKey'

export function openFile(host: string, path: string, line?: number): void {
  shell.open('main', fileKey(host, path, line))
}

// A PR's diff (S-1531), `diff:REPO#N`, in the main world like a file. The entry points that call it are S-1533.
export function openDiff(repo: string, pr: number, path?: string): void {
  const key = diffKey(repo, pr)
  land(key, path)
  shell.open('main', key)
}

// A pasted patch (S-2103/S-2105), `patch:HASH`, in the main world. `path` is the file to land on, when the caller knows
// which one the reader was looking at.
export function openPatch(hash: string, path?: string): void {
  const key = patchKey(hash)
  land(key, path)
  shell.open('main', key)
}

// The file a diff view should land on (S-2105): `openDiff`/`openPatch` set it and tell every diff view, so a tab that is
// already open lands in place, where `shell.open` alone would only bring it forward; the view whose key it names clears
// it once it has handled it.
let landing: { key: string; path: string } | null = null
const gotoListeners = new Set<() => void>()
// Told when a landing is set, so a diff view can look for its own (S-2105 review).
export function onDiffGoto(fn: () => void): () => void {
  gotoListeners.add(fn)
  return () => { gotoListeners.delete(fn) }
}
const land = (key: string, path?: string): void => {
  landing = path ? { key, path } : null
  if (landing) for (const fn of gotoListeners) fn()
}
// The landing waiting for `key`, or null. The view clears it with `clearDiffGoto` once it has jumped, or once its list is
// in without that file, so a landing never sits waiting to jump the view later, on a retry.
export const peekDiffGoto = (key: string): string | null => (landing?.key === key ? landing.path : null)
export const clearDiffGoto = (key: string): void => { if (landing?.key === key) landing = null }

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
