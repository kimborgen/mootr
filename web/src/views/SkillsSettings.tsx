// Settings › Skills (S-889): every skill stam deploys, from GET /api/skills. Each shows its name,
// the SKILL.md description, an automatic summary of the body (src/block-summaries.ts), where it
// comes from, its size in tokens, and whether each harness reaches it natively. An Import field adds
// a public skill folder from GitHub (S-890); an imported skill whose origin moved gets an Update button.
import { useEffect, useState } from 'react'
import { api } from '../api'
import { Icon } from '../Icon'
import { hico } from './TypesSettings'
import { Loading } from '../Loading'

export type Reach = 'native' | 'prompt' | 'unreachable'
export interface Skill {
  name: string
  path: string
  source: 'user' | 'stam' | 'imported'
  description: string
  tokens: number
  extraTokens: number
  reaches: Record<'claude' | 'opencode' | 'codex', Reach>
  // The agent types that name the skill (S-891).
  attachedTo?: string[]
  origin?: { url: string; path: string; commit: string; date: string }
  bodySummary: { summary?: string; state: 'auto' | 'pending' | 'off' | 'failed' }
}

const SOURCE = { user: 'User', stam: 'mootr', imported: 'Imported' }
const REACH = { native: 'Native', prompt: 'Prompt index', unreachable: 'Unreachable' }
export type UpdateState = { moved: boolean; commit?: string; error?: string }
const NOTE = { pending: 'Summary pending.', off: 'No summary model set in Settings › Instructions.', failed: 'Summary failed; retried after a restart.' }

const shortOrigin = (o: NonNullable<Skill['origin']>) => `${o.url.replace(/^https:\/\/github\.com\//, '')}${o.path ? '/' + o.path : ''} @ ${o.commit.slice(0, 7)}`

export function SkillImport({ value, busy, error, onChange, onImport }: { value: string; busy: boolean; error: string | null; onChange: (v: string) => void; onImport: () => void }) {
  return (
    <form className="skill-import" onSubmit={(e) => { e.preventDefault(); if (value.trim() && !busy) onImport() }}>
      <input type="text" className="wide" aria-label="Skill to import" value={value} placeholder="OWNER/REPO/path or a GitHub URL" spellCheck={false} autoComplete="off" disabled={busy} onChange={(e) => onChange(e.target.value)} />
      <button type="submit" className="btn primary" disabled={busy || !value.trim()}><Icon name="download" size="xs" />{busy ? 'Importing…' : 'Import'}</button>
      {error ? <p className="sp-error" role="alert">{error}</p> : null}
    </form>
  )
}

export function SkillsList({ skills, updates = {}, updating = null, updateError = null, onUpdate }: { skills: Skill[]; updates?: Record<string, UpdateState>; updating?: string | null; updateError?: { name: string; message: string } | null; onUpdate?: (name: string) => void }) {
  if (!skills.length) return <p className="muted">No skills. Import one above, or put a folder with a SKILL.md in <code>~/.claude/skills</code> or mootr's <code>skills</code> folder.</p>
  return (
    <div className="set-card tools-card skills-card">
      {skills.map((s) => (
        <details className="fold tool skill" key={s.name} data-skill={s.name}>
          <summary>
            <span className="tool-row"><Icon name="chevron-right" size="xs" /><code className="tool-name">{s.name}</code><span className="chip">{SOURCE[s.source]}</span>{updates[s.name]?.moved ? <span className="chip">Update available</span> : null}<span className="meta skill-size">{s.tokens.toLocaleString()} tokens</span></span>
            <span className="tool-desc">{s.description || 'No description.'}</span>
            <span className="skill-reach">{(['claude', 'opencode', 'codex'] as const).map((h) => <span key={h} className={`skill-reach-${s.reaches[h]}`} title={`${h}: ${REACH[s.reaches[h]]}`}>{hico(h)}{REACH[s.reaches[h]]}</span>)}</span>
            <span className="skill-attached" data-attached>{s.attachedTo?.length ? <>Attached to {s.attachedTo.map((t) => <span key={t} className="chip">{t}</span>)}</> : 'Attached to no type'}</span>
          </summary>
          <p className="tool-none skill-body">{s.bodySummary.summary ?? NOTE[s.bodySummary.state as 'pending']}{s.bodySummary.state === 'auto' ? <span className="meta"> Auto summary.</span> : null}</p>
          <p className="tool-none"><code>{s.path}</code>{s.extraTokens ? ` · ${s.extraTokens.toLocaleString()} tokens in other files` : ''}</p>
          {s.origin ? (
            <p className="tool-none skill-origin">
              <span>Imported from <code>{shortOrigin(s.origin)}</code></span>
              {updates[s.name]?.error ? <span className="meta"> Update check failed: {updates[s.name].error}</span> : null}
              {updates[s.name]?.moved && onUpdate ? <button type="button" className="btn" disabled={updating !== null} onClick={() => onUpdate(s.name)}><Icon name="rotate-ccw" size="xs" />{updating === s.name ? 'Updating…' : 'Update'}</button> : null}
              {updateError?.name === s.name ? <span className="sp-error" role="alert">{updateError.message}</span> : null}
            </p>
          ) : null}
        </details>
      ))}
    </div>
  )
}

export function SkillsSettings() {
  const [skills, setSkills] = useState<Skill[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [updates, setUpdates] = useState<Record<string, UpdateState>>({})
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState(false)
  const [updating, setUpdating] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [updateError, setUpdateError] = useState<{ name: string; message: string } | null>(null)
  const load = () => api<Skill[]>('GET', '/api/skills').then((list) => {
    setSkills(list)
    // The origin check is a network call, so it runs after the list shows, and only when something was imported.
    if (list.some((s) => s.origin)) api<Record<string, UpdateState>>('GET', '/api/skills/updates').then(setUpdates).catch(() => {})
    else setUpdates({})
  })
  useEffect(() => {
    load().catch((e) => setError((e as Error).message))
  }, [])
  const act = async (path: string, body: object, done: () => void, fail: (message: string) => void) => {
    try {
      await api('POST', path, body)
      done()
      await load()
    } catch (e) {
      fail((e as Error).message)
    }
  }
  if (error) return <p className="muted">{error}</p>
  if (!skills) return <Loading className="muted" />
  return (
    <>
      <p className="lede">The {skills.length} skills mootr can deliver. Claude Code reads your skills folder and mootr's own as a plugin; OpenCode and Codex get links to the same folders, so a skill reaches every harness.</p>
      <p className="lede">Import a public skill folder from GitHub. Its files are copied and checked; nothing in them runs.</p>
      <SkillImport
        value={source}
        busy={busy}
        error={importError}
        onChange={setSource}
        onImport={async () => {
          setBusy(true)
          setImportError(null)
          await act('/api/skills/import', { source }, () => setSource(''), setImportError)
          setBusy(false)
        }}
      />
      <SkillsList
        skills={skills}
        updates={updates}
        updating={updating}
        updateError={updateError}
        onUpdate={async (name) => {
          setUpdating(name)
          setUpdateError(null)
          await act('/api/skills/update', { name }, () => {}, (message) => setUpdateError({ name, message }))
          setUpdating(null)
        }}
      />
    </>
  )
}
