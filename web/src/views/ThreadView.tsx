// A thread's own world: the thread, and a prompt input to reply in it. Answers clicked in
// the thread (choices, picks, ranks, deferrals, permission answers) are staged, shown in a
// rendered preview, and sent with the reply.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { answerPermission, archiveThreadAndAdvance, assistantOpts, keptUnread, markMailRead, toggleThreadArchived, toggleThreadDeferred } from '../actions'
import { actItsa } from '../itsa/ItsaActions'
import { api, ApiError } from '../api'
import { Composer, type ComposerHandle, type SendPayload } from '../Composer'
import { bottomHandle, setBottomSlot, type BottomSlot } from '../bottom-slot'
import { isPlacedAsk, plainSubject } from '../format'
import { getRows } from '../outbox'
import { Icon } from '../Icon'
import * as mb from '../mail/mailblocks'
import { suggestedPicks, type SuggestedPick } from '../mail/suggestedPicks'
import { clearPermComment, nameFor, onPermComment, permComment, ThreadPanel, type ItsaAsk, type Stage } from '../mail/ThreadPanel'
import { takeOpenFocus } from '../mail/diffOpen'
import { isPhone, refreshTabs, registerView } from '../shell/layout'
import { getData, refreshSlow, setData, threadWaitsOnHuman, useData } from '../store'
import { answerInput, inputStatus } from '../perm/input'
import type { ItsaView, Mail, Permission } from '../types'
import { icon } from '../icons'

// A decision's answer quotes its question (q), then says the answer (body) and the human's
// note on it; a note alone is an answer too (kind 'note').
interface Answered { mailId: string; q: string; body: string; note?: string }
type Staged =
  // `note`: the comment on the card when it was staged; it is the answer's note (S-3829).
  // `choice`: the question dialog's option (S-3978), which is the whole answer.
  | { kind: 'perm'; mailId: string; id: string; approve: boolean; action: string; note?: string; choice?: string }
  // `shown`: the newest mail the thread showed when the action was staged, which Approve sends (S-2998).
  | { kind: 'itsa'; mailId: string; itsa: string; action: string; label: string; shown?: string }
  | (Answered & { kind: 'rank'; order: string[] })
  | (Answered & { kind: 'pick'; labels: string[] })
  | (Answered & { kind: 'choice' | 'defer' | 'note'; label?: string })
type Noting = { key: string; mailId: string; q: string }

// The reply for these staged answers and untouched pick blocks, and the text typed. A reply that answers
// decisions also answers the pick blocks left alone "as suggested" (S-1516); a plain typed reply, and a send that
// answers a permission (whose typed text is that answer's note) or runs an ITSA action, adds none. An ITSA action
// takes the typed text as its comment, so it leaves the reply.
export function composeReply(all: Staged[], suggested: SuggestedPick[], t: string) {
  const answering = all.some((x) => !isAct(x)) && !all.some((x) => x.kind === 'perm')
  const answers = [...all.filter((x) => !isAct(x)).map((x) => answerOf(x as Answered)), ...(answering ? suggested : []).map((p) => answerOf({ mailId: p.mailId, q: p.q, body: mb.pickText(p.labels, true) }))]
  const acts = all.filter((x): x is Extract<Staged, { kind: 'itsa' }> => x.kind === 'itsa')
  // The mails the answers are on: their askers are the reply's recipients (replyRecipients).
  const answered = [...all.filter((x) => !isAct(x)).map((x) => x.mailId), ...(answering ? suggested : []).map((p) => p.mailId)]
  return { body: [...answers, acts.length ? '' : t].filter(Boolean).join('\n\n'), perms: all.filter((x): x is Extract<Staged, { kind: 'perm' }> => x.kind === 'perm'), acts, answered }
}
// The note a permission answer sends: the comment typed on its card, then the reply's text when the reply answers
// nothing else (the text is then the answer's note, as before). One note, so the agent gets one message (S-3829).
const permNote = (p: { note?: string }, t: string, answersOnly: boolean) => [p.note, answersOnly ? t : ''].filter(Boolean).join(' ')
// The staged answer with the comment as it stands now: a comment typed after the tap counts, and one cleared counts as none.
const liveNote = (p: Extract<Staged, { kind: 'perm' }>) => ({ ...p, note: permComment(p.id) ?? p.note })
const answerOf = (s: Answered) => [s.q ? `> ${s.q}` : '', s.body, s.note ? mb.noteText(s.note) : ''].filter(Boolean).join('\n\n')

