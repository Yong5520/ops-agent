import { describe, it, expect } from 'vitest';
import { groupHostsByFolder } from '../host-groups.js';

interface TestHost {
  id: string;
  name: string;
  groupName?: string;
}

function host(name: string, groupName?: string): TestHost {
  return groupName ? { id: name, name, groupName } : { id: name, name };
}

describe('groupHostsByFolder', () => {
  it('groups hosts by groupName with default fallback', () => {
    const result = groupHostsByFolder([host('a', 'web'), host('b'), host('c', 'web')], []);
    expect(result.map((g) => g.group)).toEqual(['default', 'web']);
    expect(result[0].hosts.map((h) => h.name)).toEqual(['b']);
    expect(result[1].hosts.map((h) => h.name)).toEqual(['a', 'c']);
  });

  it('puts default first, then the rest alphabetical', () => {
    const result = groupHostsByFolder([host('a', 'zeta'), host('b', 'alpha'), host('c')], []);
    expect(result.map((g) => g.group)).toEqual(['default', 'alpha', 'zeta']);
  });

  it('includes empty folders from the explicit groups list', () => {
    const result = groupHostsByFolder([host('a', 'web')], ['web', 'db', 'default']);
    const names = result.map((g) => g.group);
    expect(names).toEqual(['default', 'db', 'web']);
    const db = result.find((g) => g.group === 'db')!;
    expect(db.hosts).toEqual([]);
  });

  it('handles a host with undefined groupName as default', () => {
    const result = groupHostsByFolder([host('x')], []);
    expect(result).toHaveLength(1);
    expect(result[0].group).toBe('default');
  });

  it('returns empty array for no hosts and no groups', () => {
    expect(groupHostsByFolder([], [])).toEqual([]);
  });

  it('dedupes when a group is both explicit and host-derived', () => {
    const result = groupHostsByFolder([host('a', 'web')], ['web']);
    const webGroups = result.filter((g) => g.group === 'web');
    expect(webGroups).toHaveLength(1);
    expect(webGroups[0].hosts).toHaveLength(1);
  });
});
