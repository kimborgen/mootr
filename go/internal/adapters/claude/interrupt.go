package claude

import "strings"

// What src/adapters/claude.ts interrupt reads off the screen (S-2848 B5e): whether a turn's spinner shows, how many
// "Interrupted" lines there are, and whether vim's INSERT mode shows anywhere. Pure functions over a captured screen;
// the lifecycle sends the keys.

// ShowsSpinner is SPINNER.test(screen): Claude Code's working line with its timer.
func ShowsSpinner(screen string) bool { return spinner.MatchString(screen) }

// InterruptMarks is the number of "Interrupted ·" lines on the screen: a new one confirms an interrupt.
func InterruptMarks(screen string) int { return strings.Count(screen, "Interrupted ·") }

// ShowsInsert is screen.includes('-- INSERT --'): vim keys are on and in INSERT mode, where the first Esc only leaves
// it.
func ShowsInsert(screen string) bool { return strings.Contains(screen, "-- INSERT --") }
