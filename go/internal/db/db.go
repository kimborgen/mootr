// Package db opens the stam.db the TS daemon writes (src/db.ts) and reads and writes it as is (S-2613).
//
// It runs no schema change: no table, index, column or user_version is created or altered, so a rollback to the TS
// daemon finds the file as it left it. A database with a newer user_version than SchemaVersion is refused.
//
// Connections: one writer and a pool of readers, every one with busy_timeout 5000 and synchronous=NORMAL, so a write
// lock held by another process (the TS daemon during the migration) makes them wait rather than fail.
package db

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// SchemaVersion is the newest user_version this package knows: 1, set by the TS daemon since S-2243. A database
// from before that has 0, which reads the same.
const SchemaVersion = 1

// BusyTimeout is how long a connection waits for another connection's lock before it fails with SQLITE_BUSY.
const BusyTimeout = 5 * time.Second

// DefaultReaders is the reader pool's size when Options.Readers is 0.
const DefaultReaders = 4

// ErrNotFound is returned by a lookup that matched no row.
var ErrNotFound = errors.New("db: not found")

// ErrNewerSchema is returned by Open for a database a newer stamd wrote.
var ErrNewerSchema = errors.New("db: newer schema")

// ErrClosed is returned by Read and Write after Close.
var ErrClosed = errors.New("db: closed")

// Options tunes Open.
type Options struct {
	// Readers is the number of pooled read connections (DefaultReaders when 0).
	Readers int
}

// DB is an open stam.db: one writer connection and a pool of readers. It is safe for concurrent use.
type DB struct {
	path   string
	writer *sqlitex.Pool
	// wlock queues the callers of Write in order, and counts the ones waiting (WaitingWrites).
	wlock   writeLock
	readers *sqlitex.Pool
	closed  atomic.Bool

	observer atomic.Pointer[AgentObserver]
	// changed is the agents the running write changed (noteChanged), told to the observer once it commits; only the
	// writer connection's holder touches it.
	changed []agentChange
	// activity is the org observer (ObserveActivity), and activityChanges what the running write recorded for it
	// (noteActivity); only the writer connection's holder touches activityChanges.
	activity        atomic.Pointer[ActivityObserver]
	activityChanges []ActivityChange
	// peersSeen is what each remembered peer agent was last written as (RememberPeerAgent), so an unchanged one is not
	// written again.
	peersMu   sync.Mutex
	peersSeen map[string]string
	// counting and calls are CountCalls' count of Read and Write calls (testhooks.go).
	counting atomic.Bool
	calls    atomic.Int64
}

// AgentObserver hears an agent whose lifecycle or activity changed, once the write commits (src/db.ts updateAgent's
// live-stream calls): archived when its lifecycle changed to archived. It runs on the writer's goroutine and must not
// block.
type AgentObserver func(id string, archived bool)

type agentChange struct {
	id       string
	archived bool
}

// ObserveAgents sets the agent observer (stamd sets the live stream's); nil removes it.
func (d *DB) ObserveAgents(fn AgentObserver) {
	if fn == nil {
		d.observer.Store(nil)
		return
	}
	d.observer.Store(&fn)
}

// noteChanged records, inside a write, that the agent's lifecycle or activity changed.
func (d *DB) noteChanged(id string, archived bool) {
	d.changed = append(d.changed, agentChange{id, archived})
}

// The columns the typed queries read. Open refuses a database that lacks one, rather than fail on the first query.
var required = map[string][]string{
	"agents": agentColumns,
	"events": eventColumns,
	// S-3015: when a participant left an ITSA. The TS daemon adds it when it opens the file.
	"itsa_participants": {"itsa_id", "agent_id", "left_at"},
	// S-3233: a field's kinds (S-3180). The TS daemon adds it when it opens the file, so one last opened by a TS daemon older than bbcb08f9
	// lacks it, and every ITSA read would fail.
	"itsa_fields": {"kinds"},
}

