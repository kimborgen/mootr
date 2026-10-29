// The question and options of a question dialog (AskUserQuestion, S-3978), read from a request's details.
// It takes the same shape the daemon checks before it types a choice (dialogQuestion in
// src/adapters/claude-dialog.ts): one question, single-select, and options that all have a unique label. A description is
// optional and shown under its label. Anything else is undefined, and the card then offers Approve and Deny only.
export interface AskOption { label: string; description?: string }
export interface AskQuestion { question: string; options: AskOption[] }

export function askQuestion(details?: string | null): AskQuestion | undefined {
  let d: { tool?: unknown; input?: { questions?: unknown } } | null
  try { d = JSON.parse(details ?? '') } catch { return undefined }
  if (!d || d.tool !== 'AskUserQuestion') return undefined
  const qs = d.input?.questions
  if (!Array.isArray(qs) || qs.length !== 1) return undefined
  const q = qs[0] as { question?: unknown; options?: unknown; multiSelect?: unknown } | null
  if (!q || typeof q.question !== 'string' || !q.question.trim() || !Array.isArray(q.options) || q.multiSelect === true) return undefined
  const options = q.options.map((o: { label?: unknown; description?: unknown } | null) => ({ label: o?.label, description: o?.description }))
  if (!options.length || options.some((o) => typeof o.label !== 'string' || !o.label.trim())) return undefined
  if (new Set(options.map((o) => o.label)).size !== options.length) return undefined
  return {
    question: q.question,
    options: options.map((o) => ({ label: o.label as string, ...(typeof o.description === 'string' && o.description.trim() ? { description: o.description } : {}) })),
  }
}
