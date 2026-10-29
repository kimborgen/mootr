package db

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"

	"stam/internal/api"
)

// Agent is one agents row (src/db.ts Agent). The JSON tags are the column names, which are the api Agent's field
// names; JSON columns stay the strings the api sends (x-legacy in api/schemas/Agent.yaml), with typed decoders below.
type Agent struct {
	ID                    string                     `json:"id"`
	Name                  string                     `json:"name"`
	Role                  string                     `json:"role"`
	Machine               string                     `json:"machine"`
	Harness               string                     `json:"harness"`
	Model                 *string                    `json:"model"`
	Effort                *string                    `json:"effort"`
	Cwd                   string                     `json:"cwd"`
	ParentID              *string                    `json:"parent_id"`
	SessionID             *string                    `json:"session_id"`
	TranscriptPath        *string                    `json:"transcript_path"`
	Lifecycle             api.AgentLifecycle         `json:"lifecycle"`
	Activity              api.AgentActivity          `json:"activity"`
	ActivityDetail        *string                    `json:"activity_detail"`
	ContextTokens         *int                       `json:"context_tokens"`
	ContextWindow         *int                       `json:"context_window"`
	Workspace             *string                    `json:"workspace"`
	PersonalWorkspace     *string                    `json:"personal_workspace"`
	Standing              api.AgentStanding          `json:"standing"`
	PendingAction         *string                    `json:"pending_action"`
	IdleSince             *string                    `json:"idle_since"`
	IdleNotified          *string                    `json:"idle_notified"`
	ContextLevel          int                        `json:"context_level"`
	TokensAfterCompaction *int                       `json:"tokens_after_compaction"`
	Capabilities          *string                    `json:"capabilities"`
	PermissionMode        api.AgentPermissionMode    `json:"permission_mode"`
	PermissionSource      *api.AgentPermissionSource `json:"permission_source"`
	Visibility            *string                    `json:"visibility"`
	ChildNotices          *api.AgentChildNotices     `json:"child_notices"`
	LastMessage           *string                    `json:"last_message"`
	FirstPrompt           *string                    `json:"first_prompt"`
	UsageLast             *string                    `json:"usage_last"`
	Kind                  *string                    `json:"kind"`
	Type                  *string                    `json:"type"`
	PausedBy              *string                    `json:"paused_by"`
	ForwardedTo           *string                    `json:"forwarded_to"`
	LaunchedAt            *string                    `json:"launched_at"`
	ResumedAt             *string                    `json:"resumed_at"`
	// TokenHash is the sha256 of the agent's launch token (src/agent-token.ts). The api never sends it (S-2519), so it
	// renders as redacted in JSON, fmt and slog.
	TokenHash *Secret `json:"-"`
	CreatedAt string  `json:"created_at"`
	UpdatedAt string  `json:"updated_at"`
}

// agentColumns is the select list, in Agent's field order (scanAgent reads it by position).
var agentColumns = []string{
	"id", "name", "role", "machine", "harness", "model", "effort", "cwd", "parent_id", "session_id", "transcript_path",
	"lifecycle", "activity", "activity_detail", "context_tokens", "context_window", "workspace", "personal_workspace",
	"standing", "pending_action", "idle_since", "idle_notified", "context_level", "tokens_after_compaction",
	"capabilities", "permission_mode", "permission_source", "visibility", "child_notices", "last_message",
	"first_prompt", "usage_last", "kind", "type", "paused_by", "forwarded_to", "launched_at", "resumed_at", "token_hash",
	"created_at", "updated_at",
}

var selectAgents = "SELECT " + strings.Join(agentColumns, ", ") + " FROM agents"

