# Research: what the literature on agent self-reflection says about stam's retros

Written 2026-10-14 for S-716, under S-708 (self-retro everywhere). the user asked whether two papers, and the field around them, teach us anything for stam's instructions, process, or system. This file keeps the results: the findings across papers, ranked recommendations with the file each touches, and per-paper notes with links. 31 papers were read from their arXiv HTML; every number below is quoted from a paper, and "not in text" marks what a paper didn't say.

Two kinds of claims are kept apart throughout. **Measured** means a paper reports the number from an experiment. **Extrapolated** means we map a measured result onto stam, where nobody has measured it: no paper tests a multi-agent coding team with a shared lesson store and a human approving instruction edits. Treat every recommendation as a hypothesis to check against stam's own data.

## 1. What stam does today

The retro system (S-157 to S-163, S-206, S-227) as of this writing:

- **Capture.** Every agent's system prompt carries `templates/retro.md` (69 words): file a retro item with the `retro` tool when something notable happens; search first and +1 a match. An item is an ITSA of kind `retro` with `Kind`, `Target`, `Reporter`, `On` lines and free-text details (`src/retro.ts`). Search is word overlap over title and body, top 5.
- **Final round.** An archived agent gets `templates/shutdown-archive.md`: `retro final:true` with an effort split, then up to three items. Measured effort sits beside the self-report (S-227).
- **Digest.** `src/retro-digest.ts` mails the chief of staff daily at 09:00 with new items, +1s, final rounds, and archives, grouped by kind and target.
- **Steward.** After each digest `src/retro-loop.ts` spawns a `retro-steward` (Sonnet, `templates/type-retro-steward.md`) with the open items grouped by target. It drafts one proposal ITSA with a diff to `templates/*.md`, `CLAUDE.md`, or `registry/defaults.json`; the user approves; the branch merges; items on the `Answers:` line close.
- **S-708 adds** a one-line reminder in context warnings and before compaction or shutdown, and a Settings › Retros page.

The store on 2026-10-14 (from `itsa_list kind=retro` and `itsa_get S-168`):

| Measure | Value |
|---|---|
| Retro items filed since 2026-10-12 | 184 |
| Open (status `idea`, `todo`) | 154 |
| Closed (done or duplicate) | 29 |
| Proposals so far | 2 (S-295 answering 14 items, S-623 answering 15) |
| Items S-295 answered that are still open | 11 of 14 (S-295 was kind `issue`, so `closeAnswered` never ran; S-713 fixes the kind) |
| Words in CLAUDE.md / AGENTS.md | about 1,170 each |
| Words in the stam system prompt before the harness's own | about 6,500 |

Two patterns in the store matter for what follows. First, the same lesson is filed repeatedly despite the search-first rule, because word overlap misses paraphrases: cleanup globs that delete other agents' files (S-408, S-516, S-669); a fresh worktree has no `node_modules` (S-396, S-397, S-452, S-491, S-664); the shared Chromium lock (S-199, S-328, S-330, S-536, S-642); storage can't reach GitHub (S-264, S-571, S-582, S-639, S-676, S-677); agents editing `settings.json` by hand (S-600, S-602). Second, roughly a third of the items are not instruction lessons at all but stam bugs or missing tooling (leaked daemons, lock contention, `pr_open` refusals, flaky checks), which the steward can't answer with text, so they stay open indefinitely.

## 2. Findings across the papers

Ordered by how strong the evidence is. Each names the papers and numbers behind it, then what it means for stam.

### F1. A lesson is only as good as the external signal behind it (measured, strong)

- Intrinsic self-correction with no external signal lowers accuracy: GPT-4 on GSM8K 95.5 → 91.5 → 89.0 over two rounds; GPT-3.5 on CommonSenseQA 75.8 → 38.1 (Huang et al., 2310.01798). The same loop gains with an oracle signal, which the authors call an artefact of the label.
- Reflexion regresses on MBPP (0.80 → 0.77) because its self-written tests had a 16% false-positive rate, while it gains on HumanEval where the tests were right.
- ACE degrades without labels (FiNER online, −3.4); a constantly harmful reflector pushes it below baseline. RIZZ's largest ablation is writing unverified interactions (−6.6 pp). Voyager loses 73% of discovered items without its independent critic. The Dynamic Agent Skills survey's grade-A finding: unverified self-generated skills fall from 71.1% to 41.1%.
- MAST's LLM annotator agrees with humans at κ 0.77 against 0.88 between humans: about one label in five is wrong even for a strong model classifying a known failure.

For stam: a retro item written from the agent's feeling of how it went is intrinsic self-assessment. Items that cite an external event (a red gate, a `request_changes`, a rollback, a measured wait, a user correction) are the ones with weight. The system should ask for that evidence and rank by it; +1 counts measure agreement among agents, not truth.

### F2. Few retrieved lessons beat many always-loaded ones (measured, strong)

- ReasoningBank: one retrieved item 49.7, two 46.0, three 45.5, four 44.4. Memento peaks at K=4. ReHarness: gain rises sharply from k=1 to k=5, flat to 20, declines beyond. Reflexion caps memory at 1 to 3. Voyager retrieves top 5 (96.5% hit rate).
- ReHarness's Top-K Raw baseline, which shows the five most similar past trajectories with no abstraction at all, beats every lesson-writing baseline (Mem0, ACE, GEPA-Online, DoT, RBank) and loses only to ReHarness itself (0.168 vs 0.240).
- AutoRefine: always-loaded Rules were not significant (−1.11, p = 0.875) while on-demand Skills carried the effect (−20.00). The Dynamic Agent Skills survey: "static all-injection can degrade performance"; focused subsets beat comprehensive libraries; flat retrieval selection falls from 92% at 64 items to 64% at 256.
- IFScale: compliance falls with instruction density and models favour earlier instructions; related work measures full compliance dropping from 0.88 at two instructions to 0.66 at ten.

For stam: every sentence the steward adds to `CLAUDE.md` or a type brief competes for compliance with the ones already there, and the papers find the always-loaded channel the weakest. The channel with the evidence behind it is retrieval: show an agent the three to five most similar past items, with their details, when it starts and after it compacts.

### F3. Lessons must be revisable and source-linked; appending and rewriting both fail (measured, strong)

- ReHarness's one new idea is backward revision: each retrieved reflection is revised when a later trajectory contradicts it, grounded in its source. Without revision the gain falls from 0.217 to 0.144. Every baseline that rewrites memory wholesale has negative stability, that is, it forgets. The two worked examples, an over-general tip that hurt and a tip that went stale after a schema change, are the failure stam's S-576 and node_modules cluster show.
- ACE: removing delta updates costs −27.8% SGC; a whole-context rewrite collapsed Dynamic Cheatsheet's memory from 18,282 to 122 tokens in one step (66.7 → 57.1).
- ExpeL keeps a counter per insight (ADD, EDIT, UPVOTE, DOWNVOTE, delete at zero) because "even successful trajectories can be suboptimal". Generative Agents' insights cite the records they derive from.

For stam: an instruction sentence has no link back to the items that produced it, so nobody can tell which rule is stale or contradicted. S-295's edits live in `CLAUDE.md` while 11 of its 14 items are still open. The store needs the reverse map, and the steward needs permission to revise or delete, not only add.

### F4. Instruction text is the weakest lever; tools, gates and process carry the gains (measured, strong)

- Agentic Harness Engineering: with the model fixed, the long-term memory file was the best single component (+5.6 pp) and system-prompt-only edits regressed (−2.3 pp vs seed). HarnessFix: prompt-only repair 50.6 against 61.7 for scoped repairs to tools and orchestration. Learning from Failure: all four winning fixes were capabilities (zoom crop, terminal, search, repetition warning), not wording.
- MAST: prompt fixes gave AG2 84.75 → 89.75 and ChatDev 25.0 → 34.4; topology changes gave ChatDev 40.6. The authors: topology beats prompts, and neither is "substantial".
- Skill Issue spent $2,013.98 optimising a repository instruction file and got +4.9 pp at p = 0.29; the Gloaguen study it cites finds agent-generated AGENTS.md files at −0.5% and −2% (n.s.) with 20–23% more cost, and developer-written ones at +2.4% (n.s.). The maintainer interviewed valued repo-specific rules and rejected generic best practice.

For stam: the steward only edits text, so a third of the store (bugs, locks, missing tools) has no path out, and even the text edits are the lever the field finds smallest. The loop needs a route from an item to a code or process change, and the user's approval of a text edit shouldn't be read as a measured improvement.

### F5. Attribute at the failure, with an anchor; reconstruction later doesn't work (measured, strong)

- Who&When: GPT-4o names the responsible agent in about 54% of annotated failures and the decisive step in about 14%; on logs of 93–130 steps accuracy approaches zero; o1 and R1 are no better. Human experts marked 15–30% of their own labels uncertain.
- HarnessFix: diagnosis with anchors to the step and artifact reaches 85.0 step accuracy against 55.0 from the raw trace.
- Who&When: requiring explicit reasoning adds 7.4 points at agent level.

For stam: the retro reminder fires at archive and, after S-708, at context limits. The valuable moment is the failure itself: the red gate, the review round, the denied permission, while the agent still has the trace. A steward reading a digest days later is the post-hoc attribution the papers show failing.

### F6. Curation needs a strong model (measured, moderate)

- ExpeL: a gpt-3.5 extractor yields 32.0 against 39.0 for gpt-4 on the same trajectories; feeding raw per-episode reflections to the extractor drops to 29.0. Dynamic Cheatsheet makes small models worse (GPT-4o-mini AIME 16.7 → 13.3). Reflexion gives nothing on starchat-beta. Agent Workflow Memory's near-literal recipes are model-insensitive (35.6 vs 35.5).

For stam: lesson abstraction is Opus work; recipe copying is not. The steward runs on Sonnet; the two proposals so far read well, so this is a caution rather than a finding of harm.

### F7. Failures help as pitfalls, hurt as procedures; successes are a different artifact (measured, moderate)

- ReasoningBank: success-only 46.5, success plus failure 49.7; adding failures to Agent Workflow Memory's procedures 44.4 → 42.2. PreFlect's biggest gain is a fixed checklist of three failure classes applied before acting (58.18 vs 50.30 without it), built once from mixed-outcome tasks and pruned by hand.
- Dynamic Cheatsheet's biggest win is one stored executable solver (Game of 24, 10 → 99); Voyager's library is executable code; AWM's recipes carry placeholders.

For stam: `improve` items want to become short "check before you start" lines per type; `went_well` items want to become recipes with exact commands, in docs or skills, not rules in `CLAUDE.md`.

### F8. Scope by type and prune; shared stores saturate (measured, moderate)

- RIZZ: a single memory branch costs −2.0 pp against per-family branches; positive rules can be shared across branches, failures stay local; a hard 64K cap with a drop order. CODESKILL halves its bank (1,252 → 676) for +0.82 points. Memento's case bank saturates at about 33k cases. The multi-agent survey calls archival memory's "saturation ceiling" a known limit.

For stam: per-type briefs are the right home for accumulating lessons; `CLAUDE.md` should stay the stable, repo-specific floor. Six duplicate clusters in 184 items say the merge step is missing.

### F9. Sequential small changes with a check each beat bundled rewrites; regressions are the open problem (measured on benchmarks, extrapolated to stam)

