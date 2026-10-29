package server

import (
	"os"
	"path/filepath"
	"testing"
)

// TestVoiceConfigured: GET /api/voice is the human's only, and says false even with a key set, since transcription
// isn't ported; the key never shows.
func TestVoiceConfigured(t *testing.T) {
	f := relayFixture(t, "http://127.0.0.1:1", "", nil)
	must(t, os.WriteFile(filepath.Join(f.home, "voice.env"), []byte("ELEVENLABS_API_TOKEN=sk_live1\n"), 0o600))
	if rec := f.do(call{path: "/api/voice", header: humanHdr}); rec.Code != 200 || rec.Body.String() != `{"configured":false}` {
		t.Errorf("the human: %d %s", rec.Code, rec.Body)
	}
	// The shared token's claim isn't the human's proof (TS's humanOnly asks trustedHuman alone).
	if rec := f.do(call{path: "/api/voice", token: sharedTok, header: map[string]string{"X-Stam-Human": "1"}}); rec.Code != 403 {
		t.Errorf("the shared token: %d %s", rec.Code, rec.Body)
	}
}
