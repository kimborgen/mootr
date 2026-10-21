// The **Open** button in a diff block's header (S-2105, PR 7 of the S-2092 redesign). The block shows it at rest — #707
// left the slot, and the design system's actions show that way — and a click opens what the block holds: the PR its info
// string names (`diff REPO#N`), or the pasted patch itself, in the diff view, landing on the file the block shows first.
// The click never reaches the mail card around it, and the button takes focus back when the reader returns to the mail
// (the view's own focus handle asks for it).
import { openDiff, openPatch } from '../files/open'
import { PATCH_MAX_BYTES, patchBytes, storePatch } from '../diff/patchStore'
import type { FileBase } from '../files/pathLinks'
import type { DiffRepo } from '../diff/diffApi'

// The Open button last clicked, for the view it sits in to hand focus back to. Taken only for a view that really holds it
// — another pane, or another thread, must not steal it — and dropped if the button has left the page (S-2105 review).
let lastOpen: HTMLElement | null = null
export const takeOpenFocus = (within: Element | null): HTMLElement | null => {
  const el = lastOpen
  lastOpen = null
  return el?.isConnected && within?.contains(el) ? el : null
}

// `REPO#N`, the shape a diff view's key takes after its `diff:`.
const FENCE = /^([^#\s]+)#([1-9]\d{0,8})$/

// The PR a fence's info string names, when the diff API serves that repo (`diff REPO#N`). Anything else — a repo the
// daemon does not serve, or no argument at all — leaves the fence a pasted patch. Nothing is inferred from a nearby link.
export function infoTarget(info: string | undefined, repos: DiffRepo[]): { repo: string; pr: number } | null {
  const m = FENCE.exec(String(info ?? '').trim())
  if (!m) return null
  const ref = { repo: m[1], pr: Number(m[2]) }
  return repos.some((r) => r.name === ref.repo) ? ref : null
}

// Wires every diff block in `el`: the button in its header, shown at rest, and what its click does. Called again when the
// writer's base or the served repos change, which only rebinds the click — the button stays where it is, so a reader who
// left it with focus keeps it. A block that can open nothing (a patch past the store's cap, with no PR its info string
// names) keeps a bare header rather than offering a dead button.
export function wireDiffOpen(el: HTMLElement, base: FileBase | null, repos: DiffRepo[]): void {
  for (const block of el.querySelectorAll<HTMLElement>('.mb-diff[data-patch]')) {
    const slot = block.querySelector<HTMLElement>('.mb-dopen')
    if (!slot) continue
    const text = block.dataset.patch ?? ''
    const target = infoTarget(block.dataset.info, repos)
    if (!target && patchBytes(text) > PATCH_MAX_BYTES) {
      slot.hidden = true
      slot.replaceChildren()
      continue
    }
    slot.hidden = false
    const button = slot.querySelector<HTMLButtonElement>('button') ?? slot.appendChild(makeButton())
    button.onclick = (e) => {
      e.stopPropagation()
      // The file the block shows first, which is the one Open lands on.
      const first = block.dataset.first || undefined
      if (target) openDiff(target.repo, target.pr, first)
      else {
        const hash = storePatch(text, base?.cwd ? { host: base.host, cwd: base.cwd } : null)
        // The browser can still refuse for room rather than for size: then there is nothing to open, and the block stays.
        if (hash) openPatch(hash, first)
      }
      lastOpen = button
    }
  }
}

function makeButton(): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'btn text mb-open'
  b.textContent = 'Open'
  b.title = 'Open this diff in the viewer'
  return b
}
