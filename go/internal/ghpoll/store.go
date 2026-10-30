package ghpoll

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
	// Svc stores the events with the snapshot.
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

func (s DBStore) Row(ctx context.Context, subject string) (db.WatchRow, bool, error) {
	return s.DB.WatchRow(ctx, subject)
}

func (s DBStore) Apply(ctx context.Context, subject string, evs []events.Input, state, etags string) (int, bool, error) {
	return s.Svc.IngestAndStore(ctx, subject, evs, state, etags)
}

func (s DBStore) StateSubjects(ctx context.Context) ([]string, error) {
	return s.DB.WatchStateSubjects(ctx, "github:")
}

func (s DBStore) Drop(ctx context.Context, subjects []string, olderThan time.Time) ([]string, error) {
	return s.DB.DropUnwatchedState(ctx, subjects, s.now().UnixMilli(), olderThan.UTC().Format("2006-01-02T15:04:05.000Z"), subjectsOf)
}