// A permission answer or an ITSA action has no decision block, so no note of its own.
const isAct = (s?: Staged): s is Extract<Staged, { kind: 'perm' | 'itsa' }> => s?.kind === 'perm' || s?.kind === 'itsa'
const noteOf = (s?: Staged) => (s && !isAct(s) ? s.note ?? '' : '')

// Shows a staged note inside its decision block, under the options, with Edit and Remove.
function showNote(b: HTMLElement, note?: string) {
  let el = b.querySelector<HTMLElement>(':scope > .mb-note')
  if (!note) { el?.remove(); b.querySelector<HTMLElement>('[data-own]')?.removeAttribute('hidden'); return }
  if (!el) {
    el = document.createElement('div')
    el.className = 'mb-note'
    el.innerHTML = `<span class="mb-note-label">${icon('pencil', 'xs')}Your note</span><span class="mb-note-text" data-own></span>
      <span class="mb-note-acts"><button class="mb-own" data-own type="button">Edit</button><button class="mb-own" data-unnote type="button">Remove</button></span>`
    b.querySelector(':scope > .mb-foot')!.before(el)
  }
  el.querySelector('.mb-note-text')!.textContent = note
  // The foot's "Add a note" gives way to the note's own Edit.
  b.querySelector<HTMLElement>('.mb-foot [data-own]')?.setAttribute('hidden', '')
}

// A refused reply whose thread had no box to put its draft in (its view was gone): kept for that
// thread, and put back when its view next shows.
const unsent = new Map<string, string>()

// A reply goes to the agents who wrote in the thread, or else to whom it was sent. A system sender
// (system:NAME, such as the deploy watcher) is a script with no mailbox, so it is never one (S-542).
const agent = (id: string) => id !== 'human' && !id.startsWith('system:')
export function recipients(mails: Mail[]) {
  // An ask placed in the thread (S-3827) makes its asker none of the thread's people.
  const senders = [...new Set(mails.filter((m) => !isPlacedAsk(m)).map((m) => m.from_id))].filter(agent)
  return senders.length ? senders : [...new Set(mails.flatMap((m) => m.recipients.map((r) => r.id)))].filter(agent)
}

// The agents who asked the decisions a reply answers (S-1366): a later relay in the thread never gets an
// answer meant for its asker. Empty when the reply answers no decision of an agent's.
export function askersOf(mails: Mail[], answered: string[]) {
  return [...new Set(answered.map((id) => mails.find((m) => m.id === id)?.from_id))].filter((id): id is string => !!id && agent(id))
}

// Whom a reply goes to: its askers, else the agents who wrote in the thread. A reply under an ask placed in the
// thread (S-3827) goes to that asker alone: the thread's other people never saw the ask.
export function replyRecipients(mails: Mail[], answered: string[]) {
  const asked = askersOf(mails, answered)
  if (asked.length) return asked
  const last = mails.findLast((m) => agent(m.from_id))
  return last && isPlacedAsk(last) && isPlacedAsk(mails.at(-1)!) ? [last.from_id] : recipients(mails)
}

