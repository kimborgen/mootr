package server

import (
	"context"
	"net/http"

	"stam/internal/auth"
	"stam/internal/jsfmt"
)

// The ITSA field routes of src/daemon.ts over src/itsa.ts (S-364): the shared column definitions. The values an ITSA holds
// are written by create and set.

func (s *Server) fieldRoutes() {
	s.handle("GET /api/itsas/fields", s.itsaFieldsRoute)
	s.handle("POST /api/itsas/fields", s.itsaCreateFieldRoute)
	s.handle("POST /api/itsas/fields/order", s.itsaFieldOrderRoute)
	s.handle("PATCH /api/itsas/fields/{key}", s.itsaUpdateFieldRoute)
	s.handle("DELETE /api/itsas/fields/{key}", s.itsaRemoveFieldRoute)
}

func (s *Server) itsaFieldsRoute(r *http.Request, c auth.Resolved) (any, error) {
	if err := s.notHome(c); err != nil {
		return nil, err
	}
	list, err := s.db.ItsaFields(r.Context())
	return list, asItsaErr(err)
}

// fieldRequest is what the write routes share: the home check, the body, the actor, and the right to define fields.
func (s *Server) fieldRequest(r *http.Request, c auth.Resolved) (context.Context, jsfmt.Value, string, error) {
	if err := s.notHome(c); err != nil {
		return nil, jsfmt.Value{}, "", err
	}
	ctx := context.WithoutCancel(r.Context())
	if k := r.PathValue("key"); k != "" && !reItsaID.MatchString(k) {
		return nil, jsfmt.Value{}, "", Errorf(http.StatusNotFound, "no route %s %s", r.Method, r.URL.Path)
	}
	body, err := jsonBody(r)
	if err != nil {
		return nil, jsfmt.Value{}, "", err
	}
	human := s.isHuman(r, c)
	by, err := itsaActor(body, human, systemBodyOK(c, human, body))
	if err != nil {
		return nil, jsfmt.Value{}, "", err
	}
	actor, err := s.mayDefineFields(ctx, by)
	return ctx, body, actor, err
}

// mayDefineFields is itsa.ts assertMayDefine: the human always; while a chief of staff is set, only that agent; with none
// set, any agent. It returns the actor's id.
func (s *Server) mayDefineFields(ctx context.Context, by string) (string, error) {
	actor, err := s.actorOf(ctx, by)
	if err != nil {
		return "", asItsaErr(err)
	}
	if actor == humanBox {
		return actor, nil
	}
	cos := s.settings.Get().ChiefOfStaff
	if cos == "" {
		return actor, nil
	}
	// The chief of staff may sit on another machine, so TS resolves its name through the peers; a failure there is none.
	cosID, _ := s.person(ctx, jsfmt.StringValue(cos), true)
	if actor == cos || actor == cosID || by == cos {
		return actor, nil
	}
	who := cos
	if a, err := s.db.GetAgent(ctx, cos); err == nil && a.Name != "" {
		who = a.Name
	}
	return "", Errorf(http.StatusForbidden, "only the chief of staff (%s) changes ITSA fields: mail %s to add, change, or remove a column", who, who)
}

func (s *Server) itsaCreateFieldRoute(r *http.Request, c auth.Resolved) (any, error) {
	ctx, body, actor, err := s.fieldRequest(r, c)
	if err != nil {
		return nil, err
	}
	f, err := s.db.CreateItsaField(ctx, actor, body)
	return f, asItsaErr(err)
}

func (s *Server) itsaUpdateFieldRoute(r *http.Request, c auth.Resolved) (any, error) {
	ctx, body, actor, err := s.fieldRequest(r, c)
	if err != nil {
		return nil, err
	}
	f, err := s.db.UpdateItsaField(ctx, r.PathValue("key"), actor, body)
	return f, asItsaErr(err)
}

func (s *Server) itsaRemoveFieldRoute(r *http.Request, c auth.Resolved) (any, error) {
	ctx, _, actor, err := s.fieldRequest(r, c)
	if err != nil {
		return nil, err
	}
	out, err := s.db.RemoveItsaField(ctx, r.PathValue("key"), actor)
	return out, asItsaErr(err)
}

func (s *Server) itsaFieldOrderRoute(r *http.Request, c auth.Resolved) (any, error) {
	ctx, body, actor, err := s.fieldRequest(r, c)
	if err != nil {
		return nil, err
	}
	// body?.order ?? body?.ids
	order, ok := body.Get("order")
	if !ok || order.Kind == jsfmt.Null {
		order, _ = body.Get("ids")
	}
	list, err := s.db.ReorderItsaFields(ctx, order, actor)
	return list, asItsaErr(err)
}
