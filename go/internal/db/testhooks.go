package db

import (
	"context"
	"fmt"
	"strings"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"

	"stam/internal/jsfmt"
)

// The raw reads and writes of the test routes (src/test-hooks.ts and the /api/test/* handlers in src/daemon.ts): a
// test shapes or reads state the API doesn't, so no e2e script opens stam.db. Only the server's /api/test/* routes and
// the startup seed of a test daemon call these; the statements are theirs, as in TS.

// TestExec runs one write statement in its own transaction and returns the rows it changed.
func (d *DB) TestExec(ctx context.Context, query string, args ...any) (int, error) {
	n := 0
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		if err := runSQL(conn, query, args...); err != nil {
			return err
		}
		n = conn.Changes()
		return nil
	})
	if err != nil {
		return 0, fmt.Errorf("db: test write: %w", err)
	}
	return n, nil
}

// TestScript runs statements with no arguments (a trigger's CREATE included) in one transaction.
func (d *DB) TestScript(ctx context.Context, script string) error {
	err := d.Write(ctx, func(conn *sqlite.Conn) error { return sqlitex.ExecuteScript(conn, script, nil) })
	if err != nil {
		return fmt.Errorf("db: test script: %w", err)
	}
	return nil
}

// TestTx runs fn's writes in one transaction: an error from it writes nothing (src/test-hooks.ts applyTestSeed).
func (d *DB) TestTx(ctx context.Context, fn func(exec func(query string, args ...any) (int, error)) error) error {
	return d.TestSeedTx(ctx, func(exec func(query string, args ...any) (int, error), _ func(string) (string, bool, error)) error {
		return fn(exec)
	})
}

// TestSeedTx is TestTx whose fn also resolves an agent ref (an id or a name) to its id inside the transaction, so it
// finds an agent the same transaction inserted (src/test-hooks.ts applyTestSeed's ref).
func (d *DB) TestSeedTx(ctx context.Context, fn func(exec func(query string, args ...any) (int, error), agentID func(ref string) (string, bool, error)) error) error {
	return d.Write(ctx, func(conn *sqlite.Conn) error {
		return fn(func(query string, args ...any) (int, error) {
			if err := runSQL(conn, query, args...); err != nil {
				return 0, err
			}
			return conn.Changes(), nil
		}, func(ref string) (string, bool, error) {
			ids, err := column(conn, "SELECT id FROM agents WHERE id = ? OR name = ?", ref, ref)
			if err != nil || len(ids) == 0 {
				return "", false, err
			}
			return ids[0], true, nil
		})
	})
}

// TestRows is a read's rows, named by its columns; a table that doesn't exist yet reads as no rows (src/test-hooks.ts
// rows).
func (d *DB) TestRows(ctx context.Context, query string, args ...any) ([]jsfmt.Value, error) {
	var out []jsfmt.Value
	err := d.Read(ctx, func(conn *sqlite.Conn) (err error) {
		out, err = rows(conn, query, args...)
		return err
	})
	if err != nil && strings.Contains(err.Error(), "no such table") {
		return []jsfmt.Value{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("db: test read: %w", err)
	}
	if out == nil {
		out = []jsfmt.Value{}
	}
	return out, nil
}

// CountCalls counts the database calls (each Read and Write, of every caller) until the returned stop is called, which
// returns the count (POST /api/test/statements). TS counts each statement execution on its handle; zombiezen's
// connection has no hook for that, so here each call counts once, however many statements it runs. A per-agent read
// made as its own call still counts once per agent, which is what test/e2e-agents-route.sh bounds; per-agent statements
// inside one call don't show.
func (d *DB) CountCalls() (stop func() int) {
	d.calls.Store(0)
	d.counting.Store(true)
	return func() int {
		d.counting.Store(false)
		return int(d.calls.Load())
	}
}

// WaitingWrites is how many Write calls are queued behind the one holding the writer: a caller counts from the moment
// it is in the queue, so a test that waits for it knows the call cannot be passed by a later one.
func (d *DB) WaitingWrites() int { return d.wlock.waiting() }

// count notes one call while CountCalls runs.
func (d *DB) count() {
	if d.counting.Load() {
		d.calls.Add(1)
	}
}
