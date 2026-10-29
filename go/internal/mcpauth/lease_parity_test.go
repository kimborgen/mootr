package mcpauth

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"stam/internal/jsjson"
)

// remaining is the seconds a token has left in an over-cap refusal.
var remaining = regexp.MustCompile(`lives \d+ s`)

// leaseName is the server a case asks for: the unknown-server case asks for a name no settings hold.
func leaseName(c leaseCase) string {
	if c.name == "unknown server" {
		return "nosuch"
	}
	return "prov"
}

// TestLeaseMatchesTS runs every leaseCases case through src/mcp-auth.ts leaseFor and through leaseFor here, on the same
// settings and grant, and wants the same lease, or the same refusal with the same status and message.
func TestLeaseMatchesTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to run src/mcp-auth.ts")
	}
	for _, c := range leaseCases() {
		t.Run(c.name, func(t *testing.T) {
			name := leaseName(c)
			dir := t.TempDir()
			home := filepath.Join(dir, "home")
			if err := os.Mkdir(home, 0o700); err != nil {
				t.Fatal(err)
			}
			var grant any
			if c.grant != "" {
				grant = json.RawMessage(c.grant)
			}
			caseJSON, err := json.Marshal(map[string]any{"servers": json.RawMessage(c.servers), "grant": grant, "name": name, "force": c.force})
			if err != nil {
				t.Fatal(err)
			}
			casePath := filepath.Join(dir, "case.json")
			if err := os.WriteFile(casePath, caseJSON, 0o600); err != nil {
				t.Fatal(err)
			}
			out, err := exec.Command("node", "--no-warnings", "testdata/lease.mjs", home, casePath).CombinedOutput()
			if err != nil {
				t.Fatalf("lease.mjs: %v\n%s", err, out)
			}
			want := mustParse(t, strings.TrimSpace(string(out))).(*jsjson.Object)

			f := newFixture(t, "m", "m", c.servers)
			if c.grant != "" {
				f.writeGrant("prov", c.grant)
			}
			got, gotErr := f.a.LeaseFor(context.Background(), name, c.force)

			if ok, isOK := want.Get("ok"); isOK {
				okObj := ok.(*jsjson.Object)
				url, _ := okObj.Get("url")
				token, _ := okObj.Get("access_token")
				expires, _ := okObj.Get("expires_at")
				if gotErr != nil {
					t.Fatalf("TS leases, Go refuses: %v", gotErr)
				}
				if got.URL != url.(string) || got.AccessToken != token.(string) || got.ExpiresAt != expires.(float64) {
					t.Errorf("lease %q %q %v, TS %q %q %v", got.URL, got.AccessToken, got.ExpiresAt, url, token, expires)
				}
				return
			}
			status, _ := want.Get("status")
			message, _ := want.Get("message")
			var le *LeaseError
			if !errors.As(gotErr, &le) {
				t.Fatalf("TS refuses %v %v, Go answers %v", status, message, gotErr)
			}
			// The seconds a token has left are read from the clock at the moment of the check, so the two daemons can differ
			// by one; every other word and number of the message must match.
			if float64(le.Status) != status.(float64) || remaining.ReplaceAllString(le.Message, "lives N s") != remaining.ReplaceAllString(message.(string), "lives N s") {
				t.Errorf("refusal %d %q, TS %v %q", le.Status, le.Message, status, message)
			}
		})
	}
}
