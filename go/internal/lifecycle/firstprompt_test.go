package lifecycle

import "testing"

// S-3454: the first UserPromptSubmit that isn't a stam channel push takes the first prompt (the TS rule, mirrored).
func TestFirstPromptTakenByFirstNonChannelTurn(t *testing.T) {
	l := &Lifecycle{}
	taken, done := l.awaitFirstPrompt("a1")
	defer done()
	l.firstPromptHook("a1", "<channel source=\"stam\" kind=\"mail\">\n[stam] Wrap up\n</channel>")
	if taken() {
		t.Fatal("a stam channel push took the first prompt")
	}
	l.firstPromptHook("a1", "<pasted_content id=\"1\">line one\nline two\n</pasted_content id=\"1\">")
	if !taken() {
		t.Fatal("a wrapped multi-line prompt did not take the first prompt")
	}
}

func TestFirstPromptHookWithoutStringCounts(t *testing.T) {
	l := &Lifecycle{}
	taken, done := l.awaitFirstPrompt("a2")
	defer done()
	l.firstPromptHook("a2", nil)
	if !taken() {
		t.Fatal("a hook with no prompt did not count, as before")
	}
}

func TestFirstPromptDoneIgnoresOtherLaunches(t *testing.T) {
	l := &Lifecycle{}
	oldTaken, oldDone := l.awaitFirstPrompt("a3")
	newTaken, newDone := l.awaitFirstPrompt("a3")
	oldDone()
	l.firstPromptHook("a3", "typed prompt")
	if !newTaken() {
		t.Fatal("a superseded launch's done removed the later launch's wait")
	}
	if oldTaken() {
		t.Fatal("a superseded launch was marked taken")
	}
	newDone()
}
