package server

import (
	"context"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/jsfmt"
)

// The ITSA link routes of src/daemon.ts over src/itsa.ts addLink, removeLink and recordLink (S-2849, PR 2), and the
// links of a create. An agent's branch link is checked in TS against the worktrees that own the branch (S-581); that
// check is not ported, so an agent (other than the chief of staff or the assistant) linking a branch answers 501. A
// branch link names its repo from settings.itsa.repos; TS adds the checkout it runs from, which this daemon does not
// derive, so a repo the file does not list answers 501 rather than "unknown repo".

var (
	reBranch   = regexp.MustCompile(`^[A-Za-z0-9._/-]+$`)
	reLinkPath = regexp.MustCompile(`^\d+$`)
	verdicts   = []string{"approve", "request_changes", "comment"}
)

func validBranch(b string) bool {
	return reBranch.MatchString(b) && !strings.HasPrefix(b, "-") && !strings.Contains(b, "..")
}

// jsString is JS String(v ?? ”) for a decoded member.
func jsString(body jsfmt.Value, key string) string {
	v, ok := body.Get(key)
	if !ok || v.Kind == jsfmt.Null {
		return ""
	}
	return anyString(v)
}

// validateLink is src/itsa.ts validateLink: it normalizes a link and refuses a bad one before any write.
func (s *Server) validateLink(l jsfmt.Value) (db.NewLink, error) {
	system := strings.TrimSpace(jsString(l, "system"))
	if system == "" {
		system = "url"
	}
	var external *string
	if v, ok := l.Get("external_id"); ok && v.Truthy() {
		e := anyString(v)
		external = &e
	}
	if system == "branch" {
		repo := strings.TrimSpace(jsString(l, "repo"))
		if external == nil {
			return db.NewLink{}, itsaErr("a branch link needs its branch name (external_id)")
		}
		if !validBranch(*external) {
			return db.NewLink{}, itsaErr("a branch name is letters, digits, . _ / and -, not starting with -: %s", *external)
		}
		if repo == "" {
			return db.NewLink{}, itsaErr("a branch link needs its repo: a name from settings.itsa.repos")
		}
		if strings.HasPrefix(repo, "/") || strings.Contains(repo, `\`) {
			return db.NewLink{}, itsaErr("a branch link names its repo by a name in settings.itsa.repos, not a path: %s", repo)
		}
		if _, ok := s.repos()[repo]; !ok {
			return db.NewLink{}, itsaErr("unknown repo %s: add it to settings.itsa.repos", repo)
		}
		return db.NewLink{System: system, ExternalID: external, URL: strings.TrimSpace(jsString(l, "url")), Repo: repo}, nil
	}
	url := strings.TrimSpace(jsString(l, "url"))
	if url == "" {
		return db.NewLink{}, itsaErr("a link needs a url")
	}
	return db.NewLink{System: system, ExternalID: external, URL: url}, nil
}

func (s *Server) linkRoutes() {
	s.handle("POST /api/itsas/{id}/links", s.itsaAddLinkRoute)
	s.handle("PATCH /api/itsas/{id}/links/{n}", s.itsaRecordLinkRoute)
	s.handle("DELETE /api/itsas/{id}/links/{n}", s.itsaRemoveLinkRoute)
}

// linkRequest is what the three routes share: the home check, the body, the actor, and the agent's right to edit.
func (s *Server) linkRequest(r *http.Request, c auth.Resolved) (context.Context, jsfmt.Value, string, string, error) {
	if err := s.notHome(c); err != nil {
		return nil, jsfmt.Value{}, "", "", err
	}
	ctx := context.WithoutCancel(r.Context())
	ref := r.PathValue("id")
	if !reItsaID.MatchString(ref) || (r.PathValue("n") != "" && !reLinkPath.MatchString(r.PathValue("n"))) {
		return nil, jsfmt.Value{}, "", "", Errorf(http.StatusNotFound, "no route %s %s", r.Method, r.URL.Path)
	}
	body, err := jsonBody(r)
	if err != nil {
		return nil, jsfmt.Value{}, "", "", err
	}
	if err := s.resolveItsaActors(ctx, c, &body); err != nil {
		return nil, jsfmt.Value{}, "", "", err
	}
	human := s.isHuman(r, c)
	by, err := itsaActor(body, human, systemBodyOK(c, human, body))
	if err != nil {
		return nil, jsfmt.Value{}, "", "", err
	}
	if err := s.mayActOnItsa(ctx, c, by, ref); err != nil {
		return nil, jsfmt.Value{}, "", "", err
	}
	return ctx, body, by, ref, nil
}

// actorOf is itsa.ts `(await person(by)) ?? HUMAN`.
func (s *Server) actorOf(ctx context.Context, by string) (string, error) {
	id, err := s.person(ctx, jsfmt.StringValue(by), true)
	if err != nil {
		return "", err
	}
	if id == "" {
		return humanBox, nil
	}
	return id, nil
}

func (s *Server) itsaAddLinkRoute(r *http.Request, c auth.Resolved) (any, error) {
	ctx, body, by, ref, err := s.linkRequest(r, c)
	if err != nil {
		return nil, err
	}
	if sys, _ := body.Get("system"); sys.Kind == jsfmt.String && sys.Str == "branch" && c.Caller.IsAgent() && !c.Caller.Boss && s.chiefOfStaffID(ctx) != by && !s.isAssistant(ctx, by) {
		return nil, Errorf(http.StatusNotImplemented, "an agent's branch link is checked against the worktrees that own the branch, which is not ported to the Go daemon yet")
	}
	actor, err := s.actorOf(ctx, by)
	if err != nil {
		return nil, err
	}
	l, err := s.validateLink(body)
	if err != nil {
		return nil, err
	}
	link, x, err := s.db.AddItsaLink(ctx, ref, actor, l)
	if err != nil {
		return nil, asItsaErr(err)
	}
	out := jsfmt.Value{Kind: jsfmt.Object}
	out.Set("link", link)
	out.Set("itsa", x)
	return out, nil
}

func (s *Server) itsaRemoveLinkRoute(r *http.Request, c auth.Resolved) (any, error) {
	ctx, _, by, ref, err := s.linkRequest(r, c)
	if err != nil {
		return nil, err
	}
	actor, err := s.actorOf(ctx, by)
	if err != nil {
		return nil, err
	}
	n, _ := strconv.ParseInt(r.PathValue("n"), 10, 64)
	x, err := s.db.RemoveItsaLink(ctx, ref, n, actor)
	return x, asItsaErr(err)
}

// count is recordLink's Number(v ?? 0) that must be a whole number, 0 or more.
func count(body jsfmt.Value, key string) (int64, error) {
	v, ok := body.Get(key)
	if !ok || v.Kind == jsfmt.Null {
		return 0, nil
	}
	f, ok := jsNumber(v)
	if !ok || f != math.Trunc(f) || f < 0 {
		return 0, itsaErr("%s must be a whole number, 0 or more", key)
	}
	return int64(f), nil
}

func (s *Server) itsaRecordLinkRoute(r *http.Request, c auth.Resolved) (any, error) {
	ctx, body, by, ref, err := s.linkRequest(r, c)
	if err != nil {
		return nil, err
	}
	actor, err := s.actorOf(ctx, by)
	if err != nil {
		return nil, err
	}
	n, _ := strconv.ParseInt(r.PathValue("n"), 10, 64)
	at := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	link, err := s.db.RecordItsaLink(ctx, ref, n, func(tx db.ItsaTx, key, system string, meta jsfmt.Value) (jsfmt.Value, error) {
		if system != "branch" {
			return jsfmt.Value{}, itsaErr("link %d on %s is a %s link, not a branch", n, key, system)
		}
		if meta.Kind != jsfmt.Object {
			meta = jsfmt.Value{Kind: jsfmt.Object}
		}
		if rv, ok := body.Get("review"); ok {
			if rv.Kind == jsfmt.Null {
				return jsfmt.Value{}, itsaErr("Cannot read properties of null (reading 'verdict')")
			}
			verdict, _ := rv.Get("verdict")
			if verdict.Kind != jsfmt.String || !contains(verdicts, verdict.Str) {
				return jsfmt.Value{}, itsaErr("a review verdict is %s", strings.Join(verdicts, ", "))
			}
			review := jsfmt.Value{Kind: jsfmt.Object}
			review.Set("verdict", verdict)
			review.Set("by", jsfmt.StringValue(actor))
			if sv, ok := rv.Get("summary"); ok && sv.Truthy() {
				review.Set("summary", jsfmt.StringValue(anyString(sv)))
			} else {
				review.Set("summary", jsfmt.NullValue())
			}
			review.Set("at", jsfmt.StringValue(at))
			meta.Set("review", review)
		}
		if tv, ok := body.Get("tests"); ok {
			if tv.Kind == jsfmt.Null {
				return jsfmt.Value{}, itsaErr("Cannot read properties of null (reading 'passed')")
			}
			tests := jsfmt.Value{Kind: jsfmt.Object}
			for _, k := range []string{"passed", "failed", "skipped"} {
				v, err := count(tv, k)
				if err != nil {
					return jsfmt.Value{}, err
				}
				tests.Set(k, jsfmt.IntValue(v))
			}
			if cv, ok := tv.Get("command"); ok && cv.Truthy() {
				tests.Set("command", jsfmt.StringValue(anyString(cv)))
			} else {
				tests.Set("command", jsfmt.NullValue())
			}
			tests.Set("at", jsfmt.StringValue(at))
			meta.Set("tests", tests)
		}
		if sv, ok := body.Get("screenshots"); ok {
			if sv.Kind != jsfmt.Array {
				return jsfmt.Value{}, itsaErr("screenshots is a list of { mail_id, name }")
			}
			shots := []jsfmt.Value{}
			for _, sh := range sv.Items {
				mid, name := jsString(sh, "mail_id"), jsString(sh, "name")
				if sh.Kind != jsfmt.Object || !hasTruthy(sh, "mail_id") || !hasTruthy(sh, "name") {
					return jsfmt.Value{}, itsaErr("a screenshot names its mail_id and attachment name")
				}
				ok, err := tx.HasAttachment(mid, name)
				if err != nil {
					return jsfmt.Value{}, err
				}
				if !ok {
					return jsfmt.Value{}, itsaErr("no attachment %s on mail %s", name, mid)
				}
				o := jsfmt.Value{Kind: jsfmt.Object}
				o.Set("mail_id", jsfmt.StringValue(mid))
				o.Set("name", jsfmt.StringValue(name))
				shots = append(shots, o)
			}
			meta.Set("screenshots", jsfmt.ArrayValue(shots))
		}
		return meta, nil
	})
	return link, asItsaErr(err)
}

func hasTruthy(v jsfmt.Value, key string) bool { x, ok := v.Get(key); return ok && x.Truthy() }
