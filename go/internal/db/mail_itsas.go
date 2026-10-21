package db

import (
	"context"
	"regexp"
	"strings"

	"zombiezen.com/go/sqlite"
)

// What a stored mail does with ITSAs (S-2849): src/mail-itsas.ts linkMail (the ITSAs a mail is about, S-986), the thread an
// ITSA's first post allocates, and the participant a post makes.

// maxNamedKeys is src/db.ts MAX_NAMED_KEYS: the keys a mail's text names that link it.
const maxNamedKeys = 10

// reKey is one whole run of word characters and hyphens that has the shape of an ITSA key (S-986: `S-123`, `TEAM-S-7`).
// src/itsa-keys.ts matches it with a lookbehind and a lookahead on [\w-], so a key is exactly such a run.
var reKey = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z][A-Za-z0-9]*)*-[0-9]+$`)

func isKeyChar(c byte) bool {
	return c == '-' || c == '_' || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

// stripCode is src/itsa-keys.ts stripCode: fenced blocks (an unclosed one runs to the end) and inline code spans, each
// replaced by a space.
func stripCode(text string) string {
	return stripSpans(stripFences(text))
}

// stripFences is text.replace(/(^|\n)[ \t]*(```|~~~)[\s\S]*?(?:\n[ \t]*\2[^\n]*|$)/g, ' '). A match starts at the start of the
// text or at a line break, then optional blanks and a fence; it ends at the first line that opens with the same fence
// (through that line's end) or at the end of the text.
func stripFences(text string) string {
	var out strings.Builder
	last := 0
	for i := 0; i <= len(text); {
		var fence string
		var after int
		ok := false
		if i == 0 {
			fence, after, ok = openFence(text, 0)
		}
		if !ok && i < len(text) && text[i] == '\n' {
			fence, after, ok = openFence(text, i+1)
		}
		if !ok {
			i++
			continue
		}
		to := fenceEnd(text, after, fence)
		out.WriteString(text[last:i])
		out.WriteByte(' ')
		last, i = to, to
	}
	out.WriteString(text[last:])
	return out.String()
}

// openFence reads [ \t]* then ``` or ~~~ at j; end is the index after the fence.
func openFence(text string, j int) (fence string, end int, ok bool) {
	for j < len(text) && (text[j] == ' ' || text[j] == '\t') {
		j++
	}
	for _, f := range []string{"```", "~~~"} {
		if strings.HasPrefix(text[j:], f) {
			return f, j + 3, true
		}
	}
	return "", 0, false
}

// fenceEnd is where the lazy body of a fenced block ends, from the index after its opener: before the end of the first
// following line that opens with the same fence (the match takes that whole line), else the end of the text.
func fenceEnd(text string, from int, fence string) int {
	for q := from; q <= len(text); q++ {
		if q < len(text) && text[q] == '\n' {
			k := q + 1
			for k < len(text) && (text[k] == ' ' || text[k] == '\t') {
				k++
			}
			if strings.HasPrefix(text[k:], fence) {
				e := k + 3
				for e < len(text) && text[e] != '\n' {
					e++
				}
				return e
			}
		}
		if q == len(text) {
			return q
		}
	}
	return len(text)
}

// stripSpans is text.replace(/(`+)[^`]*?\1/g, ' '): a run of backticks, the text up to the next backtick, and the same
// number of backticks (the opening run may give back backticks to make that fit).
func stripSpans(text string) string {
	var out strings.Builder
	i, last := 0, 0
	for i < len(text) {
		if text[i] != '`' {
			i++
			continue
		}
		run := 0
		for i+run < len(text) && text[i+run] == '`' {
			run++
		}
		matched := -1
		for k := run; k >= 1; k-- {
			p := i + k
			for p < len(text) && text[p] != '`' {
				p++
			}
			n := 0
			for p+n < len(text) && text[p+n] == '`' {
				n++
			}
			if n >= k {
				matched = p + k
				break
			}
		}
		if matched < 0 {
			i++
			continue
		}
		out.WriteString(text[last:i])
		out.WriteByte(' ')
		i, last = matched, matched
	}
	out.WriteString(text[last:])
	return out.String()
}

