package linearpoll

import (
	"context"
	"sort"
	"time"

	"stam/internal/db"
	"stam/internal/events"
)

// DBStore is the Store on the daemon's database: watch_state for the rows, the subscriptions and event waits for who watches.
type DBStore struct {
	DB *db.DB
	// Svc stores the events with the row.
	Svc *events.Service
	Now func() time.Time
}

func (s DBStore) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

var subjectsOf = events.SubjectsOf

func (s DBStore) Watched(ctx context.Context) ([]string, error) {
	m, err := s.DB.WatchedSubjects(ctx, s.now().UnixMilli(), subjectsOf)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out, nil
}

func (s DBStore) Row(ctx context.Context, subject string) (Row, bool, error) {
	r, ok, err := s.DB.WatchRow(ctx, subject)
	return Row{State: r.State, UpdatedAt: r.UpdatedAt}, ok, err
}

// Apply stores the events and the row (with empty ETags, {}, as TS stores them for Linear) in one transaction, unless nobody
// watches `watched`.
func (s DBStore) Apply(ctx context.Context, watched, subject string, evs []events.Input, state string) (int, bool, error) {
	return s.Svc.IngestAndStoreUnder(ctx, watched, subject, evs, state, "{}")
}

func (s DBStore) StateSubjects(ctx context.Context, prefix string) ([]string, error) {
	return s.DB.WatchStateSubjects(ctx, prefix)
}

func (s DBStore) DropTree(ctx context.Context, subjects []string, olderThan time.Time) error {
	_, err := s.DB.DropUnwatchedTree(ctx, subjects, s.now().UnixMilli(), olderThan.UTC().Format("2006-01-02T15:04:05.000Z"), subjectsOf)
	return err
}
