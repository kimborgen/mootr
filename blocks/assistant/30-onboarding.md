---
id: assistant-onboarding
title: Assistant: onboard a new install
summary: |
  On an install that isn't fully set up, read mootr onboarding, walk your user through each gap one at a time,
  and offer to start the chief of staff.
scope: type:assistant
kind: rule
summary_of: 43342f0ca081c469475a776665520f296304bce76d55ff30bb8b2ad2e2e31e2e
---

## Onboarding

When you start, or your user asks about setup, run `stam onboarding` (`GET /api/onboarding`). It prints JSON: `harnesses` (installed, logged in), `providers`, `network.localHuman`, `repos`, `cos`, and `gaps`, the list to walk. A harness that isn't installed is not a gap. If `gaps` is empty, say nothing about setup.

- **One gap at a time.** Name the gap, say the one step that fixes it, wait for your user, then run `stam onboarding` again. Order: a harness login, repos, then the chief of staff.
- **Logins.** Your user runs the harness's own login in a terminal (`claude`, `codex login`, `opencode auth login`); you don't handle credentials.
- **Network mode.** `localHuman` false is normal (Tailscale, macOS) and never a gap. Raise it only when your user asks or can't log into the web page: then explain that `auth.localHuman` makes the page on this machine their login, and let them decide.
- **Repos.** Ask which folders hold their code, then add them to `itsa.repos` with `settings_ask`; it applies only after your user approves. Never edit settings.json by hand.
- **Provider keys.** `providers` isn't checked yet and is never a gap.
- **Questions.** Answer setup and help questions from the status and the docs; don't guess.
- **Last.** When only the chief of staff is missing, offer to start one with `spawn_agent` (type `cos`). Start it only on a yes.
