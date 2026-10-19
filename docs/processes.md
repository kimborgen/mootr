# Processes

A process is a picture of how work moves through stam: one YAML file per process under
`processes/` at the repo root, named `<id>.yaml` with `process: <id>` inside. Step 1 is
read-only: the daemon draws them and counts the live ITSAs at each node; nothing runs a
process yet. The shape is in `processes/schema.json`; the loader and validator are in
`src/process.ts` (`parseProcess`, `loadProcesses`).

`GET /api/processes` serves them with live counts: `{ processes, errors }`, each process with a
`counts` entry per node that names `statuses` (`processCounts` in `src/process.ts`; a peer
proxies the path to the ITSA home, where the ITSAs are).

## The file

```yaml
process: dev-change          # the id; must equal the file name
title: Dev change
description: optional text
applies_to: { kind: [issue] }  # which ITSA kinds are instances; optional

lanes:                        # lane id -> an agent type from the registry, or human / script / cos
  human:     { type: human }
  developer: { type: developer }
  reviewer:  { type: reviewer, fallback: reviewer-opus, machine: storage }   # fallback, machine: optional

# A lane's `machine` (optional) is where its agents are spawned when the runner spawns them (process.run=on); the type's default otherwise.
nodes:                        # node id -> node; the id is a lowercase slug
  request:
    kind: start
    lane: human
    label: Mail from the human
    triggers:                 # start only: one or more; drawn only, never subscribed in step 1
      - { source: mail, actors: [human] }
      - { source: timer, cron: "0 6 * * *" }
  code:
    kind: agent
    lane: developer
    label: Implement, test, pr_open
    statuses: [in_progress]   # the ITSA statuses that count as "at this node" (live counts)
    done_when: pr_opened
    boundary:                 # optional, on a task
      - { on: cost, action: pause }
  done:
    kind: end
    lane: watcher
    status: done

edges:                        # [from, to] or [from, to, options]
  - [request, code]
  - [code, done, { when: "verdict == approve", label: approve }]
```

Node order is kept as written: the UI uses it as a layout hint. `edges` normalise to
`{ from, to, when?, label? }`, and `applies_to` becomes `appliesTo`.

## The eight node kinds

- **start** — where the process begins. Needs one or more `triggers` (each a `source` such as
  `mail`, `github`, `slack`, `feedback`, `retro`, `itsa`, `timer`, or `manual`, with optional
  `subjects`, `types`, `actors`, and a `cron` for `timer`). No incoming edges.
- **end** — where it finishes, with `status: done | canceled | wont_do`. No outgoing edges.
- **agent** — an agent does the work; its lane names the type. Optional `done_when` and, as a
  sub-process, `call: <process id>` (it must name another loaded process).
- **human** — waits on your user; `ask: approve | decide | answer | review | test`.
- **script** — runs a command (`run`), such as `scripts/merge-pr.mjs`.
- **exclusive** — a gateway that takes exactly one outgoing edge, each guarded by its `when`.
- **parallel** — a split or join: several outgoing edges (or several incoming ones) at once.
- **wait** — waits for an event (`event`), such as the deploy watcher's `deploy`.

