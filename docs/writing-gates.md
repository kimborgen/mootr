# Writing a merge gate or pr_open check

A merge-gate step and a `pr_open` check both decide whether a branch may go on. Write either to these rules. Each rule ends with the retro item it came from.

1. Scan the whole shipped tree at HEAD, not only the files a change touched. An allowlist or a regex can change while its target file stays the same, so a scan of changed files misses it. (S-2337)
2. When a check reads claims from a PR body, define a strict token format and parse only that. Don't parse prose: each new phrase opens a false pass or a false refusal. (S-2325)
3. Test the check against real output lines from past PRs, such as node's own `skipped 0` summary, not only against lines written to fit the code. (S-2322)
4. When a matcher or validator is rewritten, list every case the old version refused and keep each one as a test in the new version. Deleting the old tests with the old code drops those refusals without anyone noticing. (S-2330)
5. When a gate starts reading new export inputs, add them to every fixture repo that runs it. Otherwise its tests fail for fixture reasons. (S-2339)
6. Exemptions are fail-closed: name each exempt state in an explicit list and fail everything else. An error or an unreadable input blocks. Don't infer intent with heuristics. (S-2273, S-2339)
7. A pre-push check must run in the same mode as the merge-gate step it mirrors. A different mode refuses what the gate would pass. (S-2229)
8. When a check reads a hand-listed set of paths, also read every path another config file can extend. A missing target throws and refuses every PR that touches it. (S-2224)
