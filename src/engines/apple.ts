/**
 * AppleContainerRuntimeEngine: Apple Containerization (`container` CLI)
 * as a RuntimeEngine.
 *
 * Verification ledger (macOS 26, `container --help` surface, 2026-09-18):
 * VERIFIED by help text: run/create/exec/stop/start/delete/kill/cp/logs/
 * inspect/list, volume + network create/list/inspect/delete, image
 * build/list, labels (-l/--label), --internal networks, --cap-drop,
 * -e/-u/-w/-i/-t exec flags, --mount, -v, --rm, delete --force.
 * ASSUMED (OCI conventions, no live daemon to confirm): image digests
 * look like sha256:hex; JSON list output carries names discoverable by
 * value matching. Anything depending on an assumption fails closed.
 *
 * Live lifecycle e2e is pending (the container machine was not running);
 * the engine reports verified:false until that pass lands, and doctor
 * surfaces it.
 */
import type { RunResult } from '../docker.js';
import type { ExecSpec } from './types.js';
import type { CreateOptions, RuntimeCapabilities, RuntimeEngine } from './runtime.js';

export const APPLE_CAPABILITIES: RuntimeCapabilities = {
  labels: true,
  internalNetworks: true,
  capDrop: true,
  vectorExec: true,
};

function fail(message: string): never {
  throw new Error(message);
}

/** Match a label in CLI form (key=value) or JSON form ("key": "value"). */
export function hasLabel(text: string, key: string, value: string): boolean {
  if (text.includes(`${key}=${value}`)) return true;
  const escaped = key.replace(/[^A-Za-z0-9_.-]/g, (char) => `\\${char}`);
  const valued = value.replace(/[^A-Za-z0-9_.-]/g, (char) => `\\${char}`);
  return new RegExp(`"${escaped}"\\s*:\\s*"${valued}"`).test(text);
}

/** Collect every string leaf of a JSON value for name matching without schema knowledge. */
export function jsonStringLeaves(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') {
    into.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) jsonStringLeaves(item, into);
  } else if (typeof value === 'object' && value !== null) {
    for (const entry of Object.values(value as Record<string, unknown>)) jsonStringLeaves(entry, into);
  }
  return into;
}

function parseJsonArray(output: string, what: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    fail(`apple runtime: cannot parse ${what} output`);
  }
  if (!Array.isArray(parsed)) fail(`apple runtime: unexpected ${what} shape`);
  return parsed as Record<string, unknown>[];
}

function digestOf(text: string): string | null {
  const match = /sha256:[0-9a-f]{12,64}/.exec(text);
  return match ? match[0] : null;
}

function errorOf(result: RunResult): string {
  return result.stderr.trim() || result.stdout.trim();
}

