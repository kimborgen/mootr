// One turn of a conversation, drawn like a message in a mail thread (S-1483): the input that
// opened it on top as a card (the human's message, a mail, or a stam notice), then the agent's
// response full width below. Turns are separated like a thread's messages. `kind` says what
// opened it (turnKind in web/src/views/ownview-model.ts); the look of each is one block in
// web/style.css (`.ov-turn`).
import { useState, type ReactNode } from 'react'
import { Icon } from '../Icon'
import type { TurnKind } from '../views/ownview-model'
import { Rendered } from './Rendered'

export function TurnFrame({ id, kind, input, children }: { id: string; kind: TurnKind; input?: ReactNode; children?: ReactNode }) {
  return (
    <section className={'ov-turn ' + kind} data-turn={id} aria-label={LABEL[kind]}>
      {input ? <div className="ov-turn-in">{input}</div> : null}
      {children}
    </section>
  )
}
const LABEL: Record<TurnKind, string> = { human: 'Your message', 'human-mail': 'Your mail', mail: 'Mail', notice: 'mootr notice', start: 'Conversation start' }

// A notice folded to one line; the full text (what the agent got) opens on a tap or click.
// `line` is what the closed line says; by default the text's first line.
export function NoticeLine({ text, line, className = 'ov-notice' }: { text: string; line?: string; className?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={className}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name={open ? 'chevron-down' : 'chevron-right'} size="xs" /><span>{line ?? text.split('\n')[0]}</span></button>
      {open ? <Rendered text={text} className="ov-text" /> : null}
    </div>
  )
}
