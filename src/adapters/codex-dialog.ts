// Ties a Codex app-server request the agent waits on (an approval, or a question) to a stam permission request (S-3979),
// so the human's answer goes back as the app-server's reply to that same request. The request's details carry its
// JSON-RPC id, its method and the connection it arrived on: an answer is sent only to that request, on that connection,
// and a request the app-server no longer holds reads as gone. The details carry the request's own fields only, never
// env values, tokens or a command's environment.

// The server requests stam makes an ask of, and what each asks.
const ASKS: Record<string, { action: string; tool: string }> = {
  'item/commandExecution/requestApproval': { action: 'Codex asks to run a command', tool: 'Bash' },
  'item/fileChange/requestApproval': { action: 'Codex asks to change files', tool: 'Edit' },
  'item/tool/requestUserInput': { action: 'Codex asks a question', tool: 'AskUserQuestion' },
};

export interface CodexDialogRequest {
  id: string | number;
  method: string;
  // The connection the request arrived on: unique across daemon restarts (codex.ts).
  conn: string;
}

export interface CodexDialogDetails {
  tool: string;
  input: Record<string, unknown>;
  session?: string;
  request: CodexDialogRequest;
}

export const isCodexAsk = (method: string) => method in ASKS;

// Names one request on one connection, so a request id from another connection never matches it.
export const requestKey = (r: { id: string | number; conn: string }) => `${r.conn}#${r.id}`;

// The ask for a server request: its action, and the details the permission request keeps. The mail reads a command's
// reason as its description, and its working folder goes with the command; a question shows its questions and options
// the way a Claude Code question does (src/adapters/claude-dialog.ts). A secret question shows no options, so it can't
// be answered by choice. Undefined for a method stam doesn't ask about.
export function codexAsk(method: string, params: any, request: CodexDialogRequest): { action: string; details: string } | undefined {
  const ask = ASKS[method];
  if (!ask) return undefined;
  const reason = typeof params?.reason === 'string' && params.reason.trim() ? { description: params.reason.trim() } : {};
  const input: Record<string, unknown> = method === 'item/tool/requestUserInput'
    ? { questions: (Array.isArray(params?.questions) ? params.questions : []).map(questionOf) }
    : method === 'item/commandExecution/requestApproval'
      ? { command: typeof params?.command === 'string' && params.cwd ? `${params.command}\n# in ${params.cwd}` : params?.command, ...reason }
      : { file_path: params?.grantRoot, ...reason };
  const details: CodexDialogDetails = { tool: ask.tool, input, session: params?.threadId, request };
  return { action: ask.action, details: JSON.stringify(details) };
}

function questionOf(q: any) {
  const options = Array.isArray(q?.options) && !q.isSecret
    ? q.options.map((o: any) => ({ label: o?.label, description: o?.description }))
    : undefined;
  return { question: q?.question, ...(options ? { options } : {}), multiSelect: false };
}

// The request a dialog's details name, or undefined for details that aren't a Codex request's.
export function codexRequestOf(details: string): CodexDialogRequest | undefined {
  try {
    const r = JSON.parse(details)?.request;
    return r && (typeof r.id === 'string' || typeof r.id === 'number') && typeof r.method === 'string' && typeof r.conn === 'string' ? r : undefined;
  } catch {
    return undefined;
  }
}

// The app-server's reply to the human's answer, or undefined when stam can't answer it safely. An approval is accepted
// once or declined (the agent carries on without it), as the view's approvals are. A question takes the one option the
// human chose, and only from a single question with options and unique labels; a no answers every question with none,
// the shape ToolRequestUserInputResponse allows (test/fixtures/codex-protocol). A question that can't take a choice is
// undefined, and nothing is sent.
export function codexReply(method: string, params: any, approve: boolean, choice?: string): Record<string, unknown> | undefined {
  if (method !== 'item/tool/requestUserInput') return { decision: approve ? 'accept' : 'decline' };
  const qs: any[] = Array.isArray(params?.questions) ? params.questions : [];
  if (!approve) return { answers: Object.fromEntries(qs.map((q) => [q.id, { answers: [] }])) };
  const q = qs[0];
  const labels: unknown[] = Array.isArray(q?.options) && !q.isSecret ? q.options.map((o: any) => o?.label) : [];
  if (qs.length !== 1 || typeof choice !== 'string' || !labels.includes(choice) || new Set(labels).size !== labels.length) return undefined;
  return { answers: { [q.id]: { answers: [choice] } } };
}
