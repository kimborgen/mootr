// ITSA fields (S-364): the shared column definitions on the ITSA home daemon (src/itsa.ts), as
// the web reads them, and how they sit among the Work page's columns. A field's column id is
// `field:` and the field's id, which a key change leaves alone, so a saved layout keeps it.
import { api } from '../api'
import { LOCKED } from '../work/views'

export const FIELD_TYPES = ['text', 'number', 'choice', 'link', 'date', 'check'] as const
export const FIELD_TONES = ['ok', 'warn', 'bad', 'muted', 'accent'] as const
export const FIELD_WIDTHS = ['s', 'm', 'l'] as const
export const FIELD_ALIGNS = ['start', 'end'] as const
export const FIELD_CARDS = ['chip', 'meta'] as const
export type FieldType = (typeof FIELD_TYPES)[number]
export type FieldTone = (typeof FIELD_TONES)[number]

export interface FieldOption { value: string; label: string; tone: FieldTone | null }
export interface Field {
  id: string
  key: string
  label: string
  type: FieldType
  options: FieldOption[] | null
  description: string | null
  hint: string | null
  width: (typeof FIELD_WIDTHS)[number]
  align: (typeof FIELD_ALIGNS)[number]
  card: (typeof FIELD_CARDS)[number]
  // The ITSA kinds the field applies to (S-3180); null, or absent from an older daemon, is every kind.
  kinds?: string[] | null
  position: number
}

// Whether a field applies to an ITSA of this kind (S-3180): every kind when the field has no kinds, else the
// kind must match one of them, ignoring case. The daemon hides the values of the others; this keeps the page to it too.
export function fieldApplies(f: Pick<Field, 'kinds'>, kind: string | null | undefined): boolean {
  if (!f.kinds) return true
  const k = (kind ?? '').toLowerCase()
  return !!k && f.kinds.some((x) => x.toLowerCase() === k)
}

// A tone as the `.badge` class that draws it: the status tokens, no new colour.
export const TONE_CLASS: Record<FieldTone, string> = { ok: 'ok', warn: 'warn', bad: 'err', muted: '', accent: 'progress' }
export const TONE_LABEL: Record<FieldTone, string> = { ok: 'Good', warn: 'Warning', bad: 'Bad', muted: 'Muted', accent: 'Accent' }

const PREFIX = 'field:'
export const fieldColId = (f: Pick<Field, 'id'>) => PREFIX + f.id
export const isFieldCol = (id: string) => id.startsWith(PREFIX)
export const fieldIdOf = (col: string) => (isFieldCol(col) ? col.slice(PREFIX.length) : null)

// Every Work column id in registry order: the built-ins, then the fields by position, before a
// locked last column (views.ts LOCKED) if the registry ends with one.
export function workColumnIds(builtins: string[], fields: Pick<Field, 'id' | 'position'>[]): string[] {
  const custom = [...fields].sort((a, b) => a.position - b.position).map(fieldColId)
  const tail = builtins.length > 1 && LOCKED.includes(builtins[builtins.length - 1]) ? 1 : 0
  return [...builtins.slice(0, builtins.length - tail), ...custom, ...builtins.slice(builtins.length - tail)]
}

export const fetchFields = () => api<Field[]>('GET', '/api/itsas/fields')
