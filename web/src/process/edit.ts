// The process editor's model (S-1083, step 5a): a working copy of one process, changed by pure
// functions, checked by the same validator the daemon loads files with (src/process-validate.ts),
// and written back out as YAML. No React and no network; nothing here saves.
//
// A draft is the served process without its counts. Every change returns a new draft, so the view
// keeps history in state and a discard is dropping it. `toYaml` writes the file shape (snake_case
// keys, edges as `[from, to, {when, label}]`); `validate` writes the draft to YAML and parses it
// back, so the rules are the loader's own and cannot drift. `mergeIntoSource` applies a draft to
// the original text through the yaml Document API, which keeps the comments of what did not change.
import { Document, isMap, isScalar, isSeq, parseDocument, stringify } from 'yaml'
import { NODE_ID, NODE_KINDS, parseProcessText } from '../../../src/process-validate.ts'
import type { NodeKind, Process, ProcessEdge, ProcessLane, ProcessNode } from './types'

export type Draft = Omit<Process, 'counts'>

export const KINDS: readonly NodeKind[] = NODE_KINDS as readonly NodeKind[]
export const HUMAN_ASKS = ['approve', 'decide', 'answer', 'review', 'test'] as const
export const END_STATUSES = ['done', 'canceled', 'wont_do'] as const
export const BUILTIN_LANE_TYPES = ['human', 'script', 'cos'] as const

const clone = <T,>(v: T): T => structuredClone(v)

export function draftFrom(p: Process): Draft {
  const { counts: _counts, ...rest } = clone(p)
  return rest
}

// ---- Changes -------------------------------------------------------------------------------

// A node id not yet taken: the label (else the kind) as a slug, numbered when it collides.
export function freshNodeId(d: Draft, base: string): string {
  const slug = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/g, '').slice(0, 24) || 'node'
  let id = slug
  for (let i = 2; d.nodes[id]; i++) id = `${slug}-${i}`
  return id
}

// A new node of `kind` in `lane`, with the fields that kind needs to be valid (a human node's
// ask, an end node's status, a start node's one trigger) so adding one does not start with an error.
export function addNode(d: Draft, kind: NodeKind, lane: string, label?: string): { draft: Draft; id: string } {
  const next = clone(d)
  const id = freshNodeId(next, label || kind)
  const node: ProcessNode = { kind, lane }
  if (label) node.label = label
  if (kind === 'human') node.ask = 'approve'
  if (kind === 'end') node.status = 'done'
  if (kind === 'start') node.triggers = [{ source: 'manual' }]
  next.nodes[id] = node
  return { draft: next, id }
}

export function updateNode(d: Draft, id: string, patch: Partial<ProcessNode>): Draft {
  if (!d.nodes[id]) return d
  const next = clone(d)
  const node: Record<string, unknown> = { ...next.nodes[id], ...patch }
  for (const k of Object.keys(node)) {
    const v = node[k]
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) delete node[k]
  }
  next.nodes[id] = node as unknown as ProcessNode
  return next
}

// Change a node's kind, dropping the fields that only another kind carries.
export function setKind(d: Draft, id: string, kind: NodeKind): Draft {
  const cur = d.nodes[id]
  if (!cur || cur.kind === kind) return d
  const next = updateNode(d, id, {
    kind,
    ask: kind === 'human' ? cur.ask ?? 'approve' : undefined,
    status: kind === 'end' ? cur.status ?? 'done' : undefined,
    triggers: kind === 'start' ? (cur.triggers?.length ? cur.triggers : [{ source: 'manual' }]) : undefined,
    run: kind === 'script' ? cur.run : undefined,
    event: kind === 'wait' ? cur.event : undefined,
  })
  return next
}

