package db

import "context"

// HealthDB is the deploy watcher's DB sample (src/daemon.ts GET /api/health/db, S-474): one SELECT 1 and the count of
// agents.
func (d *DB) HealthDB(ctx context.Context) (int, error) {
	if err := d.read(ctx, "SELECT 1 AS one", func(*cols) {}); err != nil {
		return 0, wrap("health db", err)
	}
	n := 0
	err := d.read(ctx, "SELECT COUNT(*) AS n FROM agents", func(c *cols) { n = c.int() })
	return n, wrap("health db", err)
}

// CacheTTL is an agent's latest detected cache window and when it was recorded (src/cache-cold.ts TTL_AGENTS_SQL).
type CacheTTL struct {
	TTL *string
	TS  string
}

// CacheTTLs is each agent's latest cache:ttl event, by agent id (src/cache-panel.ts localCacheAgents).
func (d *DB) CacheTTLs(ctx context.Context) (map[string]CacheTTL, error) {
	out := map[string]CacheTTL{}
	err := d.read(ctx, "SELECT agent_id, json_extract(data, '$.ttl') AS ttl, ts FROM events WHERE id IN (SELECT MAX(id) FROM events WHERE type = 'cache:ttl' GROUP BY agent_id)",
		func(c *cols) {
			id := c.text()
			out[id] = CacheTTL{TTL: c.nullText(), TS: c.text()}
		})
	return out, wrap("cache ttls", err)
}
