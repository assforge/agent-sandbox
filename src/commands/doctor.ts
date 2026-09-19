import { readFileSync } from 'node:fs';
import { lookupWorkspace, networkName, type Registry } from '../registry.js';
import { resolveWorkspace } from '../resolve.js';
import { restoreClaimOf, restoreClaimState } from '../restore-claim.js';
import { homeMovePending } from '../paths.js';
import { collectProjectHookCommands, doctorExitCode, renderDoctorJson, renderDoctorText, runDoctor } from '../doctor.js';
import type { MainDeps } from './deps.js';
import { deadRosterWindows, loadRegistryOrThrow, probeNetworkInternal, selectRuntime, selectTerminal } from './lookup.js';
import { inspectRunningVersions, probeHookCommands } from './probes.js';

export async function doctorCommand(deps: MainDeps, workspace: string | undefined, json: boolean): Promise<number> {
  const registry: Registry = loadRegistryOrThrow(deps);
  const resolution = resolveWorkspace({ explicitRoot: workspace, cwd: deps.cwd, registry });
  const current = resolution.registered ? lookupWorkspace(registry, resolution.root) : null;
  const doctorRt = current ? selectRuntime(deps, current) : selectRuntime(deps);
  const doctorTerm = current ? selectTerminal(deps, current) : selectTerminal(deps);
  // Probed through the workspace's own engine. The literal docker call
  // that used to sit here reported on a runtime the workspace may not
  // use at all, and never reached the apple engine's own probe.
  const network = current ? networkName(current.id) : '';
  const networkExists = current ? doctorRt.networkExists(deps.runner, network) : false;
  const networkInternal = current ? probeNetworkInternal(doctorRt, deps.runner, network) : null;
  const deadWindows = current ? deadRosterWindows(deps, current) : [];
  // Doctor never refuses on a claim and never clears one: it reports it, like `status`.
  const claim = current ? restoreClaimOf(current) : null;
  let runningVersions: Record<string, string> | null = null;
  let unresolvedHookCommands: string[] | null = null;
  if (current && doctorRt.containerState(deps.runner, current.container, current.id) === 'running') {
    runningVersions = inspectRunningVersions(deps, doctorRt, current.container, current.root);
    const wanted = collectProjectHookCommands((path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    }, current.root);
    if (wanted.length > 0) {
      unresolvedHookCommands = probeHookCommands(deps, doctorRt, current.container, current.root, wanted);
    }
  }
  const checks = runDoctor(
    {
      nodeVersion: deps.nodeVersion,
      pathLookup: deps.pathLookup,
      commandSucceeds: deps.commandSucceeds,
      platform: deps.platform,
      runtime: {
        display: doctorRt.displayName,
        binary: doctorRt.doctorProbes.binary,
        args: doctorRt.doctorProbes.args,
        verified: doctorRt.verified,
      },
      terminal: {
        display: doctorTerm.name === 'tmux' ? 'tmux' : 'Herder',
        binary: doctorTerm.cliBinary,
        installHint: doctorTerm.installHint(deps.platform),
      },
    },
    {
      image: current?.image ?? null,
      network: current ? current.network : null,
      networkExists,
      networkInternal,
          deadWindows,
          runningVersions,
          recordedVersions: current?.agentVersions ?? null,
          unresolvedHookCommands,
      pendingHomeMove: homeMovePending(deps.homeDir),
      pendingRestore: claim ? { state: restoreClaimState(claim), source: claim.source } : null,
    },
  );
  deps.stdout(json ? renderDoctorJson(checks) : renderDoctorText(checks));
  return doctorExitCode(checks);
}
