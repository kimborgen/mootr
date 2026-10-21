package db

import (
	"context"
	"fmt"
	"regexp"
	"strconv"

	"zombiezen.com/go/sqlite"

	"stam/internal/jsfmt"
)

// The link writes of src/itsa.ts (S-2849, PR 2): addLink, removeLink and recordLink, each one transaction.

// NotPorted is a write this daemon does not do yet, found inside the transaction that would make it: the route answers
// 501 and nothing is written.
type NotPorted struct{ Msg string }

func (e *NotPorted) Error() string { return e.Msg }

var (
	reGitHubURL = regexp.MustCompile(`^https?://github\.com/([^/\s\p{Z}\x{feff}]+)/([^/\s\p{Z}\x{feff}]+)/(?:pull|issues)/(\d+)(?:[/?#][^\n\r\x{2028}\x{2029}]*)?$`)
	reLinearURL = regexp.MustCompile(`^https?://linear\.app/[^/\s\p{Z}\x{feff}]+/issue/([A-Za-z][A-Za-z0-9]*-\d+)(?:[/?#][^\n\r\x{2028}\x{2029}]*)?$`)
)

// WatchedURL is whether src/watch.ts subjectsForUrl names a subject for a link's URL: a GitHub pull request or issue, or a
// Linear issue. An ITSA with such a link has a watch on it (watch.syncItsa), which this daemon does not keep.
func WatchedURL(url string) bool {
	u := jsTrim(url)
	return reGitHubURL.MatchString(u) || reLinearURL.MatchString(u)
}

const watchNotPorted = "a link to a GitHub or Linear pull request or issue starts the ITSA's watch on it (watch.syncItsa), which is not ported to the Go daemon yet"

// HasWatchedLink is whether any link of the ITSA names a subject: closing or reopening it would change its watches.
func (t ItsaTx) HasWatchedLink(id string) (bool, error) {
	urls, err := column(t.conn, "SELECT url FROM itsa_links WHERE itsa_id = ?", id)
	for _, u := range urls {
		if WatchedURL(u) {
			return true, nil
		}
	}
	return false, err
}

// inItsa finds the ITSA a ref names and runs fn on it inside one write transaction. An error from fn, or a missing ITSA,
// is the caller's to read as it is, not a database failure to wrap.
func (d *DB) inItsa(ctx context.Context, ref string, fn func(conn *sqlite.Conn, x jsfmt.Value) (jsfmt.Value, error)) (jsfmt.Value, error) {
	var out jsfmt.Value
	var refused error
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		x, ok, err := ItsaTx{conn}.Find(ref)
		if err != nil {
			return err
		}
		if !ok {
			refused = fmt.Errorf("no ITSA %s", ref)
			return refused
		}
		if out, err = fn(conn, x); err != nil {
			refused = err
			return err
		}
		return nil
	})
	if refused != nil {
		return jsfmt.Value{}, refused
	}
	return out, wrap("ITSA link", err)
}

// NewLink is a link, validated: its kind, the branch or id it names, its url, and the meta JSON a branch link carries.
type NewLink struct {
	System, URL string
	ExternalID  *string
	// Repo is a branch link's repo; it is stored as {"repo": ...} in meta.
	Repo string
}

func linkRow(n int64, system string, external *string, url string, meta jsfmt.Value) jsfmt.Value {
	o := jsfmt.Value{Kind: jsfmt.Object}
	o.Set("n", jsfmt.IntValue(n))
	o.Set("system", jsfmt.StringValue(system))
	if external == nil {
		o.Set("external_id", jsfmt.NullValue())
	} else {
		o.Set("external_id", jsfmt.StringValue(*external))
	}
	o.Set("url", jsfmt.StringValue(url))
	o.Set("meta", meta)
	return o
}

func nextLinkN(conn *sqlite.Conn, itsaID string) (int64, error) {
	found, err := rows(conn, "SELECT MAX(n) AS n FROM itsa_links WHERE itsa_id = ?", itsaID)
	if err != nil || len(found) == 0 {
		return 1, err
	}
	v, _ := found[0].Get("n")
	if v.Kind == jsfmt.Null {
		return 1, nil
	}
	n, _ := strconv.ParseInt(v.Num, 10, 64)
	return n + 1, nil
}

// insertLink is itsa.ts addLinkRow: the next link of an ITSA, as the API shows it.
func insertLink(conn *sqlite.Conn, itsaID string, l NewLink) (jsfmt.Value, error) {
	if WatchedURL(l.URL) {
		return jsfmt.Value{}, &NotPorted{watchNotPorted}
	}
	n, err := nextLinkN(conn, itsaID)
	if err != nil {
		return jsfmt.Value{}, err
	}
	meta := jsfmt.NullValue()
	var metaText any
	if l.Repo != "" {
		meta = jsfmt.Value{Kind: jsfmt.Object}
		meta.Set("repo", jsfmt.StringValue(l.Repo))
		metaText = jsfmt.Compact(meta)
	}
	var ext any
	if l.ExternalID != nil {
		ext = *l.ExternalID
	}
	if err := runSQL(conn, "INSERT INTO itsa_links (itsa_id, n, system, external_id, url, meta) VALUES (?, ?, ?, ?, ?, ?)", itsaID, n, l.System, ext, l.URL, metaText); err != nil {
		return jsfmt.Value{}, err
	}
	return linkRow(n, l.System, l.ExternalID, l.URL, meta), nil
}

