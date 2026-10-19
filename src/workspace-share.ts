import * as db from './db.ts';
import { queueNotice } from './mail.ts';

// Workspace shares (S-896): an agent with a personal workspace grants another agent read or write
// access to that folder. `read` is advisory, since every agent runs as one Unix user; `write` is
// enforced only where the harness has a sandbox (Codex writable roots). Claude Code gets the path
// in additionalDirectories at its next launch, and every grantee gets a notice now.
export type Access = 'read' | 'write';
export interface Grant { owner: string; path: string; access: Access }

// The live agent whose personal workspace is the folder; an archived owner's folder may be adopted by a respawn.
function holderName(path: string): string | undefined {
  return db.listAgents().filter((a) => a.personal_workspace === path && a.lifecycle !== 'archived').pop()?.name;
}

// The folders shared with an agent, owner name first, sorted.
export function grantsFor(agentId: string): Grant[] {
  const rows = db.open().prepare('SELECT workspace, access, granted_by FROM workspace_grants WHERE grantee_id = ? ORDER BY workspace').all(agentId) as { workspace: string; access: Access; granted_by: string }[];
  return rows.map((r) => ({ owner: holderName(r.workspace) ?? db.getAgent(r.granted_by)?.name ?? r.granted_by, path: r.workspace, access: r.access }));
}

export function grantedPaths(agentId: string, access?: Access): string[] {
  return grantsFor(agentId).filter((g) => !access || g.access === access).map((g) => g.path);
}

// The agent and every predecessor that forwards to it, directly or through others.
function chainOf(id: string): string[] {
  const ids = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const a of db.listAgents()) if (a.forwarded_to && ids.has(a.forwarded_to) && !ids.has(a.id)) { ids.add(a.id); grew = true; }
  }
  return [...ids];
}

// A cost-switch successor holds the same grants as its predecessor (cost-switch.ts move()).
export function copyGrants(fromId: string, toId: string): void {
  db.open().prepare('INSERT OR IGNORE INTO workspace_grants (workspace, grantee_id, access, granted_by, granted_at) SELECT workspace, ?, access, granted_by, granted_at FROM workspace_grants WHERE grantee_id = ?').run(toId, fromId);
}

// Who a folder is shared with, for its owner's block.
export function sharesOf(path: string): { name: string; access: Access }[] {
  const rows = db.open().prepare('SELECT grantee_id, access FROM workspace_grants WHERE workspace = ? ORDER BY grantee_id').all(path) as { grantee_id: string; access: Access }[];
  return rows.flatMap((r) => { const a = db.getAgent(r.grantee_id); return a && a.lifecycle !== 'archived' && !a.forwarded_to ? [{ name: a.name, access: r.access }] : []; });
}

// What the grantee is told: Claude Code reads its allowed directories at launch, so a read before
// then raises a permission dialog; Codex write roots apply at launch too.
export function shareNotice(ownerName: string, harness: string, path: string, access: Access): string {
  const note = access === 'write' ? 'You may read and write there.' : 'You may read there; please don\'t write (stam can\'t enforce it).';
  const when = harness === 'claude' ? ' It becomes an allowed directory at your next launch; don\'t read it before then, since that raises a permission dialog.' : harness === 'codex' && access === 'write' ? ' It becomes writable at your next launch; you can read it now.' : ' Use it now.';
  return `${ownerName} shared its workspace \`${path}\` with you (${access}). ${note}${when}`;
}

// Claude Code reads its allowed directories at launch and Codex reads write roots at launch, so a
// revoked grant of those stays usable until the next launch. Codex read grants and OpenCode never
// had a launch gate, so the sandbox never limited them.
function outlivesRevoke(harness: string, access: Access): boolean {
  return harness === 'claude' || (harness === 'codex' && access === 'write');
}