export function ThreadView({ tid, viewKey }: { tid: string; viewKey: string }) {
  const { mailTick } = useData()
  const [mails, setMails] = useState<Mail[]>([])
  // The mails shown, for a staged ITSA action to name the newest (S-2998).
  const mailsRef = useRef(mails)
  mailsRef.current = mails
  // Replies sent but not yet confirmed by the daemon, shown after the thread's mails.
  // What the send skipped because the request was answered meanwhile; the composer's hint is hidden on a phone.
  const [skipped, setSkipped] = useState<string[]>([])
  const [pending, setPending] = useState<Mail[]>([])
  const [error, setError] = useState<string | null>(null)
  const [staged, setStaged] = useState<Map<string, Staged>>(new Map())
  const [text, setText] = useState('')
  const [noting, setNoting] = useState<Noting | null>(null)
  // On a phone the preview folds to one line until opened.
  const [previewOpen, setPreviewOpen] = useState(false)
  // A card comment typed in the thread is read by the preview at once (S-3927); the send reads it too.
  const [, setCommentTick] = useState(0)
  useEffect(() => onPermComment(() => setCommentTick((n) => n + 1)), [])
  const sig = useRef<string | null>(null)
  const unreadIds = useRef<string[]>([])
  const root = useRef<HTMLDivElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const composer = useRef<ComposerHandle>(null)
  // A desktop's one prompt input is the bottom world's; a phone keeps this view's own box (S-1436).
  const box = () => (isPhone() ? composer.current : bottomHandle())
  // The pick blocks on screen that nobody touched, kept by applyStaged as the thread renders.
  const [sugg, setSugg] = useState<SuggestedPick[]>([])
  const stagedRef = useRef(staged)
  const tidRef = useRef(tid)
  tidRef.current = tid
  stagedRef.current = staged
  const noteRef = useRef<string | null>(null)
  noteRef.current = noting?.key ?? null

  // The thread last loaded, the mail this view has already marked read, and whether the last
  // read changed the store (its tick reloads the thread, which the read already did).
  const loaded = useRef<string | null>(null)
  const marked = useRef(new Set<string>())
  const ownRead = useRef(false)
  const load = useCallback(async (force = false) => {
    let ms: Mail[]
    // Taken before the fetch, so a show while it is in flight doesn't fetch again.
    loaded.current = tid
    try { ms = await api<Mail[]>('GET', `/api/threads/${tid}`) } catch (e) { loaded.current = null; setError((e as Error).message); return }
    setError(null)
    const s = JSON.stringify(ms.map((m) => [m.id, m.recipients.map((r) => r.read_at), m.permission?.status]))
    const unread = ms.filter((m) => m.recipients.some((r) => r.id === 'human' && !r.read_at)).map((m) => m.id)
    if (s !== sig.current || force) {
      sig.current = s
      unreadIds.current = unread
      setMails(ms)
      // The loaded mails count for the waits too (S-2286): a thread past the list's 60 keeps its guard.
      setData({ openThreads: [...getData().openThreads.filter((t) => t.thread_id !== tid), { thread_id: tid, mails: ms }].slice(-20) })
      refreshTabs()
    }
    // Showing a thread marks the human's mail in it read, once per mail; mail the `u` key marked unread stays unread.
    const fresh = unread.filter((id) => !marked.current.has(id) && !keptUnread.get(tid)?.has(id))
    if (fresh.length && root.current?.offsetParent) {
      fresh.forEach((id) => marked.current.add(id))
      ownRead.current = true
      void markMailRead(fresh)
    }
  }, [tid])
  // Opening the thread (mounting it, or a new thread) reads its mail, so an earlier `u` on it no longer holds it unread.
  useEffect(() => { keptUnread.delete(tid) }, [tid])
  useEffect(() => {
    if (ownRead.current) { ownRead.current = false; return }
    load()
  }, [load, mailTick])
  // The shell shows every view after each layout render: a show reloads only a thread not yet loaded.
  // On return, the Open button that took the reader away has focus back — only one from this thread's own view (S-2105 review).
  useEffect(() => registerView(viewKey, { show: () => { if (loaded.current !== tid) load() }, focus: () => { const b = takeOpenFocus(root.current); if (b) b.focus(); else box()?.focus() } }), [viewKey, tid, load])

  // A draft refused while its view was gone goes back in its box when the view shows.
  useEffect(() => {
    const d = unsent.get(tid)
    if (d === undefined) return
    unsent.delete(tid)
    box()?.restore(d, 'thread:' + tid)
  }, [tid])

  const shown = useMemo(() => (pending.length ? [...mails, ...pending] : mails), [mails, pending])

  // The latest mail asking the human to act on an ITSA, and what that ITSA offers now.
  const askMail = mails.findLast((m) => m.kind === 'ask' && m.itsa_id)
  const [asked, setAsked] = useState<{ itsa: string; actions: ItsaAsk['actions'] } | null>(null)
  useEffect(() => {
    if (!askMail?.itsa_id) { setAsked(null); return }
    api<ItsaView>('GET', `/api/itsas/${askMail.itsa_id}`).then((v) => setAsked({ itsa: v.id, actions: v.actions ?? [] }), () => setAsked(null))
  }, [askMail?.itsa_id, mailTick])
  const stagedAct = asked ? staged.get('itsa:' + asked.itsa) : undefined
  const ask: ItsaAsk | null = askMail && asked && asked.actions.length ? { mailId: askMail.id, itsa: asked.itsa, actions: asked.actions, staged: stagedAct?.kind === 'itsa' ? stagedAct.action : null } : null

  // Stages an answer, or takes it back when clicked again. Each decision block holds one
  // answer; a pick holds the options ticked. A note stays through changes of answer.
  const stage = useCallback((a: Stage) => {
    setSkipped([])
    const next = new Map(stagedRef.current)
    const key = a.kind === 'perm' ? 'perm:' + a.id : a.kind === 'itsa' ? 'itsa:' + a.itsa : `${a.mailId}:${a.block.dataset.decision}`
    const had = next.get(key)
    if (a.kind === 'perm') {
      // Tapped again with the same answer and comment takes it back; a changed comment restages it.
      if (had?.kind === 'perm' && had.approve === a.approve && (had.note ?? '') === (a.note ?? '') && had.choice === a.choice) next.delete(key)
      else next.set(key, { kind: 'perm', mailId: a.mailId, id: a.id, approve: a.approve, action: a.action, note: a.note, choice: a.choice })
      return commit(next)
    }
    // One action per ITSA; clicking the staged one again takes it back.
    if (a.kind === 'itsa') {
      if (had?.kind === 'itsa' && had.action === a.action) next.delete(key)
      else next.set(key, { kind: 'itsa', mailId: a.mailId, itsa: a.itsa, action: a.action, label: a.label, shown: mailsRef.current.at(-1)?.id })
      return commit(next)
    }
    const q = mb.questionOf(a.block)
    const note = !isAct(had) ? had?.note : undefined
    const base = { mailId: a.mailId, q, note }
    if (a.kind === 'own') {
      setNoting({ key, mailId: a.mailId, q })
      // The keyboard comes up on a phone too: writing is what was asked for.
      return box()?.focus()
    }
    if (a.kind === 'unnote') {
      if (had?.kind === 'note') next.delete(key)
      else if (had && !isAct(had)) next.set(key, { ...had, note: undefined })
    } else if (a.kind === 'rank') {
      next.set(key, { ...base, kind: 'rank', order: a.order, body: mb.rankText(a.order) })
    } else if (a.kind === 'pick') {
      const labels = new Set(had?.kind === 'pick' ? had.labels : [...a.block.querySelectorAll<HTMLElement>('.mb-opt.sel')].map((o) => o.dataset.choose!))
      if (labels.has(a.label)) labels.delete(a.label); else labels.add(a.label)
      const order = [...a.block.querySelectorAll<HTMLElement>('[data-choose]')].map((o) => o.dataset.choose!).filter((l) => labels.has(l))
      next.set(key, { ...base, kind: 'pick', labels: order, body: order.length ? mb.pickText(order) : 'Picked none of these.' })
    } else {
      const { kind, label } = a
      if (had?.kind === kind && had.label === label) {
        if (note) next.set(key, { ...base, kind: 'note', body: '' }); else next.delete(key)
      } else next.set(key, { ...base, kind, label, body: kind === 'choice' ? mb.choiceText(label) : mb.deferText() })
    }
    commit(next)
  }, [])
  const commit = (next: Map<string, Staged>) => {
    setStaged(next)
    if (next.size && !isPhone()) box()?.focus()
  }

  // Finishes note mode: the note joins its block's answer, or leaves it when emptied.
  const finishNote = (note: string) => {
    const n = noting!
    const next = new Map(stagedRef.current)
    const had = next.get(n.key)
    if (isAct(had)) return
    if (note) next.set(n.key, had ? { ...had, note } : { kind: 'note', mailId: n.mailId, q: n.q, body: '', note })
    else if (had?.kind === 'note') next.delete(n.key)
    else if (had) next.set(n.key, { ...had, note: undefined })
    setStaged(next)
    setNoting(null)
  }

  // Marks what's staged in the thread, so the clicked option shows as chosen-to-send.
  const applyStaged = useCallback((panel: HTMLElement) => {
    const st = stagedRef.current
    for (const art of panel.querySelectorAll<HTMLElement>('.msg.open')) {
      // A sent note is in the reply; its block says it was answered.
      for (const n of art.querySelectorAll('.mb-decision.answered > .mb-note')) n.remove()
      for (const b of art.querySelectorAll<HTMLElement>('.mb-decision:not(.answered)')) {
        const key = `${art.dataset.id}:${b.dataset.decision}`
        const s = st.get(key)
        b.classList.toggle('staging', !!s)
        b.classList.toggle('noting', noteRef.current === key)
        showNote(b, isAct(s) ? undefined : s?.note)
        for (const o of b.querySelectorAll<HTMLElement>('[data-choose]')) {
          const on = s?.kind === 'pick' ? s.labels.includes(o.dataset.choose!) : s?.kind === 'choice' && s.label === o.dataset.choose
          o.classList.toggle('staged', s?.kind !== 'pick' && !!on)
          if (b.classList.contains('multi')) {
            const sel = s?.kind === 'pick' ? on : o.classList.contains('rec')
            o.classList.toggle('sel', !!sel)
            o.setAttribute('aria-pressed', String(!!sel))
            o.querySelector('.mb-box')!.innerHTML = icon(sel ? 'square-check' : 'square', 'xs')
          }
        }
        if (b.classList.contains('rank') && s?.kind === 'rank') mb.setRankOrder(b, s.order)
        b.querySelector('[data-rank-keep]')?.classList.toggle('staged', s?.kind === 'rank')
        b.querySelector('[data-defer]')?.classList.toggle('staged', s?.kind === 'defer')
        b.querySelector('[data-own]')?.classList.toggle('staged', noteRef.current === key)
      }
      for (const btn of art.querySelectorAll<HTMLElement>('[data-itsa-act]')) {
        const s = st.get('itsa:' + btn.dataset.itsa)
        btn.classList.toggle('staged', s?.kind === 'itsa' && s.action === btn.dataset.itsaAct)
      }
      for (const btn of art.querySelectorAll<HTMLElement>('[data-perm]')) {
        const s = st.get('perm:' + btn.dataset.perm)
        btn.classList.toggle('staged', s?.kind === 'perm' && s.approve === (btn.dataset.approve === '1'))
      }
    }
    const left = suggestedPicks(panel, (k) => st.has(k))
    setSugg((cur) => (JSON.stringify(cur) === JSON.stringify(left) ? cur : left))
  }, [])
  useLayoutEffect(() => { if (scroll.current) applyStaged(scroll.current) }, [staged, noting, applyStaged])

  // What the reply sends: the staged answers in the order clicked, then the typed text.
  // What the reply sends: the staged answers in the order clicked, the pick blocks nobody touched with their
  // recommended options (S-1516), then the typed text.
  const compose = (t: string) => composeReply([...staged.values()], sugg.filter((p) => !staged.has(p.key)), t)
  // Who the reply goes to: the askers of the decisions it answers (S-1366), else the thread's writers.
  const to = replyRecipients(mails, compose('').answered)

  // Once the daemon accepts a send (its row is `client_id`), the thread archives and the next mail
  // opens, unless anything else waits in this thread's strip: a draft, a failed row, or another
  // send still pending. Then the thread stays open with its rows showing (S-509).
  const archiveAndAdvance = (client_id?: string) => {
    if (getRows(`thread:${tid}`).some((r) => r.id !== client_id)) return
    void archiveThreadAndAdvance(tid)
  }
  // Sends permission answers (with the text as their note when nothing else is said) and
  // one reply holding every other answer and the text. The reply shows at once, as pending;
  // a failure takes it out again, puts the draft back, and says why.
  // A retry runs this same function again: the answers already sent and the reply already shown aren't repeated.
  const once = { answered: false, done: new Set<string>(), shown: null as Mail | null, said: undefined as string | undefined, stale: [] as string[] }
  // The suggested input a staged permission answer is for, from this thread or the pending list.
  const inputPerm = (id: string): Permission | undefined =>
    [...mails.map((m) => m.permission), ...getData().perms].find((x): x is Permission => !!x && x.id === id && x.kind === 'input')
  async function send({ text: t, files, client_id, cc, itsa }: SendPayload) {
    const { body, perms, acts } = compose(t)
    // A reply to decisions reaches their askers only (S-2064): the server adds no ITSA participant to it.
    const only = askersOf(mails, compose(t).answered)
    const answersOnly = !compose('').body
    setSkipped([])
    const before = staged
    if (!once.answered) {
      // Their client ids follow the reply's, so a retry after a lost answer is not answered twice.
      for (const p of perms) if (!once.done.has('perm:' + p.id)) {
        try {
          // A suggested input's approval sends the hash of its text (S-500), and says what came of it.
          const input = p.approve ? inputPerm(p.id) : undefined
          if (input) once.said = inputStatus(input, (await answerInput(input, input.text ?? '', true, `${client_id}:perm:${p.id}`)) || 'typed')
          else {
            // A question's choice is the whole answer: no comment, no reply text (S-3978).
            await answerPermission(p.id, p.approve, p.choice ?? permNote(liveNote(p), t, answersOnly), `${client_id}:perm:${p.id}`)
            clearPermComment(p.id)
          }
        } catch (e) {
          // A lost connection or a 5xx is rethrown as it is, so the outbox retries it.
          if (!(e instanceof ApiError) || e.status >= 500) throw e
          // Answered meanwhile (here, elsewhere, or by an agent): nothing to send. The card, once
          // the thread reloads, says who answered it, and a note says so here (S-518).
          const was = /\bis already (approved|denied|withdrawn|expired|held|failed)\b/.exec(e.message)?.[1]
          if (!was) {
            void load(true)
            throw new Error(`${p.approve ? 'Approve' : 'Deny'} "${p.action || p.id}" failed: ${e.message}. Tap this row to put the reply back in the box, then try again.`, { cause: e })
          }
          const by = await api<Mail[]>('GET', `/api/threads/${tid}`).then((ms) => ms.find((m) => m.permission?.id === p.id)?.permission?.decided_by, () => null)
          // A held request is an input approved elsewhere; a failed one was refused by its agent's box.
          once.stale.push(was === 'failed' ? `"${p.action || p.id}" already failed; nothing sent` : `Already ${was === 'held' ? 'approved' : was}${by ? ` by ${nameFor(by)}` : ''}; nothing sent for "${p.action || p.id}"`)
          void load(true)
        }
        once.done.add('perm:' + p.id)
      }
      if (once.stale.length) setSkipped([...once.stale])
      // The typed note was for answers that all turned out stale: it goes back in the box, not away.
      // A plain reply has no answers to go stale, so its text stays sent (S-3806).
      if (t && answersOnly && !acts.length && perms.length && once.stale.length === perms.length) box()?.restore(t, 'thread:' + tid)
      for (const a of acts) if (!once.done.has('itsa:' + a.itsa)) { await actItsa(a.itsa, a.action, t, undefined, `${client_id}:act:${a.itsa}`, { shown_mail: a.shown }); once.done.add('itsa:' + a.itsa) }
      once.answered = true
    }
    if (!((body && !(perms.length && answersOnly)) || files.length)) {
      // A permission answer or ITSA action sent from the mail is the user responding to it: the thread
      // archives (it waits in Awaiting) and the next mail opens, as a reply does.
      // When every answer was stale, nothing was answered here: the thread stays open for its card.
      if ((perms.length > once.stale.length) || acts.length) archiveAndAdvance(client_id)
      await load(true)
      requestAnimationFrame(() => { if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight })
      refreshSlow()
      return once.said
    }
    const reply = perms.length && answersOnly ? '' : body
    const replyTo = [...before.values()].find((x) => x.mailId)?.mailId ?? mails.at(-1)!.id
    const pm: Mail = { id: `pending-${Date.now()}`, from_id: 'human', body: reply, recipients: to.map((id) => ({ id })), created_at: new Date().toISOString(), pending: true,
      attachments: files.map((f) => ({ name: f.name, size: f.size })) }
    if (!once.shown) setPending((p) => [...p, (once.shown = pm)])
    requestAnimationFrame(() => { if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight })
    try {
      // The human names no one: the recipients come from the thread, so one nobody can mail any more is skipped, not refused (S-603).
      // A cc picked in the box (S-1464) joins the thread's own recipients, and an ITSA pick files the reply on it.
      await api('POST', '/api/mail', { from: 'human', to: [...new Set([...to, ...(cc ?? [])])], inferred: to, ...(only.length ? { only } : {}), reply_to: replyTo, body: reply, attachments: files.map((f) => ({ name: f.name, content_b64: f.content_b64 })), ...(itsa ? { itsa } : {}), client_id })
    } catch (e) {
      // The reply leaves the thread again; the prompt input's strip keeps the text, to put back in
      // the box, and onSubmit's undo brings back the staged answers that weren't sent.
      setPending((p) => p.filter((x) => x !== once.shown))
      throw e
    }
    // A reply archives its thread (it waits in Awaiting) and opens the next mail, once accepted.
    archiveAndAdvance(client_id)
    setPending((p) => p.filter((x) => x !== once.shown))
    void load(true).then(() => refreshSlow())
    return once.said
  }

  // A staged answer to a request that is no longer pending (answered here or elsewhere, or gone from the thread) is
  // dropped: the card shows who answered it, and sending the answer could only fail (S-518).
  useEffect(() => {
    const live = new Set(mails.filter((m) => m.permission?.status === 'pending').map((m) => m.permission!.id))
    const stale = [...staged].filter(([, x]) => x.kind === 'perm' && !live.has(x.id))
    if (stale.length) commit(new Map([...staged].filter(([k]) => !stale.some(([sk]) => sk === k))))
  }, [mails, staged])

  const trimmed = text.trim()
  const { body, perms, acts } = compose(trimmed)
  // The preview is for decision answers, not for ordinary writing (S-102): it appears once an
  // answer or a note is staged, and a plain typed reply needs no preview.
  const previewShown = staged.size > 0
  const mailBody = perms.length && !compose('').body ? '' : body
  const previewHtml = previewShown && mailBody ? mb.renderMail(mailBody) : ''
  const preview = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const box = preview.current
    if (!box || !previewHtml) return
    mb.renderCharts(box)
    mb.highlight(box)
    mb.renderMath(box)
  }, [previewHtml])

  const phone = isPhone()
  const slot: BottomSlot = {
    staged: staged.size > 0, onInput: setText, onSend: send, takesCc: true,
    // The staged answers go with this submit: taken now, so a second submit doesn't send them again.
    onSubmit: () => {
      const taken = staged
      setStaged(new Map())
      // If the send fails, the answers it didn't get to send (not the permission answers and ITSA
      // actions already done) come back to the box.
      return () => setStaged((cur) => new Map([...taken].filter(([k]) => !once.done.has(k)).concat([...cur])))
    },
    note: noting && { key: 'note:' + noting.key, text: noteOf(staged.get(noting.key)), done: finishNote, cancel: () => setNoting(null),
      label: <><Icon name="pencil" size="xs" />Note on <b>{noting.q || 'this decision'}</b></> },
    target: { key: 'thread:' + tid, name: `the thread "${plainSubject(mails[0]?.subject) || tid}"`, enabled: to.length > 0,
      label: to.length ? <><Icon name="reply" size="xs" />Reply to {to.map((id, i) => <span key={id}>{i ? ', ' : ''}<b>{nameFor(id)}</b></span>)}</> : '',
      placeholder: staged.size ? 'Add context (optional), then send' : to.length ? 'Reply in this thread' : 'No agent to reply to' },
  }
  // On a desktop the bottom world's prompt input writes to this thread; republished each render, so it never holds a stale send.
  useEffect(() => { if (!phone) setBottomSlot('thread:' + tid, slot) })
  useEffect(() => () => setBottomSlot('thread:' + tid, null), [tid])
  return (
    <div className="thread-view" ref={root}>
      {error ? <div className="thread-scroll"><div className="pad muted">{error}</div></div>
        : <ThreadPanel className="thread-scroll" scrollRef={scroll} mails={shown} threadKey={mails.length ? tid : ''} unread={unreadIds.current} onStage={stage} afterRender={applyStaged} ask={ask} humanView tabChips />}
      <div className={`thread-reply${noting ? ' noting' : ''}`}>
        {skipped.length ? <div className="rp-info" role="status"><Icon name="info" size="xs" /><span>{skipped.join('. ')}</span></div> : null}
        <div className={`reply-preview${previewOpen ? ' open' : ''}`} ref={preview} hidden={!previewShown}>
          {previewShown ? <>
            <div className="rp-head"><span className="eyebrow">Preview</span>
              <button className="rp-toggle" type="button" aria-expanded={previewOpen} onClick={() => setPreviewOpen(!previewOpen)}>
                <Icon name={previewOpen ? 'chevron-down' : 'chevron-right'} size="xs" />
                <span>{`${staged.size} answer${staged.size > 1 ? 's' : ''} staged`}</span><span className="eyebrow">Preview</span></button>
              <span className="muted rp-to">{mailBody ? `Reply to ${to.map((id) => nameFor(id)).join(', ')}` : ''}{mailBody && perms.length ? ' · ' : ''}{perms.length ? `${perms.length} permission answer${perms.length > 1 ? 's' : ''}` : ''}</span>
              <span className="spacer" />{staged.size ? <button className="mb-own" type="button" onClick={() => setStaged(new Map())}>Clear answers</button> : null}</div>
            {perms.map((p) => <div key={p.id} className={`rp-perm ${p.approve ? 'ok' : 'no'}`}><Icon name={p.approve ? 'check' : 'x'} size="xs" /><span>{p.approve ? 'Approve' : 'Deny'}: {p.action || p.id}</span>{permNote(liveNote(p), trimmed, !compose('').body) ? <span className="muted"> · note: {permNote(liveNote(p), trimmed, !compose('').body)}</span> : null}</div>)}
            {acts.map((a) => <div key={a.itsa} className="rp-perm ok"><Icon name="check" size="xs" /><span>{a.label}</span>{trimmed ? <span className="muted"> · comment: {trimmed}</span> : null}</div>)}
            {mailBody ? <div className="md" key={previewHtml} dangerouslySetInnerHTML={{ __html: previewHtml }} /> : null}
          </> : null}
        </div>
        {phone ? <Composer ref={composer} className="inline" assistant={assistantOpts} {...slot} /> : null}
      </div>
    </div>
  )
}

