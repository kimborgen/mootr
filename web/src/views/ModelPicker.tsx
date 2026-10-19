// A model field in Settings (S-379): a text field with a searchable list of the models it can
// take, price where known. Type to filter by id or name; sort cheapest first or by name. Any
// id can be typed, including one the list doesn't have, and the current value stays listed.
// On a phone the list opens in the page under the field (style.css).
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react'
import { api } from '../api'
import { Loading } from '../Loading'

// The most the list shows at once (style.css, .model-list max-height).
const LIST_MAX_PX = 320

export interface CatalogModel {
  id: string
  name: string
  // USD per million tokens; null when not known.
  in: number | null
  out: number | null
}
export type ModelSort = 'price' | 'name'

// Cheapest first: by input price, then output, then name. A model with no price goes last.
export function byPrice(a: CatalogModel, b: CatalogModel): number {
  const unpricedA = a.in == null && a.out == null
  const unpricedB = b.in == null && b.out == null
  if (unpricedA !== unpricedB) return unpricedA ? 1 : -1
  return (a.in ?? 0) - (b.in ?? 0) || (a.out ?? 0) - (b.out ?? 0) || a.name.localeCompare(b.name)
}

export function sortModels(models: CatalogModel[], sort: ModelSort): CatalogModel[] {
  return [...models].sort(sort === 'name' ? (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id) : byPrice)
}

// Every word of the query must appear in the id or the name, in either case.
export function filterModels(models: CatalogModel[], query: string): CatalogModel[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return models
  return models.filter((m) => {
    const text = `${m.id} ${m.name}`.toLowerCase()
    return words.every((w) => text.includes(w))
  })
}

const price = (v: number | null) => (v == null ? '?' : v === 0 ? 'free' : `$${+v.toFixed(3)}`)
export function priceLabel(m: CatalogModel): string {
  if (m.in == null && m.out == null) return 'price unknown'
  return `${price(m.in)} in · ${price(m.out)} out`
}

// One fetch per catalogue for the page: every field that lists the same models shares it. A
// failed fetch is forgotten, so the next open tries again.
const catalogs = new Map<string, Promise<CatalogModel[]>>()
function loadModels(kind: 'openrouter' | 'harness', harness?: string): Promise<CatalogModel[]> {
  const key = kind === 'harness' ? `harness:${harness ?? ''}` : 'openrouter'
  let p = catalogs.get(key)
  if (!p) {
    const q = kind === 'harness' ? `?kind=harness&harness=${encodeURIComponent(harness ?? '')}` : '?kind=openrouter'
    p = api<{ models: CatalogModel[] }>('GET', `/api/models${q}`).then((r) => r.models, (err) => {
      catalogs.delete(key)
      throw err
    })
    catalogs.set(key, p)
  }
  return p
}

// The phone's sheet (style.css, max-width 760px). Read at render and on open, so a resize still shows the right one.
const isPhone = () => Boolean(window.matchMedia?.('(max-width: 760px)')?.matches)

