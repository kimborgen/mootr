// Runs dialog screens through the TS daemon's own src/adapters/claude-dialog.ts, for go/internal/adapters/claude's
// dialog test (S-2848 B3a). The cases come as JSON on stdin, [{body, tool, target, input, approve}], and it prints
// [{names, key, target, question, questionNames, prompt, promptNames}] in the same order: dialogNames(body, tool, target),
// dialogKey(body, approve) (null for none), and dialogTarget(input); for a question dialog (S-3978), dialogQuestion(input)
// (null for none) and questionNames(body, question, options) when there is one, and dialogPrompt(input) (the deny's
// looser prompt, null for none) with questionNames on it. It touches no stam home.
//
//   node go/internal/adapters/claude/testdata/ts-dialog.mjs < cases.json
import { readFileSync, writeSync } from 'node:fs';

const { dialogNames, dialogKey, dialogTarget, dialogQuestion, dialogPrompt, questionNames } = await import('../../../../../src/adapters/claude-dialog.ts');
const cases = JSON.parse(readFileSync(0, 'utf8'));
const out = cases.map((c) => {
  const question = dialogQuestion(c.input ?? undefined) ?? null;
  const prompt = dialogPrompt(c.input ?? undefined) ?? null;
  return {
    names: dialogNames(c.body ?? [], c.tool ?? '', c.target ?? ''),
    key: dialogKey(c.body ?? [], c.approve) ?? null,
    target: dialogTarget(c.input ?? undefined),
    question,
    questionNames: question ? questionNames(c.body ?? [], question.question, question.options) : null,
    prompt,
    promptNames: prompt ? questionNames(c.body ?? [], prompt.question, prompt.options) : null,
  };
});
writeSync(1, JSON.stringify(out));
process.exit(0);
