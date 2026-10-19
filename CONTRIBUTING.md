# Contributing to mootr

Thanks for looking. mootr (repository `https://github.com/kimborgen/mootr`) is a work in progress, so small, focused changes are the easiest to review.

## Setup

The CLI is still named `stam` during the rename to mootr.

Node.js 24 or later, git and tmux; see the README for the full list.

```sh
npm run setup      # installs the root and web/ dependencies
npm run build      # build the web UI
npm run typecheck  # tsc --noEmit
```

## Tests

- `npm test` runs `sh test/run.sh`. Run only the tests a change touches (`sh test/run.sh NAME`), plus `npx tsc --noEmit` and the vitest suite in `web/` (`npm test` inside `web/`).
- Tests are deterministic and never depend on a real model. Agents in tests run the scripted fake Claude Code (see `docs/testing.md`), model calls go to stubs, and tests wait on state, not on time.
- Smoke tests (`sh test/run.sh --smoke`) use real harnesses and cost money. Run them by hand, never in CI.
- Tests that depend on the machine set `STAM_MACHINE` explicitly. A test cleans up every daemon, tmux server and unit it starts.
- A change to hook behaviour touches both `src/cli.ts` and `bin/stam-fast`.
- A new tool or API parameter gets a default and is never required at first, because running agents keep the old schema.

## Web UI

- Follow `docs/design-system.md`. Use only the tokens in `web/tokens.css` and `web/tokens-stam.css`; never add a colour, size, or duration elsewhere.
- Design for the phone (360-430 px, touch) as carefully as for the desktop, and check both. The checks live in `web/check/` and `test/e2e-ui*.sh`; they need Playwright Chromium (`npm run install:chromium`).
- A component under `web/src` has a `.stories.tsx` that you update in the same change (what it is, when it shows, rules, states); see `docs/stories.md`.

## Pull requests

- One small logical change per pull request, with a test that proves it.
- Keep to the style of the code around your change: naming, comment density and idiom.
- Say what you ran and what passed in the description.
