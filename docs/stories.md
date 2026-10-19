# Stories

The stories page shows every visual component in `web/` with what it is, when it shows, the code behind it, its design-system rules, and its states. It is the UI's documentation, so keep it current: a change to a component updates its story in the same branch.

- Open it at `/stories` on any daemon (Settings links it), or `npm run dev` in `web/` and `/web/stories.html`.
- It runs with no daemon: `web/src/stories/fixtures.ts` seeds the store and stubs every `/api` request, so it makes none. The phone check (`web/check/phone.mjs`) asserts that, and that the page has no sideways scroll at 360 px.
- Each state renders in iframes at 360 and 1280 px wide, light and dark, so media queries are real. The frame is the same page with `?frame=ID&state=N&theme=light|dark`. Frames show at their real size by default, with a 2× zoom; only whole-page states shrink to fit (`fit`).

## Writing a story

Put a file next to the component, named after it: `web/src/Tree.tsx` gets `web/src/Tree.stories.tsx`. It exports `stories: Story[]` (`web/src/stories/types.ts`); the page finds it by its name, with nothing to register.

```tsx
import { ds, reply, type Story } from './stories/types'

export const stories: Story[] = [{
  name: 'Agent tree',             // unique; its id (the #story= link) is the name, slugged
  group: 'Tree and shell',        // Primitives, Mail, Composer, Tree and shell, ITSA and work, Settings, System view
  what: 'One paragraph: what it is.',
  when: 'The app state or route that shows it.',
  code: ['web/src/Tree.tsx#Tree'], // path#Symbol from the repo root, no line numbers
  rules: ['Rows are `--size-row-tree`; on a phone `--size-hit-touch` (' + ds('Density') + ').'],
  fit: 'actual',                  // the default; 'page' shrinks whole-page states to fit the column
  states: [
    { name: 'Empty', data: { agents: [] }, render: () => <Tree /> },
    { name: 'Loading', data: { loaded: { agents: false, mail: true, itsas: true } }, render: () => <Tree /> },
    { name: 'Error', routes: { 'GET /api/agents': reply(503, { error: 'fixture: unreachable' }) }, render: () => <Tree /> },
    { name: 'Menu open', height: 400, render: () => <OnMount run={open}>…</OnMount> },
    { name: 'Whole page', fit: 'page', render: () => <App /> },
  ],
}]
```

- **States**: the ones the component has, such as empty, loading, long, error, and each harness (claude, codex, opencode). A state that only draws an overlay (a menu, sheet, or viewer, all `position: fixed`) gives a `height`; others size to their content.
- **A state's own data**: `data` patches the store (`Data` in `web/src/store.ts`) over the shared fixtures; `routes` adds stub answers by `"METHOD /path"` (or `"METHOD /path?query"`, which wins), a plain body for a 200 or `reply(status, body)` for an error; `setup()` arranges anything else. The frame applies them before drawing (`applyState` in `fixtures.ts`), and the store and routes reset before each state, so nothing leaks between states.
- **Overlay**: a state with a `height` can name `overlay`, a CSS selector for what its overlay draws (`#search-palette`, `.machines-pop`); the stories test must find it in the state or in the menu layer beside it, so a state that opens nothing fails.
- **Fit**: `fit: 'actual'` (the default) shows a frame at its real size, so a 20 px mark stays 20 px, with the viewer's 2× zoom; a frame wider than the column scrolls sideways inside its box. `fit: 'page'` shrinks it to the column, for whole-page states at 1280. Set it on the story, or on one state.
- **Rules**: the design-system rules that hold for it: tokens, touch sizes, motion. `code` and `[links](url)` render; `ds('Heading')` links a heading of `docs/design-system.md`.
- **Fixtures**: invented only, never names, tokens, or mail text from a live database. Use `agent()` and `AGENTS` from `fixtures.ts` (names like `fixture-dev`, hosts like example.com), and add to them there. A story that needs a new `/api` route adds it to the stub's `ROUTES`; an unknown one answers 404 naming the route.
- **Helpers** (`web/src/stories/helpers.tsx`): `OnMount` runs a step once the state has drawn (opening a menu from its trigger), `holdTimers` keeps a transient notice up, `Row` lays out labelled examples.

`web/src/stories/stories.test.tsx` checks every story: the format, that each `code` symbol is still defined in its file, and that each state draws something from its fixtures (and a state with a `height`, its overlay).

## The merge check

`scripts/story-check.mjs` (the `stories` gate, added for any change under `web/src/`) fails a PR when an added or changed component file exports a component that no story's `code` lists, when any story's `code` link names a missing file or symbol, or when a component changed but its stories didn't. For the last, put `Stories: unchanged, REASON` in the PR body when the change has no visible effect. The same check refuses a PR that changes a motion file (`web/src/system/**` except tests and stories, the sidebar and row flip and motion hooks; S-1281) unless it also adds or changes a `web/check/*.mjs` browser check, or the PR body has `Motion check: none, REASON`.

A story names the code it covers in its `code` array, `path#Symbol` from the repo root. That is the only place a `path#Symbol` counts as a link: the `what`, `when` and `rules` may name other components in backticks without claiming to cover them. A story file that builds its stories through a helper may also pass that array positionally, as `mailblocks.stories.tsx` does: an array whose every string is a bare symbol name or a `path#Symbol` counts as a code list too (S-824).

`node scripts/story-check.mjs --pending` prints every component that has no story. The rollout that list tracked is done (S-1096), so on a current tree it prints nothing; a file it does name needs a story.