func scanAgent(stmt *sqlite.Stmt) Agent {
	c := cols{stmt: stmt}
	a := Agent{
		ID:                    c.text(),
		Name:                  c.text(),
		Role:                  c.text(),
		Machine:               c.text(),
		Harness:               c.text(),
		Model:                 c.nullText(),
		Effort:                c.nullText(),
		Cwd:                   c.text(),
		ParentID:              c.nullText(),
		SessionID:             c.nullText(),
		TranscriptPath:        c.nullText(),
		Lifecycle:             api.AgentLifecycle(c.text()),
		Activity:              api.AgentActivity(c.text()),
		ActivityDetail:        c.nullText(),
		ContextTokens:         c.nullInt(),
		ContextWindow:         c.nullInt(),
		Workspace:             c.nullText(),
		PersonalWorkspace:     c.nullText(),
		Standing:              api.AgentStanding(c.int()),
		PendingAction:         c.nullText(),
		IdleSince:             c.nullText(),
		IdleNotified:          c.nullText(),
		ContextLevel:          c.int(),
		TokensAfterCompaction: c.nullInt(),
		Capabilities:          c.nullText(),
		PermissionMode:        api.AgentPermissionMode(c.text()),
	}
	if s := c.nullText(); s != nil {
		v := api.AgentPermissionSource(*s)
		a.PermissionSource = &v
	}
	a.Visibility = c.nullText()
	if s := c.nullText(); s != nil {
		v := api.AgentChildNotices(*s)
		a.ChildNotices = &v
	}
	a.LastMessage = c.nullText()
	a.FirstPrompt = c.nullText()
	a.UsageLast = c.nullText()
	a.Kind = c.nullText()
	a.Type = c.nullText()
	a.PausedBy = c.nullText()
	a.ForwardedTo = c.nullText()
	a.LaunchedAt = c.nullText()
	a.ResumedAt = c.nullText()
	if s := c.nullText(); s != nil {
		v := Secret(*s)
		a.TokenHash = &v
	}
	a.CreatedAt = c.text()
	a.UpdatedAt = c.text()
	return a
}

// String names the agent without its columns, so a stray %v never prints a secret or a long prompt.
func (a Agent) String() string { return fmt.Sprintf("agent %s (%s)", a.ID, a.Name) }

// GoString is String for %#v.
func (a Agent) GoString() string { return a.String() }

// LogValue logs the agent's identity only.
func (a Agent) LogValue() slog.Value {
	return slog.GroupValue(slog.String("id", a.ID), slog.String("name", a.Name))
}

func (d *DB) queryAgents(ctx context.Context, where string, args ...any) ([]Agent, error) {
	var out []Agent
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, selectAgents+" "+where, &sqlitex.ExecOptions{
			Args: args,
			ResultFunc: func(stmt *sqlite.Stmt) error {
				out = append(out, scanAgent(stmt))
				return nil
			},
		})
	})
	if err != nil {
		return nil, fmt.Errorf("db: agents: %w", err)
	}
	return out, nil
}

func (d *DB) oneAgent(ctx context.Context, where string, args ...any) (Agent, error) {
	list, err := d.queryAgents(ctx, where+" LIMIT 1", args...)
	if err != nil {
		return Agent{}, err
	}
	if len(list) == 0 {
		return Agent{}, ErrNotFound
	}
	return list[0], nil
}

// GetAgent looks an agent up by id or by name (src/db.ts getAgent); ErrNotFound when neither matches.
func (d *DB) GetAgent(ctx context.Context, ref string) (Agent, error) {
	return d.oneAgent(ctx, "WHERE id = ? OR name = ?", ref, ref)
}

// AgentByTokenHash is the agent whose launch token hashes to hash (src/db.ts agentByTokenHash).
func (d *DB) AgentByTokenHash(ctx context.Context, hash string) (Agent, error) {
	return d.oneAgent(ctx, "WHERE token_hash = ?", hash)
}

// AgentBySession is the agent whose harness session is sid (src/db.ts getAgentBySession): an OpenCode event names its
// session, not its agent.
func (d *DB) AgentBySession(ctx context.Context, sid string) (Agent, error) {
	return d.oneAgent(ctx, "WHERE session_id = ?", sid)
}

// ListAgents is every agent, oldest first.
func (d *DB) ListAgents(ctx context.Context) ([]Agent, error) {
	return d.queryAgents(ctx, "ORDER BY created_at")
}

// ListLiveAgents is every agent that isn't archived, oldest first (S-2128).
func (d *DB) ListLiveAgents(ctx context.Context) ([]Agent, error) {
	return d.queryAgents(ctx, "WHERE lifecycle != 'archived' ORDER BY created_at")
}

// ListPendingAgents is every agent with a pending action, archived or not, oldest first.
func (d *DB) ListPendingAgents(ctx context.Context) ([]Agent, error) {
	return d.queryAgents(ctx, "WHERE pending_action IS NOT NULL ORDER BY created_at")
}

// AgentLink is an agent's id, spawning parent and activity, without the rest of its row (src/db.ts agentLinks).
type AgentLink struct {
	ID       string            `json:"id"`
	ParentID *string           `json:"parent_id"`
	Activity api.AgentActivity `json:"activity"`
}

