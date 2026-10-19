// ITSA keys named in text (S-986): `S-123`, `TEAM-S-7`. Code spans and fenced blocks are skipped, so a
// key quoted as code isn't a link. No imports: db.ts uses it in a migration.

const KEY = /(?<![\w-])([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z][A-Za-z0-9]*)*-\d+)(?![\w-])/g;

// Fenced blocks (an unclosed one runs to the end) and inline code spans, replaced by a space.
export function stripCode(text: string): string {
  return text.replace(/(^|\n)[ \t]*(```|~~~)[\s\S]*?(?:\n[ \t]*\2[^\n]*|$)/g, ' ').replace(/(`+)[^`]*?\1/g, ' ');
}

// The distinct key-shaped words of the text outside code, in order of first appearance. Whether a
// key names an ITSA is for the caller to look up.
export function namedKeys(text: string): string[] {
  return [...new Set([...stripCode(text).matchAll(KEY)].map((m) => m[1]!))];
}
