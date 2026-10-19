# Activity categories

The activity tree (S-204) says what each agent item is *for*. Its definitions are the classifier's prompts, copied verbatim from the S-204 draft into `src/activity-categories.ts`, which the code reads. The wait tree (what an agent's clock waits on) is stored in `activity_items.wait_kind` by S-210 and lives in the same file.

Every item gets one activity leaf, unless it is a gap (a gap's wait kind says it all). The keys are `top.leaf`, stored in `activity_items.category`.

## Activity tree (13 top-level, 73 leaves)

### understand — learn what is there
- understand.task: read the task, brief, instructions, rules, skills
- understand.material: read the primary material (source code, a document, a dataset)
- understand.search: search for where something is (grep, find, ls, glob)
- understand.history: read change history (git log/show/blame, an ITSA's history)
- understand.state: inspect the live state of a system (ps, curl an API, a DB read, `stam ls`)
- understand.output: read output or logs of a run or job
- understand.external: research outside sources (web search, fetch, external docs)
- understand.experiment: run something only to observe behaviour

### plan — decide what to do
- plan.steps: announce or lay out next steps
- plan.design: write a design, spec, or brief
- plan.options: compare alternatives and choose
- plan.prioritize: order or schedule work against capacity, budget, time
- plan.estimate: estimate size, time, or cost

### produce — create or change the deliverable
- produce.write: create a new artifact (file, document)
- produce.edit: change an existing artifact
- produce.tests: write or change tests or checks
- produce.docs: write documentation or prose for others
- produce.config: change configuration, settings, environment
- produce.script: write a one-off script or tool for own use (analysis, migration)
- produce.data: create or transform data (fixtures, exports, a table)
- produce.media: create images, diagrams, recordings

### verify — check that work is right
- verify.static: typecheck, lint, build, compile, syntax check
- verify.unit: run fast/unit tests
- verify.integration: run integration or end-to-end tests
- verify.visual: check UI or visual output (screenshots, viewports)
- verify.probe: a manual check of one behaviour (curl, a one-liner)
- verify.review: review a change (own diff or someone else's)
- verify.rerun: rerun to confirm a fix or rule out a flake
- verify.measure: measure performance, size, cost, or quality

### diagnose — find why something is wrong
- diagnose.read-failure: read and interpret a failure
- diagnose.hypothesis: state or test a likely cause
- diagnose.instrument: add logging, bisect, or narrow down the cause
- diagnose.root-cause: state the found cause

### integrate — land work into the shared whole
- integrate.commit: stage and commit
- integrate.branch: branch, fetch, rebase, merge
- integrate.conflict: resolve a conflict
- integrate.release: release, deploy, publish
- integrate.cleanup: remove branches, worktrees, leftover artifacts

### operate — run and maintain the environment
- operate.service: start, stop, restart a service or process
- operate.install: install or update dependencies or tools
- operate.resources: check machine load, disk, memory, capacity
- operate.cleanup: clean temp files, stray processes
- operate.access: credentials, permissions, auth
- operate.backup: back up, copy, or restore data

### communicate — exchange information with others
- communicate.read: read messages or notifications
- communicate.report: report a result, status, or heads-up to someone
- communicate.ask: ask a question or escalate a decision
- communicate.answer: answer a question, approve, or deny
- communicate.narrate: interim narration of own work (to whoever reads the transcript)
- communicate.summary: final summary ending a turn

### track — keep the work's records
- track.create: create a work item
- track.status: change a work item's status
- track.note: comment or post an update on a work item
- track.organize: link, re-parent, label, or reassign items
- track.query: look up work items or their history
- track.notes: keep own notes or handover files

### delegate — have others do work
- delegate.spawn: start a new agent or worker
- delegate.brief: give a worker its task or a correction
- delegate.check: check on a worker's state or progress
- delegate.steer: pause, stop, restart, or redirect a worker
- delegate.accept: read and accept or reject a worker's result
- delegate.retire: archive or shut down a finished worker

### self — manage own working conditions
- self.tools: load tools, skills, or capabilities
- self.context: manage own context (compact, re-read own notes)
- self.budget: check or manage cost and usage
- self.schedule-wait: set up a wait, timer, or wake-up
- self.retro: reflect, file a retro or feedback
- self.identity: look up own identity or registration

### wait — an item whose purpose is to wait (tool time spent waiting)
- wait.sleep: deliberate sleep
- wait.poll: poll a condition in a loop (job output, a file, a status)
- wait.capacity: wait for machine capacity or a lock

### other
- other.unclear: cannot tell what it is for
- other.error: a failed call with no purpose of its own (wrong args, tool error)

## Wait tree (what the clock waits on: 8 top-level, 20 leaves)

Assigned to tool time, model time, and the gaps between turns, by rule from timestamps and the prompt that ended the gap; no model call.

- tool.short: tool call under 5 s
- tool.build: build or install
- tool.test: test run
- tool.network: network or remote call
- tool.sleep: deliberate sleep or poll inside a tool
- tool.contention: load-wait loop, a lock
- model.generate: model generating (result to next message)
- model.stall: model API error or retry (gap > 5 min after a result with no new prompt)
- job.background: a background job the agent started (ended by its completion notice)
- agent.child: a child agent's work (ended by a child notice or child mail)
- agent.peer: mail from a parent or peer
- agent.release: another agent's merge, deploy, or review
- human.reply: the human's reply to mail or a question
- human.permission: a permission request
- human.prompt: a new prompt from the human
- event.timer: a timer or schedule (wake_me, ScheduleWakeup)
- event.external: an external event (GitHub, Linear, a subscription)
- throttle.cost: a cost blocker or pause, rate limit
- throttle.scheduler: paused or queued by a manager or for capacity
- idle.none: idle with nothing assigned; harness restart, resume, compaction

## Wait tree

Stored in `activity_items.wait_kind`, assigned from timestamps and the prompt that ended a gap, with no model call (S-210, `src/activity.ts`).

Assigned to tool time, model time, and the gaps between turns, by rule from timestamps and the prompt that ended the gap; no model call.
- tool.short: tool call under 5 s
- tool.build: build or install
- tool.test: test run
- tool.network: network or remote call
- tool.sleep: deliberate sleep or poll inside a tool
- tool.contention: load-wait loop, a lock
- model.generate: model generating (result to next message)
- model.stall: model API error or retry (gap > 5 min after a result with no new prompt)
- job.background: a background job the agent started (ended by its completion notice)
- agent.child: a child agent's work (ended by a child notice or child mail)
- agent.peer: mail from a parent or peer
- agent.release: another agent's merge, deploy, or review
- human.reply: the human's reply to mail or a question
- human.permission: a permission request
- human.prompt: a new prompt from the human
- event.timer: a timer or schedule (wake_me, ScheduleWakeup)
- event.external: an external event (GitHub, Linear, a subscription)
- throttle.cost: a cost blocker or pause, rate limit
- throttle.scheduler: paused or queued by a manager or for capacity
- idle.none: idle with nothing assigned; harness restart, resume, compaction

## How the rules fill it (S-213, `src/activity-rules.ts`)

The rules settle an item only when the item says so. Anything else stays NULL for the model classifier (S-214). Every settled item stores `category_source` ('rule' or 'derived') and `confidence` 1.

- **Tool calls, by name:** mootr's MCP tools (`mcp__stam__` prefix dropped) and the harness tools map to one leaf each, for example `itsa_create` → `track.create`, `spawn_agent` and `Agent` → `delegate.spawn`, `Grep` and `Glob` → `understand.search`. `agent_control` maps by its action (pause, stop, restart → `delegate.steer`; archive, shutdown → `delegate.retire`). `send_mail` is left to the model.
- **Shell commands** (`Bash`, OpenCode `shell`, Codex `exec_command`): the main command is the first that isn't `cd`, `export` or `echo`. Its family picks the leaf (`git log` → `understand.history`, `tsc` → `verify.static`, `node --test` → `verify.unit`, `test/run.sh` and `e2e*.sh` → `verify.integration`, `sleep N` → `wait.sleep`). The other commands in the line must share its top-level category; a different leaf of the same category is fine, and the main command's leaf stands. A `cd DIR` sets the directory the following commands run in, so their relative paths resolve from it; a `cd` the rules can't follow (`cd ~/x`, `cd $DIR`) leaves relative paths to the model. A loop that greps or tests a file is `wait.poll`.
- **Paths:** `Read`, and `cat`, `head`, `tail`, `sed -n` on a path: instruction files and docs → `understand.task`; logs, `/tmp` and task output → `understand.output`; else `understand.material`. `Edit`, `Write`, `sed -i`, `cat >` and python heredocs that write a file (a real write call: `open(…, 'w'/'a')`, `.write(`, `write_text`, `os.replace`, `shutil`): tests → `produce.tests`; `*.md` → `produce.docs`; config files → `produce.config`; else `produce.edit` (or `produce.write` for `Write` of a new file).
- **Text:** the last text item of a turn → `communicate.summary`. Other text goes to the model.
- **Truncated input:** the readers cut summaries at 300 characters. At ingest the rules read the full input; in the backfill, a summary of 300 characters or more goes to the model.
- **Model items** take the category of the first tool or text item after them in the same turn, marked `derived`. **Gap items** get no category, marked `derived`.

Ingest runs the rules on every new slice (`write()` in `src/activity.ts`). `stam activity --classify [--agent AGENT]` runs them over stored items that have no category source yet (the backfill), in batches of 2,000 rows with a yield between them. Rows already classified keep their category.

Tests: `test/activity-rules.test.mjs` (a table of representative calls and texts, the model and gap marks, and a check that every category the rules use is in the tree) and the backfill case in `test/activity.test.mjs`.