// Open opens the stam.db at path, which must exist: a missing file is an error, never a new database.
func Open(ctx context.Context, path string, opts Options) (_ *DB, err error) {
	if _, err := os.Stat(path); err != nil {
		return nil, fmt.Errorf("db: open %s: %w", path, err)
	}
	readers := opts.Readers
	if readers <= 0 {
		readers = DefaultReaders
	}
	// No OpenCreate: a path that vanished between the stat and here fails instead of making an empty file. No
	// OpenWAL: the writer sets the journal mode itself, after its busy timeout is in place.
	const flags = sqlite.OpenReadWrite | sqlite.OpenNoMutex
	d := &DB{path: path}
	defer func() {
		if err != nil {
			d.Close()
		}
	}()
	d.writer, err = sqlitex.NewPool(path, sqlitex.PoolOptions{Flags: flags, PoolSize: 1, PrepareConn: prepare(false)})
	if err != nil {
		return nil, fmt.Errorf("db: open writer: %w", err)
	}
	if err := d.check(ctx); err != nil {
		return nil, err
	}
	d.readers, err = sqlitex.NewPool(path, sqlitex.PoolOptions{Flags: flags, PoolSize: readers, PrepareConn: prepare(true)})
	if err != nil {
		return nil, fmt.Errorf("db: open readers: %w", err)
	}
	return d, nil
}

// prepare sets up every connection the way src/db.ts open() sets up its own (S-2122's mmap_size and cache_size
// included).
// Readers are query_only, so a write sent to the wrong pool fails instead of bypassing the single writer.
func prepare(reader bool) sqlitex.ConnPrepareFunc {
	return func(conn *sqlite.Conn) error {
		conn.SetBusyTimeout(BusyTimeout)
		pragmas := []string{"PRAGMA synchronous = NORMAL", "PRAGMA mmap_size = 536870912", "PRAGMA cache_size = -65536"}
		if reader {
			pragmas = append(pragmas, "PRAGMA query_only = 1")
		}
		// One at a time: ExecuteScript wraps a savepoint around them, and synchronous can't change inside one.
		for _, p := range pragmas {
			if err := sqlitex.ExecuteTransient(conn, p, nil); err != nil {
				return fmt.Errorf("db: %s: %w", p, err)
			}
		}
		return nil
	}
}

// check runs on the writer before any query: WAL, a known user_version, and the tables and columns the typed
// queries read.
func (d *DB) check(ctx context.Context) error {
	conn, err := d.writer.Take(ctx)
	if err != nil {
		return err
	}
	defer d.writer.Put(conn)
	// The TS daemon already left the file in WAL mode; this only matters for a file it never opened, and changes
	// the journal mode, not the schema.
	var mode string
	if err := sqlitex.Execute(conn, "PRAGMA journal_mode = WAL", &sqlitex.ExecOptions{ResultFunc: func(stmt *sqlite.Stmt) error {
		mode = stmt.ColumnText(0)
		return nil
	}}); err != nil {
		return fmt.Errorf("db: journal_mode: %w", err)
	}
	if mode != "wal" {
		return fmt.Errorf("db: %s stays in journal mode %q, want wal", d.path, mode)
	}
	version, err := intPragma(conn, "user_version")
	if err != nil {
		return err
	}
	if version > SchemaVersion {
		return fmt.Errorf("%w: %s has user_version %d, and this stamd knows up to %d: run a newer stamd", ErrNewerSchema, d.path, version, SchemaVersion)
	}
	for table, cols := range required {
		have := map[string]bool{}
		if err := sqlitex.Execute(conn, "SELECT name FROM pragma_table_info(?)", &sqlitex.ExecOptions{
			Args: []any{table},
			ResultFunc: func(stmt *sqlite.Stmt) error {
				have[stmt.ColumnText(0)] = true
				return nil
			},
		}); err != nil {
			return fmt.Errorf("db: table_info(%s): %w", table, err)
		}
		if len(have) == 0 {
			return fmt.Errorf("db: %s has no %s table: not a stam.db the TS daemon opened", d.path, table)
		}
		var missing []string
		for _, c := range cols {
			if !have[c] {
				missing = append(missing, c)
			}
		}
		if len(missing) > 0 {
			return fmt.Errorf("db: %s.%s lacks columns %s: open it with the TS daemon first", d.path, table, strings.Join(missing, ", "))
		}
	}
	return nil
}

