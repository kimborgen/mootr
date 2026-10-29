package server

import (
	"context"
	"testing"
)

// TestDialogMailQuestion: a question dialog's mail says it asks a question, shows the question and its options numbered as
// the choice is typed, and names the question in its subject (src/permissions.ts dialogMail, S-3978). A question with no
// options or several questions reads as no question: the mail shows the input as before.
func TestDialogMailQuestion(t *testing.T) {
	s := &Server{}
	details := `{"tool":"AskUserQuestion","input":{"questions":[{"question":"Which folder?","options":[{"label":"Alpha"},{"label":"Beta"}]}]},"session":"q-session"}`
	got := s.dialogMail(context.Background(), "helper", nil, "Claude Code asks a question", details, "why here", dialogRoute{id: "req-q"})
	for k, want := range map[string]string{
		"line":    "asks a question, with these options.",
		"shown":   "```\nWhich folder?\n\n1. Alpha\n2. Beta\n```",
		"subject": "helper asks: Which folder?",
		"why":     "Claude Code gave no reason with this dialog; ask the agent, or read its last message in its terminal.",
	} {
		if got[k] != want {
			t.Errorf("%s = %q, want %q", k, got[k], want)
		}
	}
	multi := `{"tool":"AskUserQuestion","input":{"questions":[{"question":"Pick?","multiSelect":true,"options":[{"label":"A"}]}]}}`
	got = s.dialogMail(context.Background(), "helper", nil, "Claude Code asks a question", multi, "why here", dialogRoute{id: "req-m"})
	if got["line"] != "wants to use AskUserQuestion." || got["subject"] != "helper asks to use AskUserQuestion" {
		t.Errorf("multiSelect mail %q %q, want the plain shape", got["line"], got["subject"])
	}
}
