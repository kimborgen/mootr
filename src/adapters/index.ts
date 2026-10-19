import type { Adapter } from './types.ts';
import { claude } from './claude.ts';
import { opencode } from './opencode.ts';
import { codex } from './codex.ts';

export const adapters: Record<string, Adapter> = { claude, opencode, codex };

// Each harness's part of stam's own agent view (src/agent-view.ts).
import { register } from '../agent-view.ts';
import { opencodeView } from './opencode-view.ts';
import { codexView } from './codex-view.ts';
import { claudeView } from './claude-view.ts';
register('opencode', opencodeView);
register('codex', codexView);
register('claude', claudeView);
