// Permission modes (S-1967). stam keeps one mode per agent, 'default' (the harness asks),
// 'auto' (stam's usual mode), or 'bypass' (no checks), and each adapter maps it to its harness.
// Settings › permission modes picks the mode new agents start in, per harness and per agent type;
// a running agent whose mode came from there is listed when they change, and switched on apply.
import { isDeepStrictEqual } from 'node:util';
import * as db from './db.ts';
import { settings } from './settings.ts';

export type PermissionMode = 'default' | 'auto' | 'bypass';
export const MODES: PermissionMode[] = ['default', 'auto', 'bypass'];

export const isMode = (m: unknown): m is PermissionMode => MODES.includes(m as PermissionMode);

// Each harness's modes in its own words, and which ones Settings offers. 'default' is offered only
// where the harness's own prompts reach stam's permission requests, so a parent or the chief of
// staff can answer them: Claude Code's dialogs do (its PermissionRequest hook). Codex's approvals
// and OpenCode's permission asks only show in the agent's terminal and conversation view, so an
// agent in 'default' would wait there for the human; the backend takes the mode, Settings hides it.
export const HARNESS_MODES: Record<string, { mode: PermissionMode; label: string; harness: string; offered: boolean }[]> = {
  claude: [
    { mode: 'default', label: 'Ask', harness: '--permission-mode default', offered: true },
    { mode: 'auto', label: 'Auto', harness: '--permission-mode auto', offered: true },
    { mode: 'bypass', label: 'Bypass', harness: '--permission-mode bypassPermissions', offered: true },
  ],
  codex: [
    { mode: 'default', label: 'Ask', harness: 'on-request, workspace-write, you review', offered: false },
    { mode: 'auto', label: 'Auto', harness: 'on-request, workspace-write, auto review', offered: true },
    { mode: 'bypass', label: 'Bypass', harness: 'never, danger-full-access', offered: true },
  ],
  opencode: [
    { mode: 'default', label: 'Ask', harness: 'ask for every tool', offered: false },
    { mode: 'auto', label: 'Auto', harness: "OpenCode's own rules", offered: true },
    { mode: 'bypass', label: 'Bypass', harness: 'allow every tool', offered: true },
  ],
};

// OpenCode sets a session's permission rules when the session is made. A resume re-applies the
// agent's current mode's rules (session.update, S-1891), so the rules follow the mode at each launch;
// but applying a mode change to a running OpenCode agent is not done in place (apply skips it), so
// the change takes effect at its next launch. The other harnesses take the mode again on resume.
export const switchesInPlace = (harness: string) => harness !== 'opencode';

// The mode a new agent of this harness and type starts in: the type's override, then the
// harness's setting, then 'auto'.
export function effectiveMode(harness: string, type: string | null | undefined): PermissionMode {
  const p = settings().permissionModes;
  const t = type ? p.types[type] : undefined;
  if (isMode(t)) return t;
  const h = p.harness[harness];
  return isMode(h) ? h : 'auto';
}

// An agent from before S-1967 has no source: an 'auto' one followed the old default, so it follows
// the settings; a bypass one was the human's own pick.
export function permissionSource(a: db.Agent): 'settings' | 'manual' {
  if (a.permission_source === 'settings' || a.permission_source === 'manual') return a.permission_source;
  return a.permission_mode === 'auto' ? 'settings' : 'manual';
}

export interface StaleAgent {
  id: string;
  name: string;
  harness: string;
  type: string | null;
  mode: string;
  want: PermissionMode;
  // false: an OpenCode agent, which takes the new mode at its next launch (see switchesInPlace).
  inPlace: boolean;
  // Why its last switch failed: its restart quit the harness and the launch failed, so it is shut
  // down on its old mode, and apply retries by resuming it on the new one. Null otherwise.
  failed: string | null;
}

// The error of the agent's last mode switch when that switch failed, or null.
export function failedSwitch(id: string): string | null {
  const r = db.open().prepare("SELECT type, data FROM events WHERE agent_id = ? AND type IN ('permission-mode', 'permission-mode:failed') ORDER BY id DESC LIMIT 1").get(id) as { type: string; data: string | null } | undefined;
  return r?.type === 'permission-mode:failed' ? String(JSON.parse(r.data ?? '{}').error ?? 'failed') : null;
}

// Agents that follow the settings and run another mode than the settings now give them: the running
// ones, and the ones a failed switch left shut down.
export function staleAgents(): StaleAgent[] {
  return db
    .listAgents()
    .filter((a) => permissionSource(a) === 'settings' && a.permission_mode !== effectiveMode(a.harness, a.type))
    .map((a) => ({ a, failed: a.lifecycle === 'shut_down' ? failedSwitch(a.id) : null }))
    .filter(({ a, failed }) => a.lifecycle === 'active' || a.lifecycle === 'paused' || failed !== null)
    .map(({ a, failed }) => ({ id: a.id, name: a.name, harness: a.harness, type: a.type, mode: a.permission_mode, want: effectiveMode(a.harness, a.type), inPlace: switchesInPlace(a.harness), failed }));
}

// What a mode switch undoes when its launch fails: the mode and source it set, who set it, and
// the mode and source it replaced. A deferred restart carries it to the end of the agent's step.
export interface SwitchUndo {
  mode: string;
  source: string;
  by: string;
  kept: { permission_mode: string; permission_source: string | null };
}

// A switch's launch failed: the old mode and source come back, and permission-mode:failed keeps a
// settings agent on the stale list (see failedSwitch), so apply can retry it. Only while the row still
// holds what the switch set: a newer choice, such as the human's own pick while a restart waited for
// the step's end, stays.
export function switchFailed(id: string, u: SwitchUndo, e: unknown): void {
  const now = db.getAgent(id);
  const ours = now?.permission_mode === u.mode && now.permission_source === u.source;
  if (ours) db.updateAgent(id, u.kept);
  db.addEvent(id, 'permission-mode:failed', { mode: u.mode, source: u.source, by: u.by, kept: ours ? u.kept.permission_mode : (now?.permission_mode ?? null), error: e instanceof Error ? e.message : String(e) });
}

// Logs a change to Settings › permission modes, with who made it and the agents it leaves on their
// old mode. Called after each settings write that may change them; an unchanged write logs nothing.
export function noteSettingsChange(before: ReturnType<typeof settings>['permissionModes'], by: string): void {
  const after = settings().permissionModes;
  if (isDeepStrictEqual(before, after)) return;
  db.addEvent('human', 'permission-modes', { by, before, after, stale: staleAgents().map((s) => s.name) });
}