- Harness Learning: ten sequential revisions with feedback between them reach 0.27 on MuSiQue where independent single revisions sit at 0.15, and sequential beats the oracle best of 80 independent proposals. Agentic Harness Engineering's self-predicted regressions are near random (11.8% precision), and single-component gains don't add (+11.1 pp summed vs +7.3 pp together). SkillBoost without its regression gate: 37.7 against 48.5. AutoRefine's replay gate is its largest ablation (−16.11).

For stam: a proposal that bundles 15 items into four edits (S-623) is the shape that scores worst, and nobody can predict what the edits break. The only cheap check available is recurrence: did items with that target stop arriving after the edit landed.

### F10. A human choosing among ranked candidates is cheap; the human is also the hidden check (measured once, extrapolated)

- Learning from Failure: the LLM diagnoses and proposes, a human picks, the LLM patches; over 97% of patches were accepted unmodified and human edits touched under 3% of lines. Darwin Gödel Machine: an agent reached a perfect hallucination score by deleting the detector's logging, and gaming "occurs more frequently when these functions are not hidden"; its archive of past variants beat greedy adoption 50.0% vs 23.0%.

For stam: the user's approval is the external gate every paper asks for and none has. Make it cheap: present choices with evidence and predicted effect, not a long diff. Keep the lineage of proposals, approved and refused.

### F11. When to reflect: on events, before the trace is gone (design, weakly measured)

- Generative Agents trigger reflection when accumulated importance passes a threshold, not on a clock; ReHarness writes after every instance. Nobody measured "before compaction" reminders. MAR's multi-persona critique costs 3× for a few points, with no ablations.

For stam: S-708's reminders are consistent with the literature and cheap; the failure-triggered reminders of F5 are the higher-yield addition. The epic ring retro should stay gated by budget as it is.

## 3. Recommendations, ranked

Each gives the change, the file, the evidence, the cost, and how sure we are. Nothing here is built; @self-retro (S-708) and @cos decide.

### R1. Ask every retro item for its evidence and its trigger

- **Change.** `retro` gets two optional parameters with defaults (per S-449): `evidence` (what external event backs this: a gate name and result, a review verdict, a rollback, a measured wait, a user correction, or `none`) and `when` (the one-line condition under which the lesson applies). `templates/retro.md` asks for both in one sentence each. The digest and the steward brief sort items by evidence class first, +1s second; `none` items are listed last.
- **Files.** `templates/retro.md`, `src/retro.ts`, `src/retro-digest.ts`, `src/retro-loop.ts` (`groupByTarget` ordering).
- **Evidence.** F1 (Huang; Reflexion MBPP; RIZZ −6.6; Dynamic Skills 71.1 → 41.1), F5 (Who&When +7.4 for explicit reasoning), CODESKILL's tight `when_to_apply`.
- **Cost.** About a day for one developer; adds about 30 words to every system prompt.
- **Confidence.** High that evidence-less lessons are worth less; the exact fields are a design choice.

### R2. Retrieve lessons into the agent instead of growing CLAUDE.md

- **Change.** At spawn, and in `templates/compacted-self.md` after a compaction, stam adds a short block "Lessons from similar work": the three to five open or absorbed retro items most similar by meaning to the agent's task and type, each as its summary plus the first lines of its details and its key. Uses the embedding search already behind `search` (S-141). A setting on the Settings › Retros page sets k (default 4) or turns it off.
- **Files.** `src/agent-instructions.ts` (a `lessons` placeholder), `templates/system-prompt.md`, `templates/compacted-self.md`, `src/retro.ts` (a similarity query), settings.
- **Evidence.** F2 (Top-K Raw 0.168 vs ACE 0.043; ReasoningBank k=1 49.7 vs k=4 44.4; Memento K=4; ReHarness k≈5; AutoRefine Rules n.s.), IFScale on density.
- **Cost.** One to two days; about 300 tokens per agent start. The cheapest change with the strongest evidence behind it.
- **Confidence.** High that retrieval beats broadcast in the papers; untested on stam's item quality, so measure (R7).

### R3. Make the steward consolidate and prune, not append

- **Change.** In `templates/type-retro-steward.md`: (a) one edit per rule touched: when an item concerns a topic a sentence already covers, replace or merge that sentence rather than adding a neighbour; (b) a net length budget: `CLAUDE.md` and each type brief don't grow across a proposal unless the proposal names what it removes or merges; (c) put a lesson in the narrowest file that reaches the agents it concerns, per-type brief before `CLAUDE.md`; (d) when the clear fix is a tool, gate, script, or process change, create a child ITSA of kind `issue` under the item for @cos to schedule, and leave the item open until it closes; (e) carry a one-line predicted effect per edit ("items with Target X stop arriving"), which the next digest checks.
- **Files.** `templates/type-retro-steward.md`, `templates/retro-steward-task.md`.
- **Evidence.** F2, F3 (ACE deltas; ReHarness revision), F4 (AHE prompt-only regressed; HarnessFix; MAST topology), F8 (RIZZ scoping; CODESKILL pruning), F9 (AHE manifests).
- **Cost.** Hours of brief editing; no code. Also the change most likely to be ignored under pressure, so the digest should report the net word delta per proposal.
- **Confidence.** High on direction; the budget number is a judgment call.

### R4. Close the loop: link every rule to its items, and close items the files already answer

- **Change.** A map from instruction sentences to item keys, maintained by the steward: `docs/instruction-sources.md` (rule text or anchor, file, item keys, proposal key, date). With it the steward can find the rule an item contradicts and revise or drop it (ReHarness's backward revision), and the user can see why a sentence exists. Separately: run `closeAnswered` for any kind, not only `proposal`, or do a one-off pass that closes the 11 open S-295 items with a comment; and let an agent mark an item `absorbed` (closed) with the rule that answers it when the rule already exists.
- **Files.** `src/retro-loop.ts` (`closeAnswered`, with S-713), `templates/type-retro-steward.md`, a new `docs/instruction-sources.md`.
- **Evidence.** F3 (ReHarness 0.217 vs 0.144 without revision; ACE IDs and counters; Generative Agents citations), stam's own store (S-295's open items; S-576).
- **Cost.** About a day; the map is a few hundred lines to seed from S-295 and S-623.
- **Confidence.** High that the missing link is a defect; the map's format is a choice.

### R5. Search by meaning before filing, and show the near-duplicates

- **Change.** `retro`'s `search` and the pre-file check use the embedding search, not word overlap, and return the top three with the first line of their details so the agent can judge "same lesson, different words". The tool still files when the agent insists (ReasoningBank shows a 72.7% judge is good enough; don't block on certainty).
- **Files.** `src/retro.ts` (`searchRetros`).
- **Evidence.** Six duplicate clusters in 184 items; CODESKILL and AutoRefine merge on rubric, not embeddings, but both need candidates to merge first.
- **Cost.** Half a day.
- **Confidence.** High.

### R6. Remind at the failure, not only at the end

- **Change.** One-line retro reminders attached to the events that are the external signal: a red merge gate on the agent's PR, a `request_changes` verdict, a deploy hold or rollback that names the agent's ITSA, a denied permission, an `agent-errored` notice. Text: "Before you fix it, record what went wrong and at which step with `retro`, with the gate or verdict as evidence." Keep S-708's context and shutdown reminders, at one line each.
- **Files.** The notice templates for those events (`templates/event-notice.md`, `permission-answered.md`, the PR status notices), `templates/retro.md`.
- **Evidence.** F5 (Who&When ~54% / ~14%, near zero on long logs; HarnessFix 85.0 vs 55.0 with anchors), F11 (event-triggered reflection).
- **Cost.** Half a day; a few tokens per event.
- **Confidence.** Moderate: the attribution numbers are measured, the reminder's effect is not.

### R7. Measure the loop as an experiment

- **Change.** The digest reports, per target and per type: new items and +1s in the period, recurrence of targets a proposal already answered (the predicted-effect check from R3), items per archived agent, and the net word delta of instruction files. Each proposal records which metric it expects to move. Don't try to measure resolve rate or task success: Skill Issue couldn't detect +4.9 pp with $2,000 and 26 tasks.
- **Files.** `src/retro-digest.ts`, the Retros page (S-162), the Settings › Retros page (S-712).
- **Evidence.** F9 (regressions unpredictable; sequential checks), F4 (Skill Issue p = 0.29), the self-evolving agents survey ("sparse and inconsistent reporting of evolution costs").
- **Cost.** One to two days.
- **Confidence.** High that without it nobody will know whether the loop works; moderate on which numbers matter.

### R8. Three artifacts, not one: pitfalls, recipes, fixes

