package adapters

import (
	"reflect"
	"testing"

	"stam/internal/tmux"
)

// TestSessionEnv checks the env lifecycle adds (src/lifecycle.ts startHarness) follows TS's object spread: a key the
// spec holds keeps its place and takes the later value, new keys go last in order.
func TestSessionEnv(t *testing.T) {
	spec := tmux.Env{{Key: "STAM_USER_STATUSLINE", Value: "x"}, {Key: "STAM_TEST_TMPDIR", Value: "/spec"}}
	got := SessionEnv(spec, SessionVars{AgentID: "a1", URL: "http://127.0.0.1:1", Token: "tok", ReviewDir: "/review", ReviewTmp: "/review-tmp"})
	want := tmux.Env{{Key: "STAM_USER_STATUSLINE", Value: "x"}, {Key: "STAM_TEST_TMPDIR", Value: "/review-tmp"}, {Key: "STAM_REVIEW_DIR", Value: "/review"},
		{Key: "STAM_AGENT_ID", Value: "a1"}, {Key: "STAM_URL", Value: "http://127.0.0.1:1"}, {Key: "STAM_TOKEN", Value: "tok"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("env:\n got %v\nwant %v", got, want)
	}
	if spec[1].Value != "/spec" {
		t.Fatal("SessionEnv changed the spec's env")
	}
	plain := SessionEnv(nil, SessionVars{AgentID: "a2", URL: "u", Token: "t"})
	if len(plain) != 3 || plain[0].Key != "STAM_AGENT_ID" {
		t.Fatalf("env without a review dir: %v", plain)
	}
}