// AddItsaLink is itsa.addLink: the link and the ITSA after it.
func (d *DB) AddItsaLink(ctx context.Context, ref, actor string, l NewLink) (link, itsa jsfmt.Value, err error) {
	out, err := d.inItsa(ctx, ref, func(conn *sqlite.Conn, x jsfmt.Value) (jsfmt.Value, error) {
		row, err := insertLink(conn, x.Text("id"), l)
		if err != nil {
			return jsfmt.Value{}, err
		}
		if err := addItsaEvent(conn, x.Text("id"), actor, "link.added", &row); err != nil {
			return jsfmt.Value{}, err
		}
		found, err := rows(conn, "SELECT * FROM itsas WHERE id = ?", x.Text("id"))
		if err != nil || len(found) == 0 {
			return jsfmt.Value{}, err
		}
		res := jsfmt.Value{Kind: jsfmt.Object}
		res.Set("link", row)
		res.Set("itsa", found[0])
		return res, nil
	})
	if err != nil {
		return jsfmt.Value{}, jsfmt.Value{}, err
	}
	link, _ = out.Get("link")
	itsa, _ = out.Get("itsa")
	return link, itsa, nil
}

// RemoveItsaLink is itsa.removeLink: the ITSA after the link n is gone.
func (d *DB) RemoveItsaLink(ctx context.Context, ref string, n int64, actor string) (jsfmt.Value, error) {
	return d.inItsa(ctx, ref, func(conn *sqlite.Conn, x jsfmt.Value) (jsfmt.Value, error) {
		urls, err := column(conn, "SELECT url FROM itsa_links WHERE itsa_id = ? AND n = ?", x.Text("id"), n)
		if err != nil {
			return jsfmt.Value{}, err
		}
		if len(urls) > 0 && WatchedURL(urls[0]) {
			return jsfmt.Value{}, &NotPorted{watchNotPorted}
		}
		if err := runSQL(conn, "DELETE FROM itsa_links WHERE itsa_id = ? AND n = ?", x.Text("id"), n); err != nil {
			return jsfmt.Value{}, err
		}
		if conn.Changes() == 0 {
			return jsfmt.Value{}, fmt.Errorf("no link %d on %s", n, x.Text("key"))
		}
		ev := jsfmt.Value{Kind: jsfmt.Object}
		ev.Set("n", jsfmt.IntValue(n))
		if err := addItsaEvent(conn, x.Text("id"), actor, "link.removed", &ev); err != nil {
			return jsfmt.Value{}, err
		}
		found, err := rows(conn, "SELECT * FROM itsas WHERE id = ?", x.Text("id"))
		if err != nil || len(found) == 0 {
			return jsfmt.Value{}, err
		}
		return found[0], nil
	})
}

// RecordItsaLink is itsa.recordLink's transaction: it reads the branch link n and lets plan return its new meta from the
// old one (the key of its ITSA is given for messages); the stored link, as the API shows it, is returned.
func (d *DB) RecordItsaLink(ctx context.Context, ref string, n int64, plan func(tx ItsaTx, key string, system string, meta jsfmt.Value) (jsfmt.Value, error)) (jsfmt.Value, error) {
	return d.inItsa(ctx, ref, func(conn *sqlite.Conn, x jsfmt.Value) (jsfmt.Value, error) {
		found, err := rows(conn, "SELECT n, system, external_id, url, meta FROM itsa_links WHERE itsa_id = ? AND n = ?", x.Text("id"), n)
		if err != nil {
			return jsfmt.Value{}, err
		}
		if len(found) == 0 {
			return jsfmt.Value{}, fmt.Errorf("no link %d on %s", n, x.Text("key"))
		}
		row := found[0]
		meta := linkOut(row)
		m, _ := meta.Get("meta")
		next, err := plan(ItsaTx{conn}, x.Text("key"), row.Text("system"), m)
		if err != nil {
			return jsfmt.Value{}, err
		}
		if err := runSQL(conn, "UPDATE itsa_links SET meta = ? WHERE itsa_id = ? AND n = ?", jsfmt.Compact(next), x.Text("id"), n); err != nil {
			return jsfmt.Value{}, err
		}
		row.Set("meta", jsfmt.StringValue(jsfmt.Compact(next)))
		return linkOut(row), nil
	})
}

// HasAttachment is src/db.ts attachment: whether a mail has an attachment of this name.
func (t ItsaTx) HasAttachment(mailID, name string) (bool, error) {
	found, err := rows(t.conn, "SELECT 1 FROM attachments WHERE mail_id = ? AND name = ?", mailID, name)
	return len(found) > 0, err
}
