import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BackupRefusedError, backupWorkspace, copyRestoreHome, planRestore } from '../backup.js';
import { dryRunMigration } from '../migrate.js';
import { acquireLock } from '../lock.js';
import {
  type Registry,
  type WorkspaceEntry,
} from '../registry.js';
import { CliError, type MainDeps } from './deps.js';
import { resolveAndEnsure, selectRuntime, withRegistry } from './lookup.js';
import { selectTerminal } from './lookup.js';
import { takeRestOption } from './ui.js';
import { UsageError } from '../cli.js';
/** Read the workspace id from a backup manifest without touching the registry. */function peekBackupId(outputDir: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(outputDir, 'workspace.json'), 'utf8')) as { id?: unknown };
    if (typeof parsed.id !== 'string' || !parsed.id) throw new Error('bad id');
    return parsed.id;
  } catch {
    throw new CliError(`backup is missing or invalid: ${join(outputDir, 'workspace.json')}`, 1);
  }
}
export async function workspaceBackup(deps: MainDeps, registry: Registry, rest: string[], workspace: string | undefined): Promise<number> {
  const output = takeRestOption(rest, ['--output', '-o']);
  if (!output) throw new UsageError('workspace backup requires --output <path>');
  const entry = await resolveAndEnsure(deps, registry, workspace);
  const rt = selectRuntime(deps, entry);
  const handle = acquireLock(deps.lockDir, entry.id);
  try {
    const receipt = backupWorkspace(
      {
        copyFromContainer: (container, from, to) => {
          try {
            rt.copyFromContainer(deps.runner, container, from, to);
          } catch (error) {
            throw new CliError((error as Error).message, 1);
          }
        },
        copyToContainer: (container, from, to) => {
          try {
            rt.copyToContainer(deps.runner, container, from, to);
          } catch (error) {
            throw new CliError((error as Error).message, 1);
          }
        },
      },
      entry,
      output,
    );
    deps.stdout(`backup of ${receipt.workspace} written to ${receipt.outputDir}\n`);
    return 0;
  } finally {
    handle.release();
  }
}
export async function workspaceRestore(deps: MainDeps, registry: Registry, rest: string[], workspace: string | undefined): Promise<number> {
  const input = takeRestOption(rest, ['--input']);
  if (!input) throw new UsageError('workspace restore requires --input <path>');
  // Exempt from the claim it is about to write, and from one left by a crashed
  // predecessor: this command is what clears it.
  const entry = await resolveAndEnsure(deps, registry, workspace, { allowPendingRestore: true });
  const rt = selectRuntime(deps, entry);
  const manifestId = peekBackupId(input);
  if (manifestId !== entry.id) {
    throw new CliError(`backup belongs to ${manifestId}, not to ${entry.id}; nothing was changed`, 1);
  }
  const approved = await deps.confirm(`restore ${entry.id} from ${input}? Running state will be overwritten.`);
  if (!approved) throw new CliError('restore cancelled; nothing was changed', 1);
  const handle = acquireLock(deps.lockDir, entry.id);
  try {
    // The registry half is a short transaction. The volume copy is the slow half and
    // is deliberately outside it, so the registry lock is never held across a copy.
    //
    // The claim is written *before* the copy, because a crash during the copy is the
    // only case nothing else on disk would report. A re-run overwrites it in this same
    // transaction and clears it in the one below, which is why stop-and-re-run is safe:
    // copying over a half-copy completes it.
    const restored = withRegistry(deps, (live) => {
      let target: WorkspaceEntry;
      try {
        target = planRestore(live, input, deps.homeDir);
      } catch (error) {
        // A refused backup path is the restore-side twin of a refused
        // mount at registration, which exits 2.
        if (error instanceof BackupRefusedError) throw new CliError(error.message, 2);
        throw error;
      }
      if (target.id !== entry.id) {
        throw new CliError(`backup identity changed during restore; nothing was saved`, 1);
      }
      target.pendingOperation = {
        kind: 'restore',
        source: input,
        startedAt: new Date().toISOString(),
        pid: process.pid,
      };
      return target;
    });
    copyRestoreHome(
      {
        copyFromContainer: (container, from, to) => {
          try {
            rt.copyFromContainer(deps.runner, container, from, to);
          } catch (error) {
            throw new CliError((error as Error).message, 1);
          }
        },
        copyToContainer: (container, from, to) => {
          try {
            rt.copyToContainer(deps.runner, container, from, to);
          } catch (error) {
            throw new CliError((error as Error).message, 1);
          }
        },
      },
      restored,
      input,
    );
    // The copy completed, so the home is determinate again. Cleared in a second short
    // transaction, after the slow work -- never held across it.
    withRegistry(deps, (live) => {
      const target = live.workspaces[restored.id];
      if (target) delete target.pendingOperation;
    });
    deps.stdout(`restored ${restored.id} from ${input}; restart the workspace to cut over\n`);
    return 0;
  } finally {
    handle.release();
  }
}
export async function workspaceMigrate(deps: MainDeps, registry: Registry, rest: string[], workspace: string | undefined): Promise<number> {
  const source = takeRestOption(rest, ['--source']);
  if (source !== 'claude-relay') throw new UsageError('workspace migrate requires --source claude-relay');
  const apply = rest.includes('--apply');
  const inventoryRt = selectRuntime(deps);
  const inventoryTerm = selectTerminal(deps);
  const existing = [
    ...inventoryRt.listContainers(deps.runner).map((name) => ({ kind: 'container' as const, name })),
    ...inventoryRt.listVolumes(deps.runner).map((name) => ({ kind: 'volume' as const, name })),
    ...inventoryTerm.listSessions(deps.runner).map((name) => ({ kind: 'session' as const, name })),
  ];
  const entry = await resolveAndEnsure(deps, registry, workspace);
  const rt = selectRuntime(deps, entry);
  const plan = dryRunMigration(existing, entry.id);
  deps.stdout(`dry-run: ${plan.mappings.length} legacy resources mapped, originals retained\n`);
  for (const mapping of plan.mappings) {
    deps.stdout(`  ${mapping.legacy.kind} ${mapping.legacy.name} -> ${mapping.destination}${mapping.copiesState ? ' (state)' : ''}\n`);
  }
  if (!apply) return 0;
  const approved = await deps.confirm('copy approved agent state and interrupt writers?');
  if (!approved) throw new CliError('migrate cancelled; nothing was changed', 1);
  const handle = acquireLock(deps.lockDir, entry.id);
  try {
    let copied = 0;
    for (const mapping of plan.mappings) {
      if (!mapping.copiesState || mapping.legacy.kind !== 'volume') continue;
      rt.ensureVolume(deps.runner, mapping.destination, entry.id);
      try {
        rt.copyVolume(deps.runner, mapping.legacy.name, mapping.destination, entry.id);
      } catch (error) {
        throw new CliError(`migrate copy failed for ${mapping.legacy.name}: ${(error as Error).message}`, 1);
      }
      copied += 1;
    }
    deps.stdout(`migrate apply complete: ${copied} state volumes copied; originals retained for recovery\n`);
    return 0;
  } finally {
    handle.release();
  }
}
