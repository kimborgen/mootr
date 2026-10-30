import { ThreadPanel } from './ThreadPanel'
import { ds, type Story } from '../stories/types'
import { AGENTS_STOPPED, ASK_ITSA, STATUSES, T_ASK, T_BETWEEN, T_DIALOG, T_GATE, T_INPUT, T_LONG, T_PERM, T_PERM_DONE, T_PLAIN, T_QUESTION, T_RICH, T_UNREAD, T_WITHDRAWN } from '../stories/mailFixtures'
import type { Mail, MailItsa } from '../types'
import { humanRowsOf } from './thread-index'

const panel = (mails: Mail[], o: Partial<Parameters<typeof ThreadPanel>[0]> = {}) => <div className="thread-view"><ThreadPanel className="thread-scroll" mails={mails} threadKey={mails[0]?.thread_id ?? ''} {...o} /></div>
const unreadIds = (mails: Mail[]) => mails.filter((m) => m.recipients.some((r) => r.id === 'human' && !r.read_at)).map((m) => m.id)
const STATE = { itsaStatuses: STATUSES, itsas: [ASK_ITSA], attention: [ASK_ITSA] }
const LINKS: MailItsa[] = [
  { id: ASK_ITSA.id, key: ASK_ITSA.key, title: ASK_ITSA.title, status: ASK_ITSA.status, source: 'named' },
  { id: 'fx-i-2', key: 'S-12', title: 'A long ITSA title that has to wrap or cut on a phone', status: 'in_progress', source: 'itsa' },
  { id: 'fx-i-3', key: 'S-30', title: 'Done work', status: 'done', source: 'thread' },
]
// The first mail was superseded by the second (S-1315): dimmed, with a link to its replacement.
const superseded = T_PLAIN.mails.slice(0, 2).map((m, i) => ({ ...m, id: 'fm-s' + i, thread_id: 'fx-t-super', ...(i === 0 ? { superseded_by: 'fm-s1' } : {}) }))
// A harness each: the senders are fixture agents on Claude Code, Codex and OpenCode.
const harnesses = T_PLAIN.mails.map((m, i) => ({ ...m, from_id: ['fx-dev', 'fx-review', 'fx-ops'][i], id: 'fm-h' + i, thread_id: 'fx-t-harness' }))

