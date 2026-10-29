// The dry run of pr_open (S-3287): the result type and its text, shared by the MCP tool and `stam pr open --predict`. Kept apart from
// pr-open.ts so the CLI can print it without loading the daemon's modules.

export interface PredictedTest {
  name: string;
  // The path and rule that matched, as the refusal prints them.
  why: string;
  // 'passed': a LIGHT test pr_open ran and passed, so the body needs no line. 'absent': the branch's test/run.sh lacks it (merge
  // origin/main). 'body': the body must carry `NAME: PASS` (a LIGHT test that failed, timed out or wasn't run is 'body' with `advisory`).
  need: 'passed' | 'absent' | 'body';
  advisory?: string;
}

// A test file the diff removes cases from (S-3665): the count, and up to REMOVED_SHOWN of the titles.
export interface RemovedTests {
  path: string;
  count: number;
  titles: string[];
}

export const REMOVED_SHOWN = 10;

export interface PrPrediction {
  branch: string;
  head: string;
  base: string;
  // False for a repo with a .stam/repo.json: its gates are on its Gates line, and no NAME: PASS line is predicted.
  applies: boolean;
  tests: PredictedTest[];
  // The exact `NAME: PASS` lines the body must carry.
  lines: string[];
  note: string | null;
  message?: string;
  // The test cases the diff removes, per file. Informational: a prediction never refuses for them. Absent or empty when none.
  removed?: RemovedTests[];
  // The branch the PR merges into, by name (S-3740): the push line names it.
  baseName?: string;
  // The worktree head this call pushed to origin before predicting (S-3740). Absent when the call pushed nothing.
  pushed?: string;
}

// The test cases in a test file's text: `test(` and `it(` titles in a .test.mjs, .test.ts or .test.tsx file, `func TestX` names in a
// _test.go file. Empty for any other path.
export function testCaseTitles(path: string, text: string): string[] {
  if (path.endsWith('_test.go')) return [...new Set([...text.matchAll(/^func (Test\w*)\(/gm)].map((m) => m[1]))];
  if (!isVitestFile(path)) return [];
  return [...new Set([...text.matchAll(/^\s*(?:test|it)\(\s*(['"`])((?:(?!\1).)+)\1/gm)].map((m) => m[2]))];
}

function isVitestFile(path: string): boolean {
  return ['.test.mjs', '.test.ts', '.test.tsx'].some((ext) => path.endsWith(ext));
}

export function isTestFile(path: string): boolean {
  return isVitestFile(path) || path.endsWith('_test.go');
}

export function formatPrediction(p: PrPrediction): string {
  const text = formatTests(p);
  const body = p.removed?.length ? [text, ...formatRemoved(p.removed)].join('\n') : text;
  return p.pushed && p.baseName ? [formatPushed(p.branch, p.pushed, p.baseName), body].join('\n') : body;
}

// The push line (S-3740): the sha predict pushed, and the follow-ups that keep it, since an amend or rebase after it needs a force push.
function formatPushed(branch: string, pushed: string, base: string): string {
  return `pushed ${branch} at ${pushed.slice(0, 8)}; to change it, add a commit or merge origin/${base}. An amend or rebase needs a force push.`;
}

// The removal section (S-3665): nothing when no case is removed, so the output of a diff that only adds cases is unchanged.
function formatRemoved(removed: RemovedTests[]): string[] {
  const rows = removed.map((r) => {
    const shown = r.titles.map((t) => `"${t}"`).join(', ');
    const more = r.count > r.titles.length ? ` and ${r.count - r.titles.length} more` : '';
    return `- ${r.path}: ${r.count} test case${r.count === 1 ? '' : 's'} removed: ${shown}${more}`;
  });
  return ['Test cases the diff removes (informational; pr_open does not refuse for them):', ...rows];
}

function formatTests(p: PrPrediction): string {
  const head = `Dry run for ${p.branch} at ${p.head.slice(0, 8)} on ${p.base.slice(0, 8)}: nothing was pushed to GitHub or opened.`;
  if (!p.applies) return `${head}\n${p.message ?? 'This repo has no NAME: PASS lines.'}`;
  if (p.tests.length === 0) return `${head}\nThe gate adds no tests for this branch's files: the body needs no NAME: PASS line.${p.note ? `\n${p.note}` : ''}`;
  const row = (t: PredictedTest): string => `- ${t.name} (${t.why}): ${t.need === 'passed' ? 'pr_open ran it and it passed; no body line' : t.need === 'absent' ? "not in this branch's test/run.sh: merge origin/main first" : `the body needs \`${t.name}: PASS\`${t.advisory ? `; ${t.advisory}` : ''}`}`;
  const out = [head, 'Predicted tests:', ...p.tests.map(row)];
  if (p.lines.length) out.push('The body must carry these lines (run each with scripts/test-slot.sh test/run.sh NAME first):', ...p.lines);
  else out.push('The body needs no NAME: PASS line.');
  if (p.note) out.push(p.note);
  return out.join('\n');
}
