package server

import (
	"context"
	"net/http"
	"regexp"

	"stam/internal/auth"
)

// plusOneLine is src/retro.ts COUNTED: what counts as a +1, a `+1 from` comment or feedback's `Reported again by`.
var plusOneLine = regexp.MustCompile(`^(\+1 from |Reported again by )`)

// itsaPlusOnesRoute is GET /api/itsas/:id/plus-ones (S-796): the +1 count alone, so a +1 on a retro item or feedback
// report never makes the caller read its thread. On the open board any agent reads the count, as any may +1 there;
// elsewhere it stays with those who may read the threads. The answer is the number alone, never thread content.
func (s *Server) itsaPlusOnesRoute(r *http.Request, c auth.Resolved) (any, error) {
	if err := s.notHome(c); err != nil {
		return nil, err
	}
	ctx := context.WithoutCancel(r.Context())
	ref := r.PathValue("id")
	if !reItsaID.MatchString(ref) {
		return nil, Errorf(http.StatusNotFound, "no route %s %s", r.Method, r.URL.Path)
	}
	x, err := s.mustItsa(ctx, ref)
	if err != nil {
		return nil, asItsaErr(err)
	}
	if !isOpenBoard(x.Text("kind")) {
		if err := s.mayReadThreads(ctx, c, x.Text("id"), r.URL.Query().Get("as")); err != nil {
			return nil, err
		}
	}
	n := 0
	if tid := x.Text("thread_id"); tid != "" {
		mails, err := s.db.ThreadMail(ctx, tid, "")
		if err != nil {
			return nil, err
		}
		for _, m := range mails {
			if plusOneLine.MatchString(m.Text("body")) {
				n++
			}
		}
	}
	return struct {
		Count int `json:"count"`
	}{n}, nil
}
