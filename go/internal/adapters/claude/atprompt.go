package claude

import (
	"regexp"
	"strings"

	"stam/internal/jsjson"
)

// jsSpace is JavaScript's \s: ASCII whitespace, the Unicode space separators, U+FEFF and the line separators.
const jsSpace = `[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`

var (
	// spinner is src/adapters/claude.ts SPINNER: Claude Code's working line ("… (12s").
	spinner = regexp.MustCompile(`…` + jsSpace + `*\(\d+[smh]`)
	// inputMark is a line that starts with the input box's ❯.
	inputMark = regexp.MustCompile(`^` + jsSpace + `*❯`)
	dialogUp  = regexp.MustCompile(`Enter to confirm|Esc to cancel`)
)

// AtPrompt is src/adapters/claude.ts atPrompt over a captured screen: an empty input box, with no spinner or dialog.
func AtPrompt(screen string) bool {
	return !spinner.MatchString(screen) && inputFree(strings.Split(screen, "\n"))
}

// InputFree is inputFree over a captured screen.
func InputFree(screen string) bool { return inputFree(strings.Split(screen, "\n")) }

// inputFree is src/adapters/claude.ts inputFree: the input box is the last line starting with ❯; it must hold nothing
// but the prompt, with no dialog on screen.
func inputFree(lines []string) bool {
	input := -1
	for i := len(lines) - 1; i >= 0; i-- {
		if inputMark.MatchString(lines[i]) {
			input = i
			break
		}
	}
	if input < 0 || jsjson.Trim(inputMark.ReplaceAllString(lines[input], "")) != "" {
		return false
	}
	for _, l := range lines {
		if dialogUp.MatchString(l) {
			return false
		}
	}
	return true
}
