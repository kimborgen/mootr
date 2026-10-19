// The send_mail input both the MCP tool and the daemon's POST /api/mail accept (S-116). Haiku
// agents pass the text as `message` or `content`, and one recipient as a bare string; a mail
// with no text is refused here, not stored empty, unless it carries attachments.
export function normalizeMailInput(input: Record<string, any>): Record<string, any> & { to: string[]; body: string } {
  const { message, content, ...rest } = input;
  const found = [input.body, message, content].find((v) => typeof v === 'string' && v.trim() !== '');
  const hasAttachments = Array.isArray(input.attachments) && input.attachments.length > 0;
  if (typeof found !== 'string' && !hasAttachments) throw new Error("body is required: the mail's text");
  const body = typeof found === 'string' ? found : '';
  const to = typeof input.to === 'string' ? [input.to] : input.to;
  return { ...rest, to, body };
}
