package server

import "testing"

// commentOf is src/permissions.ts commentOf (S-3829): a bare Approve or Deny adds no comment, so the agent's notice is
// the same as before; a comment is kept, trimmed.
func TestCommentOf(t *testing.T) {
	for note, want := range map[string]string{
		"yes, but only after the backup": "yes, but only after the backup",
		"  only on staging  ":            "only on staging",
		"":                               "",
		"   ":                            "",
		"I authorize":                    "",
		"i AUTHORIZE":                    "",
		"Denied":                         "",
	} {
		if got := commentOf(note); got != want {
			t.Errorf("commentOf(%q) = %q, want %q", note, got, want)
		}
	}
}
