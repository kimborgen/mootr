package server

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sync"

	"stam/internal/adapters/claude"
	"stam/internal/auth"
	"stam/internal/jsjson"
	"stam/internal/skills"
	"stam/internal/tiny"
)

// Settings › Skills (S-889, S-890): the skills, and the import of public ones from GitHub (src/daemon.ts).
func (s *Server) skillsRoutes() {
	s.handle("GET /api/skills", s.listSkills)
	s.handle("GET /api/skills/updates", s.skillUpdates)
	s.handle("POST /api/skills/import", s.importSkill(true))
	s.handle("POST /api/skills/update", s.importSkill(false))
}

// skillPaths are where this daemon's skills live; the agents folder is STAM_AGENTS_SKILLS, which test daemons set, or
// ~/.agents/skills.
func skillPaths(home string) skills.Paths {
	user, _ := os.UserHomeDir()
	agents := getenvStam("AGENTS_SKILLS")
	if agents == "" {
		agents = filepath.Join(user, ".agents", "skills")
	}
	return skills.Paths{Home: home, UserHome: user, Agents: agents}
}

// RecoverSkillImports puts back a skill folder an interrupted update moved aside, at daemon start (recoverImports).
func (s *Server) RecoverSkillImports() { s.skills.Paths.Recover() }

// listSkills is GET /api/skills (S-889): each skill with its description, an automatic summary of its body, size,
// source and reach per harness; attachedTo lists the agent types that name it (S-891). A body's summary is the block
// summaries' (src/block-summaries.ts summaryFor): off with no model, pending while asked.
func (s *Server) listSkills(r *http.Request, _ auth.Resolved) (any, error) {
	typesV, _ := s.registry().Get("types")
	types, _ := typesV.(*jsjson.Object)
	out := []jsjson.Value{}
	for _, info := range s.skills.Paths.Infos() {
		attached := []jsjson.Value{}
		for _, name := range types.Keys() {
			t, _ := types.Get(name)
			list, _ := at(t, "skills")
			if names, ok := list.([]jsjson.Value); ok && slices.Contains(names, jsjson.Value(info.Name)) {
				attached = append(attached, name)
			}
		}
		summary, err := s.tiny.BlockSummary(r.Context(), tiny.TextHash(info.Body), info.Body, info.Name)
		if err != nil {
			return nil, err
		}
		out = append(out, info.JSON("attachedTo", attached, "bodySummary", summary))
	}
	return raw(out), nil
}

// skillUpdates is GET /api/skills/updates: the human asks the origin of every imported skill whether its folder moved.
func (s *Server) skillUpdates(r *http.Request, _ auth.Resolved) (any, error) {
	if err := s.humanOnly(r, "check imported skills against their origin"); err != nil {
		return nil, err
	}
	var names []string
	for _, info := range s.skills.Paths.Infos() {
		if info.Origin != nil {
			names = append(names, info.Name)
		}
	}
	states := make([]*jsjson.Object, len(names))
	var wg sync.WaitGroup
	for i, n := range names {
		wg.Add(1)
		go func() {
			defer wg.Done()
			states[i] = s.skills.CheckUpdate(r.Context(), n)
		}()
	}
	wg.Wait()
	out := jsjson.NewObject()
	for i, n := range names {
		out.Set(n, states[i])
	}
	return raw(out), nil
}

// importSkill is POST /api/skills/import ({source}: a GitHub URL, OWNER/REPO or OWNER/REPO/path) and
// /api/skills/update ({name}). Only the human adds or replaces a skill; downloaded content is untrusted, and nothing
// in it runs. Every harness's skills folder is linked again after.
func (s *Server) importSkill(isImport bool) handler {
	return func(r *http.Request, c auth.Resolved) (any, error) {
		if err := s.humanOnly(r, "import or update a skill"); err != nil {
			return nil, err
		}
		w, err := s.readWrite(r, c)
		if err != nil {
			return nil, err
		}
		arg := func(key string) string {
			v, _ := w.body.Get(key)
			if v == nil {
				return ""
			}
			return jsjson.ToString(v)
		}
		// The import outlives the request: a closed tab mustn't leave a half-swapped folder.
		ctx := context.WithoutCancel(r.Context())
		var out skills.Imported
		if isImport {
			out, err = s.skills.Import(ctx, arg("source"))
		} else {
			out, err = s.skills.Update(ctx, arg("name"))
		}
		var refused *skills.ImportError
		if errors.As(err, &refused) {
			return nil, Errorf(http.StatusBadRequest, "%s", refused.Error())
		}
		if err != nil {
			return nil, err
		}
		s.relinkSkills()
		verb := "imported"
		if out.Updated {
			verb = "updated"
		}
		slog.Info("skill "+verb, "name", out.Name, "commit", out.Commit[:min(7, len(out.Commit))])
		return out, nil
	}
}

// relinkSkills is src/instructions.ts relinkSkills: every harness's skills folder linked again, and stam's Claude
// Code plugin rebuilt. A failure is logged, not the request's.
func (s *Server) relinkSkills() {
	p := s.skills.Paths
	if err := p.Relink(); err != nil {
		slog.Warn("skills: relink", "err", err)
	}
	if _, err := claude.PluginDir(p.Home, p.UserHome); err != nil {
		slog.Warn("skills: claude plugin", "err", err)
	}
}
