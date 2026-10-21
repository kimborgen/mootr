package server

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strconv"

	"stam/internal/auth"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
	"stam/internal/requirements"
)

// requirementsRoutes registers the requirements API (src/daemon.ts, "Requirements"). The literal paths are registered beside
// the `{id}` ones: the mux prefers the literal.
func (s *Server) requirementsRoutes() {
	s.handle("GET /api/requirements", s.listRequirements)
	s.handle("POST /api/requirements", s.createRequirement)
	s.handle("POST /api/requirements/batch", s.batchRequirements)
	s.handle("POST /api/requirements/waivers", s.waive)
	s.handle("GET /api/req-enabled", s.reqEnabled)
	s.requirementCheckRoutes()
	s.handle("GET /api/requirements/asks/{id}", s.showAsk)
	s.handle("POST /api/requirements/asks/{id}/drop", s.dropFromBatch)
	s.handle("POST /api/requirements/{id}/preview", reqPath(s.previewRoute))
	s.handle("GET /api/requirements/{id}", reqPath(s.showRequirement))
	s.handle("PATCH /api/requirements/{id}", reqPath(s.setRequirement))
	s.handle("POST /api/requirements/{id}/links", reqPath(s.addReqLink))
	s.handle("DELETE /api/requirements/{id}/links/{link}", reqPath(s.removeReqLink))
}

var reReqLinkID = regexp.MustCompile(`^\d+$`)

// reqPath refuses a requirement route whose id isn't one TS's ([\w-]+) matches, as no route.
func reqPath(h handler) handler {
	return func(r *http.Request, c auth.Resolved) (any, error) {
		if !agentRef.MatchString(r.PathValue("id")) || (r.PathValue("link") != "" && !reReqLinkID.MatchString(r.PathValue("link"))) {
			return nil, Errorf(http.StatusNotFound, "no route %s %s", r.Method, r.URL.Path)
		}
		return h(r, c)
	}
}

var reNoReq = regexp.MustCompile(`^no requirement |^no link `)

// reqErr is src/daemon.ts reqRoute: a refusal is 403, requirements off 404, an unknown requirement or link 404, a step the Go
// daemon cannot take yet 501, any other throw 400.
func reqErr(err error) error {
	if err == nil {
		return nil
	}
	var e *Error
	var forbidden requirements.Forbidden
	var off requirements.Off
	var np requirements.NotPorted
	switch {
	case errors.As(err, &e):
		return err
	case errors.As(err, &forbidden):
		return Errorf(http.StatusForbidden, "%s", err.Error())
	case errors.As(err, &off):
		return Errorf(http.StatusNotFound, "%s", err.Error())
	case errors.As(err, &np):
		return Errorf(http.StatusNotImplemented, "%s", err.Error())
	case reNoReq.MatchString(err.Error()):
		return Errorf(http.StatusNotFound, "%s", err.Error())
	}
	return Errorf(http.StatusBadRequest, "%s", err.Error())
}

// person is src/itsa.ts person for the store: an agent id or name, or `human`, as an id; "" for none.
func (s *Server) storePerson(ctx context.Context, v jsjson.Value) (string, error) {
	f, err := jsfmt.Parse([]byte(jsjson.Stringify(v, "")))
	if err != nil {
		return "", err
	}
	return s.person(ctx, f, true)
}

func queryOpt(r *http.Request, key string) *string {
	if !r.URL.Query().Has(key) {
		return nil
	}
	v := r.URL.Query().Get(key)
	return &v
}

func (s *Server) listRequirements(r *http.Request, _ auth.Resolved) (any, error) {
	f := requirements.ListFilters{Parent: queryOpt(r, "parent"), Status: queryOpt(r, "status"), Text: queryOpt(r, "text"), Latest: r.URL.Query().Get("verdicts") == "latest"}
	if f.Text == nil {
		f.Text = queryOpt(r, "q")
	}
	out, err := s.requirements.List(r.Context(), f)
	return out, reqErr(err)
}

func (s *Server) reqEnabled(r *http.Request, _ auth.Resolved) (any, error) {
	out := jsfmt.Value{Kind: jsfmt.Object}
	out.Set("enabled", jsfmt.Value{Kind: jsfmt.Bool, Bool: s.requirements.Enabled()})
	return out, nil
}

func (s *Server) showRequirement(r *http.Request, _ auth.Resolved) (any, error) {
	var verdict *int64
	if v := r.URL.Query().Get("verdict"); regexp.MustCompile(`^\d+$`).MatchString(v) {
		n, _ := strconv.ParseInt(v, 10, 64)
		verdict = &n
	}
	out, err := s.requirements.Get(r.Context(), r.PathValue("id"), verdict)
	return out, reqErr(err)
}

// reqWrite reads a write's body and the actor it acts as: its JSON object for the store, and `by` (itsaActor).
func (s *Server) reqWrite(r *http.Request, c auth.Resolved) (*jsjson.Object, string, error) {
	ctx := context.WithoutCancel(r.Context())
	body, err := jsonBody(r)
	if err != nil {
		return nil, "", err
	}
	if err := s.resolveItsaActors(ctx, c, &body); err != nil {
		return nil, "", err
	}
	human := s.isHuman(r, c)
	by, err := itsaActor(body, human, systemBodyOK(c, human, body))
	if err != nil {
		return nil, "", err
	}
	parsed, err := jsjson.Parse([]byte(jsfmt.Compact(body)))
	if err != nil {
		return nil, "", err
	}
	o, _ := parsed.(*jsjson.Object)
	if o == nil {
		o = jsjson.NewObject()
	}
	return o, by, nil
}

