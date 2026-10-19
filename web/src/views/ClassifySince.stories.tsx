import { ClassifySince } from './ClassifySince'
import { pressEach } from '../stories/settingsFixtures'
import { OnMount } from '../stories/helpers'
import { reply, type Story } from '../stories/types'

const P = { running: false, labelled: 0, failed: 0, remaining: 128, stopped: null, capped: false, concurrency: 2, lastError: null }
const poll = (o: object) => ({ 'GET /api/activity/classify-model': { ...P, ...o } })

export const stories: Story[] = [{
  name: 'Classify since',
  group: 'Settings',
  what: 'A date field and a button that label the open activity items from that date on with the decision model, not only new ones. It spends OpenRouter credit, up to the daily cap, and needs the classifier on. The backfill runs in the background: the control polls its progress every 3 seconds while it runs, and says how many are labelled and left, and why it stopped.',
  when: 'Settings, Activity, in the Classify since row. It reads `GET /api/activity/classify-model` when it mounts and starts a run with `POST /api/activity/classify-model`. The daemon answers only the human, so it works through stam\'s Tailscale address. On a peer it is read-only like the other shared settings.',
  code: ['web/src/views/ClassifySince.tsx#ClassifySince', 'web/src/views/ClassifySince.tsx#progressText'],
  rules: [
    'The date is the start of that day in this browser\'s time zone, sent as an ISO time.',
    'The button is disabled and reads "Classifying…" while a run is going; the progress line reads "N labelled · M left" and, once stopped, "stopped: done", "stopped: capped", "stopped: rate limited", or "stopped: failing (reason)".',
    'The progress and the answer are `muted` text with `role="status"`, so a screen reader hears them; the row wraps when it is too narrow (`flex-wrap`, `--space-2` gap).',
    'A refusal is said plainly: "Off: turn on Classify activity first." when the classifier is off, "A backfill is already running." when one is.',
  ],
  states: [
    { name: 'Ready', routes: poll({}), render: () => <ClassifySince /> },
    { name: 'Running', routes: poll({ running: true, labelled: 41, remaining: 87 }), render: () => <ClassifySince /> },
    { name: 'Done', routes: poll({ labelled: 128, remaining: 0, stopped: 'done' }), render: () => <ClassifySince /> },
    { name: 'Stopped at the daily cap', routes: poll({ labelled: 60, remaining: 68, stopped: 'capped', capped: true }), render: () => <ClassifySince /> },
    { name: 'Rate limited', routes: poll({ labelled: 12, failed: 4, remaining: 112, stopped: 'stalled', lastError: 'HTTP 429' }), render: () => <ClassifySince /> },
    {
      name: 'Classifier is off',
      routes: { ...poll({}), 'POST /api/activity/classify-model': reply(409, { error: 'classifier is off' }) },
      render: () => <OnMount run={pressEach('Classify since')}><ClassifySince /></OnMount>,
    },
  ],
}]
