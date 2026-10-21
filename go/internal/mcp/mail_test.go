package mcp

import (
	"fmt"
	"strings"
	"testing"
)

// call is a tools/call line.
func call(id int, tool, args string) string {
	return fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"tools/call","params":{"name":%q,"arguments":%s}}`, id, tool, args)
}

// batches takes the random batch and ack out of the read_mail requests (each process draws its own UUIDs) after
// checking that the ack of a read is the batch of the one before it, and returns the batches seen.
func batches(t *testing.T, calls []seen) {
	t.Helper()
	last := ""
	for _, c := range calls {
		if c.Path != "/api/agents/a1/read" {
			continue
		}
		body := c.Body.(map[string]any)
		batch, _ := body["batch"].(string)
		ack, _ := body["ack"].(string)
		if len(batch) != 36 || batch[14] != '4' {
			t.Errorf("batch %q is not a v4 UUID", batch)
		}
		if ack != last {
			t.Errorf("ack %q, want the previous batch %q", ack, last)
		}
		last = batch
		delete(body, "batch")
		if ack != "" {
			body["ack"] = "ACK"
		}
	}
}

// send_mail sends what src/mcp.ts sends (the normalized input, the sender, a client_id from the words) and says what it says.
func TestSendMailMatchesTS(t *testing.T) {
	lines := []string{
		call(1, "send_mail", `{"to":["boss"],"subject":"plain","body":"hello é <&>"}`),
		call(2, "send_mail", `{"to":"boss","subject":"reply","message":"as message","extra":[1,{"a":"é"}]}`),
		call(3, "send_mail", `{"to":["x"],"subject":"reply","body":"b","reply_to":"m0","new_thread":false}`),
		call(4, "send_mail", `{"to":["x"],"subject":"stopped","content":"as content","self":"a1","override":"why"}`),
		call(5, "send_mail", `{"to":["x"],"subject":"queued","body":"b"}`),
		call(6, "send_mail", `{"to":["boom"],"subject":"boom","body":"b"}`),
		call(7, "send_mail", `{"to":["x"],"subject":"plain"}`),
		call(8, "send_mail", `{"to":["x"],"subject":"plain","body":"  ","attachments":[{"name":"a","content":"c"}]}`),
		call(9, "send_mail", `{"subject":"plain","body":"no to","itsa":"S-1","supersedes":"m1"}`),
		call(10, "send_mail", `{"to":["x"],"subject":"plain","body":"same words"}`),
		call(11, "send_mail", `{"to":["x"],"subject":"plain","body":"same words"}`),
	}
	ts, g := both(t, map[string]string{"STAM_AGENT_ID": "a1"}, lines, 11, 0, "")
	for id, want := range ts.byID {
		if g.byID[id] != want {
			t.Errorf("id %s differs\n ts: %s\n go: %s", id, want, g.byID[id])
		}
	}
	sameCalls(t, ts.calls, g.calls)
	ids := map[string]bool{}
	for _, c := range g.calls {
		if c.Path != "/api/mail" {
			continue
		}
		body := c.Body.(map[string]any)
		if body["from"] != "a1" || body["self"] != nil || body["message"] != nil || body["content"] != nil {
			t.Errorf("body %v", body)
		}
		if id, _ := body["client_id"].(string); len(id) != 32 {
			t.Errorf("client_id %v", body["client_id"])
		} else {
			ids[id] = true
		}
	}
	// Words sent twice have one id (a retry is the same send); other words another.
	if len(ids) != 9 {
		t.Errorf("%d client ids from 10 sends, two with the same words, want 9", len(ids))
	}
}

// The mail tools answer as src/mcp.ts's do: the same text, the same requests to the daemon, the same read ack from one
// read_mail to the next.
func TestMailToolsMatchTS(t *testing.T) {
	lines := []string{
		call(1, "list_inbox", `{}`),
		call(2, "list_inbox", `{"unread_only":false,"limit":5}`),
		call(3, "read_mail", `{"ids":["m1"]}`),
		"WAIT",
		call(4, "read_mail", `{}`),
		"WAIT",
		call(5, "read_mail", `{"ids":["none","m1","zz"]}`),
		"WAIT",
		call(6, "read_mail", `{"ids":["none"]}`),
		call(7, "read_thread", `{"thread_id":"m0"}`),
		call(8, "read_thread", `{"thread_id":"empty"}`),
		call(9, "read_thread", `{}`),
		"WAIT",
		call(10, "read_mail", `{"ids":[]}`),
	}
	ts, g := both(t, map[string]string{"STAM_AGENT_ID": "a1"}, lines, 10, 0, "")
	for id, want := range ts.byID {
		if g.byID[id] != want {
			t.Errorf("id %s differs\n ts: %s\n go: %s", id, want, g.byID[id])
		}
	}
	if len(g.byID) != 10 {
		t.Errorf("go answered %d requests", len(g.byID))
	}
	batches(t, ts.calls)
	batches(t, g.calls)
	sameCalls(t, ts.calls, g.calls)
	for _, want := range []string{"Attachments:", "[stam] slow down", "Not addressed to you: none, zz", "No unread mail.", "No mail of yours in thread empty."} {
		found := false
		for _, l := range g.byID {
			found = found || strings.Contains(l, want)
		}
		if !found {
			t.Errorf("no answer holds %q", want)
		}
	}
}