func (s *Server) createRequirement(r *http.Request, c auth.Resolved) (any, error) {
	ctx := context.WithoutCancel(r.Context())
	if !s.requirements.Enabled() {
		return nil, reqErr(requirements.Off{})
	}
	o, by, err := s.reqWrite(r, c)
	if err != nil {
		return nil, err
	}
	req, err := s.requirements.Create(ctx, requirements.Input(o.Get), by)
	if err != nil {
		return nil, reqErr(err)
	}
	// A draft an agent wrote reaches the human's attention list as an ask (src/req-approval.ts).
	if by != "" && by != requirements.Human && req.Status() == "draft" {
		out := req.Value
		out.Set("approval", s.askApproval(ctx, req, s.reqActor(ctx, by)).value())
		return out, nil
	}
	return req.Value, nil
}

func (s *Server) batchRequirements(r *http.Request, c auth.Resolved) (any, error) {
	ctx := context.WithoutCancel(r.Context())
	if !s.requirements.Enabled() {
		return nil, reqErr(requirements.Off{})
	}
	o, by, err := s.reqWrite(r, c)
	if err != nil {
		return nil, err
	}
	list, _ := o.Get("requirements")
	made, err := s.requirements.Batch(ctx, list, by)
	if err != nil {
		return nil, reqErr(err)
	}
	out := jsfmt.Value{Kind: jsfmt.Object}
	items := jsfmt.Value{Kind: jsfmt.Array}
	for _, m := range made {
		items.Items = append(items.Items, m.Value)
	}
	out.Set("requirements", items)
	// One ask for the whole batch when an agent made it (src/req-approval.ts askBatch).
	if actor := s.reqPerson(ctx, by); actor != requirements.Human {
		out.Set("approval", s.askApprovalBatch(ctx, made, actor).value())
	}
	return out, nil
}

// reqPerson is `(await itsa.person(by)) ?? HUMAN`.
func (s *Server) reqPerson(ctx context.Context, by string) string {
	if p, err := s.person(ctx, jsfmt.StringValue(by), true); err == nil && p != "" {
		return p
	}
	return requirements.Human
}

func (s *Server) setRequirement(r *http.Request, c auth.Resolved) (any, error) {
	ctx := context.WithoutCancel(r.Context())
	if !s.requirements.Enabled() {
		return nil, reqErr(requirements.Off{})
	}
	o, by, err := s.reqWrite(r, c)
	if err != nil {
		return nil, err
	}
	res, err := s.requirements.Set(ctx, r.PathValue("id"), requirements.Input(o.Get), by)
	if err != nil {
		return nil, reqErr(err)
	}
	// An edit to a draft with an open approval ask refreshes the ask, and a move into force by any other way than the ask's
	// Approve closes it (src/req-approval.ts).
	key := res.Requirement.Key()
	if len(res.Changes.Keys) > 0 && res.Requirement.Status() == "draft" {
		s.refreshApproval(ctx, key, s.reqActor(ctx, by))
	}
	if st, ok := res.Changes.Get("status"); ok {
		if to, ok := st.Get("to"); ok && to.Kind == jsfmt.String && to.Str == "in_force" {
			actor := s.reqActor(ctx, by)
			if actor == "" {
				actor = requirements.Human
			}
			s.approvedElsewhere(ctx, key, actor)
		}
	}
	out := jsfmt.Value{Kind: jsfmt.Object}
	out.Set("requirement", res.Requirement.Value)
	out.Set("changes", res.Changes)
	return out, nil
}

func (s *Server) addReqLink(r *http.Request, c auth.Resolved) (any, error) {
	o, _, err := s.reqWriteNoActor(r, c)
	if err != nil {
		return nil, err
	}
	out, err := s.requirements.AddLink(r.Context(), r.PathValue("id"), requirements.Input(o.Get))
	return out, reqErr(err)
}

func (s *Server) removeReqLink(r *http.Request, c auth.Resolved) (any, error) {
	if _, err := s.readWrite(r, c); err != nil {
		return nil, err
	}
	n, _ := strconv.ParseInt(r.PathValue("link"), 10, 64)
	if err := s.requirements.RemoveLink(r.Context(), r.PathValue("id"), n); err != nil {
		return nil, reqErr(err)
	}
	out := jsfmt.Value{Kind: jsfmt.Object}
	out.Set("removed", jsfmt.IntValue(n))
	return out, nil
}

// reqWriteNoActor reads a write's body for a route that takes no actor (links).
func (s *Server) reqWriteNoActor(r *http.Request, c auth.Resolved) (*jsjson.Object, struct{}, error) {
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, struct{}{}, err
	}
	if w.body == nil {
		return jsjson.NewObject(), struct{}{}, nil
	}
	return w.body, struct{}{}, nil
}

func (s *Server) waive(r *http.Request, c auth.Resolved) (any, error) {
	if !s.requirements.Enabled() {
		return nil, reqErr(requirements.Off{})
	}
	o, by, err := s.reqWrite(r, c)
	if err != nil {
		return nil, err
	}
	out, err := s.requirements.Waive(context.WithoutCancel(r.Context()), requirements.Input(o.Get), by)
	return out, reqErr(err)
}
