package opencode

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"testing"
)

// PendingAsks reads the permission listing as OpenCode 2.0.26 answers it, from the real capture test/fixtures/opencode-permissions.json
// (S-4280): a pending permission, none after an interrupt, and a 404 for a session the server doesn't have.
func TestPendingAsksFromTheCapture(t *testing.T) {
	raw, err := os.ReadFile("../../../../test/fixtures/opencode-permissions.json")
	if err != nil {
		t.Fatal(err)
	}
	var all map[string]json.RawMessage
	if err := json.Unmarshal(raw, &all); err != nil {
		t.Fatal(err)
	}
	type capture struct {
		Status int             `json:"status"`
		Body   json.RawMessage `json:"body"`
	}
	fx := map[string]capture{}
	for k, v := range all {
		var c capture
		if json.Unmarshal(v, &c) == nil && c.Status != 0 {
			fx[k] = c
		}
	}
	var listed struct {
		Data []struct {
			ID        string `json:"id"`
			SessionID string `json:"sessionID"`
		} `json:"data"`
	}
	if err := json.Unmarshal(fx["pending"].Body, &listed); err != nil || len(listed.Data) != 1 {
		t.Fatalf("the capture: %v %+v", err, listed)
	}
	sid, pid := listed.Data[0].SessionID, listed.Data[0].ID
	serve := func(key string) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			c := fx[key]
			w.WriteHeader(c.Status)
			w.Write(c.Body)
		})
	}
	ctx := context.Background()

	got, err := testServer(t, serve("pending")).PendingAsks(ctx, sid)
	if err != nil || len(got) != 1 {
		t.Fatalf("pending: %+v %v", got, err)
	}
	if got[0].Permission != pid || got[0].Action != "OpenCode asks to allow shell" {
		t.Errorf("the ask is %+v", got[0])
	}
	// The details are the ones the permission.asked event's ask has: its resources as the command, no metadata, no source.
	for _, want := range []string{`"permission":"` + pid + `"`, `"session":"` + sid + `"`, `echo capture-hello`} {
		if !strings.Contains(got[0].Details, want) {
			t.Errorf("details %s lack %s", got[0].Details, want)
		}
	}
	for _, leak := range []string{"messageID", "call_", "echo *"} {
		if strings.Contains(got[0].Details, leak) {
			t.Errorf("details %s hold the listing's %s", got[0].Details, leak)
		}
	}

	// Another session's item is left out: the item's own session is the ask's.
	if got, err := testServer(t, serve("pending")).PendingAsks(ctx, "ses_other"); err != nil || len(got) != 0 {
		t.Errorf("another session's item: %+v %v", got, err)
	}
	if got, err := testServer(t, serve("afterInterrupt")).PendingAsks(ctx, sid); err != nil || len(got) != 0 {
		t.Errorf("after an interrupt: %+v %v", got, err)
	}
	if _, err := testServer(t, serve("missingSession")).PendingAsks(ctx, "ses_doesnotexist"); !errors.Is(err, ErrSessionGone) {
		t.Errorf("a session the server doesn't have: %v", err)
	}
	failing := testServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(500) }))
	if _, err := failing.PendingAsks(ctx, sid); err == nil || errors.Is(err, ErrSessionGone) {
		t.Errorf("a server error: %v", err)
	}
}