export function ModelPicker({ kind, harness, value, placeholder, label, disabled, title, onChange }: {
  kind: 'openrouter' | 'harness'
  harness?: string
  value: string
  placeholder?: string
  label: string
  disabled?: boolean
  title?: string
  onChange: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  // What the field shows, and what the list filters by (empty when the list opens).
  const [draft, setDraft] = useState(value)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<ModelSort>('price')
  const [active, setActive] = useState(-1)
  const [models, setModels] = useState<CatalogModel[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const listId = useId()
  const optId = (i: number) => `${listId}-${i}`
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const sheetInputRef = useRef<HTMLInputElement>(null)

  // The value changed outside the field (another setting, a reload): show it, unless the user is typing.
  useEffect(() => {
    if (!open) setDraft(value)
  }, [value, open])

  useEffect(() => {
    if (!open || models || error) return
    let live = true
    loadModels(kind, harness).then(
      (m) => live && setModels(m),
      (e) => live && setError(`Couldn't load the models: ${(e as Error).message}`),
    )
    return () => {
      live = false
    }
  }, [open, models, error, kind, harness])

  // The current value stays listed even when the catalogue doesn't have it.
  const options = useMemo(() => {
    const all = models ?? []
    const listed = value && !all.some((m) => m.id === value) ? [{ id: value, name: value, in: null, out: null }, ...all] : all
    return sortModels(filterModels(listed, query), sort)
  }, [models, value, query, sort])

  useEffect(() => {
    if (active >= 0) document.getElementById(optId(active))?.scrollIntoView({ block: 'nearest' })
  }, [active])

  // A phone's search field sits in the sheet, so the keyboard opens over the sheet, not the field.
  useEffect(() => {
    if (open && isPhone()) sheetInputRef.current?.focus()
  }, [open])

  // On a desktop the list is fixed to the field, so the settings pane's scroll can't clip it: it
  // opens below the field, or above when there's no room below.
  const [place, setPlace] = useState<CSSProperties>({})
  function placeList() {
    const r = wrapRef.current?.getBoundingClientRect()
    if (!r || isPhone()) return setPlace({})
    const flip = window.innerHeight - r.bottom < LIST_MAX_PX && r.top > window.innerHeight - r.bottom
    setPlace({ left: r.left, minWidth: r.width, ...(flip ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }) })
  }
  useEffect(() => {
    if (!open) return
    placeList()
    window.addEventListener('scroll', placeList, true)
    window.addEventListener('resize', placeList)
    return () => {
      window.removeEventListener('scroll', placeList, true)
      window.removeEventListener('resize', placeList)
    }
  }, [open])

  function openList() {
    setQuery('')
    // A failed load is retried on each open: the load effect runs again once the error is cleared.
    setError(null)
    setOpen(true)
    setActive(-1)
  }
  // Saves a choice: the value changes only when the text does.
  function commit(text: string) {
    const id = text.trim()
    setDraft(id)
    setOpen(false)
    setQuery('')
    setActive(-1)
    if (id !== value) onChange(id)
  }
  // Puts back the saved value and closes the list, as Escape and leaving the field do.
  function cancel() {
    setDraft(value)
    setOpen(false)
    setQuery('')
    setActive(-1)
  }
  function type(text: string) {
    setDraft(text)
    setQuery(text)
    // Typing after Escape reopens the list too, so it retries a failed load as openList does.
    if (!open) setError(null)
    setOpen(true)
    setActive(text.trim() ? 0 : -1)
  }
  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) return openList()
      if (!options.length) return
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((a) => (a + step + options.length) % options.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      commit(open && active >= 0 && options[active] ? options[active].id : draft)
    } else if (e.key === 'Escape') {
      if (!open) return
      e.preventDefault()
      cancel()
    }
  }
  // Focus that moves within the picker (the field to the sheet's search) keeps the list open.
  function onBlur(e: React.FocusEvent<HTMLDivElement>) {
    if (wrapRef.current?.contains(e.relatedTarget as Node | null)) return
    cancel()
  }

  const searchInput = (ref: React.Ref<HTMLInputElement>, extra: { id?: string; className?: string; label?: string } = {}) => (
    <input
      ref={ref}
      id={extra.id}
      className={extra.className}
      type="text"
      role="combobox"
      aria-label={extra.label ?? label}
      disabled={disabled}
      title={title}
      aria-expanded={open}
      aria-controls={listId}
      aria-autocomplete="list"
      aria-activedescendant={open && active >= 0 ? optId(active) : undefined}
      autoComplete="off"
      spellCheck={false}
      placeholder={placeholder}
      value={draft}
      onFocus={(e) => {
        e.currentTarget.select()
        if (!open) openList()
      }}
      onChange={(e) => type(e.target.value)}
      onKeyDown={onKey}
    />
  )

  return (
    <div className="model-picker" ref={wrapRef} onBlur={onBlur}>
      {searchInput(inputRef, { className: 'wide' })}
      {open ? (
        <div className="model-list" id={listId} role="listbox" aria-label={label} style={place}>
          <div className="model-top">
            {isPhone() ? (
              <div className="model-search">
                {searchInput(sheetInputRef, { className: 'wide', id: `${listId}-search`, label: 'Search models' })}
              </div>
            ) : null}
            <div className="model-head">
              <span>Price per million tokens</span>
              <div className="seg">
                <button type="button" aria-pressed={sort === 'price'} onMouseDown={(e) => e.preventDefault()} onClick={() => setSort('price')}>Cheapest</button>
                <button type="button" aria-pressed={sort === 'name'} onMouseDown={(e) => e.preventDefault()} onClick={() => setSort('name')}>Name</button>
              </div>
            </div>
          </div>
          {error ? <div className="model-empty">{error}</div> : null}
          {!error && !models ? <Loading className="model-empty muted" label="Loading the models" /> : null}
          {models && !options.length ? <div className="model-empty muted">No model matches. Enter keeps “{draft.trim()}” as the id.</div> : null}
          {options.map((m, i) => (
            <div
              key={m.id}
              id={optId(i)}
              role="option"
              aria-selected={m.id === value}
              className={`model-opt ${i === active ? 'on' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => commit(m.id)}
            >
              <span className="model-name">{m.name}{m.id === value ? <span className="model-cur">current</span> : null}</span>
              <span className="model-price">{priceLabel(m)}</span>
              <span className="model-id">{m.id}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