// The phone's Archive, in the pane's top bar so it stays in reach as the thread scrolls. The
// thread's own header hides its copy there. Same rules: a pending permission request holds it.
// On a desktop it is the tab bar's pair (S-2286): each icon names its key in its tooltip, and a
// thread that waits on the human's answer holds Archive too, as the desktop always has.
export function ThreadArchive({ tid, desktop = false }: { tid: string; desktop?: boolean }) {
  const { humanThreads, humanArchived, humanDeferred, openThreads } = useData()
  const t = [...humanThreads, ...humanArchived, ...humanDeferred, ...openThreads].find((x) => x.thread_id === tid)
  const archived = humanArchived.some((x) => x.thread_id === tid)
  const perm = !!t?.mails.some((m) => m.permission?.status === 'pending')
  const needsAnswer = perm || (desktop && threadWaitsOnHuman(tid))
  const deferred = humanDeferred.some((x) => x.thread_id === tid)
  const dKey = desktop ? ' (d)' : ''
  const aKey = desktop ? ' (e)' : ''
  return (
    <>
      <button className="icon-btn" data-defer type="button" title={(deferred ? 'Move this thread back to your mail' : needsAnswer ? 'Save this thread for later; it stays under To answer' : 'Save this thread for later') + dKey}
        onClick={() => toggleThreadDeferred(tid)} aria-label={(deferred ? 'Undefer' : 'Defer') + dKey}><Icon name={deferred ? 'alarm-clock-off' : 'alarm-clock'} /></button>
      <button className="icon-btn" data-archive type="button" disabled={!archived && needsAnswer}
        title={archived ? 'Move this thread back to your mail' + aKey : needsAnswer ? (perm ? 'Answer the permission request first' : 'Answer what waits on you first') : 'Hide this thread from your mail' + aKey}
        onClick={() => toggleThreadArchived(tid)} aria-label={(archived ? 'Unarchive' : 'Archive') + aKey}><Icon name={archived ? 'archive-restore' : 'archive'} /></button>
    </>
  )
}
