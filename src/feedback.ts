// The `feedback` MCP tool (S-156): an agent reports a problem with stam or its MCP tools. Each
// report becomes a backlog ITSA under a standing "Feedback" parent, or a comment on an open
// report with the same tool and summary. The chief of staff gets one quiet mail for a new
// report. A report that names a screen event carries that screen (feedback-screen.ts, S-2679).
// The API is passed in, so the unit test runs against a fake without a daemon.
import { screenSection } from './feedback-screen.ts';

export type Api = (method: string, path: string, body?: unknown, timeoutMs?: number) => Promise<any>;

export const FEEDBACK_KINDS = ['bug', 'inconsistency', 'missing_param', 'missing_feature', 'other'] as const;
// The parent is found by its kind, a marker no other ITSA uses, and its title.
export const PARENT_KIND = 'feedback';
export const PARENT_TITLE = 'Feedback';
export const REPORT_KIND = 'feedback-report';

// Summaries match when they read the same once case and punctuation are dropped.
export const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// The standing parent, created on first use under the root of S-1's tree when S-1 exists,
// else as a root.
export async function feedbackParent(api: Api, by: string): Promise<any> {
  const found = (await api('GET', `/api/itsas?kind=${PARENT_KIND}`)).find((x: any) => x.title === PARENT_TITLE);
  if (found) return found;
  let parent: string | undefined;
  try {
    const s1 = await api('GET', '/api/itsas/S-1');
    parent = s1.parent_chain?.[0]?.id ?? s1.id;
  } catch {}
  return api('POST', '/api/itsas', {
    title: PARENT_TITLE,
    summary: 'Problems agents report with stam and its MCP tools.',
    kind: PARENT_KIND,
    parent,
    by,
  });
}

// The tool a report names, as its body says it (`Tool: x`), or "none".
const toolOf = (body: string | null): string => body?.match(/^Tool: (.*)$/m)?.[1]?.trim() || 'none';

// Files a report, or comments on the open report it repeats. Returns what happened, for the reporter.
export async function report(
  api: Api,
  by: string,
  a: { kind: string; title?: string; summary: string; details: string; tool?: string },
): Promise<string> {
  if (!(FEEDBACK_KINDS as readonly string[]).includes(a.kind)) throw new Error(`kind must be one of ${FEEDBACK_KINDS.join(', ')}`);
  const summary = a.summary.replace(/\s+/g, ' ').trim();
  if (!summary) throw new Error('summary is required');
  // The short title (S-1016); an older caller without one gets the summary.
  const title = a.title?.replace(/\s+/g, ' ').trim() || summary;
  const tool = a.tool?.trim() || 'none';
  const parent = await feedbackParent(api, by);

  const open = (await api('GET', `/api/itsas?parent=${parent.id}&kind=${REPORT_KIND}`)).filter((x: any) => !x.closed_at);
  for (const row of open) {
    // On the summary alone: short titles can repeat across different bugs, and an old row's summary equals its title.
    if (normalize(row.summary ?? row.title) !== normalize(summary)) continue;
    const full = await api('GET', `/api/itsas/${row.id}`);
    if (toolOf(full.body) !== tool) continue;
    await api('POST', `/api/itsas/${row.id}/post`, { by, body: `Reported again by ${by}:\n\n${a.details}` });
    return `Already reported as ${row.key} "${row.title}"; added your report there as a comment.`;
  }

  // The screen a named screen event carries (S-2679), read before filing: a read that fails files the report without it.
  const screens = await screenSection(api, a.details);
  const body = [`Kind: ${a.kind}`, `Tool: ${tool}`, `Reporter: ${by}`, '', a.details, ...(screens ? ['', screens] : [])].join('\n');
  const x = await api('POST', '/api/itsas', {
    title,
    summary,
    body,
    kind: REPORT_KIND,
    parent: parent.id,
    participants: [by],
    by,
  });

  const cos = (await api('GET', '/api/chief-of-staff')).chiefOfStaff;
  if (cos) {
    await api('POST', '/api/mail', {
      from: by,
      to: [cos],
      subject: `Feedback ${x.key}: ${title}`,
      body: `${a.kind} reported${tool === 'none' ? '' : ` on \`${tool}\``}: ${summary}. Details are in ${x.key}.`,
      itsa: x.key,
      new_thread: true,
    });
  }
  return `Filed ${x.key} "${title}" [backlog] under Feedback${cos ? ', and told the chief of staff' : ''}.`;
}
