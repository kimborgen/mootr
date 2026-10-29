package db

import (
	"context"
	"regexp"
	"strings"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"

	"stam/internal/jsfmt"
)

// The embedding index and the mail text search of src/db.ts (S-3735): the embeddings table (one vector per source item,
// a little-endian float32 blob), its counts and work lists, and searchMailText over mail_fts with LIKE as the fallback.

// Embedding is one row of the embeddings table.
type Embedding struct {
	Source, Ref, Model string
	Dim                int
	Vec                []byte
	Hash               string
}

// EmbeddingRow is the hash and model of an item's stored vector; ok false when it has none.
func (d *DB) EmbeddingRow(ctx context.Context, source, ref string) (hash, model string, ok bool, err error) {
	err = d.read(ctx, "SELECT hash, model FROM embeddings WHERE source = ? AND ref = ?", func(c *cols) {
		hash, model, ok = c.text(), c.text(), true
	}, source, ref)
	return hash, model, ok, wrap("embedding row", err)
}

// PutEmbeddings stores vectors in one transaction (src/db.ts putEmbedding inside vectors.ts's transaction).
func (d *DB) PutEmbeddings(ctx context.Context, rows []Embedding) error {
	at := now()
	return wrap("put embeddings", d.Write(ctx, func(conn *sqlite.Conn) error {
		for _, r := range rows {
			if err := sqlitex.Execute(conn, "INSERT OR REPLACE INTO embeddings (source, ref, model, dim, vec, hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				&sqlitex.ExecOptions{Args: []any{r.Source, r.Ref, r.Model, r.Dim, r.Vec, r.Hash, at}}); err != nil {
				return err
			}
		}
		return nil
	}))
}

// TouchEmbedding marks a stored vector current as of now: its text was checked and hasn't changed.
func (d *DB) TouchEmbedding(ctx context.Context, source, ref string) error {
	return wrap("touch embedding", d.Write(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "UPDATE embeddings SET updated_at = ? WHERE source = ? AND ref = ?", &sqlitex.ExecOptions{Args: []any{now(), source, ref}})
	}))
}

// DeleteEmbedding forgets an item's vector.
func (d *DB) DeleteEmbedding(ctx context.Context, source, ref string) error {
	return wrap("delete embedding", d.Write(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "DELETE FROM embeddings WHERE source = ? AND ref = ?", &sqlitex.ExecOptions{Args: []any{source, ref}})
	}))
}

// EmbeddingsOf is the vectors of one source made by one model.
func (d *DB) EmbeddingsOf(ctx context.Context, source, model string) ([]Embedding, error) {
	var out []Embedding
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT ref, dim, vec FROM embeddings WHERE source = ? AND model = ?", &sqlitex.ExecOptions{
			Args: []any{source, model}, ResultFunc: func(stmt *sqlite.Stmt) error {
				vec := make([]byte, stmt.ColumnLen(2))
				stmt.ColumnBytes(2, vec)
				out = append(out, Embedding{Source: source, Ref: stmt.ColumnText(0), Model: model, Dim: stmt.ColumnInt(1), Vec: vec})
				return nil
			}})
	})
	return out, wrap("embeddings", err)
}

// EmbeddingCount is how many rows a source has under a model.
type EmbeddingCount struct {
	Source, Model string
	N             int
}

// EmbeddingCounts is the rows per source and model, for `stam embedder status`.
func (d *DB) EmbeddingCounts(ctx context.Context) ([]EmbeddingCount, error) {
	var out []EmbeddingCount
	err := d.read(ctx, "SELECT source, model, COUNT(*) AS n FROM embeddings GROUP BY source, model", func(c *cols) {
		out = append(out, EmbeddingCount{Source: c.text(), Model: c.text(), N: c.int()})
	})
	return out, wrap("embedding counts", err)
}

func (d *DB) ids(ctx context.Context, what, query string, args ...any) ([]string, error) {
	var out []string
	err := d.read(ctx, query, func(c *cols) { out = append(out, c.text()) }, args...)
	return out, wrap(what, err)
}

// MailToEmbed is the mail with no vector from model yet, newest first: the backfill's work list.
func (d *DB) MailToEmbed(ctx context.Context, model string, limit int) ([]string, error) {
	return d.ids(ctx, "mail to embed", `SELECT m.id FROM mail m LEFT JOIN embeddings e ON e.source = 'mail' AND e.ref = m.id
       WHERE e.ref IS NULL OR e.model != ? ORDER BY m.created_at DESC LIMIT ?`, model, limit)
}

