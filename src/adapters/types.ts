import type { Agent, Activity, PermissionRequest } from '../db.ts';

export interface LaunchSpec {
  argv: string[];
  env: Record<string, string>;
  // Fields the adapter learned while preparing the launch, such as a session id.
  fields?: Partial<Agent>;
}

// The cost-signal classes an adapter reports for a provider error payload (build step 1 of
// docs/cost-policy.md). `limit` is a subscription window or rate limit, `credits` is an
// exhausted paid balance or a billing/quota error, `auth` is an authentication or
// authorization failure, and `transient` is a retryable provider failure (5xx, overloaded,
// network). Null means the payload is none of these, so the cost policy ignores it.
export type ErrorClass = 'limit' | 'credits' | 'auth' | 'transient';

export interface HookResult {
  activity?: Activity;
  detail?: string | null;
  session_id?: string;
  transcript_path?: string;
  last_message?: string;
  ended?: boolean;
  // The hook ran after a tool call, so a mail notice can ride on its output.
  afterTool?: boolean;
  // The agent finished its turn, so unread mail can arrive as a prompt.
  turnEnded?: boolean;
  // Printed to the hook's stdout, for example a mail notice as additionalContext.
  stdout?: string;
  // The harness shows a dialog that blocks the agent; stam makes it a permission request.
  // `replaces`: the hook names one dialog, so a pending request for another one is stale.
  dialog?: { action: string; details: string; replaces?: boolean };
}

export interface Adapter {
  name: string;
  // The harness's own upgrade command and version command.
  upgradeCommand: string;
  version(): string;
  // Runs after an upgrade, before agents restart, for example to restart a server.
  afterUpgrade?(): Promise<void>;
  // Runs once when the daemon starts, for example to start a harness server.
  start?(): Promise<void>;
  // The command that starts the harness. It never carries the agent's prompt or system
  // prompt: every process on the machine sees command lines (`ps`), and a broad
  // `pkill -f PATTERN` matches them.
  launch(agent: Agent, opts?: { resume?: boolean }): Promise<LaunchSpec>;
  // Runs once the harness's tmux session exists: answers launch dialogs, then starts the
  // first turn with `prompt` (spawn prompt, or the note of a resume or restart). Right
  // before it delivers the prompt it calls `admit`, the admission gate; on false it
  // delivers nothing and returns (stam has kept the prompt for later). `current`, with no side
  // effects, says whether this launch is still the agent's own (S-2123): once it isn't, the adapter
  // touches the session no more and returns quietly. Without it the launch counts as current.
  afterLaunch(agent: Agent, prompt?: string, opts?: { resume?: boolean; admit?: () => boolean; current?: () => boolean }): Promise<void>;
  // Starts a turn in an idle agent with this text, without typing into its terminal.
  // Returns false when the agent can't be reached right now.
  pushPrompt(agent: Agent, text: string): Promise<boolean>;
  // For harnesses that report through stam hook commands.
  onHook?(agent: Agent, payload: Record<string, any>): HookResult;
  // Classifies a provider error payload from this harness into a cost signal, or null when
  // the payload is not one (build step 1 of docs/cost-policy.md). Signals only: nothing
  // acts on the result yet.
  classifyError?(payload: Record<string, any>): ErrorClass | null;
  onStatusLine?(
    agent: Agent,
    payload: Record<string, any>,
  ): { context_tokens?: number; context_window?: number; cost?: number; tokensIn?: number; tokensOut?: number; tokensCacheRead?: number; tokensCacheWrite?: number; cacheTtl?: '1h' | '5m'; session?: string; subscription?: Record<string, any> };
  // Formats a notice as the after-tool hook output the harness shows the model.
  inTurnNotice?(text: string): string;
  // Types the human's own approval into the agent's input, which some safety checks
  // (Claude Code's auto mode) accept only as typed user input. Returns false when that
  // can't be done safely: the agent is busy, or someone has a draft in its input.
  typeHumanInput?(agent: Agent, text: string): Promise<boolean>;
  // Types a suggestion the human approved (S-422) into the agent's own input exactly as
  // written, then Enter, if `proceed` (asked right before Enter) still says yes. 'busy' (working,
  // a dialog, or no session) and 'draft' (someone's text in the box) type nothing; 'failed' (the
  // box didn't show exactly the text, or a menu stayed under it) and 'cancelled' (proceed said no)
  // erased what it typed.
  typeLiteralInput?(agent: Agent, text: string, proceed?: (stillTyped: () => boolean) => boolean | Promise<boolean>): Promise<'typed' | 'busy' | 'draft' | 'failed' | 'cancelled' | 'unsent'>;
  // What the agent's input box holds now (S-524), to tell the agent what blocks an approved line.
  inputText?(agent: Agent): string | undefined;
  // Answers the request's dialog on the agent's screen: yes, or no (cancel). A question dialog
  // takes `choice`, one of its option labels, instead of a yes. Types nothing when the dialog is
  // gone or its session ended ('gone'), or for a yes or choice it can't tie to the request's own
  // dialog ('unsafe'). A harness that answers over its API returns a promise; a throw keeps the
  // request pending.
  answerDialog?(agent: Agent, request: PermissionRequest, approve: boolean, choice?: string): ('typed' | 'gone' | 'unsafe') | Promise<'typed' | 'gone' | 'unsafe'>;
  // True when the harness sits at an empty input box, not running a turn or showing a
  // dialog. Lets the daemon correct a 'working' agent whose end-of-turn signal was lost.
  atPrompt?(agent: Agent): boolean | Promise<boolean>;
  // Whether the harness is still running the agent's turn with no tmux pane to show it, which a
  // server-backed harness (OpenCode's shared server) can do after its TUI exits. Lets a lost
  // terminal be checked against the harness itself before an unforced archive (S-578).
  turnRunning?(agent: Agent): Promise<boolean>;
  // Reconnects the agent's MCP servers without a restart. Returns false if only a restart can.
  // With `proceed`, it calls it right before the reload and skips the reload when it returns false.
  reconnectMcp?(agent: Agent, opts?: { proceed?: () => boolean }): Promise<boolean>;
  // Agents whose scope matches share one MCP client, so a reconnect replaces it for all of
  // them. Without it, each agent has its own.
  mcpScope?(agent: Agent): string;
  // Compacts the agent's conversation. `relaunch` means the harness was quit to do it
  // and stam must resume it.
  // `op` names the compaction; a compactor process the adapter starts carries it as STAM_COMPACTOR=AGENT:OP (S-358).
  compact?(agent: Agent, instructions?: string, opts?: { op?: string }): Promise<{ relaunch: boolean }>;
  // S-358: compact quits the harness and compacts headless, so a daemon restart can cut it short.
  compactQuits?: boolean;
  // Trims a session row a compactor stopped mid-write cut short (S-358).
  repairSession?(agent: Agent): Promise<void>;
  // Asks the harness to stop the agent's running turn through its own mechanism, as the
  // human's Esc would. Best effort: returns true only when a fresh signal confirms the turn
  // stopped. cost_switch tries it at its deadline, then stops the harness regardless.
  interrupt?(agent: Agent): Promise<boolean>;
  // Runs after stam killed the agent's tmux session: ends whatever of the harness outlives it
  // (a background server, a server-side turn), and throws unless that is confirmed. `keep`
  // says when the agent is running again: the stop then gives up without interrupting it.
  stop?(agent: Agent, opts?: { keep?: () => boolean }): Promise<void>;
}