// NamedKeys is src/itsa-keys.ts namedKeys: the distinct key-shaped words of the text outside code, in order of first
// appearance.
func NamedKeys(text string) []string {
	text = stripCode(text)
	var out []string
	seen := map[string]bool{}
	for i := 0; i < len(text); {
		if !isKeyChar(text[i]) {
			i++
			continue
		}
		j := i
		for j < len(text) && isKeyChar(text[j]) {
			j++
		}
		if w := text[i:j]; reKey.MatchString(w) && !seen[w] {
			seen[w] = true
			out = append(out, w)
		}
		i = j
	}
	return out
}

// linkMail is src/mail-itsas.ts linkMail for a stored mail: the ITSA the sender named (itsa, or a comment's own), the keys
// in the subject and body that name an ITSA here, and the ITSA whose thread the mail is in. The first source of an ITSA wins.
func linkMail(conn *sqlite.Conn, id, threadID, text, itsaID, aboutItsa string) error {
	ownIDs, err := column(conn, "SELECT id FROM itsas WHERE thread_id = ?", threadID)
	if err != nil {
		return err
	}
	own := map[string]bool{}
	for _, o := range ownIDs {
		own[o] = true
	}
	type link struct{ itsa, source string }
	var links []link
	for _, x := range []string{aboutItsa, itsaID} {
		if x != "" && !own[x] {
			links = append(links, link{x, "itsa"})
		}
	}
	keys := NamedKeys(text)
	if len(keys) > maxNamedKeys {
		keys = keys[:maxNamedKeys]
	}
	for _, k := range keys {
		found, err := column(conn, "SELECT id FROM itsas WHERE key = ?", k)
		if err != nil {
			return err
		}
		if len(found) > 0 {
			source := "named"
			if own[found[0]] {
				source = "thread"
			}
			links = append(links, link{found[0], source})
		}
	}
	for _, o := range ownIDs {
		links = append(links, link{o, "thread"})
	}
	for _, l := range links {
		if err := runSQL(conn, "INSERT OR IGNORE INTO mail_itsas (mail_id, itsa_id, source) VALUES (?, ?, ?)", id, l.itsa, l.source); err != nil {
			return err
		}
	}
	return nil
}

// AllocateItsaThread is the first step of itsa.post: the ITSA's thread id, drawn and stored when it has none (two first
// posts cannot start two threads). first says this call started it.
func (d *DB) AllocateItsaThread(ctx context.Context, itsaID string) (threadID string, first bool, err error) {
	err = d.Write(ctx, func(conn *sqlite.Conn) error {
		cur, err := rows(conn, "SELECT thread_id FROM itsas WHERE id = ?", itsaID)
		if err != nil {
			return err
		}
		if len(cur) == 0 {
			return nil
		}
		threadID = cur[0].Text("thread_id")
		if threadID != "" {
			return nil
		}
		first = true
		if err := runSQL(conn, "UPDATE itsas SET thread_id = ? WHERE id = ? AND thread_id IS NULL", NewMailID(), itsaID); err != nil {
			return err
		}
		cur, err = rows(conn, "SELECT thread_id FROM itsas WHERE id = ?", itsaID)
		if len(cur) > 0 {
			threadID = cur[0].Text("thread_id")
		}
		return err
	})
	return threadID, first, wrap("allocate ITSA thread", err)
}

// EnsureItsaParticipant is itsa.ensureParticipant.
func (d *DB) EnsureItsaParticipant(ctx context.Context, itsaID, who string) error {
	return wrap("ITSA participant", d.Write(ctx, func(conn *sqlite.Conn) error {
		return runSQL(conn, "INSERT OR IGNORE INTO itsa_participants (itsa_id, agent_id) VALUES (?, ?)", itsaID, who)
	}))
}
