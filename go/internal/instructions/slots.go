package instructions

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"

	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
	"stam/internal/peers"
)

// The ITSA and requirements slots of the system prompt (src/itsa-owners.ts itsaPrompt, src/requirements.ts prompt).

// itsaCategories are src/itsa.ts's five status categories; a configured status in another is no status.
var itsaCategories = []string{"backlog", "ready", "active", "review", "closed"}

// isOpen is src/itsa-owners.ts isOpen: the status is not in the closed category (an unknown status is open).
func (p *Prompts) isOpen(status string) bool {
	for _, st := range p.Settings().Itsa.Statuses {
		if st.Name != status {
			continue
		}
		for _, c := range itsaCategories {
			if st.Category == c {
				return c != "closed"
			}
		}
	}
	return true
}

func itsaLabel(x jsfmt.Value) string {
	return x.Text("key") + ` "` + x.Text("title") + `" (` + x.Text("status") + ")"
}

// ownedLine is src/itsa-owners.ts line: the open ITSAs the agent owns.
func (p *Prompts) ownedLine(rows []jsfmt.Value) string {
	var labels []string
	for _, x := range rows {
		if p.isOpen(x.Text("status")) {
			labels = append(labels, itsaLabel(x))
		}
	}
	if len(labels) == 0 {
		return ""
	}
	return "You own these ITSAs: " + strings.Join(labels, "; ") + "."
}

// partLine is src/itsa-owners.ts partLine: the open ITSAs the agent takes part in and doesn't own.
func (p *Prompts) partLine(rows []jsfmt.Value, agentID string) string {
	var labels []string
	for _, x := range rows {
		if p.isOpen(x.Text("status")) && x.Text("owner") != agentID {
			labels = append(labels, itsaLabel(x))
		}
	}
	if len(labels) == 0 {
		return ""
	}
	return "You participate in these ITSAs: " + strings.Join(labels, "; ") + "."
}

// HomeItsas is what a daemon that isn't the ITSA home last read from the home for the ITSA slot (src/itsa-owners.ts
// remoteOwned, remoteParticipating, remoteFields, remoteCos), filled by Load before a launch.
type HomeItsas struct {
	mu          sync.Mutex
	owned, part map[string]string
	fields      []jsfmt.Value
	cos         string
}

// HomeGet reads one GET route from the ITSA home, as JSON.
type HomeGet func(ctx context.Context, path string) (jsfmt.Value, error)

// Load is src/itsa-owners.ts loadOwned on a daemon that isn't the home: the agent's owned and participated lines, the
// fields and the chief of staff's name, from the home. A failed read keeps the last good fields and name; failed ITSA
// lists drop the agent's lines, so the slot leaves them out rather than failing the launch.
func (p *Prompts) Load(ctx context.Context, agentID string, get HomeGet) {
	h := p.Home
	if h == nil || p.home() {
		return
	}
	soft := func(what, path string) (jsfmt.Value, bool) {
		v, err := get(ctx, path)
		if err != nil {
			slog.Warn("couldn't read "+what+" from the home", "err", err)
			return jsfmt.Value{}, false
		}
		return v, true
	}
	q := peers.EncodeURIComponent(agentID)
	// The four reads run at once, as TS's Promise.all does: a slow home costs one read's deadline, not four.
	var owned, part, fields, cos jsfmt.Value
	var okOwned, okPart, okFields, okCos bool
	var wg sync.WaitGroup
	for _, r := range []struct {
		what, path string
		v          *jsfmt.Value
		ok         *bool
	}{
		{agentID + "'s owned ITSAs", "/api/itsas?owner=" + q, &owned, &okOwned},
		{agentID + "'s ITSAs", "/api/itsas?participant=" + q, &part, &okPart},
		{"the ITSA fields", "/api/itsas/fields", &fields, &okFields},
		{"the chief of staff", "/api/chief-of-staff", &cos, &okCos},
	} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			*r.v, *r.ok = soft(r.what, r.path)
		}()
	}
	wg.Wait()
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.owned == nil {
		h.owned, h.part = map[string]string{}, map[string]string{}
	}
	if okOwned && okPart {
		h.owned[agentID] = p.ownedLine(owned.Items)
		h.part[agentID] = p.partLine(part.Items, agentID)
	} else {
		delete(h.owned, agentID)
		delete(h.part, agentID)
	}
	if okFields {
		h.fields = fields.Items
	}
	if okCos {
		h.cos = cos.Text("setting")
	}
}

// Forget drops an agent's cached lines (an archived or forgotten agent).
func (h *HomeItsas) Forget(agentID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.owned, agentID)
	delete(h.part, agentID)
}

