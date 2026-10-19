#!/bin/sh
# Runs stam's tests, each against its own throwaway daemons (test/lib.sh), never the live one.
# FREE is the merge gate: deterministic, no model, no network. SMOKE runs real harnesses on
# cheap models, by hand only, and never gates a merge.
#
#   test/run.sh                   the free tests (no agents, no models)
#   test/run.sh --smoke           also the smoke tests (real harnesses, cheap models; --live is an alias)
#   test/run.sh m1 codex          only these tests (names as below, or file names)
#   test/run.sh --parallel ...    run them at once (each has its own daemon, so they can)
#   test/run.sh --remote storage ui   on storage instead of here (test/remote.sh); goes first
#
# Prints PASS or FAIL per test with its time, the spend its daemons recorded, and the
# estimate, then the totals. Logs stay in the folder it names. Exit status 1 if any failed.
# A test that runs past STAM_TEST_TIMEOUT seconds (default 600, 0 for none) is hung: its
# process group gets a SIGTERM, a SIGKILL STAM_TEST_KILL_AFTER seconds (default 30) later,
# it shows as HUNG, and the rest run on, so a hung test never holds the lock for long.
# A test whose tool is missing on this machine (the real opencode or codex binary, a reachable
# `systemd --user`, Playwright's Chromium) shows as SKIP with the reason, counted apart from
# pass and fail; it doesn't fail the run. A machine with all the tools skips nothing.
# STAM_TEST_NO_SKIP=1 makes a missing tool a FAIL (same reason) instead: the merge gates
# set it, so a machine missing a tool can't green a gate.
cd "$(dirname "$(readlink -f "$0")")/.." || exit 1
. test/tmpdir.sh
if [ "$1" = --remote ]; then
  [ -n "$2" ] || { echo "usage: test/run.sh --remote SERVER [NAME...]"; exit 2; }
  server=$2; shift 2
  exec sh test/remote.sh "$server" test/run.sh "$@"
