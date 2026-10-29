package db

import "context"

// The reads behind src/activity-stats.ts measuredEffort (S-227): an agent's activity items and the ITSA status and
// owner moves its review-fix windows come from.

// EffortItem is one activity item's kind, category (nil when NULL) and span.
type EffortItem struct {
	Kind       string
	Category   *string
	Start, End string
}

// The bounds of EffortItems over an agent's whole life.
const (
	EffortSince = "0000-01-01T00:00:00.000Z"
	EffortUntil = "9999-12-31T23:59:59.999Z"
)

// EffortItems is the agent's activity items but text that overlap [since, until) (ISO times).
func (d *DB) EffortItems(ctx context.Context, agent, since, until string) ([]EffortItem, error) {
	var out []EffortItem
	err := d.read(ctx, `SELECT kind, category, start, "end" FROM activity_items WHERE agent_id = ? AND kind != 'text' AND start < ? AND "end" > ?`, func(c *cols) {
		out = append(out, EffortItem{Kind: c.text(), Category: c.nullText(), Start: c.text(), End: c.text()})
	}, agent, until, since)
	return out, wrap("effort items", err)
}

// ItsaMove is one ITSA status or owner event.
type ItsaMove struct {
	ItsaID, TS, Type string
	Data             *string
}

// ItsaMoves is every ITSA status and owner event in order, and each ITSA's owner now (nil when none).
func (d *DB) ItsaMoves(ctx context.Context) ([]ItsaMove, map[string]*string, error) {
	owners := map[string]*string{}
	if err := d.read(ctx, "SELECT id, owner FROM itsas", func(c *cols) {
		id := c.text()
		owners[id] = c.nullText()
	}); err != nil {
		return nil, nil, wrap("itsa moves", err)
	}
	var out []ItsaMove
	err := d.read(ctx, "SELECT itsa_id, ts, type, data FROM itsa_events WHERE type IN ('status', 'owner') ORDER BY id", func(c *cols) {
		out = append(out, ItsaMove{ItsaID: c.text(), TS: c.text(), Type: c.text(), Data: c.nullText()})
	})
	return out, owners, wrap("itsa moves", err)
}
