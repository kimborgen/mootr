# ITSAs: mootr's issue management (design proposal)

Status: agreed, 2026-10-11. Steps 1-5 and 8 are built. Revised after a critique by an advisor (comment delivery, cross-machine, ids, status overlap, cuts).

## The model

One nestable type, the **ITSA** (ITS-artifact). Initiative, project, milestone, issue, and sub-issue are only a `kind` label on it; any ITSA can hold any other, to any depth. Like everything in mootr, it's optional: agents and the human can ignore it and use mail alone.

| Field | Meaning |
| --- | --- |
| `id`, `key` | Internal short id, plus a readable key decided in step 1 and never changed (`S-42`; prefix in settings, later per island), because keys end up in mail, PR bodies, and Linear. |
| `parent_id` | The ITSA it lives in; none for a root. One parent (a tree, like Linear); other relations are links. |
| `kind` | Optional label with defaults: initiative, project, milestone, issue. Only shown on cards; no rules attach to it. |
| `title`, `summary` | Title and one-line description (the card text). A title is 1-4 words, a noun phrase that names the thing (`Phone mail header`): no sentence, colon, cause or fix, and no parent key or "part N" prefix. Detail goes in `summary` and `body` (S-1013; rule in `blocks/itsa/20-itsa-owning.md`). |
| `body` | Markdown with every mail component (decision, checklist, chart, diagram...). Edited in place; old versions kept. |
| `status` | One of a rich set, each in one of six categories (next section). |
| `owner` | An agent, `human`, or nobody. |
| `participants` | Agents and `human`; they get the ITSA's comments and updates. Owner is always one. |
| `thread_id` | The ITSA's mail thread: comments and updates (next sections). |
| `links` | Rows of system (`github`, `linear`, `jira`, `url`), external id, and url. |
| `created_by`, timestamps, `machine` | `machine`: the daemon that stores it (see Cross-machine). |

Tables: `itsas`, `itsa_participants`, `itsa_links`, and `itsa_events` (append-only activity: status, owner, field changes; feeds the timeline and roll-ups).

Cut from v1, each easy to add later: relations (blocks, duplicate of), body versions, priority, due dates, labels, grouping boards by owner or kind, Jira.

### Statuses

Many statuses, five categories. Categories drive the board columns and roll-ups; statuses are names inside them, editable in Settings. Waiting on the human is a flag on a status, not a category, so it can appear wherever the work is.

| Category | Statuses (defaults; **bold** waits on the human) |
| --- | --- |
| Backlog | `idea`, `backlog`, `icebox` |
| Ready | `todo`, `ready`, `scheduled` |
| Active | `planning`, `in_progress`, `delegated` (children own the work), `waiting` (an agent, a job, CI), `blocked`, **`needs_input`** (a decision), **`needs_approval`** |
| Review | `in_review` (an agent reviewer), `testing`, **`needs_review`**, **`needs_test`** (try it yourself), `ready_to_merge` (a manager merges it), `merging`, `deploying` |
| Closed | `done`, `canceled`, `duplicate`, `wont_do` |

`blocked`, any human status, and Closed tell the parent ITSA's owner.

A parent ITSA shows a roll-up of its children (counts per category, a progress bar). Its status isn't derived automatically; its owner sets it, prompted by notices.

## Comments and updates are mail

Each ITSA owns one mail thread, created with the ITSA (subject `#k3f9q Title`). Nothing new to learn: agents comment with `send_mail` and `reply_to` (or `itsa_post`), and the human replies from the ITSA's world exactly as in any thread, components and Decision buttons included.

- **Comment:** a mail in the thread. Recipients default to the participants, minus the sender. Mailing into the thread makes the sender a participant.
- **Quiet delivery:** ITSA mail doesn't interrupt a working agent. Today every tool call with unread mail returns a "stop and read your inbox" notice; ITSA comments and updates skip that notice and arrive as one batched prompt when the agent is idle. Mail that names the agent (`@name`), comes from the human, or comes from the ITSA's owner to a child's owner interrupts as usual. Without this, an owner with chatty children is interrupted on every comment.
- **Update:** a mail in the thread marked `kind: update` with a health (`on_track`, `at_risk`, `off_track`), like Linear's project updates. Posted by the owner (`itsa_post kind=update`); shown pinned at the top of the ITSA, newest first, and as the card's health dot.
- **System lines:** status and owner changes show in the thread as one-line events from `itsa_events`, not as mail, so nobody gets notified twice.
- The human is a participant only when they own the ITSA, are added, or the ITSA enters a Human status. Then the mail follows the human-mail rules, and the Human status's mail is the one-issue thread the rules already ask for.

