package server

import (
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"stam/internal/config"
	"stam/internal/jsjson"
	"stam/internal/localhuman"
)

// The local human login (src/local-human.ts, S-613): with auth.localHuman on, stam's own page on 127.0.0.1 becomes
// the human with a code root vouched for. localhuman holds the codes and sessions; here are its routes and the
// session check auth.TrustedHuman asks.

// localHuman is src/daemon.ts trustedHuman's local part: with the setting off every session ends; with it on, a live
// session's token on a direct loopback connection is the human.
func (s *Server) localHuman(r *http.Request) bool {
	if st := s.settings.Get(); !st.Auth.LocalHuman {
		s.noteLocalHuman(st)
		return false
	}
	tok := localhuman.SessionToken(r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Get("Authorization"))
	// The session first: the socket table is read only for a request that carries one.
	return s.login.Live(tok, time.Now()) && localhuman.Direct(r)
}

// noteLocalHuman ends every session, and so every login in flight (Login.Gen), when settings have local login off.
func (s *Server) noteLocalHuman(st config.Settings) {
	if !st.Auth.LocalHuman {
		s.login.EndAll()
	}
}

// afterRedeem runs between a login's code check and its session's start; a test turns the setting off there.
var afterRedeem = func() {}

// localHumanRoute is GET /api/human/login and POST /api/human/login|logout, before any credential check: the page has
// none yet. A code works only from stam's own page on this machine (loopback, own host, same origin, JSON), so a page
// on another port or site can't spend one. The page posts its secret; root vouched for the secret's name. Every login
// and refusal is logged, never with the secret or a token.
func (s *Server) localHumanRoute(r *http.Request) (any, error) {
	// The generation first: the setting going off after this read means no session starts (Login.Start).
	gen := s.login.Gen()
	on := s.settings.Get().Auth.LocalHuman
	// The folder the page names in its command, and whether this user has passwordless sudo (S-2121): that only to a
	// direct loopback request, the one page that can log in, so a tailnet caller neither learns it nor runs sudo.
	if r.Method == http.MethodGet && r.URL.Path == "/api/human/login" {
		if !on {
			return map[string]bool{"enabled": false}, nil
		}
		return struct {
			Enabled          bool   `json:"enabled"`
			Dir              string `json:"dir"`
			PasswordlessSudo bool   `json:"passwordlessSudo"`
		}{true, s.login.UserDir(), localhuman.Direct(r) && s.login.PasswordlessSudo()}, nil
	}
	if r.Method != http.MethodPost {
		return nil, Errorf(http.StatusMethodNotAllowed, "no route %s %s", r.Method, r.URL.Path)
	}
	if !on {
		return nil, Errorf(http.StatusNotFound, "local human login is off (settings auth.localHuman)")
	}
	what := "logout"
	if strings.HasSuffix(r.URL.Path, "login") {
		what = "login"
	}
	refuse := func(why string) error {
		slog.Warn("local human " + what + " refused: " + why)
		return Errorf(http.StatusForbidden, "%s", why)
	}
	if !localhuman.Direct(r) {
		return nil, refuse("log in from a browser on this machine, at http://127.0.0.1:" + strconv.Itoa(s.cfg.Port) + "/")
	}
	origin := strings.ToLower(r.Header.Get("Origin"))
	site, hasSite := r.Header["Sec-Fetch-Site"]
	if !s.ownHost(r.Host) || origin == "" || !s.sameOrigin(origin) || (hasSite && (len(site) != 1 || site[0] != "same-origin")) {
		return nil, refuse("log in from stam's own page")
	}
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		return nil, Errorf(http.StatusUnsupportedMediaType, "the request must be JSON")
	}
	if what == "logout" {
		tok := localhuman.SessionToken(r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Get("Authorization"))
		return map[string]bool{"ended": s.login.End(tok)}, nil
	}
	raw, err := readBody(r)
	if err != nil {
		return nil, err
	}
	var secret any
	if body, err := jsjson.Parse(raw); err == nil {
		if o, ok := body.(*jsjson.Object); ok {
			secret, _ = o.Get("secret")
		}
	} else if len(raw) > 0 {
		return nil, Errorf(http.StatusBadRequest, "the request body is not valid JSON")
	}
	if why := s.login.Redeem(secret, time.Now()); why != "" {
		return nil, refuse(why)
	}
	afterRedeem()
	token, expires, ok := s.login.Start(time.Now(), gen)
	if !ok {
		slog.Warn("local human login refused: local login went off during it")
		return nil, Errorf(http.StatusNotFound, "local human login is off (settings auth.localHuman)")
	}
	slog.Info("local human login: a session started")
	return struct {
		Token   string `json:"token"`
		Expires int64  `json:"expires"`
	}{token, expires}, nil
}
