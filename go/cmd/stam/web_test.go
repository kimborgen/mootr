package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// TestWeb: `stam web` names the login page first with local login on, and marks its token links as not the human;
// with it off, only the token links, unmarked. STAM_BIND names the addresses; no tailscale here (PATH has none).
func TestWeb(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("local login is Linux only")
	}
	t.Setenv("PATH", t.TempDir())
	for _, c := range []struct {
		name, settings, want string
	}{
		{"on", `{"auth":{"localHuman":true}}`, "http://127.0.0.1:7999/   (this machine: log in as the human with a one-time command)\n" +
			"http://127.0.0.1:7999/#token=tok-1   (token link: not the human, so approvals and settings are refused)\n" +
			"http://100.1.2.3:7999/#token=tok-1   (token link: not the human, so approvals and settings are refused)\n"},
		{"off", `{"auth":{"localHuman":false}}`, "http://127.0.0.1:7999/#token=tok-1\nhttp://100.1.2.3:7999/#token=tok-1\n"},
	} {
		home := t.TempDir()
		for name, text := range map[string]string{"token": "tok-1\n", "peer-token": "peer-1\n", "settings.json": c.settings} {
			if err := os.WriteFile(filepath.Join(home, name), []byte(text), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		o := runCLI(t, map[string]string{"STAM_HOME": home, "STAM_PORT": "7999", "STAM_MACHINE": "m", "STAM_BIND": "127.0.0.1,100.1.2.3"}, "", "web")
		if o.code != 0 || o.stdout != c.want {
			t.Errorf("%s: %d\n%s%s", c.name, o.code, o.stdout, o.stderr)
		}
	}
	if o := runCLI(t, nil, "", "web", "serve"); o.code != 1 || o.stderr != "stam web serve needs tailscale on PATH (https://tailscale.com/download); without it, use the addresses `stam web` prints\n" {
		t.Errorf("serve with no tailscale: %d %q", o.code, o.stderr)
	}
}
