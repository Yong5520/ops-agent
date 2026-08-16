import { describe, it, expect } from 'vitest';
import { resolveQuickCommandHost } from '../quick-command-host.js';
import type { HostConfig } from '../../../shared/types.js';

function host(id: string, name: string): HostConfig {
  return {
    id,
    name,
    host: `${name}.example.com`,
    port: 22,
    username: 'root',
    connectionType: 'ssh',
  } as HostConfig;
}

describe('resolveQuickCommandHost (v24: no silent first-host fallback)', () => {
  const allHosts = [host('h1', 'web'), host('h2', 'db'), host('h3', 'cache')];

  it('resolves an explicit @host by name', () => {
    expect(resolveQuickCommandHost('db', [], allHosts)?.id).toBe('h2');
  });

  it('returns null for an unknown @host name', () => {
    expect(resolveQuickCommandHost('nope', [], allHosts)).toBeNull();
  });

  it('without @host, uses the session\'s first selected host (not the first host in the DB)', () => {
    // The old behavior fell back to hostsStore.list()[0] ('web') regardless
    // of the session selection - the bug this fixes.
    expect(resolveQuickCommandHost(undefined, ['h3', 'h1'], allHosts)?.id).toBe('h3');
  });

  it('without @host and no session selection, returns null instead of the first host', () => {
    expect(resolveQuickCommandHost(undefined, [], allHosts)).toBeNull();
    expect(resolveQuickCommandHost(undefined, undefined, allHosts)).toBeNull();
  });
});
