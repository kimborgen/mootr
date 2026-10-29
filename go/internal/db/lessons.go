package db

import "context"

// LessonItem is one retro item a lesson can come from (src/retro.ts LessonItem): Summary is its summary, else its title.
type LessonItem struct {
	ID, Key, Summary, Body, Status string
}

// LessonItems is src/retro-lessons.ts deps.items: the items of kind under the ITSA of parentKind titled parentTitle
// (the retro items under Retros), any status; none when there is no such parent.
func (d *DB) LessonItems(ctx context.Context, parentKind, parentTitle, kind string) ([]LessonItem, error) {
	parent := ""
	err := d.read(ctx, "SELECT id FROM itsas WHERE kind = ? AND title = ? LIMIT 1", func(c *cols) { parent = c.text() }, parentKind, parentTitle)
	if err != nil || parent == "" {
		return nil, wrap("lesson items", err)
	}
	var out []LessonItem
	err = d.read(ctx, "SELECT id, key, title, summary, body, status FROM itsas WHERE parent_id = ? AND kind = ?", func(c *cols) {
		x := LessonItem{ID: c.text(), Key: c.text()}
		title, summary := c.text(), c.text()
		x.Summary = summary
		if x.Summary == "" {
			x.Summary = title
		}
		x.Body, x.Status = c.text(), c.text()
		out = append(out, x)
	}, parent, kind)
	return out, wrap("lesson items", err)
}
