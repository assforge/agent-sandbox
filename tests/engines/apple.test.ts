import { describe, expect, it } from 'vitest';

import { AppleContainerRuntimeEngine } from '../../src/engines/apple.js';

function recordingRunner(calls: string[][]): { run: (command: string, args: string[]) => { status: number; stdout: string; stderr: string } } {
  return {
    run: (command: string, args: string[]) => {
      calls.push([command, ...args]);
      if (args.includes('image')) return { status: 0, stdout: '[{"name":"img"}]', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    },
  };
}

const options = {
  image: 'img',
  mounts: [],
  homeVolume: 'sandbox-home-w-1',
  network: 'sandbox-net-w-1',
  runtimeName: 'apple',
  generation: 'g',
  fingerprint: 'f',
};

describe('apple same-path mounts', () => {
  it('binds the workspace root at itself and prepares the target first', () => {
    const calls: string[][] = [];
    AppleContainerRuntimeEngine.createContainer(recordingRunner(calls), { id: 'w-1', container: 'sandbox-w-1', root: '/Users/u/repo' } as never, options);
    const prepare = calls.find((call) => call.includes('mkdir -p "$1"'));
    expect(prepare).toBeDefined();
    expect(prepare).toContain('/Users/u/repo');
    const created = calls.find((call) => call[0] === 'container' && call[1] === 'run' && call[2] === '-d');
    expect(created).toContain('type=bind,source=/Users/u/repo,target=/Users/u/repo');
  });

  it('passes a hostile workspace path as an argv element, never as shell code', () => {
    const calls: string[][] = [];
    // An apostrophe closes the quoting a naive `mkdir -p '${root}'` relies on,
    // and the separator would then run as root in the preparation one-shot.
    const root = "/Users/u/it's a repo; touch /tmp/pwned";
    AppleContainerRuntimeEngine.createContainer(recordingRunner(calls), { id: 'w-1', container: 'sandbox-w-1', root } as never, options);
    const prepare = calls.find((call) => call.includes('mkdir -p "$1"'));
    expect(prepare).toBeDefined();
    // Exactly one argv element carries the path, and no element mixes it with
    // the script text — that is the property the interpolation used to break.
    expect(prepare?.filter((arg) => arg.includes(root))).toHaveLength(1);
    expect(prepare?.some((arg) => arg.includes('mkdir') && arg.includes(root))).toBe(false);
  });
});