fi
# No test installs or loads the real embedder (S-141).
export STAM_EMBEDDER=stub
# Plain unit tests: a `node --test` file that starts no daemon, tmux or browser. A run of only these takes
# the light test-slot pool (S-1288); light-list-unit checks each entry is such a file (S-1768). A new daemon-free
# test goes here too, in sorted order, unless it asserts a wall-clock bound (it flakes under load). The check reads
# only the test file, so a daemon started by an imported helper isn't seen. One name per line.
LIGHT="
account-readings
accounts
activity
activity-readers
activity-rules
activity-stats
activity-summary
activity-warming
agent-class
agent-ips
agent-load
agent-rates
agent-routes-unit
agent-view-default
agent-views-unit
allocations
attribution
auto-archive-repair
banner-stagger
blocks
blocks-compose
busy
claude-dialog-unit
claude-view-unit
client-dedup-unit
codex-reviewer-sandbox
codex-usage
compress-unit
cost-display
cost-notices
db-synchronous
db-user-version
decision-fence
decl-index
default-read-stale
delegate-peer-parent
developer-cap-unit
diff-api
doc-citations
doc-shas
embed-unit
events-unit
export-overrides
feedback-unit
github-poller-unit
inventory-block-unit
issue-costs
itsa-fields-prompt
itsa-fields-unit
itsa-human-unit
itsa-permission-unit
itsa-queue
itsa-thread-unit
itsa-unit
layout-unit
light-list-unit
limits
linear-poller-unit
live-head-guard
local-human-unit
machines-unit
mail-about-unit
mail-embed-unit
mail-full-suite-sender
mail-gate-strict-unit
mail-recipients-index
mail-routing-uncertain
mail-threading
mail-visibility-creator
manager-merge-line
mcp-import
mcp-reconnect
measured-effort
merge-failures-unit
notices-unit
peer-busy
peer-remember
peer-ui-writes-unit
permission-dialog-mail
permission-modes-unit
permission-requests-index
permission-typed
pr-open-scope
pr-review-relay-unit
pr-review-unit
pr-sync-unit
process
process-briefs
process-counts
process-edit
process-proposal
process-run
process-stage
prompt-default-mode
readings
req-seed-unit
req-tools-unit
requirements-unit
retro-digest-unit
retro-loop-unit
retro-reminder-failure-unit
retro-reminders-unit
reviewer-types
ring-create-rollback
ring-split
ring-verdict-line
samples
search-meaning-unit
settings-ask-conflict
settings-file-mode
settings-memo
settings-notice
skill-import
skills
spawn-worktree-unit
stall-labels-unit
stall-unit
standing-growth
statusline-cache-unit
story-check-unit
suggest-input-unit
suggest-rescore-unit
supersede
sw-close
sw-group
swallowed-wait
template-blocks
test-hooks
thread-defer
thread-resolved
threads-with
ticket-unit
tiny-models
tmphome-unit
tool-changes-unit
tree
tree-check-unit
turn-harden-unit
type-memory
type-skills
unread-counts
usage
usage-agents-filter
usage-drill
usage-history
waits-unit
watch-unit
window-summary-calls
withdraw
withdraw-ask
workspace-prompt-unit
workspace-reused-branch
workspace-share-unit
worktree-deps-unit
worth
write-timeout-thread-unit"
LIGHT=$(echo $LIGHT)
# One name per line, keep sorted: two PRs that add different names merge cleanly.
FREE="
account-readings
accounts
activity
activity-classify
activity-readers
activity-rules
activity-load
activity-stats
activity-info
activity-warming
activity-peers
activity-peers-unit
activity-summary
agent-class
agent-load
admission
agent-identity
agent-instructions
agent-rates
agent-tokens
agent-types
agent-view-default
agent-view-unit
agent-views-unit
agent-ips
agents-route
allocations
archive-force
archive-procs
ask-block
assistant
attribution
banner-stagger
banners-quiet
block-summaries
blocks
skills
skill-import
refresh-derived
blocks-compose
mail-full-suite-sender
mail-routing-uncertain
thread-defer
mail-note-display
type-memory
type-skills
blockers
budgets
busy
check-playwright-unit
child-notices
chromium-lock
claude-dialog-unit
claude-ghost-unit
claude-permissions
claude-view
claude-view-unit
client-dedup
client-dedup-unit
write-timeout-unit
write-timeout-thread-unit
mail-recipients-index
default-read-stale
db-synchronous
db-user-version
tree
permission-requests-index
tmux-clients
codex-no-rollout
codex-reviewer-sandbox
codex-usage
codex-view
compact-dedupe
compact-restart
compact-restart-unit
compress
config-guard
config-patch
context
cos
cost
cost-display
cost-fallback
cost-instructions
cost-notices
cost-pause
cost-probes
cost-switch
daemon-stub
db-backup-lock
decide
decision-fence
thread-resolved
auto-archive-repair
auto-archive
auto-archive-peers
auto-archive-full
permission-dialog-mail
permission-typed
decision-mail
decision-mail-peers
deferred
delegate-ask
permission-asks
permission-modes
permission-modes-unit
delegate-peer-parent
files-unit
default-repo-unit
diff-api
decl-index
diff-api-route
files
deploy-canary
deploy-bisect
release-lock
deploy-prune-unit
deploy-health-wait
embed-unit
event-waits
events
events-unit
exit-context
failed-notice
fastpath
feedback
feedback-unit
first-prompt-ghost
first-prompt-recover
forget
story-check-unit
github-poller
github-poller-unit
guard
guard-unit
harness-dialog
harness-guard
home-lock
human-thread-quiet
instructions
inventory
inventory-block-unit
isolation
kill-hard
issue-costs
itsa
itsa-fields
itsa-fields-agent
itsa-fields-prompt
itsa-fields-unit
itsa-human
itsa-human-unit
itsa-mcp
itsa-owners
itsa-owners-peers
itsa-owners-unit
itsa-permission-unit
itsa-post-gate
itsa-post-gate-peers
itsa-queue
itsa-search
itsa-thread
itsa-thread-unit
itsa-tools
itsa-unit
human-owner
human-relay
local-human
local-default
local-human-unit
ticket-unit
human-strict
human-strict-peers
human-strict-holder
strict-system
janitor
janitor-sweep
janitor-tmux
orphan-procs
layout
layout-unit
ledger-recon
light-list-unit
limits
linear-poller
linear-poller-unit
llm-layer
m1
m2
m5
machines
machines-unit
machines-origin
mail-about-unit
mail-itsas-unit
tool-changes-unit
mail-archive
mail-check
mail-gate
mail-gate-peers
mail-gate-strict
mail-gate-strict-unit
mail-embed
mail-models
mail-read-cited
mail-search
mail-threading
mail-tools-unit
mail-reply-only-unit
threads-with
mail-title
mail-title-peers
mail-visibility-creator
mcp-auth
mcp-config
mcp-follow
mcp-reexec
mcp-import
mcp-itsa-create
mcp-itsa-ref
mcp-proxy
mcp-reconnect
mcp-registry
mcp-ring-submit
mcp-send-mail
mcp-servers
mcp-slack-unit
mcp-tools
mcp-wait-for
measured-effort
merge-failures-unit
model-catalog
notices-unit
opencode-token
opencode-stop
openrouter
org
peer-control
peer-identity
peer-outbox
peer-parent
peer-permission
peer-queue-start
peer-remember
peer-busy
peer-start
peer-ui-writes
peer-ui-writes-unit
peer-wait
peers
peers-down
personal-workspace
personal-workspace-unit
standing-rest-unit
rest-unit
compact-epipe-unit
standing-growth
pr-open-scope
pr-open-scope-peers
pr-review-peers
pr-open-unit
cli-help-unit
pr-sync-unit
workspace-reused-branch
workspace-fresh-base
process
process-stage
process-run
process-counts
process-edit
process-proposal
process-proposal-route
mcp-process-propose
proctree-unit
prompt-default-mode
push
read-mail
readings
reconcile-quiet
registry-home
reply-archived-peers
reply-local
reply-peers
reply-system
req-check
req-check-b-unit
req-check-unit
req-fp-unit
req-tools
req-tools-unit
requirements
requirements-unit
resolve-recipient
resource-warn
restart-mail
retro
retro-digest-unit
retro-reminder-failure-unit
retro-reminders-unit
retro-loop
retro-loop-unit
retro-search-unit
retro-unit
retro-lessons-unit
workspace-prompt-unit
workspace-share-unit
worktree-deps-unit
reviewer-ring
reviewer-spawn
doc-shas
swallowed-wait
review-dir-cleanup
reviewer-types
ring
ring-create-rollback
ring-split
ring-verdict-line
ring-peer
rules
run-flags
run-skip
run-timeout
samples
search
search-meaning
search-meaning-unit
sent-copy
said
session-end
settings-ask-conflict
settings-file-mode
settings-memo
settings-notice
settings-sync
settings-writes
tiny-models
tool-summaries
tool-summaries-route
tool-names
spawn-usage
developer-cap-unit
developer-cap
developer-cap-peer
spawn-worktree-unit
stale-working
stall
stall-unit
stall-labels-unit
children-waits-scale-unit
children-waits-cascade-unit
starting-archive
round-skipped
archive-cascade-peers
archive-cascade-route
archive-cascade
idle-shutdown-archive
starting-dead
suggest
suggest-unit
suggest-rescore-unit
turn-stall-unit
turn-harden-unit
compress-unit
mail-embed-unit
statusline-cache-unit
statusline-post-unit
cache-cold-unit
steps
steps-unit
suggest-input
suggest-input-unit
sw-close
sw-group
sweep-test-homes
term-size
test-hooks
test-slot
tmphome-unit
tmux-snapshot-unit
tmux-snapshot-async-unit
agent-reads-unit
tmux-env-unit
token-scope
tools
ui
ui-assistant
ui-ownview
ui-viewtoggle
unread-counts
usage
usage-agents-filter
usage-drill
usage-history
usage-scope
voice
voice-unit
waits
waits-claude
waits-harness-unit
waits-mcp
waits-stam
agent-routes-unit
waits-unit
tree-check-unit
watch
watch-pr
watch-pr-unit
watch-unit
window-summary-calls
withdraw
withdraw-ask
supersede
mail-from-stam-http
withdraw-ask-http
withdraw-ask-peers
withdraw-peers
withdraw-peers-unit
worth
"
FREE=$(echo $FREE)
SMOKE="
agent-view
argv
codex
decide-live
instructions-live
reboot
restart-mail-codex
suggest-input-live
waits-harness
"
SMOKE=$(echo $SMOKE)
# Tools some tests need that a fresh machine may lack. needs() names them per test; missing()
# prints the reason a tool is absent (and nothing when it is there).
needs() {
  case "$1" in
    isolation | kill-hard) echo opencode ;;
    deploy | janitor | remote) echo systemd ;;
    mcp-servers) echo codex ;;
    ui | ui-ownview | ui-assistant | ui-viewtoggle) echo chromium ;;
  esac
}
missing() {
  case "$1" in
    opencode)
      if [ -n "$STAM_OPENCODE_BIN" ]; then
        [ -x "$STAM_OPENCODE_BIN" ] || command -v "$STAM_OPENCODE_BIN" >/dev/null 2>&1
      else
        [ -x "$HOME/.opencode/bin/opencode" ] || command -v opencode >/dev/null 2>&1
      fi ||
        echo "the opencode binary isn't installed (see https://opencode.ai)" ;;
    codex)
      command -v codex >/dev/null 2>&1 || echo "the codex binary isn't installed (see https://github.com/openai/codex)" ;;
    systemd)
      systemctl --user show-environment >/dev/null 2>&1 ||
        echo "no systemd user manager (systemctl --user fails; needs systemd and XDG_RUNTIME_DIR)" ;;
    chromium)
      node web/check/chromium-available.mjs 2>/dev/null ;;
  esac
}
# The reason test $1 can't run here, or nothing.
skip_reason() {
  for tool in $(needs "$1"); do
    r=$(missing "$tool")
    [ -n "$r" ] && { echo "$r"; return; }
  done
}