// ItsasToEmbed is the ITSAs with no vector from model, or one updated since its vector was last checked, newest first
// (src/itsa-vectors.ts pendingItsas).
func (d *DB) ItsasToEmbed(ctx context.Context, model string, limit int) ([]string, error) {
	return d.ids(ctx, "itsas to embed", `SELECT i.id FROM itsas i LEFT JOIN embeddings e ON e.source = 'itsa' AND e.ref = i.id
       WHERE e.ref IS NULL OR e.model != ? OR i.updated_at > e.updated_at
       ORDER BY i.created_at DESC LIMIT ?`, model, limit)
}

// MailText is a stored mail's subject and body; ok false when there is no such mail.
func (d *DB) MailText(ctx context.Context, id string) (subject, body string, ok bool, err error) {
	err = d.read(ctx, "SELECT subject, body FROM mail WHERE id = ?", func(c *cols) { subject, body, ok = c.text(), c.text(), true }, id)
	return subject, body, ok, wrap("mail text", err)
}

var reFtsWord = regexp.MustCompile(`[\p{L}\p{N}_]+`)

// ftsQuery is src/db.ts ftsQuery: each word as a quoted prefix, so punctuation and FTS operators can't be read as query
// syntax. Empty when there is no word.
func ftsQuery(q string) string {
	words := reFtsWord.FindAllString(strings.ToLower(q), -1)
	for i, w := range words {
		words[i] = `"` + w + `"*`
	}
	return strings.Join(words, " ")
}

// mailIn is the scope of a mailbox: what it sent or received, and the threads it may read beyond them.
const mailIn = "(m.from_id = ? OR EXISTS (SELECT 1 FROM mail_recipients r WHERE r.mail_id = m.id AND r.agent_id = ?) OR m.thread_id IN (SELECT value FROM json_each(?)))"

// SearchMailText is src/db.ts searchMailText: the mail whose subject or body matches q, in box's scope and the threads
// given. FTS5 ranks by bm25; a query it can't read, or a database without mail_fts, falls back to LIKE, newest first.
// Each row is the mail's columns.
func (d *DB) SearchMailText(ctx context.Context, q, box string, limit int, threads []string) ([]jsfmt.Value, error) {
	tj := jsfmt.Compact(stringArray(threads))
	var out []jsfmt.Value
	if match := ftsQuery(q); match != "" {
		err := d.Read(ctx, func(conn *sqlite.Conn) error {
			var err error
			out, err = rows(conn, `SELECT m.* FROM mail_fts f JOIN mail m ON m.rowid = f.rowid
           WHERE mail_fts MATCH ? AND `+mailIn+` ORDER BY bm25(mail_fts) LIMIT ?`, match, box, box, tj, limit)
			return err
		})
		if err == nil {
			return out, nil
		}
		if ctx.Err() != nil {
			return nil, wrap("search mail", err)
		}
	}
	like := "%" + q + "%"
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		var err error
		out, err = rows(conn, `SELECT m.* FROM mail m WHERE (m.subject LIKE ? OR m.body LIKE ?) AND `+mailIn+` ORDER BY m.created_at DESC LIMIT ?`,
			like, like, box, box, tj, limit)
		return err
	})
	return out, wrap("search mail", err)
}

// ScopedMail is a mail a mailbox may read, and its thread.
type ScopedMail struct{ ID, Thread string }

// MailScope is src/db.ts mailScope: the mail a mailbox may read, its own and that of the threads given.
func (d *DB) MailScope(ctx context.Context, box string, threads []string) ([]ScopedMail, error) {
	var out []ScopedMail
	err := d.read(ctx, "SELECT m.id, COALESCE(m.thread_id, m.id) AS thread FROM mail m WHERE "+mailIn, func(c *cols) {
		out = append(out, ScopedMail{ID: c.text(), Thread: c.text()})
	}, box, box, jsfmt.Compact(stringArray(threads)))
	return out, wrap("mail scope", err)
}

func stringArray(ss []string) jsfmt.Value {
	items := make([]jsfmt.Value, len(ss))
	for i, s := range ss {
		items[i] = jsfmt.StringValue(s)
	}
	return jsfmt.ArrayValue(items)
}
