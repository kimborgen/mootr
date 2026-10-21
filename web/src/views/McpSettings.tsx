// Settings › MCP servers: the servers every agent gets, added by pasting any harness's own
// config (src/mcp-config.ts). Saving writes settings.mcpServers, which reaches each agent at
// its next start. A remote server that logs in does it once here, for every harness: the
// daemon holds the token and each harness reaches the server through `stam mcp-proxy` (S-50).
import { useEffect, useState, type ReactNode } from 'react'
import { api } from '../api'
import { Icon } from '../Icon'
import { toast } from '../ui/menu'

export interface McpAuth {
  type: 'gh' | 'oauth'
  client_id?: string
  // A reference into the secret store (S-2736) once saved; a typed value until the daemon stores it.
  client_secret?: string | { secret: string }
  scopes?: string[]
}
export interface McpServer {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  auth?: McpAuth
  enabled?: boolean
}
export type Servers = Record<string, McpServer>
interface McpStatus { name: string; type: string; logged_in: boolean; expires_at: number | null }
interface TestResult { ok: boolean; tools: string[]; error?: string }
interface Preview { servers: Servers; notes: string[] }
interface ImportedServer {
  name: string
  server: McpServer
  group: string
  file: string
  path?: string
  note?: string
  status: 'new' | 'same' | 'differs'
  differences?: string[]
}
interface RegistryField { name: string; description?: string; required?: boolean; secret?: boolean; prefill?: string; in: 'headers' | 'env' }
interface RegistryOption { kind: 'remote' | 'local'; label: string; server: McpServer; fields: RegistryField[]; note?: string }
interface RegistryEntry { name: string; title?: string; description?: string; version: string; websiteUrl?: string; repository?: string; options: RegistryOption[] }
interface RegistryPage { servers: RegistryEntry[]; nextCursor?: string }

// The registry browser survives the remount that follows a settings save (every save bumps
// the settings view's key): its state lives on the module, so adding a server leaves the
// results, the search, and the "added" marks where they were.
interface RegistryState { open: boolean; search: string; servers: RegistryEntry[]; nextCursor?: string; added: Record<string, boolean> }
const registry: RegistryState = { open: false, search: '', servers: [], added: {} }

const AUTH_LABEL: Record<string, string> = { gh: 'GitHub CLI login', oauth: 'OAuth' }
const isRemote = (s: McpServer) => Boolean(s.url)
const hasSecrets = (s: McpServer) => Boolean(Object.keys(s.env ?? {}).length || Object.keys(s.headers ?? {}).length)
const MASK = '••••'

// GitHub's MCP server has no dynamic client registration, so OAuth cannot work there; a
// remote server at api.githubcopilot.com defaults to the GitHub CLI login instead.
function githubAuth(s: McpServer): McpAuth | undefined {
  if (s.auth) return s.auth
  if (!s.url) return undefined
  try {
    if (/(^|\.)githubcopilot\.com$/i.test(new URL(s.url).hostname)) return { type: 'gh' }
  } catch {}
  return undefined
}

// A short, valid server name from a registry name like com.example/some-server, free of
// clashes: NAME-2, NAME-3, and so on.
function suggestName(regName: string, servers: Servers): string {
  const tail = regName.split('/').pop() ?? regName
  let base = tail.toLowerCase().replace(/[^\w.-]+/g, '-').replace(/^[^\w]+/, '').replace(/[^\w]+$/, '').slice(0, 40)
  if (!base) base = 'mcp-server'
  if (!servers[base]) return base
  for (let i = 2; i < 100; i++) if (!servers[`${base}-${i}`]) return `${base}-${i}`
  return base
}

// The import rows, grouped by source file, keeping their index for the picked set.
function groupImports(servers: ImportedServer[]): [string, { e: ImportedServer; i: number }[]][] {
  const map = new Map<string, { e: ImportedServer; i: number }[]>()
  servers.forEach((e, i) => {
    const list = map.get(e.group) ?? []
    list.push({ e, i })
    map.set(e.group, list)
  })
  return [...map]
}

const PLACEHOLDER = `Paste any harness's config, for example:

{"mcpServers": {"github": {"type": "http", "url": "https://api.githubcopilot.com/mcp/"}}}

[mcp_servers.local]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/work"]`