money() { printf '%.2f' "$(echo "$1" | bc)"; }
estimate() {
  case "$1" in
    waits-harness | agent-view | suggest-input-live) echo 0.01 ;; restart-mail-codex) echo 0.02 ;; instructions-live | codex | reboot | argv) echo 0.05 ;; decide-live) echo 0.0001 ;; *) echo 0 ;;
  esac
}
cmd() {
  case "$1" in
    mail-threading) echo "node --test test/mail-threading.test.mjs" ;;
    mail-tools-unit) echo "node --test test/mail-tools.test.mjs" ;;
    mail-reply-only-unit) echo "node --test test/mail-reply-only.test.mjs" ;;
    threads-with) echo "node --test test/threads-with.test.mjs" ;;
    client-dedup-unit) echo "node --test test/client-dedup.test.mjs" ;;
    write-timeout-unit) echo "node --test test/write-timeout.test.mjs" ;;
    write-timeout-thread-unit) echo "node --test test/write-timeout-thread.test.mjs" ;;
    mail-recipients-index) echo "node --test test/mail-recipients-index.test.mjs" ;;
    default-read-stale) echo "node --test test/default-read-stale.test.mjs" ;;
    db-synchronous) echo "node --test test/db-synchronous.test.mjs" ;;
    db-user-version) echo "node --test test/db-user-version.test.mjs" ;;
    tree) echo "node --test test/tree.test.mjs" ;;
    permission-requests-index) echo "node --test test/permission-requests-index.test.mjs" ;;
    tmux-clients) echo "node --test test/tmux-clients.test.mjs" ;;
    check-playwright-unit) echo "node --test test/check-playwright-unit.test.mjs" ;;
    prompt-default-mode) echo "node --test test/prompt-default-mode.test.mjs" ;;
    busy) echo "node --test test/busy.test.mjs" ;;
    local-human-unit) echo "node --test test/local-human.test.mjs" ;;
    ticket-unit) echo "node --test test/ticket.test.mjs" ;;
    mail-gate-strict-unit) echo "node --test test/mail-gate-strict.test.mjs" ;;
    peers-down) echo "node --test test/peers-down.test.mjs" ;;
    limits) echo "node --test test/limits.test.mjs" ;;
    usage) echo "node --test test/usage.test.mjs" ;;
    usage-agents-filter) echo "node --test test/usage-agents-filter.test.mjs" ;;
    usage-drill) echo "node --test test/usage-drill.test.mjs" ;;
    test-hooks) echo "node --test test/test-hooks.test.mjs" ;;
    run-skip) echo "node --test test/run-skip.test.mjs" ;;
    stall-unit) echo "node --test test/stall.test.mjs" ;;
    stall-labels-unit) echo "node --test test/stall-labels.test.mjs" ;;
    children-waits-scale-unit) echo "node --test test/children-waits-scale.test.mjs" ;;
    children-waits-cascade-unit) echo "node --test test/children-waits-cascade.test.mjs" ;;
    starting-archive) echo "node --test test/starting-archive.test.mjs" ;;
    round-skipped) echo "node --test test/round-skipped.test.mjs" ;;
    archive-cascade) echo "node --test test/archive-cascade.test.mjs" ;;
    idle-shutdown-archive) echo "node --test test/idle-shutdown-archive.test.mjs" ;;
    archive-cascade-peers) echo "node --test test/archive-cascade-peers.test.mjs" ;;
    archive-force) echo "node --test test/archive-force.test.mjs" ;;
    opencode-stop) echo "node --test test/opencode-stop.test.mjs" ;;
    compress-unit) echo "node --test test/compress.test.mjs" ;;
    mail-embed-unit) echo "node --test test/mail-embed.test.mjs" ;;
    compact-restart-unit) echo "node --test test/compact-restart.test.mjs" ;;
    tmux-snapshot-unit) echo "node --test test/tmux-snapshot.test.mjs" ;;
    tmux-snapshot-async-unit) echo "node --test test/tmux-snapshot-async.test.mjs" ;;
    agent-reads-unit) echo "node --test test/agent-reads.test.mjs" ;;
    tmux-env-unit) echo "node --test test/tmux-env.test.mjs" ;;
    janitor-sweep) echo "node --test test/janitor-sweep.test.mjs" ;;
    orphan-procs) echo "node --test test/orphan-procs.test.mjs" ;;
    account-readings) echo "node --test test/account-readings.test.mjs" ;;
    settings-ask-conflict) echo "node --test test/settings-ask-conflict.test.mjs" ;;
    settings-file-mode) echo "node --test test/settings-file-mode.test.mjs" ;;
    tiny-models) echo "node --test test/tiny-models.test.mjs" ;;
    tool-summaries) echo "node --test test/tool-summaries.test.mjs" ;;
    tool-names) echo "node --test test/tool-names.test.mjs" ;;
    settings-memo) echo "node --test test/settings-memo.test.mjs" ;;
    settings-notice) echo "node --test test/settings-notice.test.mjs" ;;
    peer-remember) echo "node --test test/peer-remember.test.mjs" ;;
    peer-busy) echo "node --test test/peer-busy.test.mjs" ;;
    agent-rates) echo "node --test test/agent-rates.test.mjs" ;;
    window-summary-calls) echo "node --test test/window-summary-calls.test.mjs" ;;
    unread-counts) echo "node --test test/unread-counts.test.mjs" ;;
    banner-stagger) echo "node --test test/banner-stagger.test.mjs" ;;
    ledger-recon) echo "node --test test/ledger-recon.test.mjs" ;;
    openrouter) echo "node --test test/openrouter.test.mjs" ;;
    decide) echo "node --test test/decide.test.mjs" ;;
    decision-fence) echo "node --test test/decision-fence.test.mjs" ;;
    thread-resolved) echo "node --test test/thread-resolved.test.mjs" ;;
    auto-archive-repair) echo "node --test test/auto-archive-repair.test.mjs" ;;
    permission-dialog-mail) echo "node --test test/permission-dialog-mail.test.mjs" ;;
    permission-typed) echo "node --test test/permission-typed.test.mjs" ;;
    permission-modes-unit) echo "node --test test/permission-modes.test.mjs" ;;
    withdraw) echo "node --test test/withdraw.test.mjs" ;;
    db-backup-lock) echo "node --test test/db-backup-lock.test.mjs" ;;
    withdraw-peers-unit) echo "node --test test/withdraw-peers.test.mjs" ;;
    files-unit) echo "node --test test/files.test.mjs" ;;
    default-repo-unit) echo "node --test test/default-repo.test.mjs" ;;
    diff-api) echo "node --test test/diff-api.test.mjs" ;;
    decl-index) echo "node --test test/decl-index.test.mjs" ;;
    delegate-peer-parent) echo "node --test test/delegate-peer-parent.test.mjs" ;;
    withdraw-ask) echo "node --test test/withdraw-ask.test.mjs" ;;
    supersede) echo "node --test test/supersede.test.mjs" ;;
    sw-close) echo "node --test test/sw-close.test.mjs" ;;
    sweep-test-homes) echo "node --test test/sweep-test-homes.test.mjs" ;;
    sw-group) echo "node --test test/sw-group.test.mjs" ;;
    mail-title) echo "node --test test/mail-title.test.mjs" ;;
    block-summaries) echo "node --test test/block-summaries.test.mjs" ;;
    blocks) echo "node --test test/blocks.test.mjs" ;;
    skills) echo "node --test test/skills.test.mjs" ;;
    skill-import) echo "node --test test/skill-import.test.mjs" ;;
    refresh-derived) echo "node --test test/refresh-derived.test.mjs" ;;
    blocks-compose) echo "node --test test/blocks-compose.test.mjs" ;;
    type-memory) echo "node --test test/type-memory.test.mjs" ;;
    type-skills) echo "node --test test/type-skills.test.mjs" ;;
    activity-classify) echo "node --test test/activity-classify.test.mjs" ;;
    voice-unit) echo "node --test test/voice.test.mjs" ;;
    accounts) echo "node --test test/accounts.test.mjs" ;;
    codex-usage) echo "node --test test/codex-usage.test.mjs" ;;
    codex-reviewer-sandbox) echo "node --test test/codex-reviewer-sandbox.test.mjs" ;;
    mcp-servers) echo "node --test test/mcp-servers.test.mjs" ;;
    claude-permissions) echo "node --test test/claude-permissions.test.mjs" ;;
    mcp-config) echo "node --test test/mcp-config.test.mjs" ;;
    mcp-import) echo "node --test test/mcp-import.test.mjs" ;;
    inventory-block-unit) echo "node --test test/inventory-block.test.mjs" ;;
    mcp-registry) echo "node --test test/mcp-registry.test.mjs" ;;
    mcp-ring-submit) echo "node --test test/mcp-ring-submit.test.mjs" ;;
    model-catalog) echo "node --test test/model-catalog.test.mjs" ;;
    mcp-auth) echo "node --test test/mcp-auth.test.mjs" ;;
    mcp-slack-unit) echo "node --test test/mcp-slack.test.mjs" ;;
    itsa-unit) echo "node --test test/itsa.test.mjs" ;;
    req-check-b-unit) echo "node --test test/req-check-b.test.mjs" ;;
    req-check-unit) echo "node --test test/req-check.test.mjs" ;;
    req-fp-unit) echo "node --test test/req-fp.test.mjs" ;;
    req-tools-unit) echo "node --test test/req-tools.test.mjs" ;;
    requirements-unit) echo "node --test test/requirements.test.mjs" ;;
    resolve-recipient) echo "node --test test/resolve-recipient.test.mjs" ;;
    peer-ui-writes-unit) echo "node --test test/peer-ui-writes.test.mjs" ;;
    itsa-fields-unit) echo "node --test test/itsa-fields.test.mjs" ;;
    itsa-fields-prompt) echo "node --test test/itsa-fields-prompt.test.mjs" ;;
    mail-visibility-creator) echo "node --test test/mail-visibility-creator.test.mjs" ;;
    mcp-itsa-create) echo "node --test test/mcp-itsa-create.test.mjs" ;;
    mcp-itsa-ref) echo "node --test test/mcp-itsa-ref.test.mjs" ;;
    mcp-send-mail) echo "node --test test/mcp-send-mail.test.mjs" ;;
    mcp-wait-for) echo "node --test test/mcp-wait-for.test.mjs" ;;
    feedback-unit) echo "node --test test/feedback.test.mjs" ;;
    retro-unit) echo "node --test test/retro.test.mjs" ;;
    retro-reminders-unit) echo "node --test test/retro-reminders.test.mjs" ;;
    retro-lessons-unit) echo "node --test test/retro-lessons.test.mjs" ;;
    workspace-prompt-unit) echo "node --test test/workspace-prompt.test.mjs" ;;
    workspace-share-unit) echo "node --test test/workspace-share.test.mjs" ;;
    worktree-deps-unit) echo "node --test test/worktree-deps-unit.test.mjs" ;;
    retro-reminder-failure-unit) echo "node --test test/retro-reminder-failure.test.mjs" ;;
    retro-digest-unit) echo "node --test test/retro-digest.test.mjs" ;;
    retro-loop-unit) echo "node --test test/retro-loop.test.mjs" ;;
    retro-search-unit) echo "node --test test/retro-search.test.mjs" ;;
    agent-routes-unit) echo "node --test test/agent-routes.test.mjs" ;;
    waits-unit) echo "node --test test/waits.test.mjs" ;;
    tree-check-unit) echo "node --test test/tree-check.test.mjs" ;;
    readings) echo "node --test test/readings.test.mjs" ;;
    blockers) echo "node --test test/blockers.test.mjs" ;;
    rules) echo "node --test test/rules.test.mjs" ;;
    budgets) echo "node --test test/budgets.test.mjs" ;;
    agent-ips) echo "node --test test/agent-ips.test.mjs" ;;
    cost-pause) echo "node --test test/cost-pause.test.mjs" ;;
    cost-switch) echo "node --test test/cost-switch.test.mjs" ;;
    cost-fallback) echo "node --test test/cost-fallback.test.mjs" ;;
    cost-probes) echo "node --test test/cost-probes.test.mjs" ;;
    mcp-follow) echo "node --test test/mcp-follow.test.mjs" ;;
    mcp-reexec) echo "node --test test/mcp-reexec.test.mjs" ;;
    mcp-reconnect) echo "node --test test/mcp-reconnect.test.mjs" ;;
    samples) echo "node --test test/samples.test.mjs" ;;
    itsa-human-unit) echo "node --test test/itsa-human.test.mjs" ;;
    mail-about-unit) echo "node --test test/mail-about-itsa.test.mjs" ;;
    mail-itsas-unit) echo "node --test test/mail-itsas.test.mjs" ;;
    tool-changes-unit) echo "node --test test/tool-changes.test.mjs" ;;
    itsa-queue) echo "node --test test/itsa-queue.test.mjs" ;;
    itsa-thread-unit) echo "node --test test/itsa-thread.test.mjs" ;;
    admission) echo "node --test test/admission.test.mjs" ;;
    attribution) echo "node --test test/attribution.test.mjs" ;;
    cost-display) echo "node --test test/cost-display.test.mjs" ;;
    activity) echo "node --test test/activity.test.mjs" ;;
    activity-readers) echo "node --test test/activity-readers.test.mjs" ;;
    activity-rules) echo "node --test test/activity-rules.test.mjs" ;;
    activity-load) echo "node --test test/activity-load.test.mjs" ;;
    activity-stats) echo "node --test test/activity-stats.test.mjs" ;;
    activity-info) echo "node --test test/activity-info.test.mjs" ;;
    activity-warming) echo "node --test test/activity-warming.test.mjs" ;;
    activity-summary) echo "node --test test/activity-summary.test.mjs" ;;
    agent-class) echo "node --test test/agent-class.test.mjs" ;;
    activity-peers-unit) echo "node --test test/activity-peers.test.mjs" ;;
    agent-load) echo "node --test test/agent-load.test.mjs" ;;
    measured-effort) echo "node --test test/measured-effort.test.mjs" ;;
    issue-costs) echo "node --test test/issue-costs.test.mjs" ;;
    usage-history) echo "node --test test/usage-history.test.mjs" ;;
    worth) echo "node --test test/worth.test.mjs" ;;
    cost-notices) echo "node --test test/cost-notices.test.mjs" ;;
    allocations) echo "node --test test/allocations.test.mjs" ;;
    embed-unit) echo "node --test test/embed.test.mjs" ;;
    search-meaning-unit) echo "node --test test/search-meaning.test.mjs" ;;
    suggest-unit) echo "node --test test/suggest.test.mjs" ;;
    suggest-rescore-unit) echo "node --test test/suggest-rescore.test.mjs" ;;
    turn-stall-unit) echo "node --test test/turn-stall.test.mjs" ;;
    turn-harden-unit) echo "node --test test/turn-harden.test.mjs" ;;
    waits-harness-unit) echo "node --test test/waits-harness.test.mjs" ;;
    itsa-owners-unit) echo "node --test test/itsa-owners.test.mjs" ;;
    itsa-permission-unit) echo "node --test test/itsa-permission.test.mjs" ;;
    watch-unit) echo "node --test test/watch.test.mjs" ;;
    notices-unit) echo "node --test test/notices.test.mjs" ;;
    events-unit) echo "node --test test/events.test.mjs" ;;
    github-poller-unit) echo "node --test test/github-poller.test.mjs" ;;
    watch-pr-unit) echo "node --test test/mcp-watch-pr.test.mjs" ;;
    linear-poller-unit) echo "node --test test/linear-poller.test.mjs" ;;
    fastpath) echo "node --test test/fastpath.test.mjs" ;;
    machines-unit) echo "node --test test/machines.test.mjs" ;;
    statusline-cache-unit) echo "node --test test/statusline-cache.test.mjs" ;;
    statusline-post-unit) echo "node --test test/statusline-post.test.mjs" ;;
    cache-cold-unit) echo "node --test test/cache-cold.test.mjs" ;;
    steps-unit) echo "node --test test/steps.test.mjs" ;;
    tmphome-unit) echo "node --test test/tmphome.test.mjs" ;;
    agent-view-unit) echo "node --test test/agent-view.test.mjs" ;;
    agent-view-default) echo "node --test test/agent-view-default.test.mjs" ;;
    doc-shas) echo "node --test test/doc-shas.test.mjs" ;;
    swallowed-wait) echo "node --test test/swallowed-wait.test.mjs" ;;
    developer-cap-unit) echo "node --test test/developer-cap-unit.test.mjs" ;;
    spawn-worktree-unit) echo "node --test test/spawn-worktree-unit.test.mjs" ;;
    personal-workspace-unit) echo "node --test test/personal-workspace.test.mjs" ;;
    standing-rest-unit) echo "node --test test/standing-rest.test.mjs" ;;
    rest-unit) echo "node --test test/rest.test.mjs" ;;
    compact-epipe-unit) echo "node --test test/compact-epipe.test.mjs" ;;
    standing-growth) echo "node --test test/standing-growth.test.mjs" ;;
    review-dir-cleanup) echo "node --test test/review-dir-cleanup.test.mjs" ;;
    reviewer-types) echo "node --test test/reviewer-types.test.mjs" ;;
    ring-create-rollback) echo "node --test test/ring-create-rollback.test.mjs" ;;
    ring-split) echo "node --test test/ring-split.test.mjs" ;;
    ring-verdict-line) echo "node --test test/ring-verdict-line.test.mjs" ;;
    agent-views-unit) echo "node --test test/agent-views.test.mjs" ;;
    codex-view) echo "node --test test/codex-view.test.mjs" ;;
    codex-no-rollout) echo "node --test test/codex-no-rollout.test.mjs" ;;
    claude-view-unit) echo "node --test test/claude-view.test.mjs" ;;
    claude-dialog-unit) echo "node --test test/claude-dialog.test.mjs" ;;
    claude-ghost-unit) echo "node --test test/claude-ghost.test.mjs" ;;
    suggest-input-unit) echo "node --test test/claude-input.test.mjs" ;;
    layout-unit) echo "node --test test/layout-ops.test.mjs" ;;
    light-list-unit) echo "node --test test/light-list.test.mjs" ;;
    llm-layer) echo "node --test test/llm-layer.test.mjs" ;;
    guard-unit) echo "node --test test/guard.test.mjs" ;;
    proctree-unit) echo "node --test test/proctree.test.mjs" ;;
    process) echo "node --test test/process.test.mjs" ;;
    process-run) echo "node --test test/process-run.test.mjs" ;;
    process-counts) echo "node --test test/process-counts.test.mjs" ;;
    process-edit) echo "node --test test/process-edit.test.mjs" ;;
    process-proposal) echo "node --test test/process-proposal.test.mjs" ;;
    process-proposal-route) echo "sh test/e2e-process-proposal.sh" ;;
    mcp-process-propose) echo "node --test test/mcp-process-propose.test.mjs" ;;

    process-stage) echo "node --test test/process-stage.test.mjs" ;;
    mail-full-suite-sender) echo "node --test test/mail-full-suite-sender.test.mjs" ;;
    mail-routing-uncertain) echo "node --test test/mail-routing-uncertain.test.mjs" ;;
    thread-defer) echo "node --test test/thread-defer.test.mjs" ;;
    mail-note-display) echo "node --test test/mail-note-display.test.mjs" ;;
    story-check-unit) echo "node --test test/story-check.test.mjs" ;;
    deploy-canary) echo "node --test test/deploy-canary.test.mjs" ;;
    deploy-bisect) echo "node --test test/deploy-bisect.test.mjs" ;;
    release-lock) echo "node --test test/release-lock.test.mjs" ;;
    deploy-prune-unit) echo "node --test test/deploy-prune.test.mjs" ;;
    deploy-health-wait) echo "node --test test/deploy-health-wait.test.mjs" ;;
    merge-failures-unit) echo "node --test test/merge-failures.test.mjs" ;;
    pr-open-scope) echo "node --test test/pr-open-scope.test.mjs" ;;
    pr-open-unit) echo "node --test test/pr-open-unit.test.mjs" ;;
    pr-sync-unit) echo "node --test test/pr-sync-unit.test.mjs" ;;
    workspace-reused-branch) echo "node --test test/workspace-reused-branch.test.mjs" ;;
    workspace-fresh-base) echo "node --test test/workspace-fresh-base.test.mjs" ;;
    cli-help-unit) echo "node --test test/cli-help.test.mjs" ;;
    *) echo "sh test/e2e-$1.sh" ;;
  esac
}