// What the grantee is told on revoke: the folder stays reachable until its next launch where a
// launch gated the access, and otherwise the sandbox never enforced it, so the grantee must stop.
export function revokeNotice(ownerName: string, path: string, harness: string, access: Access): string {
  const tail = outlivesRevoke(harness, access)
    ? ' The folder stays reachable until your next launch, so don\'t use it before then either.'
    : ' Nothing enforced this access, so it isn\'t cut off: please just stop using the folder.';
  return `${ownerName} stopped sharing its workspace \`${path}\` with you. Stop using it.${tail}`;
}

// What the owner's tool result says: when the revoked access actually ends.
export function revokeMessage(granteeName: string, path: string, harness: string, access: Access): string {
  const end = outlivesRevoke(harness, access)
    ? `Access ends at ${granteeName}'s next launch, not now.`
    : `Nothing enforced this access, so ${granteeName} must stop using the folder itself.`;
  return `Stopped sharing ${path} with ${granteeName}. ${end}`;
}

// Grants (or with `none` revokes) the caller's workspace to `granteeRef`. Idempotent per pair.
export function share(ownerRef: string, granteeRef: string, access: string): { message: string } {
  if (access !== 'read' && access !== 'write' && access !== 'none') throw new Error(`access must be read, write or none, not ${access}`);
  const owner = db.getAgent(ownerRef);
  if (!owner) throw new Error(`no agent ${ownerRef}`);
  if (!owner.personal_workspace) throw new Error(`${owner.name} has no personal workspace to share; spawn it with a workspace first`);
  // A grantee that was cost-switched is its live successor (the predecessor is stopped).
  const found = db.getAgent(granteeRef);
  const grantee = found && db.getAgent(db.forwardTarget(found.id));
  if (!grantee || !found) throw new Error(`no agent ${granteeRef} on this machine: a workspace folder is local, so it can only be shared with an agent on ${owner.machine}`);
  if (grantee.machine !== owner.machine) throw new Error(`${grantee.name} runs on ${grantee.machine}, and the workspace folder is on ${owner.machine}`);
  if (grantee.id === owner.id) throw new Error('an agent already has access to its own workspace');
  if (grantee.lifecycle === 'archived') throw new Error(`${grantee.name} is archived`);
  const d = db.open();
  const path = owner.personal_workspace;
  if (access === 'none') {
    // Every agent of the grantee's switch chain loses it, the successor and the stopped predecessors.
    // The access is read before the delete: a write grant's launch gate decides what the revoke says.
    // `held` is what the live grantee had: its own row, not a stopped predecessor's.
    let n = 0, held: Access = 'read';
    for (const id of chainOf(grantee.id)) {
      if (id === grantee.id && (d.prepare('SELECT access FROM workspace_grants WHERE workspace = ? AND grantee_id = ?').get(path, id) as { access: Access } | undefined)?.access === 'write') held = 'write';
      n += Number(d.prepare('DELETE FROM workspace_grants WHERE workspace = ? AND grantee_id = ?').run(path, id).changes);
    }
    if (n) queueNotice(grantee.id, revokeNotice(owner.name, path, grantee.harness, held));
    return { message: n ? revokeMessage(grantee.name, path, grantee.harness, held) : `${path} wasn't shared with ${grantee.name}.` };
  }
  const prev = d.prepare('SELECT access FROM workspace_grants WHERE workspace = ? AND grantee_id = ?').get(path, grantee.id) as { access: Access } | undefined;
  d.prepare('INSERT INTO workspace_grants (workspace, grantee_id, access, granted_by, granted_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace, grantee_id) DO UPDATE SET access = excluded.access, granted_by = excluded.granted_by, granted_at = excluded.granted_at').run(path, grantee.id, access, owner.id, new Date().toISOString());
  if (prev?.access !== access) {
    queueNotice(grantee.id, shareNotice(owner.name, grantee.harness, path, access));
  }
  return { message: `Shared ${path} with ${grantee.name} (${access}).` };
}