- **Change.** The steward maps `improve` items to a per-type "Before you start" checklist of at most five lines (PreFlect's shape), `went_well` items to recipes with exact commands in `docs/` or a skill (not `CLAUDE.md`), and `stam_issue` and tooling items to child ITSAs (R3d). Retro kinds stay as they are; the brief says where each kind goes.
- **Files.** `templates/type-retro-steward.md`, possibly a `docs/recipes.md`.
- **Evidence.** F7 (ReasoningBank 46.5 → 49.7 with pitfalls; AWM 44.4 → 42.2 with failures as procedures; PreFlect 58.18 vs 50.30; Dynamic Cheatsheet 10 → 99 for a stored procedure).
- **Cost.** Hours.
- **Confidence.** Moderate; the artifact split is measured in single-agent settings only.

### R9. Steward model, size of a proposal, and lineage

- **Change.** Run the steward on Opus (F6) and cap a proposal at the items sharing one target or one file, so a refused edit doesn't block the rest and the effect of each can be seen (F9). Keep refused proposals and their reasons in the ITSA tree, which already happens; add "refused before: S-NNN" to the steward brief's inputs so it doesn't re-propose them (DGM's archive; HarnessFix's repair memory).
- **Files.** `registry/defaults.json` (steward model), `src/retro-loop.ts` (one proposal per target group, or the S-714 early start), `templates/retro-steward-task.md`.
- **Evidence.** F6, F9, F10.
- **Cost.** Hours; Opus costs more per steward run, a few dollars a day.
- **Confidence.** Moderate; the two Sonnet proposals so far were sound.

### R10. Things the papers argue against doing

- Don't dump the open store, or a digest of it, into every agent's prompt (F2).
- Don't let the steward regenerate a file from scratch "to clean it up" (F3: ACE collapse, DC abbreviation).
- Don't treat +1 counts as evidence of truth, only of recurrence (F1); don't tell agents that +1'd items get absorbed, or they will optimise for it (F10, DGM node 114).
- Don't run multi-persona or ring retros per task; 3× cost for a few points (MAR). The existing budget gate for epic rings is right.
- Don't expect a measurable change in task success from instruction edits; expect fewer repeated items and fewer review rounds, and measure those (F4, F9).

## 4. Open questions nobody has measured

- Whether any of this holds for a human-gated, multi-agent coding team. All gains are on single-agent, auto-scored benchmarks.
- How fast a lesson store degrades over weeks. No paper runs long enough (self-evolving agents survey: benchmarks reset state between tasks).
- The compliance cost of one more rule in a 1,000-word `CLAUDE.md` for a Claude Code agent. IFScale measures keyword tasks, not procedures.
- Whether reminders before compaction recover lessons that would otherwise be lost. Consistent with the design literature, unmeasured.

## 5. Per-paper notes

Each note: method, evidence as quoted, limits, and implications for stam. Grouped by theme. The two papers the user named come first.

#### Recurrent Harness for Agentic Continual Learning (ReHarness) (arXiv:2610.12668, 2026-10-08) — https://arxiv.org/abs/2610.12668
- Method: the agent's "harness state" is a store of short textual reflections, each linked to the trajectory it came from. Forward: retrieve the top 5 reflections by embedding similarity, act, then write one new reflection from the trajectory. Backward (the new part): after each instance, revise each *retrieved* reflection using its source trajectory plus the new one as feedback, grounded in the source. Strictly online, one pass, no replay or validation set, no weight updates.
- Evidence: CL-Bench (6 tasks), MemoryBench (5), MemoryArena (5); backbones Claude Opus 4.8, GPT-5.5, Gemini 3.7 Flash; baselines Mem0, RBank, DoT, ACE, GEPA-Online, Top-K Raw, Full Raw. Metric: normalised gain over a stateless agent. Overall: ReHarness 0.240, Top-K Raw 0.168, Full Raw 0.164, Mem0 0.131, GEPA-Online 0.092, DoT 0.071, ACE 0.043, RBank 0.034 (paired Wilcoxon, Bonferroni, p_adj < 0.05 against every baseline). Ablations (CL-Bench, Claude): no revision 0.144 vs 0.217; revised reflections not used as write demos 0.191. Retrieval k: sharp rise 1 to 5, flat 5 to 20, decline beyond. Revisions stay 95-99% grounded in their source. Every baseline that rewrites memory (Mem0, RBank, DoT, ACE, GEPA-Online) has *negative* average stability, that is, it forgets; ReHarness has the highest stability (0.015) and plasticity (0.241).
- Limits: little gain on noisy, chance-driven rewards (poker, about 0.01). Must keep raw trajectories for later revision. One reflection call plus k revision calls per instance; output tokens 4.38M vs 0.46M for Top-K Raw, total about $254 per CL-Bench rollout vs $85 for Top-K Raw. Single-agent, benchmark tasks; nothing on multi-agent or human review.
- Implications for stam:
  - A retro item is this paper's "reflection". Its key design choice is that reflections carry their source and get *revised* when later evidence contradicts them; stam's items are write-once and only +1'd. The two worked examples (an over-general tip that hurt rewards; a tip that went stale after a schema change) are exactly the failure S-576 and the node_modules cluster show.
  - Raw-context baselines (Top-K Raw: just show the 5 most similar past trajectories) beat every lesson-writing baseline except ReHarness. For stam, showing an agent the 3-5 most similar *past retro items with their details* at task start is the cheap, evidence-backed move; abstracting into instruction text is the expensive, fragile one.
  - Retrieval k of about 5 is the sweet spot; beyond 20 it declines. A system prompt that carries all open items would be the wrong design.

#### Harness Learning Enables Generalizable Test-Time Adaptation (arXiv:2609.35738, 2026-09-28) — https://arxiv.org/abs/2609.35738
- Method: the "harness" is the executable program around the model (which calls, which tools, what information flows). A separate proposer model is trained with RL (SFT then RL, reward = task score of the revised harness) to read the task, the current harness source, and an *execution report* (dev-set scores, up to eight failing traces, change history) and emit SEARCH/REPLACE edits. At test time the proposer revises the harness over successive runs on a new task, with no weight updates.
- Evidence: Reasoning Gym (21 unseen families; proposer Qwen3.5-4B): base 0.32 → RL 0.62 single revision; on all 26 unseen families base 0.282, SFT 0.415, RL 0.528, 35B teacher 0.501. Multi-hop QA (train HotpotQA, test MuSiQue and 2Wiki, exact match): independent single revisions about 0.15 (barely above seed) vs 0.27 after ten *sequential* rounds. Sequential revision beats the oracle best of 80 independent proposals. Candidates are kept only if they beat the parent on a held-out dev set; failed edits score zero and are counted.
- Limits: fixed solver, prescribed revision prompts, one teacher; training on revision *sequences* "does not consistently help"; results sensitive to whether zero-scoring harnesses are included; needs a grader and a dev set per task, which coding work in stam mostly lacks. No measured regression rate per edit; the prompt only asks the proposer to name likely regressions.
- Implications for stam:
  - The retro steward is a proposer without a grader: it edits instruction files from a digest and the human is the only check. The paper's gains depend on (a) a concrete execution report of failures, not summaries, and (b) keeping an edit only if a held-out score improves. stam has (a) partly (the item details) and (b) not at all.
  - Sequential small edits with feedback between them beat big independent rewrites. One proposal per digest, rebased on current main, is the right shape; a proposal bundling 15 items (S-623) is closer to the "independent big rewrite" that scored worst.
  - The proposer must declare "unchanged" when nothing improves. The steward brief already has this (step 3); keep it.

#### Large Language Models Cannot Self-Correct Reasoning Yet (arXiv:2310.01798, ICLR 2024) — https://arxiv.org/abs/2310.01798
- Method: ask GPT-3.5, GPT-4, GPT-4-Turbo and Llama-2-70b to review and revise their own answers with no external signal; compare with an oracle that stops when the answer is already right.
- Evidence: intrinsic self-correction lowers accuracy everywhere: GPT-4 GSM8K 95.5 → 91.5 → 89.0 over two rounds; GPT-3.5 CommonSenseQA 75.8 → 38.1. With oracle labels the same loop gains (GPT-3.5 GSM8K 75.9 → 84.3), which the authors call an artefact of the label, not self-correction. Self-correction does help where an external signal exists (unit tests, execution, verifiers) and for style and safety judgements.
- Limits: 2023 models; reasoning QA, not agentic coding; one prompt family.
- Implications for stam: a retro written from the agent's own feeling of how it went is intrinsic self-assessment. The items that carry weight are those tied to an external signal: a red gate, a review round, a measured effort split, a rollback. The system should capture and rank by those signals, not by the agent's narrative.

#### How Many Instructions Can LLMs Follow at Once? (IFScale) (arXiv:2507.11538, 2025-07) — https://arxiv.org/abs/2507.11538
- Method: a report-writing task with up to 500 keyword-inclusion instructions, 20 models from 7 providers.
- Evidence: the best models reach about 68% compliance at 500 instructions; compliance falls with density, and models favour earlier instructions (primacy). Related: full-compliance rate drops from 0.88 at two instructions to 0.66 at ten for Llama-70B (Boosting Instruction Following at Scale, arXiv:2510.14842); SWE-IF reports multiplicative decay per added constraint on coding tasks.
- Limits: keyword tasks, not procedural rules; the magnitude for system prompts of stam's kind is unmeasured.
- Implications for stam: every retro-driven sentence added to CLAUDE.md or a type brief competes with the ones already there. CLAUDE.md and AGENTS.md are about 1,170 words each and the full stam system prompt about 6,500 words before the harness's own prompt. The steward's success metric can't be "items answered"; each added rule has a compliance cost on every other rule. Put rules in the order of their cost of being missed, and prefer removing or merging a rule over adding one.

### Context and prompt evolution


#### Agentic Context Engineering: Evolving Contexts for Self-Improving Language Models (arXiv:2510.04618, v3 2026-03-29) — https://arxiv.org/abs/2510.04618
- Method: Generator runs the task, Reflector distills lessons from successes and failures (up to 5 rounds), Curator emits delta bullets with IDs and helpful/harmful counters. Deltas merge into an itemized playbook by non-LLM logic; "grow-and-refine" appends, updates in place, de-dups by embedding; never a whole rewrite.
- Evidence: AppWorld, FiNER, Formula; baselines ReAct, ICL, MIPROv2, GEPA, Dynamic Cheatsheet. Headline "+10.6% on agents and +8.6% on finance". AppWorld offline with labels 42.4 -> 59.4 (GEPA 46.4); without labels 57.2; online 59.5 vs DC 51.9. Finance offline 69.1 -> 81.9 (GEPA 72.5). Ablations: no Reflector/no multi-epoch 55.1 vs full 59.4; removing deltas "-11.7% TGC and -27.8% SGC"; reflection rounds 1/3/5/10 = 61.3/65.8/67.6/65.2; harmful reflector every iteration 66.7 (-4.0 vs base). Adaptation latency vs GEPA 53,898 s -> 9,517 s; evaluation input tokens +117.4%, "91.8%" cached. Collapse case: DC context 18,282 -> 122 tokens in one step, accuracy 66.7 -> 57.1.
- Limits: needs a "reasonably strong Reflector"; degrades without reliable feedback (FiNER online no labels -3.4); Llama-3.3-70B gains smaller; single-rule tasks don't need rich contexts; playbooks long (RIZZ: released code's budget is only advisory).
- Implication:
  - Steward adds/updates entries in CLAUDE.md, never regenerates it (delta ablation, collapse case).
  - Each lesson carries helpful/harmful counters and gets de-duped (grow-and-refine).
  - Opus-level reflection, 3-5 rounds not 10 (Table 19); steady bad lessons push below baseline (Table 17), so the human gate is the safeguard the paper lacks.
  - Retros need a feedback signal (tests, PR outcome); unverified ones degrade the store.

#### GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning (arXiv:2507.19457, v2 2026-02-14) — https://arxiv.org/abs/2507.19457
- Method: Evolves module prompts of a compound system, weights frozen. Sample 3 rollouts, have an LLM reflect in natural language on traces and textual feedback, propose a revised prompt. Candidates live on a per-instance Pareto frontier (best on at least one example survives); optional Merge crosses lineages.
- Evidence: HotpotQA, IFBench, HoVer, PUPA, AIME-2025, LiveBench-Math; Qwen3 8B, GPT-4.1 Mini; baselines GRPO (24,000 rollouts), MIPROv2. "Outperforms GRPO by 6% on average and by up to 20%, while using up to 35x fewer rollouts." Qwen3 8B aggregate: base 45.23, GRPO 48.91, MIPROv2 47.84, GEPA 54.85, +Merge 52.40. GPT-4.1 Mini: 53.03, GEPA 65.22, +Merge 66.36. GRPO wins AIME-2025 on Qwen3 (38.00 vs 32.00). Ablation: SelectBestCandidate +6.05, BeamSearch +5.11, Pareto +12.44. Qwen-optimized prompts transfer to GPT-4.1 Mini (62.03). Cost "$86". Prompts "less than 33% of the size of MIPROv2's", mostly declarative instructions. Adversarial evolved prompt drops AIME-2025 pass@1 "from 76% to 10%". Generalization gap: not in text.
- Limits: most rollouts go to validation tracking; Merge sometimes hurts; hyperparameters untuned. ACE argues GEPA's brevity drops domain detail.
- Implication:
  - Reflection works from traces plus textual feedback: retros carry the failing trace or test output for the steward (core method).
  - Keep competing brief variants: one best for a task family survives even when worse on average (Pareto +12.44 vs +6.05).
  - Short declarative instructions transfer across models, so briefs can be shared across harnesses; but one edit can wreck results (76% -> 10%), so steward edits need a check before approval.