// Rename a node: its key, its own `id` when it carries one, and every edge that names it. A taken or malformed id is refused (the draft returns as it was).
export function renameNode(d: Draft, id: string, to: string): Draft {
  if (!d.nodes[id] || to === id || d.nodes[to] || !NODE_ID.test(to)) return d
  const next = clone(d)
  next.nodes = Object.fromEntries(Object.entries(next.nodes).map(([k, n]) => [k === id ? to : k, k === id && n.id !== undefined ? { ...n, id: to } : n]))
  for (const e of next.edges) {
    if (e.from === id) e.from = to
    if (e.to === id) e.to = to
  }
  return next
}

// Delete a node and the edges that touch it.
export function deleteNode(d: Draft, id: string): Draft {
  if (!d.nodes[id]) return d
  const next = clone(d)
  delete next.nodes[id]
  next.edges = next.edges.filter((e) => e.from !== id && e.to !== id)
  return next
}

// Connect two nodes. A second edge between the same pair, or a node to itself, is refused.
export function addEdge(d: Draft, from: string, to: string): Draft {
  if (from === to || !d.nodes[from] || !d.nodes[to] || d.edges.some((e) => e.from === from && e.to === to)) return d
  return { ...d, edges: [...d.edges, { from, to }] }
}

export function updateEdge(d: Draft, index: number, patch: Partial<Pick<ProcessEdge, 'when' | 'label'>>): Draft {
  if (!d.edges[index]) return d
  const edges = d.edges.map((e, i): ProcessEdge => {
    if (i !== index) return e
    const merged = { ...e, ...patch }
    if (!merged.when) delete merged.when
    if (!merged.label) delete merged.label
    return merged
  })
  return { ...d, edges }
}

export function deleteEdge(d: Draft, index: number): Draft {
  if (!d.edges[index]) return d
  return { ...d, edges: d.edges.filter((_, i) => i !== index) }
}

// A lane key not yet taken, from its type.
export function freshLaneKey(d: Draft, base: string): string {
  const slug = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'lane'
  let key = slug
  for (let i = 2; d.lanes[key]; i++) key = `${slug}-${i}`
  return key
}

export function addLane(d: Draft, type: string, label?: string): { draft: Draft; key: string } {
  const next = clone(d)
  const key = freshLaneKey(next, type)
  next.lanes[key] = label ? { type, label } : { type }
  return { draft: next, key }
}

export function updateLane(d: Draft, key: string, patch: Partial<ProcessLane>): Draft {
  if (!d.lanes[key]) return d
  const next = clone(d)
  const lane: Record<string, unknown> = { ...next.lanes[key], ...patch }
  for (const k of Object.keys(lane)) if (k !== 'type' && (lane[k] === undefined || lane[k] === '')) delete lane[k]
  next.lanes[key] = lane as unknown as ProcessLane
  return next
}

// Delete a lane. The nodes in it stay and fail validation (unknown lane) until moved.
export function deleteLane(d: Draft, key: string): Draft {
  if (!d.lanes[key]) return d
  const next = clone(d)
  delete next.lanes[key]
  return next
}

// ---- The file ------------------------------------------------------------------------------

const NODE_ORDER: readonly string[] = ['kind', 'lane', 'label', 'statuses', 'done_when', 'brief', 'tell', 'call', 'run', 'event', 'ask', 'status', 'triggers', 'boundary']

function nodeObject(n: ProcessNode): Record<string, unknown> {
  const o: Record<string, unknown> = { kind: n.kind, lane: n.lane }
  if (n.label) o.label = n.label
  if (n.statuses?.length) o.statuses = n.statuses
  if (n.doneWhen) o.done_when = n.doneWhen
  if (n.brief) o.brief = n.brief
  if (n.tell) o.tell = n.tell
  if (n.call) o.call = n.call
  if (n.run) o.run = n.run
  if (n.event) o.event = n.event
  if (n.ask) o.ask = n.ask
  if (n.status) o.status = n.status
  if (n.triggers?.length) o.triggers = n.triggers
  if (n.boundary?.length) o.boundary = n.boundary
  return o
}