function Row({ label, help, children, cls = '' }: { label: ReactNode; help?: ReactNode; children: ReactNode; cls?: string }) {
  return <div className={`set-row ${cls}`}><div className="set-label"><b>{label}</b>{help ? <p>{help}</p> : null}</div><div className="set-ctl">{children}</div></div>
}
function Seg<T extends string | null>({ value, opts, onPick }: { value: T; opts: { v: T; label: string }[]; onPick: (v: T) => void }) {
  return <div className="seg">{opts.map((o) => <button type="button" key={String(o.v)} className={o.v === value ? 'on' : ''} onClick={() => onPick(o.v)}>{o.label}</button>)}</div>
}

// The command line a local server runs, and the url a remote one reaches.
function kindOf(s: McpServer): string {
  if (s.command) return ['local', s.command, ...(s.args ?? [])].join(' ')
  if (s.url) return `remote · ${s.url}`
  return 'no command or url'
}

export function McpSettings({ servers, onChange }: { servers: Servers; onChange: (next: Servers) => void }) {
  const [status, setStatus] = useState<Record<string, McpStatus>>({})
  const [results, setResults] = useState<Record<string, TestResult | 'running'>>({})
  const [editing, setEditing] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState('')
  const [auth, setAuth] = useState<Record<string, McpAuth['type'] | null>>({})
  const [imports, setImports] = useState<ImportedServer[] | null>(null)
  const [picked, setPicked] = useState<Record<number, boolean>>({})
  const [browsing, setBrowsing] = useState(registry.open)
  const [regSearch, setRegSearch] = useState(registry.search)
  const [regPage, setRegPage] = useState<RegistryPage>({ servers: registry.servers, nextCursor: registry.nextCursor })
  const [regError, setRegError] = useState('')
  const [regLoading, setRegLoading] = useState(false)
  const [added, setAdded] = useState<Record<string, boolean>>(registry.added)
  const [regAdd, setRegAdd] = useState<RegistryEntry | null>(null)
  const names = Object.keys(servers)

  const loadStatus = () => api<{ servers: McpStatus[] }>('GET', '/api/mcp/status').then((r) => {
    setStatus(Object.fromEntries((r.servers ?? []).map((s) => [s.name, s])))
  }).catch(() => {})
  useEffect(() => {
    void loadStatus()
    // A login finishes in another tab; refresh the state when the user comes back.
    const on = () => { if (document.visibilityState !== 'hidden') void loadStatus() }
    document.addEventListener('visibilitychange', on)
    addEventListener('focus', on)
    return () => { document.removeEventListener('visibilitychange', on); removeEventListener('focus', on) }
  }, [])

  const save = (next: Servers) => { setError(''); onChange(next) }

  async function login(name: string) {
    setError('')
    try {
      const r = await api<{ url: string }>('POST', `/api/mcp/${encodeURIComponent(name)}/login`)
      open(r.url, '_blank', 'noopener')
      toast(`Finish the login in the new tab, then come back.`)
    } catch (e) { setError((e as Error).message) }
  }
  async function logout(name: string) {
    try {
      await api('POST', `/api/mcp/${encodeURIComponent(name)}/logout`)
      await loadStatus()
    } catch (e) { setError((e as Error).message) }
  }
  async function test(name: string) {
    setResults((r) => ({ ...r, [name]: 'running' }))
    try {
      const r = await api<TestResult>('POST', `/api/mcp/${encodeURIComponent(name)}/test`)
      setResults((x) => ({ ...x, [name]: r }))
    } catch (e) {
      setResults((x) => ({ ...x, [name]: { ok: false, tools: [], error: (e as Error).message } }))
    }
  }
  function setEnabled(name: string, on: boolean) {
    save({ ...servers, [name]: { ...servers[name], enabled: on } })
  }
  function remove(name: string) {
    if (!confirm(`Remove the ${name} MCP server? Agents keep it until they restart.`)) return
    const next = { ...servers }
    delete next[name]
    save(next)
  }

  async function parse() {
    setError('')
    setPreview(null)
    try {
      const r = await api<Preview>('POST', '/api/mcp/parse', { text })
      if (!Object.keys(r.servers).length) return setError('No MCP servers found in that config.')
      setAuth(Object.fromEntries(Object.entries(r.servers).map(([n, s]) => [n, githubAuth(s)?.type ?? null])))
      setPreview(r)
    } catch (e) { setError((e as Error).message) }
  }
  function add() {
    if (!preview) return
    const next: Servers = { ...servers }
    for (const [name, s] of Object.entries(preview.servers)) {
      if (servers[name] && !confirm(`Replace the existing ${name} server?`)) continue
      const a = auth[name]
      next[name] = { ...s, ...(a ? { auth: { type: a } } : {}) }
    }
    setPreview(null)
    setText('')
    save(next)
  }

  // The servers already in the harnesses' own configs, grouped by source and marked against
  // what stam has. Nothing is written until Add selected.
  async function openImport() {
    setError('')
    setPreview(null)
    setImports(null)
    try {
      const r = await api<{ servers: ImportedServer[] }>('GET', '/api/mcp/import')
      setImports(r.servers)
      setPicked(Object.fromEntries(r.servers.map((s, i) => [i, s.status === 'new'])))
    } catch (e) { setError((e as Error).message) }
  }
  function addImported() {
    if (!imports) return
    const next: Servers = { ...servers }
    for (const [i, e] of imports.entries()) {
      if (!picked[i]) continue
      const a = githubAuth(e.server)
      next[e.name] = { ...e.server, ...(a ? { auth: a } : {}) }
    }
    setImports(null)
    save(next)
  }

  // The public MCP registry (S-53), proxied by the daemon and cached there. Browsing state
  // lives on the module so a save (which remounts this view) keeps the results and marks.
  const mirrorSearch = (v: string) => { registry.search = v; setRegSearch(v) }
  const mirrorPage = (page: RegistryPage) => { registry.servers = page.servers; registry.nextCursor = page.nextCursor; setRegPage(page) }
  async function loadRegistry(cursor?: string) {
    setRegLoading(true)
    setRegError('')
    try {
      const params = new URLSearchParams()
      if (regSearch.trim()) params.set('search', regSearch.trim())
      if (cursor) params.set('cursor', cursor)
      const q = params.toString()
      const r = await api<RegistryPage>('GET', '/api/mcp/registry' + (q ? '?' + q : ''))
      mirrorPage(cursor ? { servers: [...regPage.servers, ...r.servers], nextCursor: r.nextCursor } : r)
    } catch (e) { setRegError((e as Error).message) }
    setRegLoading(false)
  }
  useEffect(() => {
    if (!browsing) return
    const t = setTimeout(() => { void loadRegistry() }, 300)
    return () => clearTimeout(t)
  }, [browsing, regSearch])

  function openRegistry() {
    setError(''); setPreview(null); setImports(null); setRegAdd(null); setRegError(''); setRegLoading(true)
    registry.open = true
    mirrorSearch('')
    mirrorPage({ servers: [] })
    setBrowsing(true)
  }
  function closeRegistry() {
    registry.open = false
    setBrowsing(false)
    setRegAdd(null)
  }
  // Add one registry option as a settings server: fill its fields, ask the daemon what login
  // a remote likely needs, and save.
  async function commitRegistry(entry: RegistryEntry, optionIndex: number, name: string, values: Record<string, string>) {
    const option = entry.options[optionIndex]
    if (!option) return
    const server: McpServer = { ...option.server }
    const env: Record<string, string> = {}
    const headers: Record<string, string> = {}
    for (const f of option.fields) {
      const v = values[f.name]
      if (v === undefined || v === '') continue
      if (f.in === 'env') env[f.name] = v
      else headers[f.name] = v
    }
    if (Object.keys(env).length) server.env = env
    if (Object.keys(headers).length) server.headers = headers
    if (option.kind === 'remote' && server.url) {
      try {
        const r = await api<{ auth: 'gh' | 'oauth' | null }>('POST', '/api/mcp/registry/probe', { url: server.url })
        if (r.auth) server.auth = { type: r.auth }
      } catch {}
    }
    registry.added = { ...registry.added, [entry.name]: true }
    setAdded(registry.added)
    setRegAdd(null)
    save({ ...servers, [name]: server })
  }
  // One click when it needs no input; a form when there is a choice or a required field.
  function chooseRegistry(entry: RegistryEntry) {
    const option = entry.options[0]
    if (!option) return
    const name = suggestName(entry.name, servers)
    const values: Record<string, string> = {}
    for (const f of option.fields) if (f.prefill !== undefined) values[f.name] = f.prefill
    const needed = entry.options.length > 1 || option.fields.some((f) => f.required && values[f.name] === undefined)
    if (needed) setRegAdd(entry)
    else void commitRegistry(entry, 0, name, values)
  }

  if (editing !== null) {
    return <McpForm key={editing} name={editing} server={servers[editing] ?? {}} servers={servers} onDone={() => setEditing(null)} onSave={(next, renamedFrom) => {
      const out: Servers = { ...servers }
      if (renamedFrom && renamedFrom !== next.name) delete out[renamedFrom]
      out[next.name] = next.server
      setEditing(null)
      save(out)
    }} />
  }

  return (
    <>
      <p className="lede">MCP servers every agent gets, in any harness's own format. mootr holds one login for a remote service and gives it to every harness, so you log in once here. Changes reach each agent at its next start.</p>
      {error ? <p className="sp-error" role="alert">{error}</p> : null}
      <div className="mcp-tools">
        <button type="button" className="btn" onClick={() => void openImport()}><Icon name="download" size="xs" />Import from harnesses</button>
        <button type="button" className="btn" onClick={() => openRegistry()}><Icon name="search" size="xs" />Browse registry</button>
      </div>
      {browsing ? (
        <div className="set-card mcp-registry" id="mcp-registry">
          <div className="tpl-head"><b>Browse the MCP registry</b><span className="muted">Public servers from registry.modelcontextprotocol.io. Adding one writes settings.mcpServers.</span></div>
          <input type="search" className="wide mcp-reg-search" value={regSearch} placeholder="Search servers…" spellCheck={false} autoComplete="off" onChange={(e) => mirrorSearch(e.target.value)} />
          {regAdd ? <RegistryAdd entry={regAdd} servers={servers} onAdd={(oi, name, values) => void commitRegistry(regAdd, oi, name, values)} onCancel={() => setRegAdd(null)} /> : null}
          {regError ? <p className="sp-error" role="alert">{regError}</p> : null}
          {regPage.servers.length ? regPage.servers.map((e) => (
            <div className="mcp-reg-row" key={e.name} data-registry={e.name}>
              <div className="mcp-info">
                <b className="mcp-name"><Icon name="server" size="xs" />{e.title ?? e.name}</b>
                <div className="mcp-meta">
                  <span>{e.name} · v{e.version}</span>
                  {e.websiteUrl ? <a className="mcp-link" href={e.websiteUrl} target="_blank" rel="noreferrer noopener">website</a> : null}
                  {e.repository ? <a className="mcp-link" href={e.repository} target="_blank" rel="noreferrer noopener">repository</a> : null}
                </div>
                {e.description ? <p className="muted mcp-desc">{e.description}</p> : null}
              </div>
              <div className="mcp-actions">
                {added[e.name] ? <span className="chip">added</span> : <button type="button" className="btn" onClick={() => chooseRegistry(e)}><Icon name="plus" size="xs" />Add</button>}
              </div>
            </div>
          )) : regLoading ? <p className="muted">Searching…</p> : <p className="muted">No servers found.</p>}
          <div className="row mcp-actions">
            {regPage.nextCursor ? <button type="button" className="btn" disabled={regLoading} onClick={() => void loadRegistry(regPage.nextCursor)}>Load more</button> : null}
            <span className="spacer" />
            <button type="button" className="btn" onClick={() => closeRegistry()}>Close</button>
          </div>
        </div>
      ) : null}
      {imports !== null ? (
        <div className="set-card mcp-import" id="mcp-import">
          <div className="tpl-head"><b>Import from harnesses</b><span className="muted">Servers already configured in Claude Code, Codex, or OpenCode. Adding them writes settings.mcpServers for every agent.</span></div>
          {imports.length ? groupImports(imports).map(([group, rows]) => (
            <div className="mcp-import-group" key={group} data-source={group}>
              <div className="mcp-import-src">{group}</div>
              {rows.map(({ e, i }) => (
                <label className={`mcp-import-row ${e.status}`} key={i} data-import={e.name}>
                  <input type="checkbox" checked={!!picked[i]} onChange={(ev) => setPicked((p) => ({ ...p, [i]: ev.target.checked }))} />
                  <span className="mcp-info">
                    <b className="mcp-name"><Icon name={isRemote(e.server) ? 'network' : 'terminal'} size="xs" />{e.name}</b>
                    <span className="mcp-meta">
                      <span>{kindOf(e.server)}</span>
                      {e.status === 'same' ? <span className="chip">already added</span> : null}
                      {e.status === 'differs' ? <span className="chip mcp-differs">differs</span> : null}
                      {githubAuth(e.server)?.type === 'gh' ? <span className="chip mcp-auth gh">GitHub CLI login</span> : null}
                    </span>
                    {e.note ? <span className="muted mcp-note">{e.note}</span> : null}
                    {e.differences?.length ? <ul className="mcp-differences">{e.differences.map((d) => <li key={d}><code>{d}</code></li>)}</ul> : null}
                  </span>
                </label>
              ))}
            </div>
          )) : <p className="muted">No MCP servers found in your harnesses.</p>}
          <div className="row mcp-actions">
            <button type="button" className="btn primary" disabled={!Object.values(picked).some(Boolean)} onClick={() => addImported()}>Add selected</button>
            <button type="button" className="btn" onClick={() => setImports(null)}>Cancel</button>
          </div>
        </div>
      ) : null}
      <div className="set-card mcp-list">
        {names.length ? names.map((name) => {
          const s = servers[name]
          const st = status[name]
          const loggedIn = Boolean(st?.logged_in)
          const res = results[name]
          return (
            <div className={`mcp-row${s.enabled === false ? ' off' : ''}`} key={name} data-server={name}>
              <div className="mcp-info">
                <b className="mcp-name"><Icon name={isRemote(s) ? 'network' : 'terminal'} size="xs" />{name}</b>
                <div className="mcp-meta"><span>{kindOf(s)}</span></div>
                {(s.auth || hasSecrets(s)) ? (
                  <div className="mcp-meta">
                    {s.auth ? <span className={`chip mcp-auth${s.auth.type === 'gh' ? ' gh' : ''}`}>{AUTH_LABEL[s.auth.type]}</span> : null}
                    {s.auth ? <span className={loggedIn ? 'tag-on' : 'muted'}>{loggedIn ? 'logged in' : 'not logged in'}</span> : null}
                    {Object.keys(s.env ?? {}).length ? <span className="muted">env {Object.keys(s.env!).join(', ')}</span> : null}
                    {Object.keys(s.headers ?? {}).length ? <span className="muted">headers {Object.keys(s.headers!).join(', ')}</span> : null}
                  </div>
                ) : null}
                {res ? <div className={`mcp-meta mcp-result${res === 'running' ? '' : res.ok ? ' ok' : ' bad'}`}>
                  {res === 'running' ? 'Testing…' : res.ok ? `${res.tools.length} tool${res.tools.length === 1 ? '' : 's'}${res.tools.length ? ': ' + res.tools.slice(0, 6).join(', ') + (res.tools.length > 6 ? '…' : '') : ''}` : res.error}
                </div> : null}
              </div>
              <label className="check mcp-on"><input type="checkbox" checked={s.enabled !== false} onChange={(e) => setEnabled(name, e.target.checked)} />On</label>
              <div className="mcp-actions">
                {s.auth?.type === 'oauth' ? <button type="button" className="btn" onClick={() => void login(name)}><Icon name="external-link" size="xs" />Log in</button> : null}
                {s.auth?.type === 'oauth' && loggedIn ? <button type="button" className="btn" onClick={() => void logout(name)}>Log out</button> : null}
                <button type="button" className="btn" disabled={res === 'running'} onClick={() => void test(name)}><Icon name="play" size="xs" />Test</button>
                <button type="button" className="btn" onClick={() => setEditing(name)}><Icon name="pencil" size="xs" />Edit</button>
                <button type="button" className="btn danger" onClick={() => remove(name)}><Icon name="trash-2" size="xs" />Remove</button>
              </div>
            </div>
          )
        }) : <p className="muted">No MCP servers yet.</p>}
      </div>

      <h3>Add a server</h3>
      <p className="muted">Paste a config from Claude Code or <code>.mcp.json</code>, Codex's <code>config.toml</code>, or OpenCode. Values held in an environment variable are noted, not carried.</p>
      <div className="set-card text-card mcp-add">
        <textarea spellCheck={false} value={text} placeholder={PLACEHOLDER} onChange={(e) => { setText(e.target.value); setPreview(null) }} />
        <div className="row">
          <button type="button" className="btn" disabled={!text.trim()} onClick={() => void parse()}>Preview</button>
        </div>
        {preview ? (
          <div className="mcp-preview">
            <div className="tpl-head"><b>{Object.keys(preview.servers).length} server{Object.keys(preview.servers).length === 1 ? '' : 's'} found</b><span className="muted">Pick each remote server's login; values are shown masked.</span></div>
            {Object.entries(preview.servers).map(([name, s]) => {
              const note = preview.notes.find((n) => n.startsWith(name + ':'))
              return (
                <div className="mcp-prev-row" key={name} data-preview={name}>
                  <b className="mcp-name"><Icon name={isRemote(s) ? 'network' : 'terminal'} size="xs" />{name}</b>
                  <span className="mcp-meta">{kindOf(s)}</span>
                  {Object.keys(s.env ?? {}).length ? <span className="muted">env {Object.keys(s.env!).map((k) => `${k} ${MASK}`).join(', ')}</span> : null}
                  {Object.keys(s.headers ?? {}).length ? <span className="muted">headers {Object.keys(s.headers!).map((k) => `${k} ${MASK}`).join(', ')}</span> : null}
                  {note ? <span className="muted mcp-note">{note}</span> : null}
                  {isRemote(s) ? <Seg value={auth[name] ?? null} onPick={(v) => setAuth((a) => ({ ...a, [name]: v }))} opts={[{ v: null, label: 'No login' }, { v: 'gh', label: 'GitHub CLI' }, { v: 'oauth', label: 'OAuth' }]} /> : null}
                </div>
              )
            })}
            <div className="row"><button type="button" className="btn primary" onClick={() => add()}>Add</button><button type="button" className="btn" onClick={() => setPreview(null)}>Cancel</button></div>
          </div>
        ) : null}
      </div>
    </>
  )
}

