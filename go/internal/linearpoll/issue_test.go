package linearpoll

import (
	"reflect"
	"strings"
	"testing"

	"stam/internal/jsjson"
)

// The unit tests of test/linear-poller.test.mjs that need no server: the subject and the defensive parsing, and the diff of
// one poll against the last snapshot.

func parse(t *testing.T, s string) jsjson.Value {
	t.Helper()
	v, err := jsjson.Parse([]byte(s))
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func TestSubjects(t *testing.T) {
	if id, ok := ParseSubject("linear:ENG-1"); !ok || id != "ENG-1" {
		t.Errorf("issue: %q %v", id, ok)
	}
	if id, ok := ParseSubject("linear:eng-12"); !ok || id != "ENG-12" {
		t.Errorf("a lower-case issue is upper-cased: %q %v", id, ok)
	}
	for _, s := range []string{"linear:team:ENG", "github:o/r#1", "linear:ENG", "linear:ENG-1/x"} {
		if _, ok := ParseSubject(s); ok {
			t.Errorf("%q is not an issue", s)
		}
	}
	if k, ok := ParseTeamSubject("linear:team:eng"); !ok || k != "ENG" {
		t.Errorf("team: %q %v", k, ok)
	}
	for _, s := range []string{"linear:team:", "linear:ENG-1", "linear:team:ENG/ENG-1"} {
		if _, ok := ParseTeamSubject(s); ok {
			t.Errorf("%q is not a team", s)
		}
	}
}

func TestNormalizeReadsNamesObjectsAndBareValues(t *testing.T) {
	n := NormalizeIssue(parse(t, `{"issue":{"title":"T","state":{"name":"Todo"},"assignee":{"displayName":"Dana"},"priority":3,"updated_at":"u","createdAt":"c"}}`), "ENG-1")
	if deref(n.State) != "Todo" || deref(n.Assignee) != "Dana" || deref(n.Priority) != "3" || deref(n.UpdatedAt) != "u" || deref(n.CreatedAt) != "c" {
		t.Errorf("%+v", n)
	}
	if p := NormalizeIssue(parse(t, `{"priority":{"value":2}}`), "X").Priority; deref(p) != "2" {
		t.Errorf("a priority object with a value alone is that value: %v", p)
	}
	if p := NormalizeIssue(parse(t, `{"priority":{"value":2,"name":"High"}}`), "X").Priority; deref(p) != "High" {
		t.Errorf("a priority name wins: %v", p)
	}
	for _, in := range []string{`{"priority":""}`, `{"priority":null}`, `{}`, `null`, `"text"`, `[1]`} {
		if p := NormalizeIssue(parse(t, in), "X").Priority; p != nil {
			t.Errorf("%s: priority %q, want none", in, *p)
		}
	}
	if p := NormalizeIssue(parse(t, `{"priority":0}`), "X").Priority; deref(p) != "0" {
		t.Errorf("a priority of 0 is the text 0: %v", p)
	}
	if NormalizeIssue(parse(t, `{}`), "ENG-2").Title != nil {
		t.Error("a missing title is none")
	}
	c := NormalizeComments(parse(t, `{"nodes":[{"id":9,"user":{"name":"bob"},"body":"hi"},{"body":"no id"},null,"x"]}`))
	want := []Comment{{ID: "9", Author: sp("bob"), Body: "hi"}}
	if !reflect.DeepEqual(c, want) {
		t.Errorf("comments %+v, want %+v", c, want)
	}
	if got := NormalizeComments(parse(t, `[{"id":"a","creator":{"email":"e@x"}}]`)); len(got) != 1 || deref(got[0].Author) != "e@x" || got[0].Body != "" {
		t.Errorf("bare array: %+v", got)
	}
	if got := NormalizeComments(parse(t, `{"comments":[{"id":"a","author":"zed","created_at":"t"}]}`)); len(got) != 1 || deref(got[0].Author) != "zed" || deref(got[0].CreatedAt) != "t" {
		t.Errorf("comments key: %+v", got)
	}
}

func issueOf(over func(*Issue)) Issue {
	i := Issue{ID: "ENG-1", Title: sp("Fix login"), URL: sp("https://linear.app/acme/issue/ENG-1/fix-login"), State: sp("Todo"), Priority: sp("High"), UpdatedAt: sp("2026-10-11T10:00:00Z")}
	if over != nil {
		over(&i)
	}
	return i
}

func TestDiffFirstPollIsSilentAndEachChangeEmitsOnceWithItsTime(t *testing.T) {
	first := issueOf(nil)
	snap := MakeSnapshot(first, nil, nil)
	if got := DiffIssue("linear:ENG-1", nil, first, nil, ""); got != nil {
		t.Errorf("the first poll emits %v", got)
	}
	if got := DiffIssue("linear:ENG-1", &snap, first, nil, ""); got != nil {
		t.Errorf("no change emits %v", got)
	}
	moved := issueOf(func(i *Issue) {
		i.State, i.Assignee, i.Priority, i.Title, i.UpdatedAt = sp("In Progress"), sp("Dana"), sp("Urgent"), sp("Fix login now"), sp("2026-10-11T11:00:00Z")
	})
	evs := DiffIssue("linear:ENG-1", &snap, moved, []Comment{{ID: "5", Author: sp("bob"), Body: "on it\nmore"}}, "")
	var types []string
	for _, e := range evs {
		types = append(types, e.Type)
	}
	if want := []string{"issue.state_changed", "issue.assigned", "issue.priority_changed", "issue.title_changed", "comment.created"}; !reflect.DeepEqual(types, want) {
		t.Fatalf("types %v, want %v", types, want)
	}
	if evs[0].Summary != "ENG-1 state: Todo → In Progress" {
		t.Errorf("summary %q", evs[0].Summary)
	}
	if evs[0].DedupeKey != "issue.state_changed:linear:ENG-1:2026-10-11T11:00:00Z" || evs[4].DedupeKey != "comment.created:linear:ENG-1:5" {
		t.Errorf("keys %q %q", evs[0].DedupeKey, evs[4].DedupeKey)
	}
	if evs[1].Summary != "ENG-1 assigned to Dana" || evs[2].Summary != "ENG-1 priority: High → Urgent" || evs[3].Summary != "ENG-1 renamed: Fix login now" {
		t.Errorf("summaries %q %q %q", evs[1].Summary, evs[2].Summary, evs[3].Summary)
	}
	if evs[4].Summary != "ENG-1 comment by bob: on it" || deref(evs[4].Actor) != "bob" || evs[0].Subject != "linear:ENG-1" || evs[0].Issue != "" {
		t.Errorf("comment event %+v", evs[4])
	}
	// Assigned back to nobody, priority cleared.
	cleared := moved
	cleared.Assignee, cleared.Priority = nil, nil
	prev := MakeSnapshot(moved, nil, nil)
	got := DiffIssue("linear:ENG-1", &prev, cleared, nil, "")
	if len(got) != 2 || got[0].Summary != "ENG-1 assigned to nobody" || got[1].Summary != "ENG-1 priority: Urgent → none" {
		t.Errorf("cleared: %+v", got)
	}
}

func TestDiffKnownCommentEmitsNothingAndARenameEmits(t *testing.T) {
	cur := issueOf(func(i *Issue) { i.Title = sp("Fix login (renamed)") })
	prev := MakeSnapshot(issueOf(nil), []Comment{{ID: "5"}}, nil)
	evs := DiffIssue("linear:ENG-1", &prev, cur, []Comment{{ID: "5", Author: sp("bob"), Body: "old"}}, "")
	if len(evs) != 1 || evs[0].Type != "issue.title_changed" {
		t.Errorf("%+v", evs)
	}
}

func TestDiffOfATeamNamesTheTeamAndTheIssue(t *testing.T) {
	prev := MakeSnapshot(issueOf(nil), nil, nil)
	cur := issueOf(func(i *Issue) { i.State, i.UpdatedAt = sp("Done"), sp("T2") })
	evs := DiffIssue("linear:ENG-1", &prev, cur, []Comment{{ID: "c"}}, "linear:team:ENG")
	if len(evs) != 2 {
		t.Fatalf("%+v", evs)
	}
	if evs[0].Subject != "linear:team:ENG" || evs[0].Issue != "linear:ENG-1" || evs[0].DedupeKey != "issue.state_changed:linear:team:ENG:linear:ENG-1:T2" {
		t.Errorf("%+v", evs[0])
	}
	if evs[1].DedupeKey != "comment.created:linear:team:ENG:linear:ENG-1:c" || evs[1].Summary != "ENG-1 comment by someone: " {
		t.Errorf("%+v", evs[1])
	}
}

func TestFirstLineCutsAtTwoHundredUTF16Units(t *testing.T) {
	if got := firstLine("  hello \nmore"); got != "hello" {
		t.Errorf("%q", got)
	}
	long := strings.Repeat("a", 250)
	if got := firstLine(long); len(got) != 200 {
		t.Errorf("%d", len(got))
	}
	// 150 astral characters are 300 UTF-16 units: JS slice(0, 200) keeps 100 of them.
	if got := []rune(firstLine(strings.Repeat("😀", 150))); len(got) != 100 {
		t.Errorf("%d runes", len(got))
	}
}

func TestSnapshotKeepsTheLastFiveHundredCommentIDsAndKeepsTheOrder(t *testing.T) {
	var cs []Comment
	for i := 0; i < 600; i++ {
		cs = append(cs, Comment{ID: "c" + strings.Repeat("x", i%3) + string(rune('A'+i%26)) + string(rune('a'+i/26))})
	}
	prev := MakeSnapshot(issueOf(nil), cs[:10], nil)
	s := MakeSnapshot(issueOf(nil), cs, &prev)
	if len(s.CommentIDs) != 500 || s.CommentIDs[499] != cs[599].ID {
		t.Errorf("%d ids, last %q", len(s.CommentIDs), s.CommentIDs[len(s.CommentIDs)-1])
	}
	if got := MakeSnapshot(issueOf(nil), nil, nil); got.CommentIDs == nil {
		t.Error("an empty id list is [], not null")
	}
}

func TestSnapshotJSONKeepsTheTSFieldOrder(t *testing.T) {
	s := marshal(MakeSnapshot(issueOf(nil), []Comment{{ID: "c1"}}, nil))
	want := `{"id":"ENG-1","title":"Fix login","url":"https://linear.app/acme/issue/ENG-1/fix-login","state":"Todo","assignee":null,"priority":"High","updatedAt":"2026-10-11T10:00:00Z","createdAt":null,"commentIds":["c1"]}`
	if s != want {
		t.Errorf("%s", s)
	}
	back := ParseSnapshot(s)
	if back == nil || back.ID != "ENG-1" || back.Assignee != nil || deref(back.State) != "Todo" || len(back.CommentIDs) != 1 {
		t.Errorf("%+v", back)
	}
	if ParseSnapshot("not json") != nil || ParseSnapshot("null") != nil || ParseSnapshot("5") != nil {
		t.Error("a stored value that is no object reads as no snapshot")
	}
}
