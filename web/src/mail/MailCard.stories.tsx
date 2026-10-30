import { MailCard } from './MailCard'
import { ds, type Story } from '../stories/types'
import { Row } from '../stories/helpers'
import { ASK_ITSA, DECISION, kinded, mail, T_K_BLOCKER, T_K_DECISION, T_K_DONE, T_K_GENERAL, T_K_LONG, T_K_OLD, rapidThreads, STATUSES, T_ASK, T_LONG, T_PERM, T_PLAIN, T_RICH, T_UNREAD } from '../stories/mailFixtures'
import type { Thread } from '../types'
import { humanRowsOf } from './thread-index'

// A mail with a model's summary (S-1002), and one whose body is long and starts with a heading.
const T_SUMMARY: Thread = { thread_id: 'fx-t-sum', mails: [{ ...mail('fm-sum', 'fx-t-sum', 'fx-dev', ['human'], 'Login fails for SSO users', 'Long body.', { read: false, min: 5 }), summary: 'SSO login works again after the fix in PR #356. Pick a token lifetime before Friday:\n- 1h: safest, users re-login daily (recommended)\n- 12h: one login per workday' } as never] }
const LONG_BODY = '## Nightly build report\n\n' + 'The nightly build ran every suite on both machines and every one of them passed, with the cache warm and the flaky retry test quiet for the third night in a row. '.repeat(6)
const T_BODY: Thread = { thread_id: 'fx-t-body', mails: [mail('fm-body', 'fx-t-body', 'fx-ops', ['human'], '', LONG_BODY, { min: 300 })] }
// A long title, a long Markdown summary with bullets, bold, code and an ITSA key; and a body with a code block and a table.
const T_MD: Thread = { thread_id: 'fx-t-md', mails: [{ ...mail('fm-md', 'fx-t-md', 'fx-dev', ['human'], 'Re: Which token lifetime should SSO sessions get now that the refresh flow, the idle timeout and the admin override all interact (S-12)?', 'Long body.', { read: false, min: 8 }), summary: 'SSO login works again after the **PR #356** fix. Pick a `token_ttl` before Friday:\n- 1h: safest, users re-login daily (recommended)\n- 12h: one login per workday\n- 7d: only with the admin override on\n\nSee [the PR](https://example.com/356) and S-12.' } as never] }
const T_BODY_MD: Thread = { thread_id: 'fx-t-bmd', mails: [mail('fm-bmd', 'fx-t-bmd', 'fx-ops', ['human'], 'Nightly build report', '## Results\n\nEvery suite passed on both machines:\n\n```sh\nnpm test\ntest/run.sh --all\n```\n\n| Suite | Time | Result |\n|---|---|---|\n| unit | 41s | pass |\n| e2e | 6m | pass |\n\n' + 'More detail follows in the thread. '.repeat(60), { min: 20 })] }
const T_K_WIDE = kinded('fx-k-wide', 'decision', 'Which path should the export write to?', 'Which path should the export write to?\n- ' + '/srv/exports/'.repeat(25) + ': a 300-character option with no break to wrap at (recommended)\n- Elsewhere: ask each time')
const card = (t: Thread, selected?: boolean, side?: 'sent') => <div style={{ maxWidth: 480 }}><MailCard thread={t} selected={selected} side={side} onTap={() => {}} /></div>
const [, T_ANSWERED, T_FOLLOWED] = rapidThreads(3)