// The form for adding one registry server that needs input: its name, the option when there
// are several, and each required (and optional) field. Secret fields are password inputs.
function RegistryAdd({ entry, servers, onAdd, onCancel }: { entry: RegistryEntry; servers: Servers; onAdd: (optionIndex: number, name: string, values: Record<string, string>) => void; onCancel: () => void }) {
  const prefill = (option: RegistryOption | undefined) => {
    const v: Record<string, string> = {}
    for (const f of option?.fields ?? []) if (f.prefill !== undefined) v[f.name] = f.prefill
    return v
  }
  const [oi, setOi] = useState(0)
  const option = entry.options[oi]
  const [values, setValues] = useState<Record<string, string>>(() => prefill(entry.options[0]))
  const [name, setName] = useState(() => suggestName(entry.name, servers))
  const [err, setErr] = useState('')
  const pick = (i: number) => { setOi(i); setValues(prefill(entry.options[i])); setErr('') }
  const setV = (k: string, v: string) => setValues((x) => ({ ...x, [k]: v }))
  function submit() {
    const n = name.trim()
    if (!/^[\w][\w.-]{0,40}$/.test(n)) return setErr('A name takes letters, digits, dots, and dashes.')
    if (servers[n]) return setErr(`A server named ${n} exists.`)
    const missing = option.fields.filter((f) => f.required && !(values[f.name] ?? '').trim()).map((f) => f.name)
    if (missing.length) return setErr(`Fill ${missing.join(', ')}.`)
    onAdd(oi, n, values)
  }
  return (
    <div className="set-card mcp-reg-add" id="mcp-reg-add" role="dialog" aria-label={`Add ${entry.title ?? entry.name}`}>
      <div className="tpl-head"><b>{entry.title ?? entry.name}</b>{entry.description ? <span className="muted">{entry.description}</span> : null}</div>
      <Row label="Name" help="The name agents see."><input type="text" className="wide" value={name} spellCheck={false} autoComplete="off" onChange={(e) => { setErr(''); setName(e.target.value) }} /></Row>
      {entry.options.length > 1 ? (
        <Row label="How to run it">
          <div className="seg">{entry.options.map((o, i) => <button type="button" key={i} className={i === oi ? 'on' : ''} onClick={() => pick(i)}>{o.label}</button>)}</div>
        </Row>
      ) : null}
      {option.fields.map((f) => (
        <Row key={f.name} label={<><code>{f.name}</code>{f.required ? ' *' : ''}</>} help={f.description}>
          <input type={f.secret ? 'password' : 'text'} className="wide" value={values[f.name] ?? ''} placeholder={f.required ? 'Required' : 'Optional'} autoComplete="off" spellCheck={false} onChange={(e) => setV(f.name, e.target.value)} />
        </Row>
      ))}
      {option.note ? <p className="muted mcp-note">{option.note}</p> : null}
      {err ? <p className="sp-error" role="alert">{err}</p> : null}
      <div className="row mcp-actions">
        <button type="button" className="btn primary" onClick={() => submit()}>Add</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

// The edit form for one server. Env and header values are masked: a value field shows only a
// placeholder, and a typed value replaces the stored one.
// Slack's MCP server (mcp.slack.com) only works with a Slack app's client ID and secret (docs/slack.md).
const isSlackUrl = (url?: string): boolean => /^https:\/\/mcp\.slack\.com(?:[/:?#]|$)/i.test((url ?? '').trim());

export function McpForm({ name, server, servers, onDone, onSave }: { name: string; server: McpServer; servers: Servers; onDone: (changed: boolean) => void; onSave: (next: { name: string; server: McpServer }, renamedFrom?: string) => void }) {
  const isNew = name === ''
  const [m, setM] = useState(name)
  const [s, setS] = useState<McpServer>({ args: [], env: {}, headers: {}, ...server })
  const [err, setErr] = useState('')
  const remote = isRemote(s)
  // The reference the saved server holds, not the field's: a value typed over it and then cleared keeps it.
  const secretRef = server.auth?.client_secret && typeof server.auth.client_secret === 'object' ? server.auth.client_secret.secret : undefined
  const kind = remote ? 'remote' : 'local'
  const set = (patch: Partial<McpServer>) => { setErr(''); setS((o) => ({ ...o, ...patch })) }

  function setKind(k: 'local' | 'remote') {
    if (k === 'remote') set({ command: undefined, args: undefined, env: undefined })
    else set({ url: undefined, headers: undefined, auth: undefined })
  }
  function submit() {
    const n = m.trim()
    if (!/^[\w][\w.-]{0,40}$/.test(n)) return setErr('A name takes letters, digits, dots, and dashes.')
    if (n !== name && servers[n]) return setErr(`A server named ${n} exists.`)
    const out: McpServer = { ...s }
    if (remote && !out.url) return setErr('A remote server needs a url.')
    if (!remote && !out.command) return setErr('A local server needs a command.')
    onSave({ name: n, server: out }, isNew ? undefined : name)
  }

  return (
    <form className="mcp-form" aria-label={isNew ? 'New MCP server' : `MCP server ${name}`} onSubmit={(e) => { e.preventDefault(); submit() }}>
      <button type="button" className="btn mcp-back" onClick={() => onDone(false)}><Icon name="arrow-left" size="xs" />MCP servers</button>
      <div className="set-card">
        <Row label="Name"><input type="text" className="wide" value={m} placeholder="github" spellCheck={false} autoComplete="off" onChange={(e) => { setErr(''); setM(e.target.value) }} /></Row>
        <Row label="Kind" help="A local server runs a command; a remote one reaches a url."><Seg value={kind} opts={[{ v: 'local', label: 'Local command' }, { v: 'remote', label: 'Remote url' }]} onPick={setKind} /></Row>
        {remote
          ? <>
            <Row label="URL"><input type="text" className="wide" value={s.url ?? ''} placeholder="https://mcp.example.com/mcp" spellCheck={false} onChange={(e) => set({ url: e.target.value })} /></Row>
            {isSlackUrl(s.url) && !s.auth?.client_id ? <p className="muted mcp-note mcp-slack-note">Slack needs a Slack app's client ID and secret: see docs/slack.md</p> : null}
            <Row label="Login" help="The daemon holds one login and gives it to every harness."><Seg value={s.auth?.type ?? null} opts={[{ v: null, label: 'None' }, { v: 'gh', label: 'GitHub CLI' }, { v: 'oauth', label: 'OAuth' }]} onPick={(v) => set({ auth: v ? { ...s.auth, type: v } : undefined })} /></Row>
            {s.auth?.type === 'oauth' ? <>
              <Row label="Client ID" help="Empty: mootr registers itself, when the server supports it."><input type="text" className="wide" value={s.auth.client_id ?? ''} placeholder="Optional" spellCheck={false} onChange={(e) => set({ auth: { ...s.auth, type: 'oauth', client_id: e.target.value || undefined } })} /></Row>
              <Row label="Client secret" help={secretRef ? `Stored as ${secretRef}. Type a new value to replace it.` : 'Saved in the secret store, not in settings.'}><input type="password" aria-label="Client secret" value={typeof s.auth.client_secret === 'string' ? s.auth.client_secret : ''} placeholder={secretRef ? `Stored as ${secretRef}` : 'Optional'} autoComplete="off" onChange={(e) => set({ auth: { ...s.auth, type: 'oauth', client_secret: e.target.value || (secretRef ? { secret: secretRef } : undefined) } })} /></Row>
            </> : null}
          </>
          : <>
            <Row label="Command"><input type="text" className="wide" value={s.command ?? ''} placeholder="npx" spellCheck={false} onChange={(e) => set({ command: e.target.value })} /></Row>
            <Row label="Arguments" help="One per line."><textarea className="mcp-args" spellCheck={false} value={(s.args ?? []).join('\n')} onChange={(e) => set({ args: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })} /></Row>
          </>}
        <Row label="Enabled"><label className="check"><input type="checkbox" checked={s.enabled !== false} onChange={(e) => set({ enabled: e.target.checked })} />On</label></Row>
      </div>
      <Secrets label={remote ? 'Headers' : 'Environment'} pairs={(remote ? s.headers : s.env) ?? {}} help="Sent with every request; values are stored and shown masked." onChange={(pairs) => set(remote ? { headers: pairs } : { env: pairs })} />
      {err ? <p className="sp-error" role="alert">{err}</p> : null}
      <div className="row mcp-actions">
        <button type="submit" className="btn primary">{isNew ? 'Add server' : 'Save'}</button>
      </div>
    </form>
  )
}

// A name/value editor for env and headers: names are shown, values stay masked. Typing a value
// replaces the stored one; a blank field keeps it.
function Secrets({ label, help, pairs, onChange }: { label: string; help: string; pairs: Record<string, string>; onChange: (pairs: Record<string, string>) => void }) {
  const [nk, setNk] = useState('')
  const [nv, setNv] = useState('')
  const keys = Object.keys(pairs)
  const set = (k: string, v: string) => onChange({ ...pairs, [k]: v })
  const del = (k: string) => { const next = { ...pairs }; delete next[k]; onChange(next) }
  const add = () => { const k = nk.trim(); if (!k) return; onChange({ ...pairs, [k]: nv }); setNk(''); setNv('') }
  return (
    <>
      <h3>{label}</h3>
      <p className="muted">{help}</p>
      <div className="set-card">
        {keys.map((k) => <SecretRow key={k} name={k} onSet={(v) => set(k, v)} onRemove={() => del(k)} />)}
        <div className="mcp-secret add">
          <input type="text" value={nk} placeholder="Name" spellCheck={false} onChange={(e) => setNk(e.target.value)} />
          <input type="password" value={nv} placeholder="Value" autoComplete="off" spellCheck={false} onChange={(e) => setNv(e.target.value)} />
          <button type="button" className="icon-btn" title={`Add ${label.toLowerCase()}`} onClick={add} disabled={!nk.trim()}><Icon name="plus" size="xs" /></button>
        </div>
      </div>
    </>
  )
}

function SecretRow({ name, onSet, onRemove }: { name: string; onSet: (v: string) => void; onRemove: () => void }) {
  const [v, setV] = useState('')
  return (
    <div className="mcp-secret">
      <code>{name}</code>
      <input type="password" value={v} placeholder={MASK} autoComplete="off" spellCheck={false}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => { if (v) { onSet(v); setV('') } }} />
      <button type="button" className="icon-btn" title={`Remove ${name}`} onClick={onRemove}><Icon name="trash-2" size="xs" /></button>
    </div>
  )
}