parallel=""; tests=""; smoke=""; explicit=""
for a in "$@"; do
  case "$a" in
    --smoke | --live) smoke=1 ;;
    --parallel) parallel=1 ;;
    -h | --help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "test/run.sh: unknown flag $a; usage: test/run.sh [--smoke|--live] [--parallel] [NAME...] (test/run.sh -h). A single light test takes no flag: test/run.sh NAME (docs/testing.md)" >&2; exit 2 ;;
    *) a=${a#test/}; a=${a#e2e-}; a=${a%.sh}; a=${a%.test.mjs}; tests="$tests $a"; explicit=1 ;;
  esac
done
[ -n "$tests" ] || tests="$FREE${smoke:+ $SMOKE}"
for t in $tests; do
  case " $FREE $SMOKE " in *" $t "*) ;; *) echo "no test $t; tests: $FREE $SMOKE"; exit 2 ;; esac
done

light=""
if [ -n "$explicit" ]; then
  light=1
  for t in $tests; do case " $LIGHT " in *" $t "*) ;; *) light="" ;; esac; done
fi
# One of the machine's test slots (scripts/test-slot.sh, S-692); the suite lock below nests inside it.
# A run of only LIGHT tests takes the light pool and no suite lock, so it never queues behind heavy runs (S-1288).
[ -n "$STAM_TEST_NOSLOT" ] || sh scripts/test-slot.sh ${light:+--light} --held || exec sh scripts/test-slot.sh ${light:+--light} sh test/run.sh "$@"
# Nearly every test listens on 127.0.0.1. A sandbox without loopback (Codex's) refuses that,
# and a test that waits on the listen hangs (S-323), so stop here with the reason instead.
node -e "require('net').createServer().once('error', (e) => { console.error('test/run.sh: can\'t listen on 127.0.0.1 (' + e.code + '): no loopback here, as in a Codex sandbox; run the tests outside it'); process.exit(3); }).listen(0, '127.0.0.1', function () { this.close(); })" || exit 2
# One suite at a time on this machine: agents share it, and parallel suites starved it of
# memory (2026-10-11). STAM_TEST_NOLOCK=1 skips the wait.
if [ -z "$light" ] && [ -z "$STAM_TEST_NOLOCK" ] && command -v flock >/dev/null; then
  exec 9>/tmp/stam-test-suite.lock
  flock -n 9 || { echo "waiting for another test/run.sh on this machine..."; flock 9; }
