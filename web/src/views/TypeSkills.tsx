// The Skills tab of the type page (S-891): every skill stam can deliver with a switch to attach it to
// the type. An attached skill goes into the type's agents' prompts as a "Skills available" line (name,
// description, path to its SKILL.md), on every harness. Saves through `POST /api/types/NAME` (human-only,
// shared: on a peer it goes to the home, and with no home page the tab is read-only).
import { useEffect, useState } from 'react'
import { api, homeApi } from '../api'
import { readOnly, scopeOf, writesToHome, type SettingsReply, type SettingsScope } from '../settings-scope'
import { useData } from '../store'
import { toast } from '../ui/menu'
import type { Skill } from './SkillsSettings'
import { typePayload, type TypeDef } from './type-form'
import { blockTokens, lineTokens, sameSkills, skillsPayload, toggleSkill } from './type-skills'
import { Loading } from '../Loading'

export function TypeSkills({ name, def, defaultReviewer, onSaved }: { name: string; def: TypeDef; defaultReviewer?: string; onSaved: () => void }) {
  const { machine } = useData()
  const [skills, setSkills] = useState<Skill[] | 'error' | null>(null)
  const [scope, setScope] = useState<SettingsScope | null>(null)
  const savedKey = JSON.stringify(def.skills ?? [])
  const [draft, setDraft] = useState<string[]>(def.skills ?? [])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let on = true
    api<Skill[]>('GET', '/api/skills').then((s) => on && setSkills(s), () => on && setSkills('error'))
    api<SettingsReply>('GET', '/api/config/settings').then((s) => on && setScope(scopeOf(s, machine)), () => {})
    return () => { on = false }
  }, [machine])
  useEffect(() => { setDraft(def.skills ?? []) }, [savedKey]) // eslint-disable-line react-hooks/exhaustive-deps
  if (skills === 'error') return <p className="muted">The skill list didn't load.</p>
  if (!skills) return <Loading className="muted" />
  const saved = def.skills ?? []
  const dirty = !sameSkills(draft, saved)
  const ro = readOnly('agentTypes', scope)
  const known = new Set(skills.map((s) => s.name))
  const gone = draft.filter((n) => !known.has(n))

  async function save() {
    setBusy(true)
    setErr('')
    try {
      const body = { ...typePayload(def, defaultReviewer === name), skills: skillsPayload(draft.filter((n) => known.has(n))) }
      if (writesToHome(scope)) {
        await homeApi(scope.homeWeb, scope.home, 'POST', `/api/types/${name}`, body)
        await api('POST', '/api/config/settings/sync').catch(() => {})
      } else await api('POST', `/api/types/${name}`, body)
      toast(`Saved the ${name} skills`)
      onSaved()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <section className="comp type-skills" aria-label={`Skills of ${name}`}>
      <p className="muted comp-lede">Attach a skill and agents of {name} see its name, description and the path to its SKILL.md in their prompt, whatever harness they run on. Agents get the change after they restart.{ro ? ` Shared by all machines; change it on ${scope?.home}.` : ''}</p>
      {skills.length ? (
        <ul className="comp-list">
          {skills.map((s) => (
            <li key={s.name} className="comp-row" data-skill={s.name} data-attached={draft.includes(s.name) || undefined}>
              <label className="comp-switch">
                <input type="checkbox" role="switch" checked={draft.includes(s.name)} disabled={ro} aria-label={`${s.name}: ${draft.includes(s.name) ? 'attached' : 'not attached'}`} onChange={(e) => { setErr(''); setDraft(toggleSkill(draft, s.name, e.target.checked)) }} />
                <code className="inv-title">{s.name}</code>
              </label>
              <span className="badge" title="Tokens the line adds to the prompt">{lineTokens(s)} tok</span>
              <span className="inv-sum comp-sum">{s.description || 'No description.'}</span>
            </li>
          ))}
        </ul>
      ) : <p className="muted">No skills. Add one in Settings › Skills.</p>}
      {gone.length ? <p className="muted" role="status">Not installed any more, so left out of the prompt: {gone.join(', ')}. Saving removes {gone.length === 1 ? 'it' : 'them'}.</p> : null}
      <div className="comp-foot" role="group" aria-label="Token total and actions">
        <span className="comp-total"><b>{blockTokens(skills, draft)}</b> tokens for the Skills available block</span>
        {err ? <span className="comp-err" role="alert">{err}</span> : null}
        <span className="comp-actions">
          <button type="button" className="btn" disabled={!dirty || busy} onClick={() => setDraft(saved)}>Discard</button>
          <button type="button" className="btn primary" disabled={!dirty || busy || ro} onClick={() => void save()}>Save</button>
        </span>
      </div>
    </section>
  )
}
