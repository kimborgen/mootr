// Settings › Mail to you: label the open activity items from a date now (S-214). The daemon
// answers only the human, so this runs in the browser through stam's Tailscale address. It
// spends OpenRouter credit, up to the daily cap. The backfill runs in the background (S-252):
// Classify starts it, then the control polls its progress every 3 s while it runs.
import { useEffect, useState } from 'react'
import { api } from '../api'

// The daemon's progress for the backfill (GET /api/activity/classify-model).
export interface BackfillProgress {
  running: boolean
  labelled: number
  failed: number
  remaining: number
  stopped: 'done' | 'capped' | 'stalled' | null
  capped: boolean
  concurrency: number
  lastError: string | null
}

// The daemon's refusals, as the page says them.
function refusal(message: string): string {
  if (/classifier is off/.test(message)) return 'Off: turn on Classify activity first.'
  if (/already running/.test(message)) return 'A backfill is already running.'
  return message
}

// The progress as one line: "N labelled · M left", then why it stopped once it has.
export function progressText(p: BackfillProgress): string {
  const counts = `${p.labelled} labelled · ${p.remaining} left`
  if (p.running) return counts
  if (!p.stopped) return counts
  const why =
    p.stopped === 'capped'
      ? 'stopped: capped'
      : p.stopped === 'done'
        ? 'stopped: done'
        : /HTTP 429/.test(p.lastError ?? '')
          ? 'stopped: rate limited'
          : `stopped: failing${p.lastError ? ` (${p.lastError})` : ''}`
  return `${counts} · ${why}`
}

export function ClassifySince() {
  const [since, setSince] = useState('')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<BackfillProgress | null>(null)
  const [msg, setMsg] = useState('')

  // On mount, and after a start: read the progress; keep polling while it runs.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let alive = true
    const poll = async () => {
      try {
        const p = await api<BackfillProgress>('GET', '/api/activity/classify-model')
        if (!alive) return
        setProgress(p)
        setRunning(p.running)
        if (p.running) timer = setTimeout(() => void poll(), 3000)
      } catch (e) {
        // A transient failure while running: say so, and try again; the button stays disabled until it stops.
        if (!alive) return
        setMsg(refusal((e as Error).message))
        if (running) timer = setTimeout(() => void poll(), 3000)
      }
    }
    void poll()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [running])

  const run = async () => {
    setMsg('')
    try {
      // The date is the start of that day in this browser's time zone.
      const from = since ? new Date(`${since}T00:00:00`).toISOString() : ''
      await api('POST', '/api/activity/classify-model', { since: from })
      setMsg('Started')
      setRunning(true)
    } catch (e) {
      setMsg(refusal((e as Error).message))
    }
  }

  return (
    <div className="classify-since">
      <input type="date" aria-label="Classify items since" value={since} onChange={(e) => setSince(e.currentTarget.value)} />
      <button className="btn" disabled={running} onClick={() => void run()}>{running ? 'Classifying…' : 'Classify since…'}</button>
      {msg ? <span className="muted msg" role="status">{msg}</span> : null}
      {progress && (running || progress.stopped) ? <span className="muted msg" role="status">{progressText(progress)}</span> : null}
    </div>
  )
}
