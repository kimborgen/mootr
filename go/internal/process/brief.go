package process

const fallbackDeveloper = "When the branch is ready, open its pull request with `pr_open` (branch, title, and the body per docs/pull-requests.md, with `itsa` set to your ITSA). It fetches the branch from storage, pushes it, opens the PR (or replaces the body of the open one), and links the PR and the branch to your ITSA. Then `watch_pr` the PR number it returns, so its checks and reviews reach you. Then mail {{parent}} your branch and commits, the PR link, what changed, what you tested and the results, and anything you weren't sure about. Then set your ITSA to `in_review`, and stop. Never set it to done; the deploy watcher closes it after deploy. If you're blocked, mail {{parent}} instead of guessing. Never mail the human; report to your parent."

const fallbackReviewer = "Watch the PR you review with `watch_pr` when it's open, so you hear its checks and any changes. When the review is of a PR, give your verdict with the `pr_review` tool (PR number, approve or request_changes, a one-line summary, and head: the full sha of the commit you reviewed), then mail {{parent}} your findings when you're done."

const fallbackManager = "A reviewer's task for a PR must include this sentence verbatim: \"When the review is of a PR, watch it with `watch_pr`, and give your verdict with the `pr_review` tool (PR number, approve or request_changes, a one-line summary, and head: the full sha of the commit you reviewed).\"\n\nOnce its reviewer's `stam/review` is success on the PR's current head, the PR is merged with the `pr_merge` tool (see Merging in docs/pull-requests.md): by you, or by the process runner when `process.run` is `on`."

// FallbackNextSteps is src/process-brief-fallback.ts fallbackNextSteps: the {{next_steps}} prose of a type's brief when no
// process has a lane for it; "" for a type without one.
func FallbackNextSteps(typ string) string {
	switch typ {
	case "developer":
		return fallbackDeveloper
	case "reviewer", "reviewer-opus":
		return fallbackReviewer
	case "manager", "coordinator":
		return fallbackManager
	}
	return ""
}

// NextSteps is src/process-brief-fallback.ts nextSteps over already loaded processes: the first process with step text for the
// type, else the fallback prose.
func NextSteps(processes []*Def, typ string) string {
	for _, p := range processes {
		if text := RenderNextSteps(p, typ); text != "" {
			return text
		}
	}
	return FallbackNextSteps(typ)
}