## Owners and the agent tree

Owning an ITSA means: you drive it to Closed, keep its status true, post updates, and answer its comments.

- An owner breaks its ITSA into children with `itsa_create parent=…`. For each child it either keeps ownership, assigns an existing agent, or spawns a new owner: `spawn_agent … itsa=ID` makes the new agent the child ITSA's owner, puts the ITSA (title, body, parent chain, links) in its first prompt, and its system prompt says which ITSAs it owns.
- So the agent tree usually mirrors the ITSA tree, because the owner of a parent ITSA spawns the owners of its children. It isn't forced: one agent can own many ITSAs, an ITSA can change owner, and the human can own any.
- Walk an agent's children or descendants only through `src/tree.ts` (`childrenOf`, `descendantsOf`): the local db alone misses children on the peer machine (S-1156, S-1379); `test/tree.test.mjs` refuses `db.childrenOf` elsewhere, and reads of `agent_parents` or `agents.parent_id` outside `tree.ts`, `db.ts` and `cost-switch.ts` (S-1447). To index every parent link at once, use `tree.edges`.
- Notices, not mail, between owners: the parent ITSA's owner gets a notice (same channel as child-turn notices) when a child ITSA enters Human, `blocked`, or Closed, or its owner stops. Configurable like `childNotices`: `settings.itsa.ownerNotices`, `on` (default) or `off`. Nothing is sent when the parent ITSA's owner is the human or nobody. The owner's system prompt names the open ITSAs it owns (built on every start and resume, so it stays true after a restart).
- An owner archived or forgotten leaves its ITSAs unowned (Ready category if they were Active) and notifies the parent ITSA's owner.
- The agent tree shows, per agent, its owned ITSA as a chip (title, status colour); the ITSA shows its owner's state ring.
- Bulk edits to ITSAs owned by others (S-1047): a manager writes a `{key, old, new}` mapping, and cos applies it with a CLI script under its own token, since owners' agents can't `itsa_set` ITSAs they don't own. The script skips an ITSA whose title changed since the mapping and logs the old value for undo (S-1006, 76 retitles).

## Where the human attends

