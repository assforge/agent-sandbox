import { describe, expect, it } from 'vitest';

import { AppleContainerRuntimeEngine } from '../../src/engines/apple.js';

describe('apple same-path mounts', () => {
  it('binds the workspace root at itself and prepares the target first', () => {
    const calls: string[][] = [];
    const runner = {
      run: (command: string, args: string[]) => {
        calls.push([command, ...args]);
        if (args.includes('image')) return { status: 0, stdout: '[{"name":"img"}]', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      },
    };
    AppleContainerRuntimeEngine.createContainer(runner, { id: 'w-1', container: 'sandbox-w-1', root: '/Users/u/repo' } as never, {
      image: 'img',
      mounts: [],
      homeVolume: 'sandbox-home-w-1',
      network: 'sandbox-net-w-1',
      runtimeName: 'apple',
      generation: 'g',
      fingerprint: 'f',
    });
    const prepare = calls.find((call) => call.includes('mkdir -p \'/Users/u/repo\''));
    expect(prepare).toBeDefined();
    const created = calls.find((call) => call[0] === 'container' && call[1] === 'run' && call[2] === '-d');
    expect(created).toContain('type=bind,source=/Users/u/repo,target=/Users/u/repo');
  });
});
