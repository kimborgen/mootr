// Decision mails (S-352): an agent's mail to the human whose body has a decision block, the tags
// the web renders as a choice. It waits on the human until they reply in its thread, so the
// attention list shows it. The mail is recorded when it is stored (db.addDecisionMail), so listing
// them never scans mail. A storage agent's mail is stored on that daemon, so the list merges the
// peers' lists (daemon.ts decisionMailsAll).
import * as db from './db.ts';

// The fenced-block tags the web renders as a choice (web/src/mail/mailblocks.ts).
const TAGS = new Set(['decision', 'yesno', 'question', 'pick', 'multi', 'choose', 'rank']);

// Whether the body has a fenced block with one of those tags, read the way the web reads it:
// CommonMark, as marked parses it. A fence is 3 or more backticks or tildes, inside any nesting of
// block quotes and list items, and its info string must be exactly the tag (trimmed, any case).
// Nothing inside another open fence counts. A fence ends with its container: a line that leaves the
// quote or list item it was opened in closes it. Lazy continuation lines keep a container open.
// This is not a full parser; it follows containers, fences, and the paragraph state that lazy lines need.
export function hasDecisionBlock(body: string): boolean {
  // Open containers, outermost first: a quote, or a list item that needs `width` columns of indent.
  const containers: Array<{ width: number } | 'quote'> = [];
  let fence: { ch: string; len: number } | undefined;
  let para = false; // the previous line continues a paragraph
  for (const raw of body.split('\n')) {
    let rest = raw.replace(/\r$/, '').replace(/^[ \t]+/, (w) => w.replace(/\t/g, '    '));
    // Match the open containers, as far as this line continues them.
    let matched = 0;
    for (const c of containers) {
      if (c === 'quote') {
        const m = /^ {0,3}>[ \t]?/.exec(rest);
        if (!m) break;
        rest = rest.slice(m[0].length);
      } else if (rest.trim()) {
        if (indentOf(rest) < c.width) break;
        rest = rest.slice(c.width);
      }
      matched++;
    }
    if (fence) {
      if (matched === containers.length) {
        // A closing fence is the same character, at least as long, and has no info string.
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(rest);
        if (close && close[1][0] === fence.ch && close[1].length >= fence.len) fence = undefined;
        continue;
      }
      // The line left the container the fence was in, which ends it.
      fence = undefined;
      containers.length = matched;
    } else if (matched < containers.length) {
      if (para && rest.trim() && !startsBlock(rest)) {
        continue; // a lazy continuation line keeps every container open
      }
      containers.length = matched;
      para = false;
    }
    // Open the containers this line starts.
    for (;;) {
      if (/^ {0,3}>/.test(rest)) {
        rest = rest.replace(/^ {0,3}>[ \t]?/, '');
        containers.push('quote');
        continue;
      }
      const li = /^( {0,3})([-+*]|\d{1,9}[.)])( +|$)/.exec(rest);
      if (!li) break;
      // The text starts 1-4 columns after the marker; with more, or none, it is one column.
      const gap = li[3].length >= 1 && li[3].length <= 4 && rest.trim() !== li[2] ? li[3].length : 1;
      const width = li[1].length + li[2].length + gap;
      containers.push({ width });
      rest = rest.slice(Math.min(width, rest.length));
    }
    if (!rest.trim()) {
      para = false;
      continue;
    }
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(rest);
    // A backtick fence's info string can't contain a backtick, so such a line is text.
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) {
      if (TAGS.has(f[2].trim().toLowerCase())) return true;
      fence = { ch: f[1][0], len: f[1].length };
      para = false;
    } else {
      // Indented code, unlike indented text after a paragraph, is not a paragraph.
      para = !(indentOf(rest) >= 4 && !para);
    }
  }
  return false;
}

function indentOf(s: string): number {
  return s.length - s.trimStart().length;
}

// Whether the text starts a block that can't be a lazy continuation of a paragraph.
function startsBlock(s: string): boolean {
  return /^ {0,3}(>|`{3,}|~{3,}|#{1,6}([ \t]|$)|[-+*]([ \t]|$)|\d{1,9}[.)]([ \t]|$))/.test(s);
}

// The replies the web writes for "Decide later" (web/src/mail/mailblocks.ts: DEFERRED, and the older
// "Go with your recommendation" one). A human mail defers its thread when every answer in it is one
// of those deferrals, and it has at least one. Quoted question lines don't count.
const DEFERRAL = /^Deferring this one(?:: still open, I'll decide later\.(?: Keep working on what doesn't depend on it\.)?|\. Go with your recommendation, \*\*[^*]+\*\*, for now\.)$/;
// A note is not a deferral, and attachments aren't either: only deferral lines defer.
export function isDeferralOnly(body: string, attachments = 0): boolean {
  if (attachments) return false;
  const lines = body.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('>'));
  return lines.some((l) => DEFERRAL.test(l)) && lines.every((l) => DEFERRAL.test(l));
}

export type DecisionMail = db.DecisionRow;

// The unanswered decision mails stored on this daemon, oldest first. A mail about an ITSA in a
// human status is still here: withoutHeld leaves it out, since that ITSA's row covers it.
export function localDecisionMails(): DecisionMail[] {
  return db.decisionMails();
}

// The mails not about an ITSA in a human status. `held` is the ids of every such ITSA, on every
// home, so a mail stored here about an ITSA homed elsewhere is left out too.
export function withoutHeld(mails: DecisionMail[], held: Set<string>): DecisionMail[] {
  return mails.filter((m) => !m.about_itsa || !held.has(m.about_itsa));
}
