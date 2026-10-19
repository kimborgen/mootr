import { SkillImport, SkillsList, SkillsSettings, type Skill, type UpdateState } from './SkillsSettings'
import { ds, pending, reply, type Story } from '../stories/types'

const all = { claude: 'native', opencode: 'native', codex: 'native' } as const
const skills: Skill[] = [
  { name: 'fixture-style', path: '/home/fixture/.claude/skills/fixture-style', source: 'user', description: 'How to write every answer: lead with the outcome, keep it short.', tokens: 2500, extraTokens: 0, reaches: all, attachedTo: ['developer', 'reviewer'], bodySummary: { state: 'auto', summary: 'Rules for short, front-loaded answers, with a check before sending.' } },
  { name: 'fixture-brainstorm', path: '/home/fixture/.stam/skills/fixture-brainstorm', source: 'stam', description: 'Parallel divergent ideation under several frames, then scoring and pruning.', tokens: 2900, extraTokens: 800, reaches: { claude: 'native', opencode: 'native', codex: 'unreachable' }, bodySummary: { state: 'pending' } },
  { name: 'fixture-imported', path: '/home/fixture/.stam/skills/fixture-imported', source: 'imported', description: 'A skill fetched from a repository.', tokens: 400, extraTokens: 12000, reaches: { claude: 'native', opencode: 'unreachable', codex: 'unreachable' }, origin: { url: 'https://github.com/fixture/skills', path: 'skills/fixture-imported', commit: '3f2a9c1d8e', date: '2026-10-12T10:00:00Z' }, bodySummary: { state: 'off' } },
]
const moved: Record<string, UpdateState> = { 'fixture-imported': { moved: true, commit: 'b71c0de4a2' } }
const same: Record<string, UpdateState> = { 'fixture-imported': { moved: false, commit: '3f2a9c1d8e' } }

export const stories: Story[] = [{
  name: 'Skills settings',
  group: 'Settings',
  what: 'Settings › Skills: every skill stam deploys, and an Import field that adds a public skill folder from GitHub. A row shows the skill name, its source (User, stam or Imported), its size in tokens and the SKILL.md description; it opens to an automatic summary of the body, the folder, and the size of its other files. A line says which agent types the skill is attached to (chips, or "Attached to no type"; attach on a type\'s page, Skills tab), and a line of harness marks says whether Claude Code, OpenCode and Codex reach the skill natively. An imported skill also shows its origin and commit, and an Update button when the origin changed under that folder.',
  when: 'Settings, Skills section, between Agent types and Tools. The list comes from GET /api/skills; imported skills are checked against their origin with GET /api/skills/updates after the list shows. Import and Update are POST /api/skills/import and /api/skills/update, which only the human may call.',
  code: ['web/src/views/SkillsSettings.tsx#SkillsSettings'],
  rules: [
    'The card and rows are those of Settings › Tools: rows fold with a chevron, and on a phone the summary rows are `--size-hit-touch` tall (' + ds('Density') + ').',
    'The summary says honestly when there is none: pending while asked, off with no model set, failed after an error. It is never invented.',
    'Reach is shown with the harness mark and a word, so it does not rely on colour (' + ds('Color semantics') + '); unreachable is muted.',
    'The Import field takes a GitHub URL, OWNER/REPO or OWNER/REPO/path. Downloaded files are untrusted: nothing runs at import, and a refusal (bad name, symlink out of the folder, too large, name taken) shows under the field and changes nothing.',
    'A refused Update shows its reason beside the Update button, not under the Import field.',
    'Update appears only when the origin\'s folder changed, not on any commit to its repository; a failed check says so and offers nothing.',
    'On a phone the field, Import and Update are `--size-hit-touch` tall (' + ds('Density') + ').',
    'Only design-system tokens; the section adds no colour, size or duration.',
  ],
  states: [
    { name: 'Three skills', routes: { 'GET /api/skills': skills, 'GET /api/skills/updates': same }, render: () => <SkillsSettings /> },
    { name: 'Update available', routes: { 'GET /api/skills': skills, 'GET /api/skills/updates': moved }, render: () => <SkillsSettings /> },
    { name: 'No skills', routes: { 'GET /api/skills': [], 'GET /api/skills/updates': {} }, render: () => <SkillsSettings /> },
    { name: 'Loading', routes: { 'GET /api/skills': pending(), 'GET /api/skills/updates': {} }, render: () => <SkillsSettings /> },
    { name: 'Error', routes: { 'GET /api/skills': reply(503, { error: 'fixture: unreachable' }) }, render: () => <SkillsSettings /> },
  ],
}, {
  name: 'Skills list',
  group: 'Settings',
  what: 'The list inside Settings › Skills: one fold per skill with its name, source chip, size in tokens, description and a line of harness marks; opened, it shows the body summary, the folder and the size of other files.',
  when: 'Inside the Skills settings section once GET /api/skills answers.',
  code: ['web/src/views/SkillsSettings.tsx#SkillsList'],
  rules: [
    'Rows fold like Settings › Tools; on a phone the summary rows are `--size-hit-touch` tall (' + ds('Density') + ').',
    'A missing body summary says why (pending, off, failed) and is never invented.',
    'Only design-system tokens; the list adds no colour, size or duration.',
  ],
  states: [
    { name: 'Source and reach mix', render: () => <SkillsList skills={skills} /> },
    { name: 'Update available', render: () => <SkillsList skills={skills} updates={moved} onUpdate={() => {}} /> },
    { name: 'Update refused', render: () => <SkillsList skills={skills} updates={moved} updateError={{ name: 'fixture-imported', message: 'the origin\'s skill is now called "renamed", not "fixture-imported"' }} onUpdate={() => {}} /> },
    { name: 'Updating', render: () => <SkillsList skills={skills} updates={moved} updating="fixture-imported" onUpdate={() => {}} /> },
    { name: 'Empty', render: () => <SkillsList skills={[]} /> },
  ],
}, {
  name: 'Skill import field',
  group: 'Settings',
  what: 'The field above the skills list: one text box for a GitHub URL, OWNER/REPO or OWNER/REPO/path, and an Import button. A refusal shows under it.',
  when: 'At the top of Settings › Skills. Enter or Import posts the source to POST /api/skills/import.',
  code: ['web/src/views/SkillsSettings.tsx#SkillImport'],
  rules: [
    'Import is disabled while the field is empty or an import runs; the field is disabled while it runs.',
    'The refusal is the daemon\'s own sentence, shown as it came and never softened into success.',
    'On a phone the field and button are `--size-hit-touch` tall and the field takes the full row (' + ds('Density') + ').',
  ],
  states: [
    { name: 'Empty', render: () => <SkillImport value="" busy={false} error={null} onChange={() => {}} onImport={() => {}} /> },
    { name: 'Filled', render: () => <SkillImport value="anthropics/skills/skills/pdf" busy={false} error={null} onChange={() => {}} onImport={() => {}} /> },
    { name: 'Importing', render: () => <SkillImport value="anthropics/skills/skills/pdf" busy error={null} onChange={() => {}} onImport={() => {}} /> },
    { name: 'Refused', render: () => <SkillImport value="o/r/skills/x" busy={false} error='the name "x" in SKILL.md must match its folder "y"' onChange={() => {}} onImport={() => {}} /> },
  ],
}]