func intPragma(conn *sqlite.Conn, name string) (int, error) {
	n, err := sqlitex.ResultInt(conn.Prep("PRAGMA " + name))
	if err != nil {
		return 0, fmt.Errorf("db: %s: %w", name, err)
	}
	return n, nil
}

// Read runs fn on a pooled read connection. fn must not keep conn after it returns.
func (d *DB) Read(ctx context.Context, fn func(conn *sqlite.Conn) error) error {
	if d.closed.Load() {
		return ErrClosed
	}
	d.count()
	conn, err := d.readers.Take(ctx)
	if err != nil {
		return err
	}
	defer d.readers.Put(conn)
	return fn(conn)
}

// Write runs fn on the writer connection inside one IMMEDIATE transaction: everything fn writes commits together, or
// nothing does when it returns an error. The transaction takes the write lock up front, so a lock another process
// holds is waited for (up to BusyTimeout) at the start, never failed on mid-transaction.
func (d *DB) Write(ctx context.Context, fn func(conn *sqlite.Conn) error) (err error) {
	if d.closed.Load() {
		return ErrClosed
	}
	d.count()
	if err := d.wlock.lock(ctx); err != nil {
		return err
	}
	conn, err := d.writer.Take(ctx)
	if err != nil {
		d.wlock.unlock()
		return err
	}
	// The connection goes back even when fn panics, so a panic never leaves every later Write waiting for it; the
	// changes are taken first, while the connection is still this write's.
	var changed []agentChange
	err = func() (err error) {
		defer func() {
			d.writer.Put(conn)
			d.wlock.unlock()
		}()
		d.changed, d.activityChanges = nil, nil
		// The activity observer hears a committed write's changes before the writer connection goes back, so writes
		// reach it in commit order; it only queues them (ActivityObserver).
		defer func() {
			var activity []ActivityChange
			changed, d.changed, activity, d.activityChanges = d.changed, nil, d.activityChanges, nil
			if r := recover(); r != nil {
				panic(r)
			}
			if obs := d.activity.Load(); obs != nil && err == nil {
				for _, c := range activity {
					(*obs)(ctx, c)
				}
			}
		}()
		end, err := sqlitex.ImmediateTransaction(conn)
		if err != nil {
			return fmt.Errorf("db: begin: %w", err)
		}
		defer end(&err)
		return fn(conn)
	}()
	if obs := d.observer.Load(); obs != nil && err == nil {
		for _, c := range changed {
			(*obs)(c.id, c.archived)
		}
	}
	return err
}

// Close closes every connection, readers first, so the writer is the last one out: SQLite then checkpoints the WAL
// and removes the -wal and -shm files, and a restart finds no stale ones. A connection in use has its statement
// interrupted (sqlitex.Pool.Close cancels it), and Close waits until its Read or Write returns it. Later calls to
// Read and Write fail with ErrClosed (a call racing Close fails with the pool's "pool closed" error); a second Close
// does nothing.
func (d *DB) Close() error {
	if d.closed.Swap(true) {
		return nil
	}
	var errs []error
	if d.readers != nil {
		errs = append(errs, d.readers.Close())
	}
	if d.writer != nil {
		errs = append(errs, d.writer.Close())
	}
	return errors.Join(errs...)
}

// now is the TS daemon's timestamp format (new Date().toISOString()), so rows sort the same whoever wrote them.
func now() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}
