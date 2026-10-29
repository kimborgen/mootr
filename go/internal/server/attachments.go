package server

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/peers"
)

// A mail's attachments and the agents and ITSAs attached to it (src/mail.ts storeMail's files, src/daemon.ts GET
// /api/mail/:id/attachments/:name, src/mail-itsas.ts attachToMail; S-3734). An attachment's bytes are never logged.

// saveAttachments writes a send's attachments under dir, as src/mail.ts storeMail does: base64 content, else a path to
// copy, else text content. Each keeps the base name it was given.
// hasAttachments says whether saveAttachments would write a file for any of atts.
func hasAttachments(atts []jsfmt.Value) bool {
	for _, a := range atts {
		if a.Kind == jsfmt.Object {
			return true
		}
	}
	return false
}

func saveAttachments(dir string, atts []jsfmt.Value) ([]db.MailFile, error) {
	var out []db.MailFile
	save := func(name string, write func(p string) error) error {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
		p := filepath.Join(dir, filepath.Base(name))
		if err := write(p); err != nil {
			return err
		}
		info, err := os.Stat(p)
		if err != nil {
			return err
		}
		out = append(out, db.MailFile{Name: filepath.Base(name), Path: p, Size: info.Size()})
		return nil
	}
	for _, a := range atts {
		if a.Kind != jsfmt.Object {
			continue
		}
		name := func(fallback string) string {
			if v, ok := a.Get("name"); ok && v.Kind != jsfmt.Null {
				return anyString(v)
			}
			return fallback
		}
		var err error
		if b64, ok := a.Get("content_b64"); ok {
			err = save(name("attachment.bin"), func(p string) error {
				data, err := base64.StdEncoding.DecodeString(anyString(b64))
				if err != nil {
					// Buffer.from(_, 'base64') skips what isn't base64; a padding-free or odd input decodes as far as it goes.
					data, _ = base64.RawStdEncoding.DecodeString(strings.TrimRight(anyString(b64), "="))
				}
				return os.WriteFile(p, data, 0o644)
			})
		} else if path, ok := a.Get("path"); ok && path.Truthy() {
			src := anyString(path)
			err = save(name(src), func(p string) error { return copyFile(src, p) })
		} else if content, ok := a.Get("content"); ok {
			err = save(name("attachment.txt"), func(p string) error { return os.WriteFile(p, []byte(anyString(content)), 0o644) })
		}
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// itsaIDOf is src/itsa.ts idOf: the id of the ITSA a key or id names, asked of the ITSA home when that is a peer.
func (s *Server) itsaIDOf(ctx context.Context, ref string) (string, error) {
	home := s.settings.Get().Itsa.Home
	if home == "" || home == s.cfg.Machine {
		x, ok, err := s.db.FindItsa(ctx, ref)
		if err != nil {
			return "", err
		}
		if !ok {
			return "", fmt.Errorf("no ITSA %s", ref)
		}
		return x.Text("id"), nil
	}
	peer, ok := s.peers.ByName(home)
	if !ok {
		return "", fmt.Errorf("ITSA home '%s' is not a configured peer", home)
	}
	r, err := s.peers.Call(ctx, peer, http.MethodGet, "/api/itsas/"+url.PathEscape(ref), nil, peers.DefaultTimeout, false, nil)
	if err != nil {
		return "", err
	}
	if id := r.Data.Text("id"); r.Status == http.StatusOK && id != "" {
		return id, nil
	}
	return "", fmt.Errorf("no ITSA %s", ref)
}

// mediaTypes and reTextExt are src/files.ts TYPES and TEXT_EXT: the types an attachment is served as, by extension.
var mediaTypes = map[string]string{
	"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp", "svg": "image/svg+xml", "pdf": "application/pdf",
	"mp4": "video/mp4", "webm": "video/webm", "mov": "video/quicktime", "m4v": "video/mp4", "mp3": "audio/mpeg", "wav": "audio/wav", "ogg": "audio/ogg", "m4a": "audio/mp4",
}

var reTextExt = regexp.MustCompile(`^(txt|md|log|json|ya?ml|toml|csv|tsv|ts|tsx|js|jsx|mjs|py|sh|rs|go|css|html|sql|diff|patch)$`)

// typeByExt is src/files.ts typeByExt: the extension is what follows the last dot, or the whole name without one.
func typeByExt(name string) string {
	ext := strings.ToLower(name[strings.LastIndex(name, ".")+1:])
	if t, ok := mediaTypes[ext]; ok {
		return t
	}
	if reTextExt.MatchString(ext) {
		return "text/plain; charset=utf-8"
	}
	return "application/octet-stream"
}

var reRange = regexp.MustCompile(`^bytes=(\d*)-(\d*)$`)

// attachmentRoute is GET /api/mail/:id/attachments/:name: an attachment's bytes, for showing it in the web UI. Ranges let
// a video seek.
func (s *Server) attachmentRoute(w http.ResponseWriter, r *http.Request, _ auth.Resolved) error {
	name := r.PathValue("name")
	path, ok, err := s.db.Attachment(r.Context(), r.PathValue("id"), name)
	if err != nil {
		return err
	}
	info, statErr := os.Stat(path)
	if !ok || statErr != nil {
		return Errorf(http.StatusNotFound, "no such attachment")
	}
	f, err := os.Open(path)
	if err != nil {
		return Errorf(http.StatusNotFound, "no such attachment")
	}
	defer f.Close()
	size := info.Size()
	h := w.Header()
	h.Set("content-type", typeByExt(name))
	h.Set("accept-ranges", "bytes")
	h.Set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
	h.Set("cache-control", "private, max-age=86400")
	if m := reRange.FindStringSubmatch(r.Header.Get("range")); m != nil && (m[1] != "" || m[2] != "") {
		var start, end int64
		if m[1] != "" {
			start, _ = strconv.ParseInt(m[1], 10, 64)
		} else {
			n, _ := strconv.ParseInt(m[2], 10, 64)
			start = max(0, size-n)
		}
		end = size - 1
		if m[1] != "" && m[2] != "" {
			n, _ := strconv.ParseInt(m[2], 10, 64)
			end = min(n, size-1)
		}
		if start >= size || start > end {
			for _, k := range []string{"content-type", "accept-ranges", "content-security-policy", "cache-control"} {
				h.Del(k)
			}
			h.Set("content-range", fmt.Sprintf("bytes */%d", size))
			w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
			return nil
		}
		h.Set("content-range", fmt.Sprintf("bytes %d-%d/%d", start, end, size))
		h.Set("content-length", strconv.FormatInt(end-start+1, 10))
		w.WriteHeader(http.StatusPartialContent)
		if _, err := f.Seek(start, io.SeekStart); err == nil {
			_, _ = io.CopyN(w, f, end-start+1)
		}
		return nil
	}
	h.Set("content-length", strconv.FormatInt(size, 10))
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, f)
	return nil
}

// attachRoute is POST /api/mail/:id/attach: an agent attaches ITSAs and agents to a mail, silently (S-1305): no mail,
// notice or unread state. Only a recipient of the mail, or the chief of staff, the assistant or a boss, may.
func (s *Server) attachRoute(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	if !c.Caller.IsAgent() {
		return nil, Errorf(http.StatusForbidden, "only an agent attaches to mail")
	}
	body, err := jsonBody(r)
	if err != nil {
		return nil, err
	}
	by := c.Caller.Agent
	if c.Caller.Kind != auth.Agent {
		by = orString(body, "by", "")
	}
	if by == "" {
		return nil, Errorf(http.StatusForbidden, "attaching is for a named agent")
	}
	boss := c.Caller.Boss || s.chiefOfStaffID(ctx) == by || s.isAssistant(ctx, by)
	list := func(k string) []string {
		var out []string
		if v, ok := body.Get(k); ok && v.Kind == jsfmt.Array {
			for _, x := range v.Items {
				out = append(out, anyString(x))
			}
		}
		return out
	}
	id := r.PathValue("id")
	if _, ok, err := s.db.GetMail(ctx, id); err != nil {
		return nil, err
	} else if !ok {
		return nil, Errorf(http.StatusNotFound, "no mail %s here", id)
	}
	if !boss {
		to, err := s.db.MailRecipientIDs(ctx, id)
		if err != nil {
			return nil, err
		}
		if !contains(to, by) {
			return nil, Errorf(http.StatusForbidden, "only a recipient of the mail, or the chief of staff, attaches to it")
		}
	}
	itsaIDs := []string{}
	for _, ref := range list("itsas") {
		x, ok, err := s.db.FindItsa(ctx, ref)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, Errorf(http.StatusNotFound, "no ITSA %s", ref)
		}
		itsaIDs = append(itsaIDs, x.Text("id"))
	}
	agentIDs := []string{}
	for _, ref := range list("agents") {
		a, err := s.db.GetAgent(ctx, ref)
		switch {
		case err == nil:
			agentIDs = append(agentIDs, a.ID)
			continue
		case !errors.Is(err, db.ErrNotFound):
			return nil, err
		}
		p, ok, err := s.db.FindPeerAgent(ctx, ref)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, Errorf(http.StatusNotFound, "no agent %s", ref)
		}
		agentIDs = append(agentIDs, p.ID)
	}
	if len(itsaIDs) == 0 && len(agentIDs) == 0 {
		return nil, Errorf(http.StatusBadRequest, "itsas or agents is required")
	}
	added, err := s.db.AttachToMail(ctx, id, itsaIDs, agentIDs, by)
	if err != nil {
		return nil, err
	}
	attached := jsfmt.Value{Kind: jsfmt.Object}
	attached.Set("itsas", jsfmt.ArrayValue(stringValues(itsaIDs)))
	attached.Set("agents", jsfmt.ArrayValue(stringValues(added)))
	out := jsfmt.Value{Kind: jsfmt.Object}
	out.Set("attached", attached)
	return out, nil
}