// The file's data: keys in the order the files are written, empty optional fields left out.
export function toObject(d: Draft): Record<string, unknown> {
  const o: Record<string, unknown> = { process: d.id, title: d.title }
  if (d.description) o.description = d.description
  if (d.appliesTo?.kind?.length) o.applies_to = { kind: d.appliesTo.kind }
  o.lanes = Object.fromEntries(Object.entries(d.lanes).map(([k, l]) => [k, { ...l }]))
  o.nodes = Object.fromEntries(Object.entries(d.nodes).map(([k, n]) => [k, nodeObject(n)]))
  o.edges = d.edges.map((e) => (e.when || e.label ? [e.from, e.to, { ...(e.when ? { when: e.when } : {}), ...(e.label ? { label: e.label } : {}) }] : [e.from, e.to]))
  return o
}

// Short lists and each edge stay on one line, as the files are written.
function flowShort(doc: Document): void {
  const visit = (node: unknown): void => {
    if (isSeq(node)) {
      if (node.items.every((i) => !isMap(i) && !isSeq(i))) node.flow = true
      node.items.forEach(visit)
    } else if (isMap(node)) for (const p of node.items) visit(p.value)
  }
  visit(doc.contents)
  flowEdges(isMap(doc.contents) ? doc.contents.get('edges', true) : null)
  // A lane is one short line: `human: { type: human }`.
  const lanes = isMap(doc.contents) ? doc.contents.get('lanes', true) : null
  if (isMap(lanes)) for (const l of lanes.items) if (isMap(l.value)) l.value.flow = true
}

const OUT = { lineWidth: 0, flowCollectionPadding: false } as const

function flowEdges(edges: unknown): void {
  if (!isSeq(edges)) return
  for (const e of edges.items) if (isSeq(e)) { e.flow = true; for (const x of e.items) if (isMap(x)) x.flow = true }
}

export function toYaml(d: Draft): string {
  const doc = new Document(toObject(d))
  flowShort(doc)
  return doc.toString(OUT)
}

// Key order does not matter to the loader, so content is compared with sorted keys.
const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canon(x)])) : v)
const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b))

// ---- Text patches: change the file's bytes only where the draft differs ----------------------
// A re-serialised Document loses the file's alignment and flow padding, so a one-field edit would
// rewrite dozens of lines. `patchSource` instead walks the parsed document against the draft's data
// and splices: a scalar replaced in place, a flow list re-rendered, a key or list item removed (its
// lines) or added (new lines after the last one). It returns null for a change it can't express
// that way (another type, an added root key), and the caller then goes through the Document.

interface Edit { from: number; to: number; text: string }

