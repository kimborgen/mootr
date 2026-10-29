// S-3454: a launch's first prompt counts as taken by the first UserPromptSubmit that is not a stam
// channel push. A channel push starts a turn of its own (a restart's wrap-up to a launch still
// starting), and it can come before the typed prompt is submitted, so it must not end the wait
// while the typed prompt is still in the box. Any other hook counts, as it did before, including
// a hook with no string prompt. Claude Code submits a long multi-line prompt wrapped in
// `<pasted_content>` tags, so the text is never compared with what was typed.
// One entry per agent: a launch that is superseded or ends calls done, and a later launch
// replaces the entry, so only the launch that is still waiting can be marked taken.
const awaiting = new Map<string, { taken: boolean }>();

const isChannelPush = (prompt: unknown): boolean => typeof prompt === 'string' && prompt.trimStart().startsWith('<channel source="stam"');

export function awaitFirstPrompt(agentId: string): { taken(): boolean; done(): void } {
  const mine = { taken: false };
  awaiting.set(agentId, mine);
  return {
    taken: () => mine.taken,
    done: () => {
      if (awaiting.get(agentId) === mine) awaiting.delete(agentId);
    },
  };
}

// The agent's UserPromptSubmit hook: marks the awaited first prompt taken unless the turn is a channel push.
export function firstPromptHook(agentId: string, prompt: unknown): void {
  const mine = awaiting.get(agentId);
  if (mine && !isChannelPush(prompt)) mine.taken = true;
}