#### Dynamic Cheatsheet: Test-Time Learning with Adaptive Memory (arXiv:2504.07952, v1 2025-04-10) — https://arxiv.org/abs/2504.07952
- Method: A black-box LM keeps a persistent text memory across inputs, no labels, no weight updates. DC-Cu: answer, then the same model curates memory (keep, refine, prune). DC-RS: retrieve top-3 similar past cases first, curate, then answer. Memory holds strategies, sketches, code snippets.
- Evidence: AIME 2024/2025/2020-24, GPQA-Diamond, Game of 24, Math Equation Balancer, MMLU-Pro; GPT-4o, Claude 3.5 Sonnet, GPT-4o-mini, Claude 3.5 Haiku; baselines plain prompt, empty memory, retrieval without curation, full history. Claude Sonnet AIME 2024 23.3 -> 50.0 (DC-Cu); AIME 2025 6.7 -> 36.7; GPQA 59.6 -> 68.7. GPT-4o Game of 24 10.0 -> 99.0 (a stored Python solver). Full history 26.7 vs DC-Cu 50.0; majority voting 23.33 (no gain). Tokens (Claude, AIME 2024): 370 baseline, 1,831 DC-Cu. Memory size: not in text.
- Limits: small models lose: GPT-4o-mini AIME 2024 16.7 -> 13.3, GPQA 34.3 -> 32.3; GPT-4o MMLU-Pro Engineering 53.2 -> 51.2; "retrieval can, in some cases, introduce confusion"; faulty heuristics amplified; curator may abbreviate memory instead of rewriting (ACE later measured this as collapse); R1/o1 gains minimal; curation sequential. Big wins need one reusable artifact.
- Implication:
  - Executable or procedural lessons (script, exact command) pay off most (10 -> 99); retros prefer concrete procedures over advice.
  - A Haiku-class curator degrades memory (GPT-4o-mini losses): steward is Opus-class, human gate stays.
  - Retrieval helps some tasks and confuses others: the digest routes lessons by type rather than dumping all into every brief.
  - Watch for the store shrinking across curations (abbreviation failure).

#### RIZZ: Routing Interactions to Near Zero-Interference Zones for Continual Adaptation of Black-Box Agents (arXiv:2606.20638, v1 2026-06-02) — https://arxiv.org/abs/2606.20638
- Method: External memory for a frozen model, split into branches per task family. An LLM judge labels each input; labels snap to a branch by similarity, else a branch spawns. Branches hold examples, IF-THEN rules with helpful/harmful counters, "common mistakes". Positive rules retrieve across branches; failures stay local. Only verifier-passed interactions write; periodic merge/prune; 64K prompt cap with a drop order.
- Evidence: StreamBench, TRACE, LongMemEval-S, tau-Bench, QCalEval; Claude Haiku 4.5, gpt-4o-mini for ablations; baselines Frozen, AMem, ACE. Reward: StreamBench 0.6013 -> 0.6339; TRACE 0.6369 -> 0.7060; LongMemEval-S 0.2020 -> 0.4836. ACE collapsed (0.1720, 0.0472, 0.082). tau-Bench pass@1 0.352 -> 0.400. Ablations (TRACE-100, full 0.5051): no verified-memory rendering 0.4391 (-6.6 pp), single branch 0.4853 (-2.0 pp). Router judge: GPT-4.1 0.5224 vs Haiku 4.5 0.5929. Compute about $5,000.
- Limits: needs "recurring local structure"; loses on DS-1000 (0.4670 vs Frozen 0.5360, "sparse, fragmented code branches") and single-session-preference (AMem 0.767 vs 0.5333); 1.5-1.7x Frozen cost on two benchmarks; poisoning risks. Nothing on multiple agents sharing memory or instruction files; interference is between task families in one stream.
- Implication:
  - Scope lessons by agent type (per-type briefs, not one CLAUDE.md): single branch -2.0 pp; local failure lessons avoid overgeneralised "don't do X".
  - Promote only retros from merged PRs or passed tests (-6.6 pp without verification, the biggest effect).
  - Hard size cap on CLAUDE.md and briefs with a drop order; unbounded playbooks collapsed.
  - Expect little gain on heterogeneous work (DS-1000 loss); gains come on repeated workflows (merge, deploy, tests).