// remote is the cache's view for one agent, read under its lock: the agent's owned and participated lines, the fields
// (a slice Load replaces whole, never edits) and the chief of staff's name.
func (p *Prompts) remote(agentID string) (owned, part string, fields []jsfmt.Value, cos string) {
	h := p.Home
	if h == nil {
		return "", "", nil, ""
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.owned[agentID], h.part[agentID], h.fields, h.cos
}

// OwnedPrompt is src/itsa-owners.ts ownedPrompt: the open ITSAs the agent owns, rebuilt on every start and resume.
func (p *Prompts) OwnedPrompt(ctx context.Context, agentID string) (string, error) {
	if !p.home() {
		owned, _, _, _ := p.remote(agentID)
		return owned, nil
	}
	rows, err := p.DB.ListItsas(ctx, db.ItsaFilter{Owner: agentID})
	if err != nil {
		return "", err
	}
	return p.ownedLine(rows), nil
}

// ParticipatingPrompt is src/itsa-owners.ts participatingPrompt: the open ITSAs the agent takes part in and doesn't own.
func (p *Prompts) ParticipatingPrompt(ctx context.Context, agentID string) (string, error) {
	if !p.home() {
		_, part, _, _ := p.remote(agentID)
		return part, nil
	}
	rows, err := p.DB.ListItsas(ctx, db.ItsaFilter{Participant: agentID})
	if err != nil {
		return "", err
	}
	return p.partLine(rows, agentID), nil
}

// FieldsPrompt is src/itsa-owners.ts fieldsPrompt: the Work page columns agents fill with itsa_set fields; "" when
// there are none or the read fails.
func (p *Prompts) FieldsPrompt(ctx context.Context) string {
	var list []jsfmt.Value
	if p.home() {
		var err error
		if list, err = p.DB.ItsaFields(ctx); err != nil {
			slog.Warn("couldn't list the ITSA fields", "err", err)
			return ""
		}
	} else {
		_, _, list, _ = p.remote("")
	}
	if len(list) == 0 {
		return ""
	}
	rows := make([]string, len(list))
	for i, f := range list {
		opts := ""
		if o, ok := f.Get("options"); f.Text("type") == "choice" && ok && o.Truthy() {
			vals := make([]string, len(o.Items))
			for j, x := range o.Items {
				v, _ := x.Get("value")
				vals[j] = joined(v)
			}
			opts = " (" + strings.Join(vals, " | ") + ")"
		}
		kinds := ""
		if k, ok := f.Get("kinds"); ok && k.Truthy() {
			ks := make([]string, len(k.Items))
			for j, x := range k.Items {
				ks[j] = joined(x)
			}
			kinds = " · only for kind " + strings.Join(ks, " or ")
		}
		desc := ""
		if d := f.Text("description"); d != "" {
			desc = ": " + d
		}
		rows[i] = fmt.Sprintf("- `%s` · %s · %s%s%s%s", f.Text("key"), f.Text("label"), f.Text("type"), opts, kinds, desc)
	}
	return "Work page columns (ITSA fields) you fill with `itsa_set` `fields`:\n" + strings.Join(rows, "\n")
}

// ColumnsPrompt is src/itsa-owners.ts columnsPrompt: who changes the Work columns.
func (p *Prompts) ColumnsPrompt(ctx context.Context, agentID string) string {
	cos := p.Settings().ChiefOfStaff
	if !p.home() {
		_, _, _, cos = p.remote(agentID)
	}
	if cos == "" {
		return "No chief of staff is set, so any agent may add, change, or remove Work columns (ITSA fields) with `itsa_fields`; do it sparingly."
	}
	if me, err := p.DB.GetAgent(ctx, agentID); err == nil && (me.ID == cos || me.Name == cos) {
		return "You own the Work column definitions (ITSA fields): other agents mail you to add, change, or remove a column. Change them with `itsa_fields`."
	}
	return "Only the chief of staff (@" + cos + ") adds, changes, or removes Work columns (ITSA fields); mail them to ask."
}

// ItsaPrompt is src/itsa-owners.ts itsaPrompt: the itsa template with the agent's owned and participated lines, the
// fields and who changes the columns.
func (p *Prompts) ItsaPrompt(ctx context.Context, agentID string) (string, error) {
	owned, err := p.OwnedPrompt(ctx, agentID)
	if err != nil {
		return "", err
	}
	part, err := p.ParticipatingPrompt(ctx, agentID)
	if err != nil {
		return "", err
	}
	return p.Templates.Render("itsa", map[string]string{"owned": owned, "participating": part, "fields": p.FieldsPrompt(ctx), "columns": p.ColumnsPrompt(ctx, agentID)}, "")
}

// RequirementsPrompt is src/requirements.ts prompt: the requirements template while requirements are on, else "".
func (p *Prompts) RequirementsPrompt() (string, error) {
	if !p.Settings().RequirementsEnabled {
		return "", nil
	}
	t, err := p.Templates.Render("requirements", nil, "")
	return jsjson.Trim(t), err
}

// joined is an array element as Array.prototype.join writes it: "" for null or a missing value.
func joined(v jsfmt.Value) string {
	switch v.Kind {
	case jsfmt.Null:
		return ""
	case jsfmt.String:
		return v.Str
	case jsfmt.Number:
		return v.Num
	case jsfmt.Bool:
		return fmt.Sprint(v.Bool)
	}
	return jsfmt.Compact(v)
}
