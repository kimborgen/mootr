package db

import (
	"context"
	"encoding/json"
)

// The reads src/attribution.ts makes (S-2848 B5c): window readings around a range, an account's token samples, a
// window's last reset time, and the remembered peer agents' children.

// WindowReading is one window_readings row: its time (ISO), percentage (nil when null) and reset time (Unix seconds,
// nil when null).
type WindowReading struct {
	At       string
	Used     *float64
	ResetsAt *float64
}

// WindowReadingsAround is attribution.ts readings' two queries: the last reading with a percentage before from, as
// context for the outlier test on the first, then every reading from from to until (ISO times, both inclusive), oldest
// first.
func (d *DB) WindowReadingsAround(ctx context.Context, name, window, from, until string) ([]WindowReading, error) {
	const q = "SELECT at, used_percentage, resets_at FROM window_readings WHERE name = ? AND window = ?"
	var out []WindowReading
	row := func(c *cols) {
		r := WindowReading{At: c.text()}
		if i := c.next(); !c.stmt.ColumnIsNull(i) {
			v := c.stmt.ColumnFloat(i)
			r.Used = &v
		}
		if i := c.next(); !c.stmt.ColumnIsNull(i) {
			v := c.stmt.ColumnFloat(i)
			r.ResetsAt = &v
		}
		out = append(out, r)
	}
	if err := d.read(ctx, q+" AND at < ? AND used_percentage IS NOT NULL ORDER BY at DESC LIMIT 1", row, name, window, from); err != nil {
		return nil, wrap("window readings", err)
	}
	return out, wrap("window readings", d.read(ctx, q+" AND at >= ? AND at <= ? ORDER BY at", row, name, window, from, until))
}

// TokenSample is one usage_samples row's bucket (ISO), agent, model and four token counts.
type TokenSample struct {
	Bucket, AgentID, Model string
	In, Out, CacheRead     float64
	CacheWrite             float64
}

// TokenSamples is attribution.ts readWeightedSamples' query: an account's samples with a bucket from from (inclusive)
// to until (exclusive), by bucket.
func (d *DB) TokenSamples(ctx context.Context, account, from, until string) ([]TokenSample, error) {
	var out []TokenSample
	err := d.read(ctx, "SELECT bucket, agent_id, model, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write FROM usage_samples WHERE account = ? AND bucket >= ? AND bucket < ? ORDER BY bucket",
		func(c *cols) {
			out = append(out, TokenSample{Bucket: c.text(), AgentID: c.text(), Model: c.text(), In: c.stmt.ColumnFloat(3), Out: c.stmt.ColumnFloat(4),
				CacheRead: c.stmt.ColumnFloat(5), CacheWrite: c.stmt.ColumnFloat(6)})
		}, account, from, until)
	return out, wrap("token samples", err)
}

// LastResetsAt is attribution.ts windowStart's query: the reset time of the window's latest reading, nil when there is
// no reading or its reset time is null.
func (d *DB) LastResetsAt(ctx context.Context, name, window string) (*float64, error) {
	var out *float64
	err := d.read(ctx, "SELECT resets_at FROM window_readings WHERE name = ? AND window = ? ORDER BY at DESC LIMIT 1", func(c *cols) {
		if !c.stmt.ColumnIsNull(0) {
			v := c.stmt.ColumnFloat(0)
			out = &v
		}
	}, name, window)
	return out, wrap("last resets_at", err)
}

// HasWindowReading is src/cost-notices.ts shareLine's check: whether the window has any reading.
func (d *DB) HasWindowReading(ctx context.Context, name, window string) (bool, error) {
	has := false
	err := d.read(ctx, "SELECT 1 FROM window_readings WHERE name = ? AND window = ? LIMIT 1", func(*cols) { has = true }, name, window)
	return has, wrap("window reading", err)
}

// PeerChildrenOf is src/db.ts peerChildrenOf: the remembered peer agents that list id as a parent.
func (d *DB) PeerChildrenOf(ctx context.Context, id string) ([]string, error) {
	var out []string
	err := d.read(ctx, "SELECT id, parents FROM peer_agents WHERE parents IS NOT NULL", func(c *cols) {
		child := c.text()
		var parents []string
		if json.Unmarshal([]byte(c.text()), &parents) != nil {
			return
		}
		for _, p := range parents {
			if p == id {
				out = append(out, child)
			}
		}
	})
	return out, wrap("peer children", err)
}

// DayRow is one usage row's agent and cost.
type DayRow struct {
	AgentID string
	Cost    float64
}

// DaySpend is src/usage.ts checkDailySpend's two queries: the day's total agent spend, and its top rows by cost.
func (d *DB) DaySpend(ctx context.Context, day string, top int) (float64, []DayRow, error) {
	total := 0.0
	if err := d.read(ctx, "SELECT SUM(cost_usd) AS s FROM usage WHERE day = ?", func(c *cols) { total = c.stmt.ColumnFloat(0) }, day); err != nil {
		return 0, nil, wrap("day spend", err)
	}
	var rows []DayRow
	err := d.read(ctx, "SELECT agent_id, cost_usd FROM usage WHERE day = ? ORDER BY cost_usd DESC LIMIT ?", func(c *cols) {
		rows = append(rows, DayRow{AgentID: c.text(), Cost: c.stmt.ColumnFloat(1)})
	}, day, top)
	return total, rows, wrap("day spend", err)
}