// AgentLinks is every agent's AgentLink.
func (d *DB) AgentLinks(ctx context.Context) ([]AgentLink, error) {
	var out []AgentLink
	err := d.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT id, parent_id, activity FROM agents", &sqlitex.ExecOptions{
			ResultFunc: func(stmt *sqlite.Stmt) error {
				c := cols{stmt: stmt}
				out = append(out, AgentLink{ID: c.text(), ParentID: c.nullText(), Activity: api.AgentActivity(c.text())})
				return nil
			},
		})
	})
	if err != nil {
		return nil, fmt.Errorf("db: agent links: %w", err)
	}
	return out, nil
}

// NewAgent holds the columns a spawn sets (src/db.ts createAgent); the rest take the table's defaults.
type NewAgent struct {
	ID, Name, Role, Machine, Harness, Cwd string
	Model, Effort, ParentID, SessionID    *string
}

// CreateAgent inserts an agent and returns its row. It writes the row only: the TS daemon's spawn event and observers
// belong to the layers above.
func (d *DB) CreateAgent(ctx context.Context, a NewAgent) (Agent, error) {
	t := now()
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, `INSERT INTO agents (id, name, role, machine, harness, model, effort, cwd, parent_id, session_id, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, &sqlitex.ExecOptions{
			Args: []any{a.ID, a.Name, a.Role, a.Machine, a.Harness, orNull(a.Model), orNull(a.Effort), a.Cwd, orNull(a.ParentID), orNull(a.SessionID), t, t},
		})
	})
	if err != nil {
		return Agent{}, fmt.Errorf("db: create agent %s: %w", a.ID, err)
	}
	return d.GetAgent(ctx, a.ID)
}

// Secret is a column value that never renders: JSON, fmt and slog all show it redacted. Reveal returns the value.
type Secret string

const redacted = "[redacted]"

// Reveal returns the secret's value, for comparing it; never log or send it.
func (s Secret) Reveal() string { return string(s) }

func (s Secret) String() string               { return redacted }
func (s Secret) GoString() string             { return redacted }
func (s Secret) LogValue() slog.Value         { return slog.StringValue(redacted) }
func (s Secret) MarshalJSON() ([]byte, error) { return json.Marshal(redacted) }
func (s Secret) MarshalText() ([]byte, error) { return []byte(redacted), nil }

// The JSON columns' shapes, from the TS types that write them. A NULL column decodes to the TS daemon's default.

// Visibility is who a child may reach (src/org.ts Visibility).
type Visibility struct {
	Reach    string `json:"reach"`
	Siblings bool   `json:"siblings"`
	Registry bool   `json:"registry"`
}

// VisibilityOf decodes the visibility column as src/org.ts visibilityOf does (S-4003). A NULL column or a missing field
// keeps the open default. A column that isn't a JSON object fails closed, and so does each field with a wrong type or
// value: a bad column must never widen what an agent may reach or see.
func (a Agent) VisibilityOf() Visibility {
	open := Visibility{Reach: "all", Siblings: true, Registry: true}
	if a.Visibility == nil {
		return open
	}
	closed := Visibility{Reach: "parent", Siblings: false, Registry: false}
	var o map[string]json.RawMessage
	if err := json.Unmarshal([]byte(*a.Visibility), &o); err != nil || o == nil {
		return closed
	}
	v := open
	if raw, ok := o["reach"]; ok {
		var s string
		if json.Unmarshal(raw, &s) != nil || (s != "all" && s != "tree" && s != "parent") {
			s = closed.Reach
		}
		v.Reach = s
	}
	flag := func(k string, def bool) bool {
		raw, ok := o[k]
		if !ok {
			return def
		}
		// Only the literal true opens it: false, null (which decodes into a bool without an error) and any other value close it.
		return string(raw) == "true"
	}
	v.Siblings = flag("siblings", open.Siblings)
	v.Registry = flag("registry", open.Registry)
	return v
}

// WorkspaceSpec is how a workspace was asked for (src/workspace.ts WorkspaceSpec): the fields Kind uses are set.
type WorkspaceSpec struct {
	Kind    string `json:"kind"`
	Path    string `json:"path,omitempty"`
	Repo    string `json:"repo,omitempty"`
	Branch  string `json:"branch,omitempty"`
	Base    string `json:"base,omitempty"`
	Command string `json:"command,omitempty"`
	Cwd     string `json:"cwd,omitempty"`
	Text    string `json:"text,omitempty"`
}

// Worktree is a worktree an agent owns.
type Worktree struct {
	Repo      string `json:"repo"`
	Path      string `json:"path"`
	Branch    string `json:"branch"`
	Base      string `json:"base,omitempty"`
	Continues bool   `json:"continues,omitempty"`
}

// DepsEvent is one package folder's dependency linking (src/workspace.ts DepsEvent).
type DepsEvent struct {
	Dir   string `json:"dir"`
	Key   string `json:"key"`
	Event string `json:"event"`
}

// BaseUsed is where a branch was cut from (src/workspace.ts BaseUsed).
type BaseUsed struct {
	Ref       string `json:"ref"`
	Sha       string `json:"sha"`
	Fetch     string `json:"fetch"`
	Error     string `json:"error,omitempty"`
	Defaulted bool   `json:"defaulted,omitempty"`
	Continued string `json:"continued,omitempty"`
}

// Workspace is how an agent's working directory was made (src/workspace.ts Workspace).
type Workspace struct {
	Spec     WorkspaceSpec `json:"spec"`
	Cwd      string        `json:"cwd"`
	Worktree *Worktree     `json:"worktree,omitempty"`
	Deps     []DepsEvent   `json:"deps,omitempty"`
	BaseUsed *BaseUsed     `json:"baseUsed,omitempty"`
}

// WorkspaceOf decodes the workspace column; nil when it is NULL.
func (a Agent) WorkspaceOf() (*Workspace, error) {
	return decodeColumn[Workspace](a.Workspace, "workspace")
}

// PendingAction is an action waiting for the agent to go idle (src/lifecycle.ts Pending). Type picks which fields
// apply; Raw keeps the whole document for the fields this struct doesn't name.
type PendingAction struct {
	Type          string          `json:"type"`
	At            *int64          `json:"at,omitempty"`
	MidTurn       bool            `json:"midTurn,omitempty"`
	Waited        bool            `json:"waited,omitempty"`
	Force         bool            `json:"force,omitempty"`
	Discard       bool            `json:"discard,omitempty"`
	ForceUnpushed bool            `json:"forceUnpushed,omitempty"`
	Tries         int             `json:"tries,omitempty"`
	Reason        string          `json:"reason,omitempty"`
	Instructions  string          `json:"instructions,omitempty"`
	Prompt        string          `json:"prompt,omitempty"`
	Raw           json.RawMessage `json:"-"`
}

// PendingActionOf decodes the pending_action column; nil when it is NULL.
func (a Agent) PendingActionOf() (*PendingAction, error) {
	p, err := decodeColumn[PendingAction](a.PendingAction, "pending_action")
	if p != nil {
		p.Raw = json.RawMessage(*a.PendingAction)
	}
	return p, err
}

// PausedByOf decodes the paused_by column: who holds a pause, "human" or agent ids; empty when NULL.
func (a Agent) PausedByOf() ([]string, error) {
	p, err := decodeColumn[[]string](a.PausedBy, "paused_by")
	if p == nil {
		return nil, err
	}
	return *p, err
}

// CapabilitiesOf decodes the capabilities column (src/registry.ts capabilitiesFor); nil when it is NULL.
func (a Agent) CapabilitiesOf() (map[string]any, error) {
	p, err := decodeColumn[map[string]any](a.Capabilities, "capabilities")
	if p == nil {
		return nil, err
	}
	return *p, err
}

// orNull binds a nullable string: sqlitex binds a pointer as its fmt.Sprint text, so deref it or pass nil for NULL.
func orNull(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

func decodeColumn[T any](s *string, name string) (*T, error) {
	if s == nil {
		return nil, nil
	}
	var v T
	if err := json.Unmarshal([]byte(*s), &v); err != nil {
		return nil, fmt.Errorf("db: agents.%s: %w", name, err)
	}
	return &v, nil
}

// cols reads a result row's columns in order.
type cols struct {
	stmt *sqlite.Stmt
	i    int
}

func (c *cols) next() int { c.i++; return c.i - 1 }

func (c *cols) text() string { return c.stmt.ColumnText(c.next()) }

func (c *cols) int() int { return c.stmt.ColumnInt(c.next()) }

func (c *cols) int64() int64 { return c.stmt.ColumnInt64(c.next()) }

func (c *cols) nullText() *string {
	i := c.next()
	if c.stmt.ColumnIsNull(i) {
		return nil
	}
	s := c.stmt.ColumnText(i)
	return &s
}

func (c *cols) nullInt() *int {
	i := c.next()
	if c.stmt.ColumnIsNull(i) {
		return nil
	}
	n := c.stmt.ColumnInt(i)
	return &n
}