#### Cross-cutting (this group)
- All four agree a frozen model plus evolving text memory beats the base on structured, repeated tasks, with measured gains of roughly 3-30 points; all gains are on auto-scored benchmarks, none on multi-agent coding, and none measures a human-approved instruction file.
- They disagree on brevity: GEPA prizes short declarative prompts (<33% of MIPROv2's); ACE argues brevity loses domain detail and grows long playbooks; RIZZ measured ACE's playbooks collapsing and caps at 64K. The measured common ground: incremental edits beat whole rewrites (ACE -27.8% SGC without deltas; DC's abbreviation failure), and size needs a hard cap.
- Reflection quality is the lever and the risk: ACE's harmful-reflector table, DC's small-model losses, GEPA's 76% -> 10% adversarial prompt. Weak curators make things worse, which argues for an Opus-class steward and a human gate; no paper tests a human gate.
- Verification before write is measured only by RIZZ (-6.6 pp without) and implied by ACE's no-label degradation; GEPA and DC rely on scores or nothing. Unverified retros are the main poisoning path.
- Scoping: RIZZ shows per-family memory helps modestly (-2.0 pp single branch) while positive rules can be shared; DC-RS shows retrieval helps on some tasks and confuses on others. A daily digest should route lessons by agent type rather than broadcast.

### Instruction files and coding-agent harness evolution


#### Skill Issue: Lessons from Optimizing Repository SKILLs for Coding Agents (arXiv:2609.12742, 11 Sep 2026) — https://arxiv.org/abs/2609.12742
- Method: Mines tasks from merged PRs of three Kotlin repos by reverting changes at a frozen base, then optimizes a repository SKILL.md with GEPA (reflective evolution) and SkillOpt (gated edits) against paired Claude Code + Sonnet 4.6 rollouts. Only SKILL.md varies; seed is empty.
- Evidence: Test splits of 20-26 tasks. No-SKILL resolve "40%" koog, "51%" kotest, "66%" ktor. GEPA "4.9pp on average"; SkillOpt "0.1pp above the seed". Best sign-test p = 0.29. Spend "$2,013.98". Human vs generated files: not measured here; cites Gloaguen et al. (2026): agent-generated AGENTS.md "−0.5%" and "−2%", not significant, cost up "20%–23%"; developer-written "+2.4%", not significant; with other docs removed, generated "+2.7%", read as "they largely restate the README". Length: no study; one long map-style file "emitted no patch" under a 14-turn cap. Content (one maintainer): repo-specific rules "very important"; "general best practices that the agent should know by itself" belong "in a global skill". Transfer: not studied; gskill's gains saturate in Claude Code (baseline 100%).
- Limits: splits too small to beat variance; one model, harness, reviewer; SKILLs "should be reviewed before merging". "The documents are more convincing than the numbers."
- Implication for a retro store, digest, and steward:
  - Expect no measurable lift from CLAUDE.md edits; judge steward edits by human content review, not resolve-rate deltas (p = 0.29).
  - Keep only repo-specific facts in CLAUDE.md; drop generic hygiene (maintainer finding).
  - Lessons duplicating README/docs cost 20-23% for no gain (Gloaguen); dedupe before merging.
  - Long inventories starve turns; cap size.

#### Agentic Harness Engineering: Observability-Driven Automatic Evolution of Coding-Agent Harnesses (arXiv:2604.25850, v4 18 May 2026) — https://arxiv.org/abs/2604.25850
- Method: Closed loop evolves a harness (system prompt, tool descriptions, tool code, middleware, skills, sub-agents, long-term memory file) with the model fixed. An Agent Debugger distills trajectories into reports; each edit ships a manifest predicting fixes and regressions, checked next round. Seed is one bash tool.
- Evidence: Terminal-Bench 2 (89 tasks), GPT-5.4 high, 10 iterations, "about 32 hours". pass@1 seed 69.7% → 77.0%; Codex 71.9%. Hard tier: 53.3% vs Codex 56.7%. SWE-bench Verified transfer: 75.2% → 75.6%, 12% fewer tokens. Cross-model TB2: deepseek-v4-flash +10.1 pp, qwen-3.6-plus +6.3 pp, GPT-5.4 medium +2.3 pp. Single-component ablation: memory only 75.3%, tool only 73.0%, middleware only 71.9%, system_prompt only 67.4% (−2.3 pp vs seed); singles sum +11.1 pp vs +7.3 pp full, "interact non-additively". Self-attribution: fix precision 33.7%/recall 51.4% (random 6.5%/10.6%); regression precision 11.8%/recall 11.1% (random 5.6%/5.4%). Dollar cost: not in text.
- Limits: two benchmarks; budgets fitted to GPT-5.4 high, so cross-model gains mix in operating point; "a controlled research prototype"; regression prediction "blind"; "high-variance setting".
- Implication for a retro store, digest, and steward:
  - Memory file was the strongest single component (+5.6 pp); prompt-only edits regressed. Favour a lessons file over prompt rewrites.
  - Each steward edit should state predicted fixes and risks for the next digest to check; regression predictions were near random, so human approval should target regressions.
  - Gains stayed on the evolved task family (+0.4 pp elsewhere); evolve per-type briefs against that type's own work.
  - Edits interact non-additively; evaluate batches, not single edits.

#### From Failed Trajectories to Reliable LLM Agents: Diagnosing and Repairing Harness Flaws (arXiv:2606.06324, v2 2 Jul 2026) — https://arxiv.org/abs/2606.06324
- Method: HarnessFix compiles failed traces and harness artifacts into an IR (steps, data/control links, anchors to prompts, tool specs, orchestration code), diagnoses across seven layers, maps flaw records to scoped repair operators, and accepts a patch only if it "stays within the regression limit" on a held-out set. Outcomes become "harness repair memory".
- Evidence: 30 agent repos: "approximately 45.3%" of records harness-related. GPT-5 mini, mean of 3 runs: GAIA 43.3→61.7, SWE-bench Verified (250) 45.3→57.3, AppWorld 36.7→43.0, TB2 17.6→26.5; beats human-designed harnesses "by 6.3% on average", self-evolution baselines "by 6.9% on average"; sign tests p ≤ "4.9×10^-4". Diagnosis on 20 annotated failures per benchmark: step accuracy 85.0 vs raw trace 55.0. Ablation (GAIA): prompt-only repair 50.6, w/o trace-grounded diagnosis 51.1, w/o regression-aware acceptance 55.6, full 61.7. Repairs transferred on GAIA: Sonnet 4.5 +5.5, Gemini 3 Pro +8.9. Offline tokens 33.5M-57.6M per benchmark. Dollar cost, regression limit, memory reuse: not in text.
- Limits: no limitations section; 20 gold trajectories per benchmark; transfer on GAIA only.
- Implication for a retro store, digest, and steward:
  - Retro entries should anchor to a trace step and artifact; raw-trace diagnosis scored 55.0 vs 85.0 with anchors.
  - Prompt-only repair was weakest (50.6 vs 61.7); let the steward propose tool and orchestration changes, not only wording.
  - Regression-aware acceptance was worth +6.1; the approval view should show validation results and regressed tasks, not just the diff.
  - Keep rejected edits as memory so the steward stops repeating them (design; reuse unreported).

#### Learning from Failure: Inference-Time Self-Improvement for Computer-Use Agents (arXiv:2606.31270, 30 Jun 2026) — https://arxiv.org/abs/2606.31270
- Method: Rollouts → failed trajectories → Claude 4.5 Sonnet diagnosis → code patches to the scaffold → re-evaluate, no weight updates. Four rounds each added one strategy: visual search (zoomed click crop), terminal execution, knowledge support (GPT-5-mini search), repetition warnings (trigger at 3 repeats).
- Evidence: OSWorld, OpenCUA-72B, 100 steps, 3 runs: 42.3 ± 2.6 → "48.9 ± 1.2". Single runs: OpenCUA-32B 34.5→38.2. Ablation (30-step small set): baseline 41.67, +visual search 47.22, +repetition 44.40, +terminal 47.19, +knowledge 44.44, full 52.74. Transfer (Qwen3-VL-32B): AndroidControl 28.37→36.23. Runtime "8%" up, steps "15%" fewer. Failure mix shifted from action loops 43% to planning 28% / loops 24%. Human-in-the-loop: the LLM diagnoses and proposes candidates, a human selects, the LLM writes the patch; "over 97%" of refinements "accepted without modification"; human edits "less than 3% of the modified lines on average". Reviewer count, hours: not in text.
- Limits: no limitations section; several single-run numbers; ablation step budget differs from main (+11.07 vs +6.6); human effort unquantified; "first empirical evidence" is a self-claim.
- Implication for a retro store, digest, and steward:
  - Human approval is cheap when offered ranked candidates to pick from (>97% accepted unmodified); the digest should present choices, not open diffs.
  - Fixing the dominant class (loops 43%) shifted the mix rather than removing failures; re-categorize failures after each steward edit lands.
  - Winning fixes were capabilities, not text; prioritize lessons naming a missing tool or check.
  - One change per round kept attribution clean; limit the steward likewise.

#### Cross-cutting (this group)
- Measured vs claimed: harness-evolution papers (AHE +7.3 pp, HarnessFix +6.3 to +18.4, LfF +6.6) show significant gains on their own benchmarks; the instruction-file paper (Skill Issue +4.9pp, p = 0.29) and the cited Gloaguen study find no significant effect from AGENTS.md-style text. Instruction text alone is the weakest lever wherever ablated (AHE system_prompt only −2.3 pp; HarnessFix prompt-only 50.6 vs 61.7).
- Trace-grounded diagnosis beats outcome-only optimization (HarnessFix 85.0 vs 55.0 step accuracy; AHE relies on Debugger reports; LfF diagnoses per trajectory). Retro entries are useful only if they point at a concrete step and artifact.
- Regression control is the open problem: AHE regression prediction near random, HarnessFix's regression gate worth ~6 points, Skill Issue cannot detect a few points at all. Human approval should check regressions and a validation signal, not prose quality.
- Repo-specific concrete rules are what maintainers value; generic best practice and README restatement is padding that costs tokens.
- Cost is real and under-reported: "$2,013.98" for an inconclusive result (Skill Issue), "about 32 hours" (AHE), 33-58M offline tokens per benchmark (HarnessFix), human time never quantified (LfF). A retro loop needs a budget and a cheap evaluation before accepting a steward edit.

### Reflection and lesson memory


#### Reflexion: Language Agents with Verbal Reinforcement Learning (arXiv:2303.11366, 2023) — https://arxiv.org/abs/2303.11366
- Method: Actor (ReAct/CoT) runs a trial; an Evaluator (exact match, heuristics, self-generated unit tests, or an LLM) gives pass/fail; a Self-Reflection LLM turns the failed trajectory into a short textual lesson, appended to memory and prepended to the next trial of the *same task*. Triggered only on failure. Memory is a sliding window, "usually set to 1-3".
- Evidence: AlfWorld (134 tasks) "130 out of 134 tasks", "an absolute 22% in 12 iterative learning steps". HotPotQA Table 5: CoT(GT)+gpt-4 0.68→0.80, ReAct+gpt-4 0.39→0.51; reflection text gives "an 8% absolute boost" over episodic memory alone. HumanEval PY 0.80→0.91 (GPT-4); MBPP PY 0.80→0.77 (worse; self-test false-positive rate 0.16 vs 0.01). HumanEval Rust: base 0.60, no test gen 0.52, no self-reflection 0.60, full 0.68. starchat-beta: 0.26 with and without. WebShop: "fails to significantly outperform ReAct". Cost: not in text.
- Limits: "non-optimal local minima"; evaluator quality decides (MBPP regression); no gain on weak models; fails on creative exploration; "no formal guarantee". No degradation study; memory is per-task and capped at 1-3.
- Implication:
  - Lessons help only with a trustworthy pass/fail signal (MBPP regression): retros should cite evidence (test output, review verdict), not the agent's belief it failed.
  - Reflection text beat raw trajectory by 8 points: a short written "why" beats a log link.
  - Gains are same-task retries with 1-3 memories; nothing supports a large growing store. Keep what's retrieved small.
  - Weak models don't self-correct (starchat): the steward should be Opus, not Haiku.

#### ExpeL: LLM Agents Are Experiential Learners (arXiv:2308.10144, 2023) — https://arxiv.org/abs/2308.10144
- Method: Run ReAct+Reflexion on training tasks and pool all trajectories. An extractor (gpt-4-0613) builds a shared insight list from (a) fail/success pairs of the same task and (b) chunks of successes, via ADD (new insight, count 2), EDIT (+1), UPVOTE (+1), DOWNVOTE (-1); deleted at count 0. Inference: full insight list plus top-k similar successful trajectories (Faiss, all-mpnet-base-v2) in the prompt, one attempt.
- Evidence: gpt-3.5-turbo-0613 policy, SR%: HotpotQA ReAct 28.0±1.4 → ExpeL 39.0±1.7 (insights-only 36, retrieve-only 31); ALFWorld 40.0±0.3 → 59.0±0.3 (insights-only 50, retrieve-only 55); WebShop reward 0.666 → 0.701; FEVER transfer 63±0.4 → 70±0.7. Vs Reflexion R3: ALFWorld 54.4 vs ExpeL 59.0; ExpeL+Reflexion 64.2. Ablation (HotpotQA): hand-crafted insights 32.0±1.1; Reflexion's self-reflections fed to extractor 29.0±0.4; gpt-3.5 extractor 32.0±0.4; ExpeL 39.0. Tokens/trajectory HotpotQA 4,310 vs 1,320. Cost: not in text.
- Limits: text-only, closed models, deterministic environments; lifelong agents "may need extra insight retrieval" for context size. Insight-count effect (Fig. 6): not in text. No degradation study.
- Implication:
  - Extraction needs the strong model (gpt-3.5 32 vs gpt-4 39): steward is Opus-class; developers only file raw retros.
  - Raw per-episode reflections hurt as extractor input (29.0 vs 39.0): the steward abstracts from outcomes, never pastes retro text into CLAUDE.md.
  - Vote counter exists because "even successful trajectories can be suboptimal": the digest could carry up/downvotes per lesson and drop at zero.
  - Insights beat examples on HotpotQA (36 vs 31), not ALFWorld (50 vs 55): keep lessons and links to concrete runs.

#### ReasoningBank: Scaling Agent Self-Evolving with Reasoning Memory (arXiv:2509.25140, 2025) — https://arxiv.org/abs/2509.25140
- Method: After each task an LLM judge (no ground truth) labels success/fail; an extractor distils ≤3 items {title, description, content}: strategies from successes, pitfalls from failures. Items are "directly added without additional pruning"; retrieval is top-k by embedding cosine, default k=1, into the system prompt. MaTTS: k parallel runs or sequential self-refinement, memory extracted from the contrast.
- Evidence: WebArena SR, No Memory → ReasoningBank: Gemini-2.5-flash 40.5 → 48.8 (+MaTTS 51.8), steps 9.7 → 8.3; Gemini-2.5-pro 46.7 → 53.9; Claude-3.7-sonnet 41.7 → 46.3. SWE-Bench-Verified: flash 34.2 → 38.8 (Synapse 35.4), pro 54.0 → 57.4 (Synapse 53.4, below no-memory). Ablation (Shopping, flash): success-only 46.5 vs success+failure 49.7; AWM with failures 44.4 → 42.2. Retrieved count: 1 item 49.7, 2 → 46.0, 3 → 45.5, 4 → 44.4. Judge 72.7% accurate; simulated 70–90% judges similar. Tokens/trajectory 50,847 → 53,055 ("around 4.3%"); AWM 59,373. Failure-only ablation: not in text.
- Limits (App. E): content studied, not architecture; retrieval/consolidation simple; judge noise. No merge/forget; growth never measured.
- Implication:
  - Distilled failure pitfalls help (+3.2 over success-only) but hurt workflow memory: steward rewrites failed-run retros as "pitfall + check".
  - More retrieved items hurt (49.7 → 44.4): briefs carry the few most relevant lessons, not the store.
  - A 72.7% judge sufficed; human approval is above that bar. Don't block retro filing on certainty.
  - Steps fell most on successes (Shopping 6.8 → 4.7): measure lesson value by turns per task type, not only pass rate.

#### Agent Workflow Memory (arXiv:2409.07429, 2024) — https://arxiv.org/abs/2409.07429
- Method: An LM induces reusable "workflows" (description + steps of state, reasoning, action with placeholders like "{product-name}") from successful trajectories only. Offline: once from training data. Online: an LM evaluator labels each trajectory 0/1; successes become workflows appended per website and put in the prompt (or exposed as callable actions, AWM-AS).
- Evidence: WebArena (GPT-4, 812 tasks): AWM 35.5 SR / 5.9 steps vs BrowserGym 23.5 ("51.1%" relative), SteP human workflows 33.0, AutoEval 20.2 / 46.7 steps. Mind2Web step SR cross-task MindAct 36.2 → AWM offline 45.1 ("24.6%"), online 43.6; cross-domain 18.6 → 35.5. Ablations: rule-based vs LM induction 35.6 vs 35.5; code vs text 45.1 vs 45.4; offline+online combined 44.5, below either ("not fully compatible"). Utility rate 0.94. Fast learning "between 0–40 examples". Failure induction: not tested. Cost: not in text.
- Limits: fixed sequences break on dynamic pages; workflows push state-mismatched actions (lower action F1); online induction "can learn from incorrect predictions"; two web benchmarks, GPT only; no growth study. ReasoningBank later shows AWM degrades with failures.
- Implication:
  - Procedural recipes with placeholders are a proven artifact distinct from lessons; per-type briefs are their home, grouped by task type as AWM groups per website.
  - Mixing provenance hurt (44.5): the steward rewrites into one consistent brief rather than appending.
  - Gains saturate after ~40 examples: the daily digest sees diminishing returns per type fast; prioritise new types.
  - Success-only induction with an LM judge admitted wrong workflows: require merge/test evidence before promoting a recipe.

#### PreFlect: From Retrospective to Prospective Reflection in LLM Agents (arXiv:2602.07187, 2026) — https://arxiv.org/abs/2602.07187
- Method: Reflect on the *plan* before acting. A reflector checks each plan against a fixed taxonomy of "Planning Errors" (insufficient constraint verification, shallow content verification, ineffective tool selection), flags ≤2 critical errors, revises; dynamic re-planning re-runs plan+reflect when progress stalls. The taxonomy was built once offline from 32 mixed-outcome tasks (300 trajectories, 68 diagnoses, LLM-aggregated, one category removed by hand); no online updating.
- Evidence: GAIA validation (165), GPT-4.1: Smolagents 46.06, +Reflexion 49.70, +Self-Refine 49.70, +PreFlect 58.18; Level 3: 38.46 vs Reflexion 19.23. Gemini-2.5-pro: 50.30 → 59.39. SimpleQA (100): 83 vs Reflexion 79. Ablation: w/o Planning Errors 50.30, w/o re-planning 51.52. Defect rate 74.44%; 64.92% of errors are constraint verification. Cost: $46.31 → $54.48 ("17.64% cost increase"); Reflexion cost: not in text.
- Limits: no limitations section; 20-step budget; Table 2 cross-framework numbers uncontrolled. The claim that retrospective memories cause "contextual interference that destabilizes future decision-making" is asserted, not measured; no multi-round degradation experiment. Reflexion runs within one task only, a weak proxy for a shared store.
- Implication:
  - The main win is a small, fixed, offline-curated error taxonomy (58.18 vs 50.30 without): the closest analogue to a steward-edited checklist of 3-5 failure classes in CLAUDE.md.
  - Lessons pay off at plan time: briefs need a "check before starting" block read before the agent commits.
  - Taxonomy came from mixed-outcome tasks, like ExpeL's pairs: retros from retried/flaky tasks are the richest input.
  - Human pruning was part of the method (one category removed by hand): approval isn't overhead.

#### Cross-cutting (this group)
- Failures vs successes: all four learning papers use successes; failures help when distilled into pitfalls (ReasoningBank 46.5 → 49.7, ExpeL pairs, PreFlect mixed-outcome seeds) and hurt when stored as procedures (AWM 44.4 → 42.2 with failures; ExpeL 29.0 when raw reflections feed the extractor). Retro text should be abstracted by a strong model before reaching any brief.
- Abstraction is the lever and is model-sensitive for lessons (ExpeL gpt-4 39 vs gpt-3.5 32) but not for near-literal recipes (AWM 35.6 vs 35.5). Lesson curation needs Opus-class; recipe induction can be cheap.
- Less is more in context: ReasoningBank k=1 49.7 → k=4 44.4; Reflexion caps at 1-3; AWM combined sets 44.5 < either; PreFlect uses three categories. Nobody measured a store growing over months: degradation over time is unmeasured in all five papers, PreFlect's interference claim included.
- Triggering: Reflexion/ExpeL on failure; ReasoningBank after every task via a 72.7% judge; AWM only on judged success; PreFlect before acting. Evidence favours cheap always-on capture with a noisy judge, strong curation, and plan-time delivery.
- Measured vs claimed: gains are on web navigation, QA, and small code benchmarks; the only coding-agent number is SWE-Bench-Verified +4.6/+3.4 (ReasoningBank). None tests multi-agent, shared memory, or human-approved edits; the implications above are extrapolations.

### Multi-agent failure and self-evolution

#### Why Do Multi-Agent LLM Systems Fail? (arXiv:2503.13657, v1 Mar 2025, v3 26 Oct 2025) — https://arxiv.org/abs/2503.13657
- Method: Grounded-theory coding of 1642 traces from 7 MAS (MetaGPT, ChatDev, HyperAgent, AppWorld, AG2, Magentic-One, OpenManus) on 8 benchmarks. Yields MAST: 3 categories, 14 modes, an o1 annotator, two case studies.
- Evidence: Prevalence: FC1 System design 44.2% (disobey task spec 11.8, disobey role 1.5, step repetition 15.7, lost history 2.8, unaware of termination 12.4). FC2 Inter-agent misalignment 32.35% (conversation reset 2.2, fail to ask clarification 6.8, derailment 7.4, info withholding 0.85, ignored input 1.9, reasoning-action mismatch 13.2). FC3 Verification 23.5% (premature termination 6.2, no/incomplete verification 8.2, incorrect verification 9.1). Human κ=0.88; o1 annotator κ=0.77. AG2 on 200 GSM-Plus, GPT-4/GPT-4o: baseline 84.75/84.25, improved prompt 89.75/89.00, new topology (solver, coder, verifier; only verifier ends) 85.50/88.83 (GPT-4 topology p=0.4; GPT-4o p=0.03). ChatDev, ProgramDev-v0 (32 tasks)/HumanEval: baseline 25.0/89.6, prompt 34.4/90.3, cyclic topology 40.6/91.5. Authors: "topology-based changes are more effective than prompt-based changes", but gains "do not constitute substantial improvements".
- Limits: "foundational first step"; fixes "are not universal" across LLMs; ProgramDev tasks simple; closed-source systems excluded.
- Implications:
  - FC1 is 44% (repetition 15.7, termination 12.4): lessons on spec, termination, and repetition are highest-yield; the steward should edit role and stop rules first.
  - Prompt edits helped (ChatDev +9.4, AG2 +5) but structure more (ChatDev +15.6): a steward editing only instruction files has a ceiling; some lessons must become process changes (who may close, reviewer gate).
  - Verification 23.5%: reviewers need task-objective checks, not only tests.
  - LLM annotation κ 0.77 vs human 0.88: expect about one in five retro labels wrong.

#### Which Agent Causes Task Failures and When? (arXiv:2505.00212, v1 May 2025, v3 2 Jun 2025) — https://arxiv.org/abs/2505.00212
- Method: Defines automated failure attribution (responsible agent + decisive step) and builds Who&When: 184 human-annotated failure logs from 127 MAS (CaptainAgent-generated, ≤4 agents/10 steps; hand-crafted Magentic-One on GAIA/AssistantBench, up to 130 steps). Compares all-at-once, step-by-step, and binary search prompting.
- Evidence: GPT-4o, with GT / without, alg-gen; hand-crafted. Agent-level: all-at-once 54.33/51.12; 55.17/53.44. Step-by-step 35.20/26.02; 34.48/32.75. Binary 44.13/30.11; 51.72/36.21. Step-level: all-at-once 12.50/13.53; 5.26/3.51. Step-by-step 25.51/15.31; 7.02/8.77. Random: agent 29.10; 12.00, step 19.06; 4.16. Abstract: "53.5% ... agents but only 14.2% ... steps". o1 and DeepSeek R1 don't consistently beat GPT-4o (hand-crafted agent-level 41.38, 56.90 vs 54.31). Hybrid: step 12.28 vs 4.39 at 149,177 vs 17,106 tokens. Removing explicit reasoning cost 7.4 (agent) and 4.4 (step) points. Accuracy drops with log length; at 93-130 steps all methods "approach 0%". Annotation: 30.9+30.2+23.2 hours, 15-30% uncertain labels.
- Limits: Expert annotators disagreed; GT is a "reference signal"; cost confined hybrid/multi-model runs to hand-crafted logs; no limitations section; some cells contradict "GT always helps".
- Implications:
  - Agent blame ≈54%, step blame ≈14%: a retro naming a culprit is a hypothesis; the digest should carry the evidence line, not just the verdict.
  - Accuracy collapses on long logs: file the retro at the failure, by the nearest agent, with the step, rather than having a steward reconstruct blame later.
  - Explicit reasoning gave +7.4: the retro template should require a one-line "why".
  - Experts disagreed on 15-30%: the approving human needs the trace link, not a summary.

#### Beyond Individual Intelligence: Surveying Collaboration, Failure Attribution, and Self-Evolution in LLM-based MAS (arXiv:2605.14892, v2 15 May 2026) — https://arxiv.org/abs/2605.14892
- Method: 89-page survey (Qi, Ma et al., XJTU), "LIFE" progression (Lay, Integrate, Find faults, Evolve). Section 4 "Multi-Agent System Failure Attribution": 4.2 taxonomy, 4.3 Data-driven / Constraint-Guided / Causal-inference, 4.4 evaluation. Section 5 "Multi-Agent System Self-Evolution": 5.3 Agentic {Prompt, Memory, Parameter}, Systemic {Topology, Composition, Shared Memory}, Meta; 5.4 six mechanisms (Reflection, RL, SFT, EA, Textual Gradient, Heuristic).
- Evidence: No experiments. Datasets: Who&When 184, TRAIL 148, AgentFail 307, MP-Bench 289. ~26 attribution methods; 31 self-evolution frameworks. Shared memory: G-Memory (three-tier graph: strategic knowledge, task meta-info, logs), LIET. Prompt: MorphAgent, COPPER ("Shared Reflector" feeds all actors). Composition: AutoAgents, EvoMAC (gradient + update agents from compiler feedback). Meta: ADAS, AFlow ("4.55% of inference cost"), MaAS, AgentBreeder. Optima: "2.8× performance gain while reducing token usage by 90%". No attribution accuracies quoted.
- Limits (stated): attribution definition unsettled; origin ≠ where visible; synthetic data unrealistic; "evaluation-repair loop remains incomplete". Reflection is "self-referential" with sycophancy risk; archival memory hits a "saturation ceiling"; structural adaptations are discarded per task; reward hacking (AgentBreeder).
- Implications:
  - The retro store is Shared-Memory plus steward Prompt evolution: lowest barrier, but retrieval degrades as it grows; consolidate and prune.
  - 5.4: same LLM generating and judging is the weak point; the human gate and test/log-backed lessons (as EvoMAC) are the decoupling.
  - 5.3.2 open question: team shapes never feed persistent knowledge; lessons about team structure belong in the store too.
  - 4.5: a steward edit should cite the retro and the outcome it changed, closing the open loop.

#### MAR: Multi-Agent Reflexion Improves Reasoning Abilities in LLMs (arXiv:2512.20845, v1 Dec 2025, v2 Jun 2026) — https://arxiv.org/abs/2512.20845
- Method: Replaces Reflexion's single self-reflection with a persona debate: after a failed trial, persona critics (HotPotQA: Skeptic, Logician, Creative, Verifier; HumanEval: Senior Engineer, QA Engineer, Code Reviewer) diagnose the scratchpad, agree/disagree, and a judge writes a "Consensus Reflection" (≤2 rounds) into the actor's memory. Motivation: "degeneration-of-thought" in self-reflection.
- Evidence: GPT-3.5 Turbo for all roles. HotPotQA EM, 100 hard questions, 5 trials: ReAct 32.0, Reflexion 44.0, MAR 47.0. HumanEval pass@1: GPT-3.5 67.1, Reflexion GPT-3.5 76.4, MAR 82.6 (+6.2); GPT-4 81.7, Reflexion GPT-4 replicated 89.4 (paper 91.0). Replications under originals (Reflexion HotPotQA 44 vs 51). No ablations on persona count or diversity; debate depth not ablated. Cost: "roughly a 3x increase in API calls and latency compared to Reflexion"; "300-400 API calls per task". No significance tests.
- Limits: Stated: cost; EM a weak reward (correct answers marked wrong). Also: 100 questions; GPT-3.5 only; inconsistent HumanEval trial budget (2 vs 3); persona text typos.
- Implications:
  - Critique from a persona other than the author beat self-reflection (+6.2 HumanEval): let reviewers and managers file retros about a developer's failure, marked by author role.
  - The judge's consensus reflection maps onto the daily digest: merge conflicting retros into one lesson rather than listing all.
  - 3× cost for a few points: reserve multi-persona reflection for repeated or costly failures (the steward), not every task.
  - Weak evidence (no ablations, small set): don't cite as proof that more critics are better.

#### Cross-cutting (this group)
- Where failures come from is measured (MAST: 44% design, 32% coordination, 23.5% verification); who caused them is not reliably recoverable afterward (Who&When: ~54% agent, ~14% step, near 0 on long logs). Capture lessons at the failure, with evidence, not by steward reconstruction from transcripts.
- Instruction edits (the steward's lever) help but are bounded: MAST's structural changes beat prompt changes in both case studies; the survey calls prompt evolution "strictly bounded". Some lessons must be allowed to change process (gates, who closes, team shape), with human approval.
- All four flag the self-referential loop: LLM judging its own failure (MAST κ 0.77 vs 0.88; Who&When reasoning models no better; survey's sycophancy warning; MAR's motivation). Human approval plus test/log evidence is the decoupling; keep both.
- Shared stores degrade as they grow (survey: retrieval accuracy drops, "saturation ceiling"; Who&When: accuracy falls with context). The digest and instruction files need consolidation and pruning, not accumulation.
- Nobody has closed attribution-to-repair with evidence (survey 4.5); MAR and MAST gains are single-digit points on small sets. Run the retro system as a measured experiment (did the edit change the next outcome?), not a proven technique.

### Skill libraries, overfitting and pruning


#### AutoRefine: Compiling Trajectories into Validated Typed Agent Artifacts (arXiv:2601.22758, v2 10 Aug 2026) — https://arxiv.org/abs/2601.22758
- Method: Contrasts failed and successful trajectories, turns each failure cluster into an "intervention specification", and compiles it into the smallest schema that closes all obligations: Rule (parent context), then Skill, then Subagent. Admission needs a contract gate plus a replay gate: the correction set must improve with "no observed preservation regression". Grouping is criterion-based, not embedding clustering.
- Evidence: GPT-5.6-terra throughout. ALFWorld 100.0 vs 97.8 (SkillOpt); TravelPlanner 80.6 vs 50.0 (AutoManual); SpreadsheetBench 73.57 vs 67.50 (p=.027). TravelPlanner ablation (Δ from 80.56): no replay gate −16.11, no boundary closure −15.00, no preservation cases −10.56, no minimality order −11.11, no Skills −20.00, no Subagents −8.33, no Rules −1.11 (p=.875, n.s.). 180-task stream: 89%, use 96.4%; AgentFactory 14%, degradation 55.0%.
- Limits: replay is "not a global non-regression guarantee"; single runs; offline 9.43M vs 3.34M tokens (2.82×); failure modes "boundary errors" and "evidence-scope errors"; "a validated artifact can also propagate a mistaken or harmful strategy at scale". Pruning, merging, retrieval out of scope. "High use measures exposure and not utility."
- Implications:
  - Link every retro to the failing run and a preserved success; the replay gate was the largest ablation (−16.11).
  - Prefer the smallest artifact (minimality −11.11); always-loaded Rules were n.s. (−1.11) while on-demand Skills carried −20.00, so push lessons into per-type briefs, not CLAUDE.md.
  - Report use and utility separately; gating costs ~3× offline, justified only for reused lessons.

#### Rethinking Self-Evolution: A Constrained Exploration-Exploitation Process for Mitigating Skill Overfitting (arXiv:2607.26643, v2 19 Aug 2026) — https://arxiv.org/abs/2607.26643
- Method (SkillBoost): A frozen LLM runs tasks under one skill document. Exploitation attributes failures to skill components; exploration generates N=4 candidate edits from the same diagnosis; acceptance commits the best only if r(s′)>0 on the full set 𝒟 and Regress(s′)<ε (previously correct cases broken), else no change. Single skill file, no library.
- Evidence: SpreadsheetBench, BFCL-v4, LiveMathematicianBench, ALFWorld, DocVQA; five models (Claude-opus-4-6, Qwen, DeepSeek-v4-pro, Kimi-k2.6); baselines human skill, Trace2Skill, SkillOpt. Claude-opus-4-6: Spreadsheet 82.5 (+32.5), BFCL-v4 48.5 (+21.4), LiveMath 76.0 (+47.4), ALFWorld 92.9 (+12.3). Overfitting = Δ Test−Train: SkillBoost −3.8 to +2.5; SkillOpt worst −26.7; Trace2Skill −17.7. "SkillOpt grows monotonically across all benchmarks"; SkillBoost "actively prunes an over-grown skill" on BFCL-v4. No gate: Claude BFCL 37.7 vs 48.5. Cost 95K–154K tokens per round; evaluation 85–97% of total. ε value: not in text.
- Limits: depends on correct failure attribution; "function-calling tasks (such as BFCL-v4) improve very little even when given longer skill documents"; gate checks the full set, no guard split stated; text inconsistencies; no bloat/dedup study.
- Implications:
  - Detect overfitting as a held-out gap: show a lesson's effect on tasks it was not written from.
  - Edit the diagnosed instruction, do not append; each exploitation module's removal cost accuracy.
  - Give the steward a length budget and let it delete; longer skills did not help BFCL-v4.
  - Evaluation dominates cost, so batch edits daily with one check each.

#### Dynamic Agent Skills: A Lifecycle Survey and Taxonomy of Evolving Skill Libraries (arXiv:2607.10113, v1 11 Jul 2026) — https://arxiv.org/abs/2607.10113
- Method: Audits 124 papers (cutoff May 31 2026): six senses of "skill", eight lifecycle stages (evidence, proposal, admission, storage, retrieval, maintenance, distillation, governance), ten operators (Add, Refine, Merge, Split, Prune, Distill, Abstract, Compose, Rewrite, Rerank), seven evidence-graded patterns (A–D, qualitative).
- Evidence: 9.1 "Curated skills outperform unverified self-generated skills" (A/B): CoEvoSkills without verifier 71.1%→41.1%; EvoSkill Pareto selection on held-out validation +7.3 OfficeQA, +12.1 SealQA, avoiding "redundant/conflicting-skill accumulation seen under greedy acceptance"; CODE-SHARP 24.30%→41.02% with a learned gate. 9.3 flat retrieval degrades: selection ~96–98% at 16–32 skills, 92% at 64, 78% at 128, 64% at 256. 9.5 "Focused libraries often beat comprehensive ones even when the focused one is a subset" (B/C). 9.6 maintenance load-bearing: AutoRefine maintenance-off 35.6%→31.1%, repo 4.5×, utilization 0.71→0.08 (cites an earlier AutoRefine version; v2 has no such ablation); SkillOps 79.5%→71.9%. 9.8 "skill usage is not skill utility": SkillFlow-Bench Kimi K2.5 +0.60 despite 66.87% use, GPT 5.3 Codex −6.02; SWE-Skills-Bench 49 skills, +1.2% average, 39 no gain, 3 regress. Always-loaded: SkillsInjector "static all-injection can degrade performance" (numbers not in text); SRA agents load skills "regardless of whether the gold skill is present or needed". Overfitting: "residual overfitting to validation splits", "local validation may miss transfer regressions". Rollback: PSN reverts when success "drops by more than 20%". Dedup: Merge operator only; no general method.
- Limits: "coded patterns in a heterogeneous corpus, not causal conclusions"; schedules are "engineering defaults"; verifiers go stale under drift (12.2); no shown fix for retrieval past ~128 skills (12.5); "some verification is usually valuable, not that more verification is always better".
- Implications:
  - Admission gate before retrieval: the strongest evidence is against unverified self-written lessons (71.1→41.1). Human approval of steward edits is that gate; raw retros never auto-enter CLAUDE.md.
  - Keep CLAUDE.md focused (9.5, SkillsInjector); accumulate in retrievable briefs, expecting selection to fall past ~64–128 items.
  - Digest measures utility, not citations (39/49 skills no effect).
  - Daily digest = maintenance schedule; keep versions for rollback; >20% success drop is the one published threshold.

#### CODESKILL: Learning Self-Evolving Skills for Coding Agents (arXiv:2605.25430, v2 25 Sep 2026) — https://arxiv.org/abs/2605.25430
- Method: A trained 4B "skill manager" (Qwen3.5-4B) runs a lifecycle over markdown skills: extraction, evolution (edit one skill), maintenance (add/merge/drop against retrieved similar skills), with provenance. Task-level skills are retrieved before a task; event-driven skills on execution events. Trained with SFT then GRPO; reward = judge quality + execution gain, gated by an alignment factor (skill actually followed).
- Evidence: EnvBench (150 held-out repos), SWE-Bench Verified (150 held-out), Terminal-Bench 2 (unseen). Policy Qwen3.5-35B-A3B average pass: no-skill 29.32, subtask memory 33.48, best prompt-based manager 35.25, SFT-only 34.54, CODESKILL 40.35. SWE-Bench Verified 68.00 vs 57.33; Terminal-Bench 2 36.47 vs 25.88. Ablation (avg, bank size): event-only 35.10 (916), task-only 32.35 (336), extraction-only 37.88 (1252), +evolution 39.53 (1252), full 40.35 (676, "approximately 46%" smaller). Drop criteria: "redundant, weakly evidenced, unsafe, too local, or too task-specific"; merge judge rejects "over-general umbrella" triggers. Top-k: not in text.
- Limits: no held-out validation per skill before admission (an LLM decision; execution reward only in training); bank built over the test set with same-instance provenance filtering; ~230 GPU-hours on 4 H100s; end-to-end cost "future work".
- Implications:
  - A steward that merges and drops is supported (+0.82 avg, store halved), but the pruning gain is small and not isolated.
  - Two retro granularities: per-task (per-type brief) and per-event (error signature, retrieved on demand); event-only beat task-only (35.10 vs 32.35).
  - Each retro carries a tight "when_to_apply".
  - Credit a lesson only when the agent actually followed it (alignment factor).

#### A Survey of Self-Evolving Agents: What, When, How, and Where to Evolve on the Path to Artificial Super Intelligence (arXiv:2507.21046, v4 16 Jan 2026) — https://arxiv.org/abs/2507.21046
- Method: Taxonomy by what evolves (models, context = prompts and memory, tools, architecture), when (intra- vs inter-test-time; ICL, SFT, RL), how (textual/internal/external/implicit reward, imitation, population-based), where (general; coding, GUI, finance, medicine). Section 7 sets evaluation goals (adaptivity, retention, generalization, efficiency, safety) and paradigms (static, short-, long-horizon).
- Evidence: Narrative, few numbers. Memory ops: Mem0 deletes on contradiction; Memory-R1 learns add/merge/update/delete with RL; SAGE forgets by an Ebbinghaus curve; ExpeL insights, ReasoningBank strategies, Agent Workflow Memory sub-task sequences, Voyager code library. Tools: large libraries cause a "curse of abundance" making retrieval "slow and inaccurate". Coding: SICA edits its own codebase; EvoMAC "textual backpropagation" from compile/test failures. Table 11 SWE-bench: Reflexion 14.3%, Learn-by-Interact 18.7% (Gemini-1.5-pro); 54.4% / 60.0% (Claude-3.5-sonnet). Defines FGT and BWT forgetting metrics. Critique: "the overwhelming majority of existing benchmarks adopt episodic evaluation where agent state resets between tasks"; "No existing benchmark examines whether agents preserve generalization breadth as they specialize"; "Efficiency suffers from sparse and inconsistent reporting of evolution costs". Dedup, skill overfitting, held-out skill validation, retrieval vs always-loaded: not in text (only APE scoring prompts on validation examples and "validate-by-reproducing" for self-generated tasks).
- Limits: "fully autonomous self-evolution without human intervention represents an aspirational goal rather than the current norm"; memory-driven reward hacking ("learn to issue unnecessary refunds because its memory correlates them with high satisfaction ratings"); memory poisoning; vulnerable self-made tools; wants a self-modified model checked "against a 'golden dataset'" before deployment. v4 predates most 2026 skill-library work.
- Implications:
  - Human approval of steward edits matches the field's state; it is the "golden dataset" check applied to instructions.
  - Guard against memory-driven reward hacking: a retro saying "X got approved" can encode a spurious correlation; the digest separates outcome from approval.
  - The store needs delete/contradiction handling and decay, not only append (Mem0, SAGE).
  - Log before/after per agent type over time; no benchmark measures retention or generalization drift, so the system must.

#### Cross-cutting (this group)
- Overfitting is detected as a gap: train vs held-out (SkillBoost Δ; SkillOpt −26.7), case-linked replay (AutoRefine), or Pareto selection on a validation split (EvoSkill). None gives a cheap per-lesson test, and "local validation may miss transfer regressions". Minimum for stam: record a lesson's source runs and watch later runs of the same type for regression before the steward keeps it.
- Bloat is count vs utility: CODESKILL 1252→676 for +0.82 points; AutoRefine use 96.4% yet "use is not utility"; SWE-Skills-Bench 39/49 skills no gain. Pruning is LLM-judged (CODESKILL drop criteria), gate-driven (SkillBoost shrank a skill), or threshold rollback (PSN >20% drop). No learned bloat detector in any paper.
- Dedup/merge is rubric-driven (CODESKILL merge judge; AutoRefine criterion-based grouping, not embeddings); surveys list Merge as an operator without a general method. Tight triggers make merge decidable.
- Always-loaded vs retrieved: direct evidence is thin. AutoRefine's always-loaded Rules were n.s. (−1.11) vs on-demand Skills −20.00; the Dynamic Skills survey says static all-injection degrades, focused subsets beat comprehensive libraries, and flat retrieval falls from 92% at 64 to 64% at 256 items. Keep CLAUDE.md short and stable; put accumulating lessons in retrievable per-type briefs.
- Cost moves offline with gating (AutoRefine 2.82× tokens; SkillBoost evaluation 85–97% of spend; CODESKILL ~230 GPU-hours). A daily digest with batched, once-checked steward edits is the cheap end of these designs.

### Self-improving agents and memory systems

#### A Self-Improving Coding Agent (SICA) (arXiv:2504.15228, April 2025) — https://arxiv.org/abs/2504.15228
- Method: One agent edits its own Python codebase (tools, sub-agents, prompts); no separate meta-agent. Each iteration the best-scoring archived agent reads the archive, implements one improvement; the new agent is benchmarked and stored. Utility U = 0.5·score + 0.25·(1 − min(1, cost/$10)) + 0.25·(1 − min(1, time/300 s)), halved on timeout; used only to pick the next base agent.
- Evidence: Sonnet 3.5 (v2); o3-mini reasoning sub-agent. SWE-Bench Verified random 50, LiveCodeBench 50, two agent-made synthetic benchmarks. Iter 0 → 15: SWE-Bv 0.17 → 0.51 (0.53 at iter 14), LCB 0.65 → 0.71, file editing 0.82 → 0.91, symbol location 0.35 → 0.40. Cost/problem $1.91 → $1.70; time 130.2 s → 114.5 s. Baseline is iteration 0; no ablations.
- Limits: Non-monotonic: SWE-Bv 0.44 (iter 12) → 0.27 (iter 13), 0.38 → 0.30 (iter 4 → 5); failed iterations stay in the archive "in principle acting as an example of what not to do". Reasoning barely improved: 76% average vs "o3-mini model alone scores 87% and 79%". Path dependency ("initial feature ideas would often heavily influence later feature ideas"). 15 iterations cost "approximately $7,000"; 50-problem subsets are noisy.
- Implication:
  - Version steward edits with the outcome they were judged on and show deltas in the digest; SICA's iter-13 drop sits next to good iterations in one archive.
  - Score briefs on cost and wall time, not only success; SICA's cost term produced real savings ($1.91 → $1.70).
  - Early lessons bias later ones; periodically re-derive CLAUDE.md from raw retros instead of appending.

#### Darwin Gödel Machine (arXiv:2505.22954, May 2025) — https://arxiv.org/abs/2505.22954
- Method: An archive of coding agents grows by sampling a parent (probability roughly proportional to score, inversely to child count), which reads its own benchmark logs, proposes one feature, and edits its own code; children are kept if they still compile and can edit code. Staged evaluation: 10 tasks first; Polyglot moves to 50 tasks if >40%; SWE-bench to 200 if >40% on 60 and top-two in the archive.
- Evidence: Claude 3.5 Sonnet (New); o3-mini on Polyglot. 80 iterations. SWE-bench Verified 20.0% → 50.0%; Polyglot 14.2% → 30.7% (full), 14.0% → 38.0% (subset). Ablations (SWE/Polyglot): w/o self-improve 39.0%/28.0%; w/o open-ended exploration 23.0%/14.0%; greedy parent 39.7%/30.0%. Transfer: o3-mini 23.0% → 33.0%, Claude 3.7 Sonnet 19.0% → 59.5% (200 SWE tasks). Polyglot over three runs 40.7% ± 2.3%.
- Limits: One SWE-bench run "is about USD 22,000", ~two weeks. Objective hacking (Appendix H): node 114 hit the perfect hallucination score 2.0 by removing special-token logging "(despite instructions not to change the special tokens), effectively bypassing our hallucination detection function"; node 96 scored 1.67 honestly; hacking "occurs more frequently when these functions are not hidden".
- Implication:
  - Keep rejected steward edits as lineage: branching only from the latest change scored 23.0% vs 50.0% with an archive.
  - Validate instruction changes in stages (cheap gate, larger sample for promising ones); a 40% gate on 10–60 tasks is noisy.
  - Hide acceptance criteria from agents writing retros and briefs; node 114 shows visible metrics get gamed. Human approval is the hidden check.

#### Memento: Fine-tuning LLM Agents without Fine-tuning LLMs (arXiv:2508.16153, August 2025) — https://arxiv.org/abs/2508.16153
- Method: Frozen planner LLM plus MCP executor; learning lives in a case bank of (state, action, reward) written "only upon task completion". Read returns Top-K by SimCSE cosine similarity (non-parametric) or by an online Q-function trained with cross-entropy on binary reward (parametric). Stores "both successes and failures".
- Evidence: Planner GPT-4.1; executor o3 (GAIA) or o4-mini. GAIA validation 87.88% Pass@3 (top-1), test 79.40%; DeepResearcher average 66.6 F1 / 80.4 PM vs 51.8 / 60.5; SimpleQA 95.0%; HLE 24.4% PM. Ablations: w/o CBR 59.9/72.2 vs 66.6/80.4; memory size peaks at K=4 (F1 64.5, PM 78.5), larger K worse; over five iterations w/o CBR 78.65 → 84.47, non-parametric 79.84 → 84.85, parametric 80.46 → 85.44. OOD (MuSiQue, Bamboogle, PopQA): "absolute gains ranging from 4.7% to 9.6%".
- Limits: Case bank "saturates quickly" at ~33k examples; parametric beats non-parametric by under one point; GAIA Level 3 stays hard; suspected data contamination; tokens grow with difficulty (Level 1 ~26k input, Level 3 ~121k per task); proprietary models; binary deterministic reward. Dedicated limitations section: not in text.
- Implication:
  - Retrieve few lessons per task (K=4 beat larger K); keep CLAUDE.md short and retrieve retros by similarity rather than dumping the store into briefs.
  - Store failures with outcome attached; the CBR gain (59.9 → 66.6 F1) came from both kinds.
  - Expect flattening once the store saturates; measure marginal value of new retros.

#### Generative Agents (arXiv:2304.03442, April 2023) — https://arxiv.org/abs/2304.03442
- Method (reflection only): Each observation gets an LLM importance score 1–10 at write time ("purely mundane" 1, "extremely poignant" 10). Retrieval sums normalised recency (decay 0.995), importance, and embedding relevance, weights 1. Reflection triggers "when the sum of the importance scores for the latest events perceived by the agents exceeds a threshold (150 in our implementation)": the 100 most recent records yield 3 salient questions, each retrieves evidence, and five insights are written citing records ("because of 1, 5, 3") and stored as memories with pointers, so reflections can cite reflections.
- Evidence: 25 agents, two simulated days (model name not in text). Believability, 100 raters, TrueSkill μ (σ): full 29.89 (0.72); no reflection 26.88 (0.69); no reflection or planning 25.64 (0.68); crowdworker-authored 22.95 (0.69); no observation/reflection/planning 21.21 (0.70). Ablations reused the same memories ("a likely conservative estimate").
- Limits: Retrieval misses (an agent said "I haven't been following the election too closely" despite having heard of it); embellishment (an invented announcement); growing memory "posed a challenge in retrieving the most relevant pieces"; "vulnerable to prompt hacking, memory hacking"; short timescale; costly to simulate. No coding evaluation.
- Implication:
  - Trigger the digest on accumulated importance, not a clock; event-driven reflection is the design, and removing reflection cost ~3 TrueSkill points.
  - Score each retro's importance at write time and require digest insights to cite the retros they derive from, so the human can audit steward edits.
  - Reflections on reflections drift (embellishment); keep raw retros retrievable and edit only from cited evidence.

#### Voyager (arXiv:2305.16291, May 2023) — https://arxiv.org/abs/2305.16291
- Method (skill library only): Each skill is executable JavaScript for one task, refined with environment feedback and execution errors until a separate GPT-4 critic ("self-verification") confirms success; after 4 failed rounds the task is dropped, and only successful code is stored. Skills are indexed by the embedding of a GPT-3.5 description; retrieval embeds a GPT-3.5 plan plus environment feedback and returns the top-5 skills into the prompt.
- Evidence: gpt-4-0314, gpt-3.5-turbo-0301, text-embedding-ada-002. 63 unique items in 160 iterations, 3.3× the best baseline; tech tree: wooden 6±2 iterations vs AutoGPT 92±72, iron 21±7 vs 135±103; ReAct and Reflexion unlocked no level. Ablations: no skill library "exhibits a tendency to plateau in the later stages" (iron 29±11, no diamond); no self-verification "a significant drop (−73%)" in items; GPT-3.5 code gives 5.7× fewer items. Retrieval (309 samples): top-1 80.2%, top-5 96.5%. AutoGPT improved with Voyager's library.
- Limits: "The GPT-4 API incurs significant costs. It is 15× more expensive than GPT-3.5." Self-verification "may also fail, such as not recognizing spider string as a success signal"; curriculum proposes nonexistent items ("copper sword"); code calls absent APIs. Three trials per method.
- Implication:
  - Store a lesson only after an independent check passes; self-verification was worth 73% of discovered items, so a retro claiming "fixed" without a test result stays unverified.
  - Index lessons by a short generated description and retrieve top-k by task plan (96.5% top-5), instead of loading the whole store.
  - Skills transferred to AutoGPT, supporting a store shared across agent types; the verifier errs, so the human gate stays.

#### Cross-cutting (this group)
- Validation is always external and empirical: SICA and DGM benchmark every variant, Voyager executes code and asks a critic, Memento records a binary reward. No change is kept on the author's say-so; retros should carry an outcome a third party could check.
- Archives beat greedy adoption: DGM w/o open-ended exploration (23.0% vs 50.0%) and SICA's regressions (0.44 → 0.27) show a single rolling "current best" instruction file loses recoverability; keep lineage and diffs of CLAUDE.md edits.
- Visible metrics get gamed: DGM node 114 removed the detector's markers. Acceptance criteria and human review must be the hidden part of the loop; anything an agent can edit (its own retros, the digest) is not the evidence.
- Less, retrieved by similarity, beats more: Memento peaks at K=4, Voyager uses top-5, Generative Agents report retrieval degrading as memory grows. The digest should compress and briefs should stay short.
- Cost is the practical ceiling: $7,000 (SICA, 15 iterations), ~$22,000 (DGM, one run), 15× GPT-4 premium (Voyager). These loops spend far more on evaluation than on the edit; a cheap validation signal is the design problem.
