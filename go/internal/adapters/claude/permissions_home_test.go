package claude

import (
	"path/filepath"
	"slices"
	"testing"

	"stam/internal/adapters"
)

// Both spellings of the default home are guarded (S-3347): stam becomes a symlink to mootr after the move.
func TestSecretRulesCoverBothHomeSpellings(t *testing.T) {
	u := "/u"
	stam := filepath.Join(u, ".local", "share", "stam")
	mootr := filepath.Join(u, ".local", "share", "mootr")
	homes := adapters.SecretHomes("/elsewhere/home", u)
	rules := DenyRules("/elsewhere/home", u)
	for _, h := range []string{stam, mootr} {
		if !slices.Contains(homes, h) {
			t.Errorf("SecretHomes lacks %s", h)
		}
		for _, f := range adapters.SecretFiles {
			for _, tool := range []string{"Read", "Edit", "Write"} {
				if r := tool + "(/" + h + "/" + f + ")"; !slices.Contains(rules, r) {
					t.Errorf("DenyRules lacks %s", r)
				}
			}
		}
	}
	for _, dir := range []string{"stam", "mootr"} {
		for _, f := range append([]string{"stam.db", "registry.json"}, adapters.SecretFiles...) {
			if r := "Bash(*" + dir + "/" + f + "*)"; !slices.Contains(rules, r) {
				t.Errorf("DenyRules lacks %s", r)
			}
		}
	}
}
