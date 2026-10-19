// Settings › Requirements › Import: a JSON file of requirements, a list or {requirements: [...]},
// sent through POST /api/requirements/batch. The daemon creates them parents first; an agent's
// batch raises one approval ask. A bad file or a refusal shows in place.
import { useRef, useState } from 'react'
import { api } from '../api'
import { Icon } from '../Icon'
import { refreshReq } from './store'

// The requirements a file holds, or why it can't be imported.
export function parseImport(text: string): { requirements: unknown[] } | { error: string } {
  let v: unknown
  try { v = JSON.parse(text) } catch { return { error: 'The file is not JSON.' } }
  const list = Array.isArray(v) ? v : v && typeof v === 'object' && Array.isArray((v as { requirements?: unknown }).requirements) ? (v as { requirements: unknown[] }).requirements : null
  if (!list) return { error: 'The file holds neither a list of requirements nor {"requirements": [...]}.' }
  if (!list.length) return { error: 'The file holds no requirements.' }
  if (list.some((x) => !x || typeof x !== 'object' || Array.isArray(x))) return { error: 'Each requirement must be an object.' }
  return { requirements: list }
}

export function ReqImport({ enabled }: { enabled: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null)
  const send = async (file: File) => {
    const parsed = parseImport(await file.text())
    if ('error' in parsed) { setNote({ text: parsed.error, error: true }); return }
    setBusy(true)
    setNote(null)
    try {
      const r = await api<{ requirements: { key: string }[]; approval?: { itsa?: string; error?: string } }>('POST', '/api/requirements/batch', parsed)
      const n = r.requirements?.length ?? 0
      setNote({ text: `Imported ${n} requirement${n === 1 ? '' : 's'}${n ? ` (${r.requirements.map((x) => x.key).slice(0, 5).join(', ')}${n > 5 ? ', …' : ''})` : ''}.${r.approval?.itsa ? ` Approval asked in ${r.approval.itsa}.` : ''}` })
      void refreshReq()
    } catch (e) { setNote({ text: (e as Error).message, error: true }) }
    finally { setBusy(false); if (input.current) input.current.value = '' }
  }
  return (
    <div className="rq-import">
      <input ref={input} type="file" accept="application/json,.json" hidden data-req-import-file onChange={(e) => { const f = e.target.files?.[0]; if (f) void send(f) }} />
      <button type="button" className="btn" data-req-import disabled={!enabled || busy} title={enabled ? undefined : 'Turn requirements on first'} onClick={() => input.current?.click()}>
        <Icon name="upload" />{busy ? 'Importing…' : 'Import'}
      </button>
      {note ? <span className={note.error ? 'rq-error' : 'muted'} role={note.error ? 'alert' : 'status'} data-req-import-note>{note.text}</span> : null}
    </div>
  )
}
