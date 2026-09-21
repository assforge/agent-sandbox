import { describe, expect, it } from 'vitest';

import {
  agentEngine,
  agentEngines,
  BUILTIN_CATALOG,
  loadAgentCatalog,
  NativeAgentEngine,
  NpmAgentEngine,
} from '../../src/engines/agent.js';
import { runtimeEngine, RUNTIME_ENGINES, requireCapabilities } from '../../src/engines/runtime.js';
import { terminalEngine, TERMINAL_ENGINES } from '../../src/engines/terminal.js';

describe('engine registries', () => {
  it('resolves every known engine by name and rejects unknown names', () => {
    expect(agentEngine(agentEngines(), 'codex')).toBeInstanceOf(NpmAgentEngine);
    expect(agentEngine(agentEngines(), 'claude')).toBeInstanceOf(NativeAgentEngine);
    expect(terminalEngine('tmux').name).toBe('tmux');
    expect(terminalEngine('herder').name).toBe('herder');
    expect(runtimeEngine('docker').name).toBe('docker');
    expect(TERMINAL_ENGINES['tmux']).toBeDefined();
    expect(RUNTIME_ENGINES['docker']).toBeDefined();
    expect(() => terminalEngine('screen')).toThrow(/unknown terminal engine/);
    expect(() => runtimeEngine('podman')).toThrow(/unknown runtime engine/);
  });

  it('adds another agent through catalog data alone (AC-4)', () => {
    const document = JSON.parse(
      '[{"name":"nova","statePaths":[".nova"],"launch":["nova"],"npmPackage":null,"minimumVersion":"9.9.9"}]',
    ) as unknown;
    const extended = agentEngines(loadAgentCatalog(document));
    expect(agentEngine(extended, 'nova').launch).toEqual(['nova']);
    expect(extended.size).toBe(BUILTIN_CATALOG.length + 1);
  });

  it('fails catalog loading closed on any violation', () => {
    expect(() => loadAgentCatalog({})).toThrow(/must be an array/);
    expect(() => loadAgentCatalog([{ name: 'bad name!' }])).toThrow(/invalid name/);
    expect(() => loadAgentCatalog([{ name: 'x', statePaths: 's', launch: ['x'] }])).toThrow(/statePaths/);
    expect(() => loadAgentCatalog([{ name: 'x', statePaths: [], launch: ['x'] }])).toThrow(/statePaths/);
    expect(() => loadAgentCatalog([{ name: 'x', statePaths: ['s'], launch: [] }])).toThrow(/launch/);
    expect(() => loadAgentCatalog([{ name: 'x', statePaths: ['s'], launch: ['x'], npmPackage: 'p' }])).toThrow(/together/);
    expect(() => loadAgentCatalog([{ name: 'x', statePaths: ['s'], launch: ['x'], npmPackage: null, minimumVersion: null }])).toThrow(/minimum version/);
  });
});

describe('runtime capabilities', () => {
  it('fails closed when the engine cannot provide a required capability', () => {
    expect(() => requireCapabilities(runtimeEngine('docker'), true)).not.toThrow();
    expect(() =>
      requireCapabilities({ ...runtimeEngine('docker'), name: 'limited', capabilities: { labels: true, internalNetworks: false, capDrop: true, vectorExec: true } }, true),
    ).toThrow(/cannot provide restricted networks/);
  });
});
