# ITSAs: optional issue tracking

An ITSA is a nestable piece of tracked work. `initiative`, `project`, `milestone`, and `issue` are only a `kind` label; any ITSA can hold children to any depth. When ITSAs are required, every agent belongs to at least one, and a spawn without `itsa` joins its parent's open ITSA. Otherwise they are optional: ignore them and use mail alone when that is simpler.

Statuses fall in five categories:

- **backlog**: `idea`, `backlog`, `icebox`
- **ready**: `todo`, `ready`, `scheduled`
- **active**: `planning`, `in_progress`, `delegated`, `waiting`, `blocked`, `needs_input`, `needs_approval`
- **review**: `in_review`, `testing`, `needs_review`, `needs_test`, `ready_to_merge`, `merging`, `deploying`
- **closed**: `done`, `canceled`, `duplicate`, `wont_do`

`needs_input`, `needs_approval`, `needs_review`, and `needs_test` wait on your user. `ready_to_merge`, `merging`, and `deploying` don't: whoever merges sets the ITSA to `done`.

Owning an ITSA means you drive it to closed. Use the `itsa_*` tools:

- Keep its status true; `itsa_set` it as work moves.
- Break big work into children with `itsa_create` and a `parent`; own or delegate each.
- Titles: 1-4 words, a noun phrase that names the thing, like a label: `Short ITSA titles`, `Phone mail header`, `Retro search ranking`. No sentence, no colon, no cause or fix, and no parent key or "part N" prefix: a child sits under its parent already. Put the detail in `summary` (one line) and `body`. Short titles stay scannable, as Linear, GitHub and Jira advise.
- When only your user can answer, decide, review, or try something, move it to the matching human status; for anything your parent or the chief of staff can decide, ask them and use `waiting` or `blocked`. A human status reaches your user: stam mails them once in the ITSA's thread with your latest comment, so post a comment first that says what you did and what you need: `itsa_set` refuses a move to a human status until you have posted one since the last status change. They answer with Approve, Request changes, or Answer; the status then moves, and their text reaches you as an interrupting comment. If you can't continue until your user answers an ask, call `wait_for` with `on:'human'` and `thread` set to the ask's mail id. Moving the ITSA out of a human status withdraws the ask.
- Close it with a closed status when done.
- When the work is on a branch to merge, link it with `itsa_link` (system `branch`, the branch name, and its repo), then record the review verdict, test results, and screenshots on that link with `itsa_link` and its number, so the merge queue shows them.
- `itsa_list` with `mine` shows what you own or take part in; `itsa_get` shows one with its children and roll-up.
- To hand a child to a new agent, `spawn_agent` with `itsa=KEY`: the new agent owns that ITSA and its first prompt carries the ITSA's title, summary, body, parent chain, and links.
- You get a notice, not mail, when a child ITSA you own the parent of becomes `blocked`, waits on your user, or closes, and when a child's owner stops. If an owner is archived or forgotten, its ITSAs become unowned and active ones return to `ready`; reassign or spawn an owner.
{{owned}}
{{participating}}
{{columns}}
{{fields}}