fi
LOGS="$(mktemp -d "$STAM_TEST_TMPDIR/stam-test-logs.XXXXXX")"
est=0
for t in $tests; do est=$(echo "$est + $(estimate "$t")" | bc); done
echo "running:$tests (estimated spend \$$(money "$est"); logs in $LOGS)"

# timeout puts the test in its own process group and signals the whole group, so the
# test's children (daemons, node --test workers) go with it (S-323).
TIMEOUT=${STAM_TEST_TIMEOUT:-600}
KILL_AFTER=${STAM_TEST_KILL_AFTER:-30}
run_one() {
  start=$(date +%s)
  reason=$(skip_reason "$1")
  if [ -n "$reason" ] && [ -n "$STAM_TEST_NO_SKIP" ]; then
    echo "FAIL $1: $reason (STAM_TEST_NO_SKIP is set, so a missing tool fails)" | tee "$LOGS/$1.log" >&2
    echo "1 0" >"$LOGS/$1.status"
    return
  fi
  if [ -n "$reason" ]; then
    echo "SKIP $1: $reason" >&2
    echo "$reason" >"$LOGS/$1.skip"
    echo "skip 0" >"$LOGS/$1.status"
    return
  fi
  case " $SMOKE " in *" $1 "*) smoke=1 ;; *) smoke= ;; esac
  STAM_TEST_SMOKE=$smoke timeout -k "$KILL_AFTER" "$TIMEOUT" $(cmd "$1") >"$LOGS/$1.log" 2>&1 9>&- &
  # timeout leads its own group, so its pid is the group's id.
  group=$!
  echo "$group" >"$LOGS/$1.group"
  wait "$group"
  code=$?
  secs=$(($(date +%s) - start))
  # 124: timeout's SIGTERM ended it; 137: it needed the SIGKILL.
  if [ "$TIMEOUT" != 0 ] && [ "$secs" -ge "$TIMEOUT" ] && { [ "$code" = 124 ] || [ "$code" = 137 ]; }; then
    code=hung
    # timeout's SIGKILL reaches only the test itself, so whatever of its group ignored the
    # SIGTERM (and outlived the test's own cleanup) goes now.
    kill -KILL "-$group" 2>/dev/null
    echo "test $1 hung: stopped after ${secs}s (STAM_TEST_TIMEOUT=$TIMEOUT); its log: $LOGS/$1.log" >&2
  fi
  rm -f "$LOGS/$1.group"
  echo "$code $secs" >"$LOGS/$1.status"
}
# Being in its own group, a test misses the Ctrl-C or SIGTERM that stops run.sh, so pass it on,
# wait up to STAM_TEST_KILL_AFTER seconds for the groups to go, SIGKILL what is left, and only
# then exit, which releases the lock.
stop_tests() {
  trap '' INT TERM HUP
  groups=$(cat "$LOGS"/*.group 2>/dev/null)
  for g in $groups; do kill -TERM "-$g" 2>/dev/null; done
  i=0
  while [ "$i" -lt "$KILL_AFTER" ]; do
    left=""
    for g in $groups; do kill -0 "-$g" 2>/dev/null && left="$left $g"; done
    [ -z "$left" ] && break
    sleep 1; i=$((i + 1))
  done
  for g in $groups; do kill -KILL "-$g" 2>/dev/null; done
  exit 130
}
trap stop_tests INT TERM HUP
for t in $tests; do
  if [ -n "$parallel" ]; then run_one "$t" & else run_one "$t"; fi
done
wait

failed=0; spent=0; skipped=0
printf '\n%-16s %-5s %6s %9s %9s\n' TEST RESULT TIME SPEND ESTIMATE
for t in $tests; do
  read -r code secs <"$LOGS/$t.status"
  if [ "$code" = skip ]; then
    skipped=$((skipped + 1))
    printf '%-16s %-5s %6s\n' "$t" SKIP ""
    echo "                 $(cat "$LOGS/$t.skip")"
    continue
  fi
  s=$(sed -n 's/^spend [^:]*: \$\([0-9.]*\)$/\1/p' "$LOGS/$t.log" | paste -sd+ - | sed 's/^$/0/' | bc)
  spent=$(echo "$spent + $s" | bc)
  if [ "$code" = 0 ]; then r=PASS; elif [ "$code" = hung ]; then r=HUNG; failed=1; else r=FAIL; failed=1; fi
  printf '%-16s %-5s %5ss %9s %9s\n' "$t" "$r" "$secs" "\$$(money "$s")" "\$$(money "$(estimate "$t")")"
  [ "$r" = FAIL ] && grep -m1 '^FAIL' "$LOGS/$t.log" | sed 's/^/                 /'
  [ "$r" = HUNG ] && echo "                 stopped after ${secs}s with no result (STAM_TEST_TIMEOUT=$TIMEOUT)"
done
printf '%-16s %-5s %6s %9s %9s\n' total "" "" "\$$(money "$spent")" "\$$(money "$est")"
[ "$skipped" = 0 ] || echo "$skipped skipped: a tool they need is missing here (reasons above); they didn't run and don't count as failures"
echo "(spend: cost the test daemons recorded; Codex agents report none)"
# Logs go when every test passed. Otherwise the passing tests' logs go and the failing ones stay.
if [ "$failed" = 0 ]; then
  rm -rf "$LOGS"; echo "logs deleted: every test passed"
else
  for t in $tests; do read -r code _ <"$LOGS/$t.status"; [ "$code" = 0 ] && rm -f "$LOGS/$t.log" "$LOGS/$t.status"; done
  echo "logs kept for the failing tests: $LOGS"
fi
exit $failed
