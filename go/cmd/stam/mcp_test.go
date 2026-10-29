package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// `stam mcp lease-rotate` writes a new lease token to STAM_HOME/mcp-lease-token at mode 0600, prints the message without the
// token, and refuses without a home (S-3176).
func TestLeaseRotateWritesTheTokenToTheFileOnly(t *testing.T) {
	home := t.TempDir()
	var out bytes.Buffer
	e := env{getenv: func(k string) string {
		if k == "STAM_HOME" {
			return home
		}
		return ""
	}, stdout: &out}
	if err := mcpCmd(nil, []string{"lease-rotate"}, e); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(home, "mcp-lease-token"))
	if err != nil {
		t.Fatal(err)
	}
	token := strings.TrimSpace(string(raw))
	if token == "" {
		t.Fatal("the rotation wrote no token")
	}
	info, err := os.Stat(filepath.Join(home, "mcp-lease-token"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("lease token mode %o, want 600", info.Mode().Perm())
	}
	if strings.Contains(out.String(), token) {
		t.Errorf("the rotation printed the token: %s", out.String())
	}
	if !strings.Contains(out.String(), "rotated the MCP lease token") {
		t.Errorf("output %q", out.String())
	}
	if err := mcpCmd(nil, []string{"lease-rotate"}, env{getenv: func(string) string { return "" }, stdout: &out}); err == nil {
		t.Error("a rotation with no home was accepted")
	}
}
