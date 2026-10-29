// What a caller of pr_review is told when no answer came back (S-2631). The verdict may already be posted, so the caller
// checks with pr_view. A repeat is safe: scripts/pr-review.mjs sets the same stam/review status again and the newest one
// counts, but it posts a second comment. Kept apart from pr-review.ts, so the MCP process can use it without the daemon's modules.
export function unconfirmedVerdict(pr: number | string, where: string): string {
  return `the verdict on PR #${pr} may already be posted: ${where}, so there was no answer. Check with pr_view (PR ${pr}): its checks show the stam/review status. If your verdict is there, it is posted. If not, call pr_review again with the same head: a repeat sets the same status again, but posts a second comment.`;
}
