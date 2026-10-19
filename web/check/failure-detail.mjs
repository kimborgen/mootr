// The text a failed check reports: the error's first line, then any ` | detail` a check appended to
// the message (a row's text, a count). Playwright's call log after the first line stays out, so the
// gate log keeps the diagnostic without the whole log. Whitespace collapses and the text caps at 300.
export function failureDetail(message, max = 300) {
  const text = String(message);
  const firstEnd = text.indexOf('\n');
  const head = (firstEnd < 0 ? text : text.slice(0, firstEnd)).trim();
  const at = text.indexOf(' | ', firstEnd < 0 ? text.length : firstEnd);
  if (at < 0) return head.slice(0, max);
  const detail = text.slice(at + 3).replace(/\s+/g, ' ').trim();
  return `${head} | ${detail}`.slice(0, max);
}
