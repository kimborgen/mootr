package server

import (
	"net/http"

	"stam/internal/auth"
)

// Voice input (src/voice.ts): GET /api/voice says whether the page may offer the microphone. The Go daemon hasn't
// ported POST /api/voice/transcribe, the clip's transcription, so it answers false whatever STAM_HOME/voice.env holds,
// and the page offers none.
func (s *Server) voiceRoutes() {
	s.handle("GET /api/voice", func(r *http.Request, _ auth.Resolved) (any, error) {
		if err := s.humanOnly(r, "use voice input"); err != nil {
			return nil, err
		}
		return map[string]bool{"configured": false}, nil
	})
}