export const stories: Story[] = [{
  name: 'Thread panel',
  group: 'Mail',
  what: 'One mail thread, oldest first, each message its own sheet on the thread deck. The latest message and any the mailbox has not read are open; the rest fold to one line with a snippet, and a long thread folds its middle into one "earlier messages" row. The header holds the subject, who is in the thread, and the count; on a phone, and in the agent inbox that has no tab, it also holds the ITSAs it is linked to as chips (S-986) and the attached agents; the desktop thread tab carries them instead (S-1471 §2a). A message that names an ITSA itself, by its sender or a key in its text, shows its key inline on the sender line, unless every message of the thread links that ITSA. Bodies render through the mail components (decisions, charts, tables and the rest, `docs/mail-components.md`). Cards also carry permission requests, suggested inputs, and the ask bar of an ITSA waiting on you.',
  when: 'Inside `ThreadView` (the `thread:ID` world, with answers staged for the reply), and inside `MailView` (an agent\'s inbox, read only, without `onStage`). It is the whole right-hand side of the Mail tab on a desktop and the full pane on a phone.',
  code: ['web/src/mail/ThreadPanel.tsx#ThreadPanel', 'web/src/mail/ThreadPanel.tsx#MailBody', 'web/src/mail/ThreadPanel.tsx#Avatar', 'web/src/mail/ThreadPanel.tsx#nameFor', 'web/src/mail/ThreadPanel.tsx#repeatedIds', 'web/src/mail/ThreadPanel.tsx#withdrawnFor', 'web/src/mail/ThreadPanel.tsx#between', 'web/src/mail/ThreadPanel.tsx#BetweenRow', 'web/src/mail/ThreadPanel.tsx#Card', 'web/src/mail/ThreadPanel.tsx#Folded', 'web/src/mail/ThreadPanel.tsx#MailAttachments', 'web/src/mail/ThreadPanel.tsx#SupersededBy', 'web/src/mail/ThreadPanel.tsx#VerdictMark', 'web/src/mail/mailblocks.ts#renderMail'],
  rules: [
    'A mail the daemon records as showing an ITSA\'s text (an ask, a re-show) carries where that text sits in its body (`shown`, S-2998). `MailBody` draws that part in its own `.mb-shown` box on `--surface-page`, above everything after it, so nothing later in the mail can cover it. Only that recorded range makes the box; a range that doesn\'t land on the snapshot renders the mail whole.',
    'A `Card` handles its own clicks (S-1769): table sort and "show all rows", a mail link, an agent link, a file link and copy. A host that mounts it, such as the ITSA thread, needs no click handler of its own; the panel root keeps only the header\'s agent chips and the staging controls.',
    'A mail\'s attachments (`MailAttachments`), its superseded line (`SupersededBy`) and the verdict mark (`VerdictMark`) are shared with the ITSA thread (S-1508), whose conversation cards draw them the same way.',
    'A thread opens scrolled to its latest message (S-1500), not the top; a latest message taller than the pane starts at its own top. A mail link still scrolls to the message it names.',
    'A file attachment that is not an image is a link under the message (S-1529) that opens the file view on the machine that stores it (`file:HOST:PATH`), as a tab, next to a Download button (an icon button, `--size-hit-touch` square on a phone). Download fetches with the Bearer header and saves from a blob: URL, so the token is never in the address bar (S-1534), also on a middle click (S-1600). A daemon that sends no path keeps S-1512: text and Markdown open in a new tab, every other file downloads. Images open in the image viewer.',
    'A PDF an embed shows is a card with an Open PDF link (the file view\'s PDF viewer) and Download, never an iframe; a linked PDF opens its own page in a new tab.',
    'A file path in a message body (`src/daemon.ts:3613`, `/abs/path.ts:12`, `web/src/App.tsx`) is an inline link that opens the file view at that line (S-1529). It links only with a known extension or project folder, never a URL; a relative path resolves in the sender\'s cwd on the sender\'s machine (from the registry) and stays text when the sender is unknown. Code blocks are not linked; it wraps with the text and does not change the line height.',
    'A diff block in a body carries its Open button here as it does in a mail\'s own view (S-2105): a tap stores the fence as a patch and opens the diff view, landing on the block\'s first file.',
    'A message lies on its thread\'s deck like a sheet: `--surface-page`, square corners, a hairline border and no shadow (' + ds('Surfaces and elevation') + ').',
    'The header scrolls away with the messages on a desktop and on a phone, where who is in the thread folds behind one button (`.th-people`) so the header stays one line. On a desktop the header, the messages and the reply share one column at `--measure-conversation`, centred (S-1471).',
    'Folding is by default, not by loss: a tap on a folded row or a message header opens or folds it, and a new arrival opens by itself. A mail link scrolls to its message, opens it, and flashes it once (`--duration-focus`).',
    'Buttons on a card (Approve, Deny, the ITSA actions) meet `--size-hit-touch` on a phone (' + ds('Density') + '). An unread recipient shows a dot, never colour alone.',
    'A question dialog (AskUserQuestion, S-3978) is headed "Waiting for your answer" and leads with its question. Each option is a full-width row with its label and its description, and Skip question closes it with Esc. There is no comment field: the option is the whole answer, typed into the dialog as its number. On a phone the rows wrap, each `--size-hit-touch` high, and nothing scrolls sideways.',
    'A permission card has an "Add a comment…" field (`.perm-comment`, a `--size-control` input) on its own row, above Approve and Deny. The comment travels with the answer as its note, so the agent gets the verdict and the comment in one message (S-3829). A comment typed after Approve is still sent, and the reply preview shows it as it is typed (S-3927).',
    'The header mark shows the mail check (S-983): a check for pass, a warning for a fail, and a shield-alert warning when the sender overrode a refusal. Tapping or hovering shows the scores, or the sender\'s reason; the mark is an icon with a text label, never colour alone.',
    'Linked ITSAs are chips, not mail: no unread count and no new message. On a phone, the thread header chip shows status glyph, key and title and wraps, `--size-hit-touch` high (' + ds('Density') + '); a message chip is a small key with its glyph, `--size-hit-touch` high on a phone with negative margins so the line stays one control tall. A tap opens the ITSA; nothing scrolls sideways. A message with more than two ITSAs shows "+N": on a desktop it expands in place to all of them, with a "Fewer" chip to fold them again (tooltip "Show all N ITSAs"); on a phone it scrolls to the header.',
    'Agents attached to a mail (S-1305, `mail_attach`) are chips under the ITSA chips, an avatar and a name; a tap opens the agent. Like linked ITSAs they are not mail: no unread count, no new message.',
    'A superseded mail (S-1315) stays in its thread, dimmed, with a "Superseded by" line whose link jumps to the mail that replaced it (plain text when that mail is in another thread); the link is `--size-hit-touch` high on a phone. Its text, not colour alone, says it is replaced. It leaves the inbox (S-1304).',
    'Mail between agents (S-1458), not addressed to you, folds in your own mail view to one dimmed row, "Between agents: A to B", with a snippet; a tap opens it with a "Between agents, not addressed to you" line. It never counts as unread or waiting on you. An agent\'s inbox view shows it as ordinary mail.',
    'Mail components are apparatus, not cards: a hairline callout, ink mentions, bordered decision rows (`docs/mail-components.md`).',
    'No toast: a permission answer shows on its own card (' + ds('Persona rules') + ').',
  ],
  states: [
    { name: 'Short thread, read', render: () => panel(T_PLAIN.mails) },
    { name: 'Unread, with a title and a verdict', render: () => panel(T_UNREAD.mails, { unread: unreadIds(T_UNREAD.mails) }) },
    { name: 'Overridden mail', render: () => panel(T_GATE.mails) },
    { name: 'Long thread, folded', render: () => panel(T_LONG.mails, { unread: unreadIds(T_LONG.mails) }) },
    { name: 'A decision to answer', render: () => panel(T_RICH.mails, { onStage: () => {} }) },
    { name: 'Linked to ITSAs', data: STATE, render: () => panel(T_PLAIN.mails.map((m, i) => ({ ...m, itsas: i === 0 ? LINKS : i === 1 ? [{ ...LINKS[1], source: 'named' as const }] : [LINKS[2]] }))) },
    { name: 'With attached agents', data: STATE, render: () => panel(T_PLAIN.mails.map((m, i) => ({ ...m, agents: i === 0 ? ['fx-dev', 'fx-review'] : [] }))) },
    { name: 'Each harness as sender', render: () => panel(harnesses) },
    { name: 'Permission request waiting', data: { perms: [T_PERM.mails[0].permission!], humanRows: humanRowsOf([T_PERM]) }, render: () => panel(T_PERM.mails, { onStage: () => {} }) },
    { name: 'Permission request, read only', render: () => panel(T_PERM.mails) },
    { name: 'Permission request answered', render: () => panel(T_PERM_DONE.mails) },
    { name: 'Dialog stopping an agent', data: { agents: AGENTS_STOPPED, perms: [T_DIALOG.mails[0].permission!], humanRows: humanRowsOf([T_DIALOG]) }, render: () => panel(T_DIALOG.mails, { onStage: () => {} }) },
    { name: 'Question with choices', data: { perms: [T_QUESTION.mails[0].permission!], humanRows: humanRowsOf([T_QUESTION]) }, render: () => panel(T_QUESTION.mails, { onStage: () => {} }) },
    { name: 'Suggested input', render: () => panel(T_INPUT.mails, { onStage: () => {} }) },
    { name: 'An ITSA waiting on you', data: { ...STATE, agents: AGENTS_STOPPED, humanRows: humanRowsOf([T_ASK]) }, render: () => panel(T_ASK.mails, { unread: unreadIds(T_ASK.mails), ask: { mailId: 'fm-41', itsa: ASK_ITSA.id, actions: ASK_ITSA.actions }, onStage: () => {} }) },
    { name: 'Withdrawn mail', render: () => panel(T_WITHDRAWN.mails) },
    { name: 'Mail between agents', render: () => panel(T_BETWEEN.mails, { humanView: true }) },
    { name: 'File attachments', render: () => panel(T_PLAIN.mails.map((m, i) => ({ ...m, attachments: i === 0 ? [{ name: 'work-table-design.md', size: 4200 }, { name: 'numbers.xlsx', size: 18000 }] : [] })) as Mail[]) },
    { name: 'File attachments in the file view', data: { machine: 'fixture-machine' }, render: () => panel(T_PLAIN.mails.map((m, i) => ({ ...m, attachments: i === 0 ? [{ name: 'design.md', size: 4200, path: '/home/fixture/.stam/attachments/fx-1/design.md' }, { name: 'report.pdf', size: 18000, path: '/home/fixture/.stam/attachments/fx-1/report.pdf' }] : [] })) as Mail[]) },
    { name: 'PDF attachment card and path links', data: { machine: 'fixture-machine' }, render: () => panel(T_PLAIN.mails.map((m, i) => ({ ...m, body: i === 0 ? 'Fixed in `src/daemon.ts:3613` and /home/fixture/projects/app/web/src/App.tsx:12.\n\n```embed\nattachment: report.pdf\n```' : m.body, attachments: i === 0 ? [{ name: 'report.pdf', size: 18000, path: '/home/fixture/.stam/attachments/fx-1/report.pdf' }] : [] })) as Mail[]) },
    { name: 'Superseded mail', render: () => panel(superseded) },
    { name: 'No messages', render: () => panel([]) },
  ],
}]
