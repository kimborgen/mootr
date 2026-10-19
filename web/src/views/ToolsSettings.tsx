// Settings › Tools: read-only, the MCP tools every agent talks to, grouped (GET /api/tools,
// built from src/mcp.ts's toolCatalog). Each tool shows its name and description and expands
// to its arguments, and offers to add a decision step that checks it (Settings › Decision steps,
// which picks its triggers from this same list).
import { useEffect, useState } from 'react'
import { api } from '../api'
import { Icon } from '../Icon'
import { Loading } from '../Loading'

interface Prop { type?: string; description?: string; enum?: string[]; items?: { type?: string } }
interface Schema { type?: string; properties?: Record<string, Prop>; required?: string[] }
interface Tool { name: string; description: string; inputSchema: Schema }
interface Catalog { groups: { name: string; tools: Tool[] }[]; harnessTools: { note: string } }

// A short type label for an argument, including array item types and enums.
function argType(p: Prop): string {
  let t = p.type ?? 'any'
  if (t === 'array' && p.items?.type) t = `${p.items.type}[]`
  if (p.enum?.length) t += `: ${p.enum.join(', ')}`
  return t
}

export function ToolsSettings({ onAddStep }: { onAddStep?: (tool: string) => void }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api<Catalog>('GET', '/api/tools').then(setCatalog).catch((e) => setError((e as Error).message))
  }, [])

  if (error) return <p className="muted">{error}</p>
  if (!catalog) return <Loading className="muted" />
  const count = catalog.groups.reduce((n, g) => n + g.tools.length, 0)
  return (
    <>
      <p className="lede">Every tool mootr offers its agents over MCP, {count} in all. Each agent's system prompt tells it how to use these; a decision step can approve or deny each call of one.</p>
      {catalog.groups.map((g) => (
        <section key={g.name}>
          <h3>{g.name}</h3>
          <div className="set-card tools-card">
            {g.tools.map((t) => {
              const props = Object.entries(t.inputSchema.properties ?? {})
              const required = new Set(t.inputSchema.required ?? [])
              return (
                <details className="fold tool" key={t.name}>
                  <summary>
                    <span className="tool-row"><Icon name="chevron-right" size="xs" /><code className="tool-name">{t.name}</code></span>
                    <span className="tool-desc">{t.description}</span>
                  </summary>
                  {props.length ? (
                    <ul className="tool-args">
                      {props.map(([name, p]) => (
                        <li className="tool-arg" key={name}>
                          <span className="tool-arg-head"><code>{name}</code><span className="tool-arg-type">{argType(p)}</span>{required.has(name) ? <span className="tool-arg-req">required</span> : null}</span>
                          {p.description ? <span className="tool-arg-desc">{p.description}</span> : null}
                        </li>
                      ))}
                    </ul>
                  ) : <p className="tool-none">No arguments.</p>}
                  {onAddStep ? <button type="button" className="btn tool-step" onClick={() => onAddStep(t.name)}><Icon name="list-checks" />Add a step</button> : null}
                </details>
              )
            })}
          </div>
        </section>
      ))}
      <h3>Harness tools</h3>
      <div className="set-card tools-card"><p className="tool-note">{catalog.harnessTools.note}</p></div>
    </>
  )
}
