import { useEffect, useState } from 'react'
import { isPhone } from '../decl/DeclPicker'

// The code viewers' text size and wrap, remembered per viewer: the file view's CodeView and the diff view (S-1531) share them.
// The text sizes, as existing type tokens: chrome 11, 12, 13, 14 and 16 px, then the document body size (17 px).
export const SIZES = ['--type-chrome-xs', '--type-chrome-sm', '--type-chrome-md', '--type-chrome-lg', '--type-chrome-xl', '--doc-size-body']
const DEFAULT_SIZE = '--type-chrome-md'
const SIZE_KEY = 'stam.codeview.size', WRAP_KEY = 'stam.codeview.wrap'

const read = (key: string): string | null => { try { return localStorage.getItem(key) } catch { return null } }
const write = (key: string, v: string) => { try { localStorage.setItem(key, v) } catch { /* private window */ } }
const startSize = () => { const n = read(SIZE_KEY); return n && SIZES.includes(n) ? n : DEFAULT_SIZE }
// Wrap starts on at a phone width (S-2103): a file or a patch reads better wrapped on a phone, and the toggle keeps the
// reader's own choice from then on. The query is the viewers' own (`isPhone`), so a desktop pane is never forced.
const startWrap = (): boolean => { const v = read(WRAP_KEY); return v === null ? isPhone() : v === '1' }

export interface CodePrefs { size: string; wrap: boolean; setWrap: (f: (w: boolean) => boolean) => void; step: (d: number) => void }

export function useCodePrefs(): CodePrefs {
  const [size, setSize] = useState(startSize)
  const [wrap, setWrap] = useState(startWrap)
  useEffect(() => { write(WRAP_KEY, wrap ? '1' : '0') }, [wrap])
  useEffect(() => { write(SIZE_KEY, size) }, [size])
  const step = (d: number) => setSize(s => SIZES[Math.min(SIZES.length - 1, Math.max(0, SIZES.indexOf(s) + d))])
  return { size, wrap, setWrap, step }
}

// The Wrap toggle and the text-size pair, in the toolbar of whichever viewer uses them.
export function CodePrefButtons({ prefs }: { prefs: CodePrefs }) {
  const at = SIZES.indexOf(prefs.size)
  return (
    <>
      <button type="button" aria-pressed={prefs.wrap} onClick={() => prefs.setWrap(w => !w)}>Wrap</button>
      <span className="codeview-size">
        <button type="button" aria-label="Smaller text" disabled={at <= 0} onClick={() => prefs.step(-1)}>A−</button>
        <button type="button" aria-label="Larger text" disabled={at >= SIZES.length - 1} onClick={() => prefs.step(1)}>A+</button>
      </span>
    </>
  )
}
