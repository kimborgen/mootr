// The saved views as a tab strip over the Work table (S-1517): Default first, then each saved view in
// the order it was saved. One click switches; a dot marks the current view when it was edited after it
// was saved (Save and Revert are in the View menu). The strip scrolls sideways when the views don't fit.
import type { SavedView } from './views'

export function ViewTabs({ views, current, dirty, onPick }: { views: Pick<SavedView, 'id' | 'name'>[]; current: string; dirty: boolean; onPick: (id: string) => void }) {
  return <div className="w-tabs" role="tablist" aria-label="Saved views">
    {[{ id: '', name: 'Default' }, ...views].map((v) => {
      const on = v.id === current
      return <button key={v.id} type="button" role="tab" className={'w-tab' + (on ? ' on' : '')} data-view={v.id} aria-selected={on} tabIndex={on ? 0 : -1}
        onClick={() => { if (!on) onPick(v.id) }}
        onKeyDown={(e) => {
          const tabs = [...e.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>('[role=tab]')]
          const at = tabs.indexOf(e.currentTarget)
          const to = e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowLeft' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1
          if (to < 0) return
          e.preventDefault()
          tabs[(to + tabs.length) % tabs.length].focus()
        }}>
        <span className="w-tname">{v.name}</span>
        {on && dirty ? <span className="w-tdot" role="img" aria-label="Edited since saved" /> : null}
      </button>
    })}
  </div>
}