A node may carry brief text (S-925): `brief` is the next-step text its lane's agent type gets where its
brief has `{{next_steps}}`, and `tell: { lanes: [...], text }` is text the briefs of those other lanes carry
about the step (the manager's verbatim reviewer sentence). `renderNextSteps` joins them in node order. With
no process loaded, the brief falls back to the text in `src/process-brief-fallback.ts`.

A task (agent, human, or script) may also carry `boundary` events: a list of
`{ on: cost | timeout | error, action?, minutes?, interrupting? }`, drawn as interruptions.

## Statuses and validation

`statuses` on a node map its ITSA statuses for live counts; each status may sit on only one
node in a process. `ready_to_merge`, `merging`, and `deploying` are ordinary statuses; the
human statuses (`needs_input`, `needs_approval`, `needs_review`, `needs_test`) belong on a
human node. A status no node names simply isn't counted.

`parseProcess` checks the file itself and `loadProcesses` adds the cross-file checks: unknown
kind, a missing or unknown lane, an edge to an unknown node, a start with an incoming edge, an
end with an outgoing edge, a start with no trigger, a trigger with no source, an unknown ITSA
status, a status on two nodes, a `call` to a process that isn't loaded, and a `process` that
doesn't match the file name.

## The editor (S-1083, step 5a)

**Edit** in the Process view opens a working copy of the selected process in the browser. **Discard** drops the copy; **Save as proposal** (step 5b, below) is the only way an edit leaves the browser.

- **Nodes:** the Add panel picks a kind, a lane and a label; on a desktop the palette also drags a kind onto a lane. A node's panel (a side panel on a desktop, a bottom sheet on a phone) edits its label, kind, lane, id, statuses, brief, and the field its kind carries (`ask`, `status`, `run`, `event`, `call`, `triggers`). Deleting a node removes its edges.
- **Edges:** drag from one node's handle to another on a desktop, or **Connect to…** in the node's panel (the only way on a phone). The panel lists a node's outgoing edges with their `when` and `label`, and deletes an edge.
- **Lanes:** the Lanes panel adds, edits (type, label, fallback, machine) and deletes lanes.
- **Layout** stays automatic (Dagre); no positions are stored.
- **Validation** is live and is the loader's own: `web/src/process/edit.ts` writes the draft to YAML and parses it with `parseProcessText` from `src/process-validate.ts`, the pure core `parseProcess` wraps. A problem marks its node or edge and is listed under the bar.
- **Review** shows the YAML diff of the draft against the file. `GET /api/processes` sends each process's `source` text, and `mergeIntoSource` (`edit.ts`) patches only the changed lines into it, so comments, alignment and flow style stay and a one-field edit is a one-line diff. Against a daemon that sends no `source`, the diff is against the loaded process written back out.

Boundary events and a node's `tell` aren't editable in the panel yet; they are kept as loaded.

## Saving an edit as a proposal (S-1084, step 5b)

**Save as proposal** (in the review panel, with a summary) sends the patched file to `POST /api/processes/:id/proposal {yaml, summary}`. The editor calls it as the human; an agent calls the `process_propose` tool (S-1085: `id`, `yaml`, `summary`, and a required `base`, the exact text it edited from, so a stale base is refused with 409), which lands on the same route and `propose` (`src/process-proposal.ts`) with the agent as `by`. An agent's proposal ends at `needs_approval` and a PR: only the human's Approve leads to a merge, and the owner's merge notice names the commit (`Commit:` in the proposal body) to merge only if the PR head is still. An agent may hold 3 open process proposals (429 beyond); at the route an agent must send `base` (400 otherwise). On the ITSA home, `propose`:

1. checks the file with `parseProcess` against the registry's agent types (a `call` must name a loaded process), and refuses an empty summary or a file equal to `main`'s;
2. files a `proposal` ITSA in `needs_approval` under S-866 (`STAM_PROCESS_PROPOSAL_PARENT` overrides the key), owned by the chief of staff, whose body starts `Process proposal: ID` and holds the summary and the diff;
3. in a scratch `git worktree` made from `origin/main` (the live checkout's files and branch are never touched), commits the file to `process/ID-…` and pushes the branch;
4. opens a PR with the `docs/pull-requests.md` body (`ITSA:` the proposal, `Gates: run process process-counts process-stage process-run`), links the PR and the branch to the proposal and writes the PR into its body.

A failure after the ITSA exists cancels it and deletes a pushed branch. Nothing changes until the PR merges.

Your user's **Approve** on the proposal tells its owner to have the PR reviewed (`scripts/pr-review.mjs`) and merged (`scripts/merge-pr.mjs`); the deploy watcher closes the ITSA after the deploy. **Request changes**, or a proposal closed as canceled or won't-do, closes the PR and deletes its branch. The existing proposal gate (`src/retro-loop.ts`) already stops an agent from moving the proposal to merge or done before the human approved it.