export const AppleContainerRuntimeEngine: RuntimeEngine = {
  name: 'apple',
  verified: false,
  capabilities: APPLE_CAPABILITIES,
  doctorProbes: { binary: 'container', args: ['system', 'status'] },
  displayName: 'Apple Container',

  execVector(container, options) {
    const args = ['exec', '-i'];
    if (options.tty !== false) args.push('-t');
    args.push('-u', options.user ?? 'agent');
    for (const [key, value] of Object.entries(options.env ?? {})) args.push('-e', `${key}=${value}`);
    args.push('-w', options.workdir, container, ...options.argv);
    const spec: ExecSpec = { command: 'container', args };
    return spec;
  },

  containerState(runner, container, workspaceId) {
    const listed = runner.run('container', ['list', '--all', '--format', 'json']);
    if (listed.status !== 0) fail(`apple runtime: cannot list containers: ${errorOf(listed)}`);
    const items = parseJsonArray(listed.stdout, 'container list');
    const item = items.find((entry) => jsonStringLeaves(entry).includes(container));
    if (!item) return 'absent';
    const raw = runner.run('container', ['inspect', container]);
    if (raw.status !== 0) return 'absent';
    const text = raw.stdout;
    if (!hasLabel(text, 'sandbox.managed', 'true')) return 'foreign';
    if (!hasLabel(text, 'sandbox.workspace', workspaceId)) return 'foreign';
    // Strict: the apple engine only touches containers it labeled itself.
    // Unlabeled legacy containers belong to another runtime: never adopt.
    if (!hasLabel(text, 'sandbox.runtime', 'apple')) return 'foreign';
    const probed = runner.run('container', ['exec', container, 'true']);
    return probed.status === 0 ? 'running' : 'stopped';
  },

  containerRuntime(runner, container) {
    const raw = runner.run('container', ['inspect', container]);
    if (raw.status !== 0) return null;
    const flat = raw.stdout.match(/sandbox\.runtime=([A-Za-z0-9_-]+)/);
    if (flat) return flat[1] as string;
    const json = /"sandbox\.runtime"\s*:\s*"([A-Za-z0-9_-]+)"/.exec(raw.stdout);
    return json ? (json[1] as string) : null;
  },

  ensureVolume(runner, volume, workspaceId) {
    if (AppleContainerRuntimeEngine.volumeExists(runner, volume)) return;
    const created = runner.run('container', [
      'volume', 'create',
      '--label', 'sandbox.managed=true',
      '--label', `sandbox.workspace=${workspaceId}`,
      '--label', 'sandbox.runtime=apple',
      volume,
    ]);
    if (created.status !== 0) fail(`apple runtime: cannot create volume ${volume}: ${errorOf(created)}`);
  },

  volumeExists(runner, volume) {
    return AppleContainerRuntimeEngine.listVolumes(runner).includes(volume);
  },

  ensureNetwork(runner, network, workspaceId, restricted) {
    if (AppleContainerRuntimeEngine.networkExists(runner, network)) {
      const internal = AppleContainerRuntimeEngine.networkInternal(runner, network);
      if (internal === restricted) return;
      // The internal flag is create-time immutable. Refuse to guess which
      // containers are attached: the operator stops them first.
      fail(
        `apple runtime: network ${network} policy changed; stop attached containers, ` +
          `delete the network with \`container network delete ${network}\`, then retry`,
      );
    }
    const args = [
      'network', 'create',
      '--label', 'sandbox.managed=true',
      '--label', `sandbox.workspace=${workspaceId}`,
      '--label', 'sandbox.runtime=apple',
    ];
    if (restricted) args.push('--internal');
    args.push(network);
    const created = runner.run('container', args);
    if (created.status !== 0) fail(`apple runtime: cannot create network ${network}: ${errorOf(created)}`);
  },

  containerNetworks(runner, container) {
    const raw = runner.run('container', ['inspect', container]);
    if (raw.status !== 0) return [];
    const found = new Set<string>();
    for (const match of raw.stdout.matchAll(/sandbox-net-[A-Za-z0-9_-]+/g)) found.add(match[0]);
    return [...found];
  },

  networkInternal(runner, network) {
    const raw = runner.run('container', ['network', 'inspect', network]);
    if (raw.status !== 0) fail(`apple runtime: cannot inspect network ${network}: ${errorOf(raw)}`);
    if (/"internal"\s*:\s*true/i.test(raw.stdout)) return true;
    if (/"internal"\s*:\s*false/i.test(raw.stdout)) return false;
    fail(`apple runtime: cannot determine internal flag of ${network} (unverified output shape)`);
  },

  createContainer(runner, entry, options: CreateOptions) {
    AppleContainerRuntimeEngine.ensureVolume(runner, options.homeVolume, entry.id);
    if (!AppleContainerRuntimeEngine.imageExists(runner, options.image)) {
      fail(`apple runtime: image not found locally: ${options.image}; build or pull it for this runtime first`);
    }
    const args = [
      'run', '-d', '--cap-drop', 'ALL', '--network', options.network, '--name', entry.container,
      '--label', 'sandbox.managed=true', '--label', `sandbox.workspace=${entry.id}`, '--label', 'sandbox.runtime=apple',
      '--mount', `type=bind,source=${entry.root},target=${options.workdir}`,
      '--mount', `type=volume,source=${options.homeVolume},target=/home/agent`,
    ];
    for (const mount of options.mounts) {
      if (mount !== entry.root) args.push('--mount', `type=bind,source=${mount},target=${mount},readonly`);
    }
    args.push(
      '-e', `SANDBOX_GENERATION=${options.generation}`,
      '-e', `SANDBOX_CONFIG_FINGERPRINT=${options.fingerprint}`,
      options.image, 'sleep', 'infinity',
    );
    const created = runner.run('container', args);
    if (created.status !== 0) fail(`apple runtime: cannot create container ${entry.container}: ${errorOf(created)}`);
  },

  startContainer(runner, container) {
    const started = runner.run('container', ['start', container]);
    if (started.status !== 0) fail(`apple runtime: cannot start container ${container}: ${errorOf(started)}`);
  },

  stopContainer(runner, container) {
    const stopped = runner.run('container', ['stop', container]);
    if (stopped.status !== 0) fail(`apple runtime: cannot stop container ${container}: ${errorOf(stopped)}`);
  },

  removeContainer(runner, container) {
    const removed = runner.run('container', ['delete', '--force', container]);
    if (removed.status !== 0) fail(`apple runtime: cannot remove container ${container}: ${errorOf(removed)}`);
  },

  containerImageId(runner, container) {
    const raw = runner.run('container', ['inspect', container]);
    if (raw.status !== 0) return null;
    return digestOf(raw.stdout);
  },

  referenceImageId(runner, image) {
    const listed = runner.run('container', ['image', 'list', '--format', 'json']);
    if (listed.status !== 0) return null;
    let items: Record<string, unknown>[];
    try {
      items = parseJsonArray(listed.stdout, 'image list');
    } catch {
      return null;
    }
    const item = items.find((entry) => jsonStringLeaves(entry).includes(image));
    if (!item) return null;
    return digestOf(JSON.stringify(item));
  },

  readReadyJson(runner, container) {
    const probed = runner.run('container', ['exec', container, 'cat', '/tmp/sandbox-ready/ready.json']);
    if (probed.status !== 0) return null;
    try {
      const parsed = JSON.parse(probed.stdout) as { generation?: unknown; fingerprint?: unknown; started_at?: unknown };
      if (typeof parsed.generation !== 'string' || typeof parsed.fingerprint !== 'string') return null;
      return {
        generation: parsed.generation,
        fingerprint: parsed.fingerprint,
        startedAt: typeof parsed.started_at === 'number' ? parsed.started_at : 0,
      };
    } catch {
      return null;
    }
  },

  imageExists(runner, image) {
    const listed = runner.run('container', ['image', 'list', '--format', 'json']);
    if (listed.status !== 0) return false;
    let items: Record<string, unknown>[];
    try {
      items = parseJsonArray(listed.stdout, 'image list');
    } catch {
      return false;
    }
    return items.some((entry) => jsonStringLeaves(entry).includes(image));
  },

  listManagedContainers(runner) {
    const listed = runner.run('container', ['list', '--all', '--format', 'json']);
    if (listed.status !== 0) return [];
    let items: Record<string, unknown>[];
    try {
      items = parseJsonArray(listed.stdout, 'container list');
    } catch {
      return [];
    }
    const names: string[] = [];
    for (const item of items) {
      const text = JSON.stringify(item);
      if (!text.includes('sandbox.managed')) continue;
      const leaves = jsonStringLeaves(item);
      const name = leaves.find((leaf) => leaf.startsWith('sandbox-') && !leaf.startsWith('sandbox-home-') && !leaf.startsWith('sandbox-net-'));
      if (name) names.push(name);
    }
    return names;
  },

  listContainers(runner) {
    const listed = runner.run('container', ['list', '--all', '--format', 'json']);
    if (listed.status !== 0) return [];
    let items: Record<string, unknown>[];
    try {
      items = parseJsonArray(listed.stdout, 'container list');
    } catch {
      return [];
    }
    const names: string[] = [];
    for (const item of items) {
      const leaves = jsonStringLeaves(item);
      const name = leaves.find((leaf) => leaf.startsWith('sandbox-') && !leaf.startsWith('sandbox-home-') && !leaf.startsWith('sandbox-net-'));
      if (name) names.push(name);
    }
    return names;
  },

  listVolumes(runner) {
    const listed = runner.run('container', ['volume', 'list', '--format', 'json']);
    if (listed.status !== 0) return [];
    let items: Record<string, unknown>[];
    try {
      items = parseJsonArray(listed.stdout, 'container volume list');
    } catch {
      return [];
    }
    const names: string[] = [];
    for (const item of items) {
      const leaves = jsonStringLeaves(item);
      const name = leaves.find((leaf) => leaf.startsWith('sandbox-'));
      if (name) names.push(name);
    }
    return names;
  },

  networkExists(runner, network) {
    const listed = runner.run('container', ['network', 'list', '--format', 'json']);
    if (listed.status !== 0) return false;
    let items: Record<string, unknown>[];
    try {
      items = parseJsonArray(listed.stdout, 'container network list');
    } catch {
      return false;
    }
    return items.some((entry) => jsonStringLeaves(entry).includes(network));
  },

  copyVolume(runner, source, destination, workspaceId) {
    AppleContainerRuntimeEngine.ensureVolume(runner, destination, workspaceId);
    const result = runner.run('container', [
      'run', '--rm',
      '--mount', `type=volume,source=${source},target=/from,readonly`,
      '--mount', `type=volume,source=${destination},target=/to`,
      'alpine', 'sh', '-c', 'cp -a /from/. /to/',
    ]);
    if (result.status !== 0) fail(`apple runtime: volume copy failed: ${errorOf(result)}`);
  },

  buildImage(runner, request) {
    const args = ['build', '-f', `${request.contextDir}/Dockerfile`];
    for (const [key, value] of Object.entries(request.buildArgs)) args.push('--build-arg', `${key}=${value}`);
    args.push('-t', request.tag, request.contextDir);
    const result = runner.run('container', args);
    if (result.status !== 0) {
      const tail = result.stdout.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim().length > 0).slice(-15).join('\n');
      const detail = [result.stderr.trim(), tail].filter((part) => part.length > 0).join('\n');
      fail(`apple runtime: image build failed:\n${detail}`);
    }
    return request.tag;
  },

  runOneShot(runner, image, env, argv) {
    const args = ['run', '--rm'];
    for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`);
    args.push(image, ...argv);
    return runner.run('container', args);
  },

  copyFromContainer(runner, container, containerPath, hostDir) {
    const result = runner.run('container', ['copy', `${container}:${containerPath}`, hostDir]);
    if (result.status !== 0) fail(`apple runtime: backup copy failed: ${errorOf(result)}`);
  },

  copyToContainer(runner, container, hostDir, containerPath) {
    const result = runner.run('container', ['copy', hostDir, `${container}:${containerPath}`]);
    if (result.status !== 0) fail(`apple runtime: restore copy failed: ${errorOf(result)}`);
  },

  containerLogs(runner, container, tail) {
    return runner.run('container', ['logs', '-n', tail, container]);
  },
};
