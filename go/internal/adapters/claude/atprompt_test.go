package claude

import "testing"

// TestAtPrompt: an empty input box (JavaScript's whitespace counts as empty), with no spinner or dialog anywhere.
func TestAtPrompt(t *testing.T) {
	for _, tc := range []struct {
		name, screen string
		want         bool
	}{
		{"an empty box", "╭───╮\n❯ \n╰───╯\n? for shortcuts", true},
		{"a box with a no-break space", "❯  \n", true},
		{"an indented box", "   ❯\n", true},
		{"a draft", "❯ hello\n", false},
		{"the spinner", "✻ Thinking… (12s · esc to interrupt)\n❯ \n", false},
		{"the spinner with a no-break space", "✻ Working… (3m · esc to interrupt)\n❯ \n", false},
		{"an ellipsis that is no spinner", "Reading… done (ok)\n❯ \n", true},
		{"a dialog", "Do you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel\n", false},
		{"a dialog's confirm line", "❯ \nEnter to confirm\n", false},
		{"no box", "? for shortcuts\n", false},
		{"the last box wins", "❯ 1. Yes\n❯ \n", true},
		{"the last box holds text", "❯ \n❯ draft\n", false},
	} {
		if got := AtPrompt(tc.screen); got != tc.want {
			t.Errorf("%s: AtPrompt = %v, want %v", tc.name, got, tc.want)
		}
	}
}
