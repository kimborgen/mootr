package server

import (
	"net/http"

	"stam/internal/auth"
)

// POST /api/push/notify (src/daemon.ts, webpush.onRelay): a peer daemon relays a notification, or the close of one, to
// the devices registered here. Only a peer relays: an agent's token reaches this route too, and a close from it must not
// close the user's notifications. The web push itself (the devices and their notifications, part of the chief of staff
// module) is not ported, so a peer's relay answers 501.
func (s *Server) pushRoutes() {
	s.handle("POST /api/push/notify", s.pushNotifyRoute)
}

func (s *Server) pushNotifyRoute(_ *http.Request, c auth.Resolved) (any, error) {
	if !c.Local {
		return nil, Errorf(http.StatusForbidden, "only a peer daemon relays notifications")
	}
	return nil, unported("the web push is not ported to the Go daemon yet")
}
