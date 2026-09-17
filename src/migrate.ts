export interface LegacyResource {
  kind: 'container' | 'volume' | 'session';
  name: string;
}

export interface MigrationMapping {
  legacy: LegacyResource;
  destination: string;
  copiesState: boolean;
}

export interface MigrationPlan {
  source: string;
  mappings: MigrationMapping[];
}

const LEGACY_CONTAINERS = ['claude-relay-agents', 'pedantic_snyder'];
const LEGACY_VOLUMES = ['claude-relay-config', 'claude-relay-m2', 'claude-relay-pub', 'claude-relay-codex', 'claude-relay-xdg'];
const STATE_VOLUMES = ['claude-relay-config', 'claude-relay-codex', 'claude-relay-xdg'];

/**
 * Read-only dry-run inventory. Never touches legacy resources and never
 * includes secret values. Originals are always retained for recovery.
 */
export function dryRunMigration(existing: LegacyResource[], workspaceIdValue: string): MigrationPlan {
  const known = new Set<string>();
  for (const name of [...LEGACY_CONTAINERS, ...LEGACY_VOLUMES]) known.add(name);
  const mappings: MigrationMapping[] = [];
  for (const resource of existing) {
    if (!known.has(resource.name)) continue;
    const copiesState = resource.kind === 'volume' && STATE_VOLUMES.includes(resource.name);
    mappings.push({
      legacy: resource,
      destination: resource.kind === 'volume' ? `sandbox-home-${workspaceIdValue}` : `sandbox-${workspaceIdValue}`,
      copiesState,
    });
  }
  return { source: 'claude-relay', mappings };
}

export function approveMigration(plan: MigrationPlan, apply: boolean): string {
  if (!apply) return `dry-run: ${plan.mappings.length} legacy resources mapped, no changes made`;
  return `apply approved: copy ${plan.mappings.filter((m) => m.copiesState).length} state volumes after quiescing writers`;
}