export const stories: Story[] = [{
  name: 'Mail card',
  group: 'Mail',
  what: 'One mail thread as a minimal card: who wrote last (glyph and name), an unread dot, a band naming its kind (decision, blocker, done, or plain mail) with an icon, a left edge in the kind\'s colour, a chip for what it holds (an approval, an ITSA ask with its status, or the ITSA it is about), attachments and the message count, the age, and the thread title, and a short version of what the mail says: the mail\'s model summary (a condensed copy of the content, with line breaks and bullets; a decision shows its question and options with the recommended one badged, a blocker or done card its Problem, Solution, Deferred and Note as labelled sections, and a summary off that contract shows as Markdown), else the first lines of its body as prose, else its title and subject, else its subject. It knows nothing of gestures; whoever shows it moves it.',
  when: 'The Swipe view (`w:swipe`) stacks them; the conversation view\'s rapid-fire mode (S-1004) lists them with `side="sent"`, which speaks for the first mail you sent in the thread, in your own first line, and heads it with who wrote last, and `selected` for the thread a follow-up goes to.',
  code: ['web/src/mail/MailCard.tsx#MailCard', 'web/src/mail/MailCard.tsx#cardText', 'web/src/mail/MailCard.tsx#firstLine', 'web/src/mail/MailCard.tsx#sentMail', 'web/src/mail/MailCard.tsx#sentText'],
  rules: [
    'A sheet: `--surface-page`, a `--stroke-card` hairline in `--border-default`, `--radius-sm`, no shadow at rest (' + ds('Shadow assignment') + ').',
    'The thread title heads the body in `--type-chrome-xl` semibold, three lines at most (an ellipsis cuts a longer one). The text is the mail Markdown through the shared mail renderer (lists, bold, code, links, ITSA keys, tables), read-only, bounded by a height with a fade, in `--type-chrome-md` (`--type-chrome-lg` on a phone); unread is the dot and a medium weight, never colour alone (' + ds('State vocabulary') + ').',
    'The kind band holds an icon and a word besides its colour: warning for a decision, error for a blocker, success for done, neutral for plain mail (' + ds('State vocabulary') + '). A sent card has no band. The recommended option has a success badge with a check and the word.',
    'An approval or an ITSA ask waiting on you is a warning badge with a glyph and words; an ITSA it is about is a neutral chip (' + ds('Checkboxes and badges') + ').',
    'A card that shows a mail from its start keeps the recorded snapshot range (`shown`, S-2998) and draws the snapshot above the rest as the thread does; when the card cuts the body or shows a summary, the range fails its own check and the text renders as before.',
    'Selected is `--accent-subtle` with its border, as a selected row is; never a solid accent fill (' + ds('Developer rules') + ').',
  ],
  states: [
    { name: 'Read, plain', data: { humanRows: humanRowsOf([T_PLAIN]) }, render: () => card(T_PLAIN) },
    { name: 'Unread, with a title', data: { humanRows: humanRowsOf([T_UNREAD]) }, render: () => card(T_UNREAD) },
    { name: 'Card kinds', data: { humanRows: humanRowsOf([T_K_DECISION, T_K_BLOCKER, T_K_DONE, T_K_GENERAL]) },
      render: () => <Row items={[{ label: 'Decision: the question, a four-option list, one recommended', node: card(T_K_DECISION) }, { label: 'Blocker: problem and solution', node: card(T_K_BLOCKER) }, { label: 'Done: problem, solution, deferred, note', node: card(T_K_DONE) }, { label: 'General', node: card(T_K_GENERAL) }]} /> },
    { name: 'Kind with a long title, or an old-style summary', data: { humanRows: humanRowsOf([T_K_LONG, T_K_OLD]) }, render: () => <Row items={[{ label: 'Blocker, long title and text', node: card(T_K_LONG) }, { label: 'Decision whose summary is off the contract: Markdown, as before', node: card(T_K_OLD) }]} /> },
    { name: 'A long unbroken option', data: { humanRows: humanRowsOf([T_K_WIDE]) }, render: () => card(T_K_WIDE) },
    { name: 'With a condensed summary', data: { humanRows: humanRowsOf([T_SUMMARY]) }, render: () => card(T_SUMMARY) },
    { name: 'Waiting on you', data: { humanRows: humanRowsOf([T_PERM, T_ASK, T_RICH]), attention: [ASK_ITSA], itsas: [ASK_ITSA as never], decisions: [DECISION], itsaStatuses: STATUSES },
      render: () => <Row items={[{ label: 'Approval', node: card(T_PERM) }, { label: 'ITSA ask', node: card(T_ASK) }, { label: 'Decision', node: card(T_RICH) }]} /> },
    { name: 'Long thread, long body', data: { humanRows: humanRowsOf([T_LONG, T_BODY]) }, render: () => <Row items={[{ label: 'Sixteen messages', node: card(T_LONG) }, { label: 'No summary: the first lines of the body', node: card(T_BODY) }]} /> },
    { name: 'Long title, Markdown summary', data: { humanRows: humanRowsOf([T_MD]) }, render: () => card(T_MD) },
    { name: 'Body with a code block and a table', data: { humanRows: humanRowsOf([T_BODY_MD]) }, render: () => card(T_BODY_MD) },
    { name: 'Selected', data: { humanRows: humanRowsOf([T_PLAIN]) }, render: () => card(T_PLAIN, true) },
    { name: 'Sent by you', data: { humanRows: humanRowsOf([T_ANSWERED, T_FOLLOWED]) }, render: () => <Row items={[{ label: 'Answered, unread', node: card(T_ANSWERED, false, 'sent') }, { label: 'Your follow-up last, selected', node: card(T_FOLLOWED, true, 'sent') }]} /> },
  ],
}]