- **Human statuses** are the hook. An agent moves an ITSA to `needs_review` (with its branch and any external link); mootr adds the human as participant and mails them in the ITSA thread with the matching action: Approve or Request changes, Merge (the merge queue's action, 8b), a Decision block for `needs_input`. The `request_permission` flow stays as it is; it only joins the same list.
- **One attention list:** pinned at the top of the human's mail list: pending permission requests and every ITSA in a human status, merged, oldest first. No second mechanism. The same filter works on any board.
- **Closing:** the owner closes its own ITSA; the human gates through human statuses the owner chooses to pass through (review, merge).
- **Buttons act**: Approve moves the ITSA to its next status (configurable per status, `settings.itsa.actions`; `ready_to_merge` isn't a human status by default, since a manager merges); Request changes moves it back to `in_progress` and sends the reply text to the owner.
- **Following along** without being asked: any board, the ITSA world, and the agent tree chips. No mail unless a Human status or the human is a participant.

## Web UI

- **Sidebar:** an Issues section under the agent tree (resizable like mail): root ITSAs as rows with a status glyph and roll-up bar, expandable into the tree.
- **ITSA world** (`w:itsa:ID`), like an agent's or a thread's world. Default tabs: the ITSA view (header with title, status, owner, kind, health; summary; body; updates; the thread with its reply box; links; children as a list) and the board of its children. Tabs and splits work as in every world: add the owner's terminal beside it.
- **Board, desktop:** one column per category by default (five), statuses as chips on cards; a toggle shows one column per status. Cards: title, kind, owner's harness mark and state ring, health dot, children roll-up, link icons (PR state). Drag between columns sets the status (to the category's first status, or the exact column in per-status mode); drag within sets order. Scope: an ITSA's children, or its whole subtree flattened, or every root.
- **Board, phone:** one column at a time with a strip of column chips showing counts (tap, or swipe sideways); cards full width. Moving a card: long press or the card's menu opens a bottom sheet of statuses. Tap opens the ITSA world. Checked by `web/check/phone.mjs` with touch, like the rest.
- All on the existing tokens and `docs/design-system.md`; status colours map onto existing state tokens, no new colours.

## MCP tools

Five tools, mirrored as `stam itsa …` in the CLI and `/api/itsas` for the UI:

- `itsa_create`: parent, title, summary, body, kind, status, owner, participants, links.
- `itsa_get`: an ITSA with its parent chain, children (one level, with roll-ups), latest update, recent thread messages, links.
- `itsa_list`: filters: mine (owned or participating), parent, subtree, status or category, owner, kind, text.
- `itsa_set`: change any field (status, owner, participants, body, links, relations); returns what changed.
- `itsa_post`: comment or update (with health) into the ITSA's thread. A thin wrapper on `send_mail`.

Plus `spawn_agent itsa=ID`. The system prompt gets a short `itsa.md` template: what ITSAs are, that they're optional, how owners behave. Everything stays in editable templates.

## Links to external tools

mootr's ITSA is the hub; an external item is linked to it by URL (any URL, icon by host), never the other way round. Decision (2026-10-11): mootr complements GitHub and Linear and won't sync with them — no imports, no two-way sync, no GitHub PR polling — and external connections and events are covered elsewhere (S-5).

## Islands

Not built now. When needed: an `island` table (name, settings overrides, instructions, default status set, key prefix for readable ids, external workspaces it syncs with), and `island_id` on ITSAs and agents. Until then everything is in one implicit island; a root ITSA of kind `initiative` fills the role for organising work. Nothing in this design blocks adding them.

## Cross-machine

Every ITSA lives on one home daemon (`settings.itsa.home`), threads included; other daemons proxy ITSA calls to it, as they already forward requests about remote agents. ITSAs are low-volume, so a single home costs little, and it gives one key counter, plain subtree queries, and boards without cross-daemon joins. If the home is down, ITSA tools fail with a clear error while mail and agents keep working. The alternative, each tree on its root's daemon, avoids that single point but makes keys and cross-tree boards harder; rings already show how per-daemon state hurts (status, Open 6).

## Build plan

Each step is one small change, one agent in its own worktree, reviewed by Codex `gpt-6.1-sol` at low effort, merged by cos. Step 1 is usable on its own (agents and the assistant track work through the CLI and MCP).

| # | Change | Model |
| --- | --- | --- |
| 1 | Storage, API, CLI: `itsas` and its tables, keys, statuses from settings, `/api/itsas`, `stam itsa`, home-daemon proxying, unit tests | OpenCode DeepSeek flash |
| 2 | MCP tools and `itsa.md` template; e2e test with a live Haiku agent creating, nesting, and closing ITSAs | OpenCode DeepSeek flash |
| 3 | Thread binding: each ITSA's thread, comments to participants, updates with health, event lines, quiet delivery | Claude Code Sonnet |
| 4 | Owners: `spawn_agent itsa=`, notices to the parent ITSA's owner, unowning on archive | Claude Code Sonnet |
| 5 | Web: ITSA world (view, thread, children list) and the Issues sidebar section | Claude Code Opus (UI judgment) |
| 6 | Web: board on desktop, drag to change status | Claude Code Opus |
| 7 | Web: board on the phone, column strip, move sheet, phone checks | OpenCode DeepSeek flash |
| 8 | Human attention: human statuses mail the human with action buttons, one merged attention list, tree chips | Claude Code Sonnet |
| 8b | Merge queue: it lists the ITSAs in `ready_to_merge` that link a branch (new link system `branch`: repo and branch name), shown with diff stat, merge-cleanly check, latest review verdict, test results, and screenshots from the thread; Merge and Deploy buttons running per-repo commands from settings (stam: merge then tests; `stam deploy` plus storage). | Claude Code Sonnet |
| 10 | Every agent in an ITSA (S-41): `settings.itsa.required` (default on); a spawn with no `itsa` joins the parent's most recently updated open ITSA as a participant, through the home daemon and never blocking the spawn; the system prompt, the Instructions view, and OpenCode's system endpoint list owned and participated ITSAs separately; `GET /api/agents` carries whether each agent is in any open ITSA and the tree marks the rows with none. | OpenCode DeepSeek flash |
| later | Islands | |

Steps 1 and 2 together are the first usable slice: agents and the assistant track work through MCP and the CLI, no UI needed.

## Decisions (2026-10-11)

1. Comments and updates live in the ITSA's own mail thread.
2. ITSAs live on one home daemon, with readable keys like `S-42`.
3. The owner closes its ITSA; the human gates through review and merge statuses.
4. mootr complements GitHub and Linear and won't sync with them: links only. External connections and events are covered elsewhere (S-5).

Decided by the manager: ownership is loosely tied to the agent tree; categories are fixed and statuses editable in Settings; one attention list.