const isPlain = (v: unknown): boolean => v === null || typeof v !== 'object'
const scalarText = (v: unknown): string => {
  const t = stringify(v).trimEnd()
  if (t.includes('\n')) throw new Error('multi-line')
  return t
}
// A value on one line, in the files' flow style: `[a, b]`, `{ k: v }`.
function flow(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(flow).join(', ')}]`
  if (v && typeof v === 'object') return `{ ${Object.entries(v).map(([k, x]) => `${k}: ${flow(x)}`).join(', ')} }`
  return scalarText(v)
}
// `key: value` lines at an indent: a multi-line string as a block scalar, a list of maps as a block
// list of flow maps, anything else on one line.
function fieldLines(indent: string, key: string, v: unknown): string[] {
  if (typeof v === 'string' && v.includes('\n')) return stringify({ [key]: v }, { indent: 2 }).trimEnd().split('\n').map((l) => indent + l)
  if (Array.isArray(v) && v.some((x) => !isPlain(x) && !Array.isArray(x))) return [`${indent}${key}:`, ...v.map((x) => `${indent}  - ${flow(x)}`)]
  return [`${indent}${key}: ${flow(v)}`]
}
const mapLines = (indent: string, o: Record<string, unknown>, order: readonly string[] = []): string[] => {
  const keys = [...order.filter((k) => k in o), ...Object.keys(o).filter((k) => !order.includes(k))]
  return keys.flatMap((k) => fieldLines(indent, k, o[k]))
}

function patchSource(source: string, doc: Document, want: Record<string, unknown>): string | null {
  const lineStart = (pos: number) => source.lastIndexOf('\n', pos - 1) + 1
  const lineEnd = (pos: number) => { const i = source.indexOf('\n', pos); return i < 0 ? source.length : i + 1 }
  const edits: Edit[] = []
  const insertAt = (pos: number, lines: string[]) => {
    const text = lines.join('\n') + '\n'
    edits.push({ from: pos, to: pos, text: pos > 0 && source[pos - 1] !== '\n' ? '\n' + text : text })
  }
  const endOf = (n: { range?: [number, number, number] | null }) => (n.range ? n.range[1] : 0)
  const column = (pos: number) => pos - lineStart(pos)

  // `where`: the path below the root, which decides how an added map entry is drawn.
  const patch = (node: unknown, w: unknown, where: string[]): boolean => {
    if (isScalar(node)) {
      if (!isPlain(w) || w === null || !node.range) return false
      if (node.value !== w) edits.push({ from: node.range[0], to: node.range[1], text: scalarText(w) })
      return true
    }
    if (isMap(node)) {
      if (!w || typeof w !== 'object' || Array.isArray(w) || !node.range) return false
      const o = w as Record<string, unknown>
      const keys = node.items.map((p) => String((p.key as { value?: unknown }).value))
      if (node.flow) return keys.length === Object.keys(o).length && keys.every((k) => k in o) && node.items.every((p, i) => patch(p.value, o[keys[i]], [...where, keys[i]]))
      const removed = keys.filter((k) => !(k in o))
      const added = Object.keys(o).filter((k) => !keys.includes(k))
      if (removed.length === keys.length && keys.length) return false
      if (where.length === 0 && (removed.length || added.length)) return false
      for (const item of node.items) {
        const k = String((item.key as { value?: unknown }).value)
        const v = item.value as { range?: [number, number, number] | null } | null
        const keyStart = (item.key as { range?: [number, number, number] }).range?.[0] ?? 0
        if (removed.includes(k)) edits.push({ from: lineStart(keyStart), to: lineEnd(Math.max(endOf(v ?? {}) - 1, keyStart)), text: '' })
        else if (!patch(item.value, o[k], [...where, k])) return false
      }
      if (added.length) {
        const last = node.items[node.items.length - 1]
        const indent = ' '.repeat(column((node.items[0].key as { range: [number, number, number] }).range[0]))
        const section = where[where.length - 1]
        const lines = added.flatMap((k) => {
          const v = o[k]
          if (v && typeof v === 'object' && !Array.isArray(v) && where.length === 1 && where[0] === 'nodes') return [`${indent}${k}:`, ...mapLines(indent + '  ', v as Record<string, unknown>, NODE_ORDER)]
          return fieldLines(indent, k, v)
        })
        void section
        insertAt(lineEnd(Math.max(endOf((last.value ?? {}) as { range?: [number, number, number] }) - 1, 0)), lines)
      }
      return true
    }
    if (isSeq(node)) {
      if (!Array.isArray(w) || !node.range) return false
      const items = node.items
      if (items.length === w.length) {
        // Same length: change each item in place. When that can't be done (an item became another shape), match the items as a list below.
        const mark = edits.length
        if (items.every((it, i) => patch(it, w[i], [...where, String(i)]))) return true
        edits.length = mark
        if (node.flow) return false
      }
      if (node.flow) {
        if (!w.every(isPlain) || !items.every((x) => isScalar(x))) return false
        edits.push({ from: node.range[0], to: node.range[1], text: flow(w) })
        return true
      }
      // A block list: match the items that stay (longest common subsequence), then remove, replace or add the rest.
      const have = items.map((it) => JSON.stringify(canon((it as { toJSON(): unknown }).toJSON())))
      const wants = w.map((x) => JSON.stringify(canon(x)))
      const lcs = Array.from({ length: have.length + 1 }, () => new Array<number>(wants.length + 1).fill(0))
      for (let i = have.length - 1; i >= 0; i--) for (let j = wants.length - 1; j >= 0; j--) lcs[i][j] = have[i] === wants[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
      const dash = ' '.repeat(column((items[0] as { range: [number, number, number] }).range[0]) - 2)
      let i = 0
      let j = 0
      let pendingDel: number[] = []
      let anchor = -1
      const itemRange = (k: number) => (items[k] as { range: [number, number, number] }).range
      const flush = () => { for (const k of pendingDel) edits.push({ from: lineStart(itemRange(k)[0]), to: lineEnd(itemRange(k)[1] - 1), text: '' }); pendingDel = [] }
      const addAfterAnchor = (x: unknown) => {
        const text = `${dash}- ${flow(x)}`
        if (anchor >= 0) insertAt(lineEnd(itemRange(anchor)[1] - 1), [text])
        else insertAt(lineStart(itemRange(0)[0]), [text])
      }
      while (i < have.length || j < wants.length) {
        if (i < have.length && j < wants.length && have[i] === wants[j]) { flush(); anchor = i; i++; j++ }
        else if (i < have.length && (j >= wants.length || lcs[i + 1][j] >= lcs[i][j + 1])) { pendingDel.push(i); i++ }
        else {
          // An added item that follows a removed one takes its place.
          const k = pendingDel.shift()
          if (k !== undefined) { edits.push({ from: itemRange(k)[0], to: itemRange(k)[1], text: flow(w[j]) }); anchor = k } else addAfterAnchor(w[j])
          j++
        }
      }
      flush()
      return true
    }
    return false
  }
  try {
    if (!patch(doc.contents, want, [])) return null
  } catch {
    return null
  }
  let out = source
  // Later edits apply first, so two inserts at one anchor land in the order they were made.
  const order = new Map(edits.map((e, i) => [e, i]))
  for (const e of edits.sort((a, b) => b.from - a.from || b.to - a.to || order.get(b)! - order.get(a)!)) out = out.slice(0, e.from) + e.text + out.slice(e.to)
  return out
}

// Apply a draft to the original file text, leaving what did not change as it was written
// (comments, blank lines, alignment, flow style): `patchSource` edits only the changed lines, and
// is checked by parsing its result. A change it can't express goes through the Document instead:
// a node or lane that changed is updated field by field, and the edges, when they differ, replaced.
export function mergeIntoSource(source: string, d: Draft): string {
  const doc = parseDocument(source)
  const want = toObject(d) as Record<string, any>
  const root = doc.contents
  if (!isMap(root)) return toYaml(d)
  if (same(doc.toJS(), want)) return source
  const patched = patchSource(source, doc, want)
  if (patched !== null && same(parseDocument(patched).toJS(), want)) return patched
  for (const key of ['title', 'description', 'applies_to'] as const) {
    if (same((doc.toJS() as Record<string, unknown>)[key], want[key])) continue
    if (want[key] === undefined) doc.delete(key)
    else doc.set(key, want[key])
  }
  for (const section of ['lanes', 'nodes'] as const) {
    const cur = root.get(section, true)
    if (!isMap(cur)) { doc.set(section, doc.createNode(want[section])); continue }
    const wanted = want[section] as Record<string, Record<string, unknown>>
    for (const item of [...cur.items]) {
      const k = String((item.key as { value?: unknown }).value)
      if (!(k in wanted)) cur.delete(k)
    }
    for (const [k, fields] of Object.entries(wanted)) {
      const node = cur.get(k, true)
      if (!isMap(node)) { cur.set(k, doc.createNode(fields)); continue }
      const have = node.toJSON() as Record<string, unknown>
      if (same(have, fields)) continue
      for (const f of Object.keys(have)) if (!(f in fields)) node.delete(f)
      for (const f of NODE_ORDER.filter((x) => x in fields).concat(Object.keys(fields).filter((x) => !NODE_ORDER.includes(x)))) {
        if (!same(have[f], fields[f])) node.set(f, doc.createNode(fields[f]))
      }
    }
  }
  if (!same((doc.toJS() as Record<string, unknown>).edges, want.edges)) {
    const seq = doc.createNode(want.edges)
    flowEdges(seq)
    doc.set('edges', seq)
  }
  return doc.toString({ lineWidth: 0 })
}

// ---- Validation ----------------------------------------------------------------------------

export interface Issue {
  message: string
  // What the message is about, for marking the node, edge or lane on the drawing.
  node?: string
  edge?: number
  lane?: string
}

// Where a loader message points. The messages are the loader's own strings (src/process-validate.ts).
export function locate(message: string, d: Draft): Issue {
  const issue: Issue = { message }
  const edge = /^edge (.+) -> (.+?): /.exec(message)
  if (edge) {
    const i = d.edges.findIndex((e) => e.from === edge[1] && e.to === edge[2])
    if (i >= 0) issue.edge = i
    return issue
  }
  const numbered = /^edge (\d+): /.exec(message)
  if (numbered) { issue.edge = Number(numbered[1]) - 1; return issue }
  const lane = /^lane "([^"]*)"/.exec(message)
  if (lane) { issue.lane = lane[1]; return issue }
  const mapped = /\("[^"]*" and "([^"]*)"\)/.exec(message)
  const node = /(?:^|\s)node "([^"]*)"/.exec(message) ?? /^(?:start|end|human) node "([^"]*)"/.exec(message) ?? mapped
  if (node) issue.node = node[1]
  return issue
}

// Every problem the loader finds in the draft, as it would find it in the file.
// `processIds` (the loaded processes) checks a node's `call`, as the loader's cross-file check does.
export function validate(d: Draft, knownStatuses: Iterable<string>, knownTypes?: Set<string>, processIds?: string[]): Issue[] {
  const file = `${d.id}.yaml`
  const { errors } = parseProcessText(toYaml(d), { file, knownTypes, knownStatuses: new Set(knownStatuses) })
  const out = errors.map((e) => e.startsWith(file + ': ') ? e.slice(file.length + 2) : e)
  if (processIds) for (const [id, n] of Object.entries(d.nodes)) if (n.call && n.call !== d.id && !processIds.includes(n.call)) out.push(`node "${id}": call "${n.call}" is not a loaded process`)
  return out.map((e) => locate(e, d))
}

// ---- The diff ------------------------------------------------------------------------------

export interface DiffLine { kind: 'same' | 'add' | 'del'; text: string }

// A line diff (longest common subsequence), for showing what an edit would change in the file.
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  if (a[a.length - 1] === '') a.pop()
  if (b[b.length - 1] === '') b.pop()
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: 'same', text: a[i] }); i++; j++ }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ kind: 'del', text: a[i++] })
    else out.push({ kind: 'add', text: b[j++] })
  }
  while (i < n) out.push({ kind: 'del', text: a[i++] })
  while (j < m) out.push({ kind: 'add', text: b[j++] })
  return out
}

// The diff cut to the changed lines with `context` lines around them; a gap is one `…` line.
export function hunks(lines: DiffLine[], context = 2): DiffLine[] {
  const keep = lines.map((l, i) => l.kind !== 'same' || lines.slice(Math.max(0, i - context), i + context + 1).some((x) => x.kind !== 'same'))
  const out: DiffLine[] = []
  lines.forEach((l, i) => {
    if (keep[i]) out.push(l)
    else if (out.length && out[out.length - 1].text !== '…') out.push({ kind: 'same', text: '…' })
  })
  return out
}

export const changed = (lines: DiffLine[]) => lines.some((l) => l.kind !== 'same')
