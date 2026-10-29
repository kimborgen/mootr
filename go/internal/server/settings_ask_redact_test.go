package server

import (
	"context"
	"log/slog"
	"strings"
	"testing"

	"stam/internal/config"
)

// TestSettingsAskSecretLeavesThePayload (S-3869): once a settings ask is approved, denied or withdrawn, its payload holds no
// plaintext client secret, and an approval still applies it; no route, mail, event or log line shows it. A start redacts the
// payloads decided before, and leaves a pending one whole.
func TestSettingsAskSecretLeavesThePayload(t *testing.T) {
	var logs strings.Builder
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })
	f, path := cosFixture(t)
	payload := func(id string) string { return f.text("SELECT payload FROM permission_requests WHERE id = ?", id) }
	askFor := func(server, value string) string {
		t.Helper()
		id := ask(t, f, "PATCH", `{"patch":{"mcpServers":{"`+server+`":{"url":"https://y","auth":{"client_secret":"`+value+`"}}}}}`)
		if !strings.Contains(payload(id), value) {
			t.Fatalf("the pending payload doesn't hold the asked value, so this test checks nothing")
		}
		return id
	}
	const approved, denied, withdrawn, old, pending = "approved-secret-1111", "denied-secret-2222", "withdrawn-secret-3333", "old-secret-4444", "pending-secret-5555"

	id := askFor("t", approved)
	if out := answer(t, f, id, true); out["status"] != "approved" {
		t.Fatalf("the approval: %v", out)
	}
	name, _ := config.McpClientSecretName("t")
	if got, _ := f.srv.secrets.Get(name); got.Reveal() != approved || strings.Contains(readFile(t, path), approved) {
		t.Errorf("the approval didn't apply the secret: the store holds %v", got)
	}
	if p := payload(id); strings.Contains(p, approved) || !strings.Contains(p, `"redacted":true`) || !strings.Contains(p, `"client_secret":"[redacted]"`) {
		t.Errorf("the approved ask's payload: %s", p)
	}

	id2 := askFor("u", denied)
	before := readFile(t, path)
	if out := answer(t, f, id2, false); out["status"] != "denied" || readFile(t, path) != before {
		t.Errorf("the denial: %v", out)
	}
	if p := payload(id2); strings.Contains(p, denied) || !strings.Contains(p, `"redacted":true`) {
		t.Errorf("the denied ask's payload: %s", p)
	}

	id3 := askFor("v", withdrawn)
	if ok, err := f.db.WithdrawPermissionRequest(context.Background(), id3, "gone"); err != nil || !ok {
		t.Fatalf("the withdrawal: %v %v", ok, err)
	}
	if p := payload(id3); strings.Contains(p, withdrawn) {
		t.Errorf("the withdrawn ask's payload: %s", p)
	}

	// A payload a daemon decided before this change is redacted at start; a pending one keeps what its approval needs.
	id4, id5 := askFor("w", old), askFor("x", pending)
	f.sql("UPDATE permission_requests SET status = 'denied', decided_at = ? WHERE id = ?", "2026-10-01T00:00:00.000Z", id4)
	f.srv.StartSecrets()
	if p := payload(id4); strings.Contains(p, old) || !strings.Contains(payload(id5), pending) {
		t.Errorf("the start's sweep: decided %s, pending %s", p, payload(id5))
	}
	if n, err := f.db.RedactDecidedPayloads(context.Background()); err != nil || n != 0 {
		t.Errorf("a second sweep rewrote %d (%v)", n, err)
	}

	var shown strings.Builder
	for _, c := range []call{{path: "/api/permissions", token: sharedTok}, {path: "/api/permissions?status=denied", token: sharedTok, header: trusted}, {path: "/api/asks", token: sharedTok}} {
		shown.WriteString(f.do(c).Body.String())
	}
	shown.WriteString(f.text("SELECT coalesce(group_concat(subject || body, ''), '') FROM mail"))
	shown.WriteString(f.text("SELECT coalesce(group_concat(coalesce(data, ''), ''), '') FROM events"))
	shown.WriteString(logs.String())
	for _, v := range []string{approved, denied, withdrawn, old} {
		if strings.Contains(shown.String(), v) {
			t.Errorf("a route, mail, event or log line shows %s", v)
		}
	}
}
