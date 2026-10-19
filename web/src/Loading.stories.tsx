import { Loading, StamLoader } from './Loading'
import { ds, type Story } from './stories/types'

export const stories: Story[] = [{
  name: 'Loading',
  group: 'Primitives',
  what: "A view's first load: the stam logo at work, standing where the empty state will, so the view doesn't jump when its rows arrive. An accent arc turns round the logo's ring while the bot bobs and blinks. Never a skeleton.",
  when: "Until a view's first load lands (the store's `loaded` flags, or the view's own first fetch): the agent tree, the mail list, an agent's Mail tab, the Issues and Requirements sections, Work, Usage, Processes, an agent's own view, and the Settings and agent tabs that fetch on open. Buttons that load more (Earlier messages) keep their words. It fades in only after `--duration-hold`, so a fast load shows nothing. Once loaded, an empty view shows its empty-state text instead.",
  code: ['web/src/Loading.tsx#Loading', 'web/src/Loading.tsx#StamLoader', 'web/src/store.ts#Data'],
  rules: [
    "The loading mark is an exception the user asked for to \"motion never performs\" (S-1451), as the working dots are (" + ds('Motion') + ').',
    'Four stacked layers move by `transform` and `opacity` only, so the loop composites without repainting while the page fetches; no `transition: all`, no `scale(0)`, no layout property.',
    'Its turn, bob and blink run on `--duration-loader` (six `--duration-slow`), so reduced motion stills them; the arc\'s breathe is on `--duration-loader-breathe`, which doesn\'t zero, so a still mark still reads as working.',
    'Colours are the logo\'s, from tokens: the ring is `--border-subtle`, the arc `--accent`, the bot `--text-secondary`. Sizes are `--size-loader` in a list and `--size-loader-lg` alone in a pane.',
    'The mark is centred on both axes in whatever container it fills (`.loading`), whichever empty-state class the caller borrows (S-1907).',
    'Loading is the empty-state stack with the mark in the eyebrow\'s place (' + ds('Empty, loading, and error') + '); skeleton screens and shimmer stay banned.',
  ],
  states: [
    { name: 'In a pane (the tree)', render: () => <Loading /> },
    { name: 'In a sidebar list (mail, Issues)', render: () => <div className="mail-list"><Loading className="mail-empty" /></div> },
    { name: 'Large, alone in a pane', render: () => <div className="empty-pane"><StamLoader size="lg" /></div> },
  ],
}]
