package events

import (
	"context"

	"stam/internal/db"
)

// IngestAndStoreUnder is IngestAndStore for a row under a watched subject (a Linear team's issue or cursor): the events and the
// row `subject` are stored in one transaction, only if `watched` is watched when it begins (db.PollApplyUnder). ins may be empty.
func (s *Service) IngestAndStoreUnder(ctx context.Context, watched, subject string, ins []Input, state, etags string) (stored int, written bool, err error) {
	evs := make([]db.PollEvent, 0, len(ins))
	for _, in := range ins {
		row, hooks, err := s.prepare(in)
		if err != nil {
			return 0, false, err
		}
		evs = append(evs, db.PollEvent{In: row, Hooks: hooks})
	}
	t := s.o.Now()
	outs, written, err := s.o.DB.PollApplyUnder(ctx, watched, subject, evs, state, etags, t.UTC().Format("2006-01-02T15:04:05.000Z"), t.UnixMilli(), SubjectsOf)
	if err != nil {
		return 0, false, err
	}
	for _, out := range outs {
		if out.Stored {
			stored++
			s.afterIngest(ctx, out)
		}
	}
	return stored, written, nil
}
