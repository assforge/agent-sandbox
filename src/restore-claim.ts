import { pidAlive } from './lock.js';
import type { PendingOperation, WorkspaceEntry } from './registry.js';

/**
 * The `restore` claim: the one long operation whose interruption nothing else on
 * disk reports.
 *
 * `restore` replaces the workspace entry wholesale from the backup, then copies
 * the home volume back over the live one. The workspace lock serialises it
 * against every other home-touching command, so a *concurrent* run simply waits
 * and then finds a complete home. Nothing protects a run that **dies**: the lock
 * is reclaimed by pid liveness, so a crash mid-copy leaves a half-copied home,
 * an already-replaced entry, and no record that either happened. The claim is
 * that record. It exists for death, not for concurrency.
 *
 * Two rules read it, and only two:
 *
 *   - every other command refuses while a claim is outstanding, naming the backup
 *     to re-run from (`restorePendingRefusal`, thrown by the CLI);
 *   - `status` reports it and `doctor` warns about it, mutating nothing.
 *
 * `restore` itself is exempt: it is the operation that clears the claim.
 *
 * Why *every* command, and not only the ones that touch the home: a re-run
 * rebuilds the entry from the backup file and replaces the entry wholesale, so a
 * `mount` or a `configure` accepted in the window between the interruption and
 * the re-run is **guaranteed** to be discarded by it. Refusing is the only
 * answer that never hands the user a change that is certain to be lost. The rule
 * is deliberately one rule with two carve-outs rather than a per-command
 * judgement about which writes are independent of a restore -- that judgement is
 * the thing that would get one wrong.
 */

/** The outstanding claim on a workspace, or null. */
export function restoreClaimOf(entry: WorkspaceEntry): PendingOperation | null {
  return entry.pendingOperation ?? null;
}

/**
 * `restore in progress (pid N)` when the claiming process is alive,
 * `restore-interrupted` when it is not.
 *
 * The distinction is *descriptive only* -- both states freeze the workspace
 * identically, because the honest meaning of either is "the home is
 * indeterminate; re-run restore". It is reported so a user can tell "something
 * is running right now" from "something died", not so a caller can treat them
 * differently. A pid recycled by an unrelated process reads as "in progress";
 * that mislabels the state and changes nothing else.
 */
export function restoreClaimState(claim: PendingOperation): string {
  return pidAlive(claim.pid) ? `restore in progress (pid ${claim.pid})` : 'restore-interrupted';
}

/** The re-run that clears the claim, as a pasteable command. */
export function restoreRerunCommand(claim: PendingOperation): string {
  return `sandbox workspace restore --input ${claim.source}`;
}

/** The refusal message for every frozen command. Names the one thing the user needs. */
export function restorePendingRefusal(entry: WorkspaceEntry, claim: PendingOperation): string {
  return (
    `workspace ${entry.id} has an unfinished restore (${restoreClaimState(claim)}, started ${claim.startedAt}); ` +
    `its home is indeterminate and no other command may touch it -- re-run: ${restoreRerunCommand(claim)} --workspace ${entry.root}`
  );
}
