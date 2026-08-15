import { describe, it, expect } from 'vitest';
import { filterHosts, hostMatchesQuery, normalizeSearchQuery } from '../host-search.js';

// Minimal host shape that satisfies SearchableHost. Uses `name` as the id so
// tests read naturally. Mirrors the host-groups.test.ts fixture style.
interface TestHost {
  id: string;
  name: string;
  host: string;
  username: string;
  groupName?: string;
  port?: number;
}

function host(overrides: Partial<TestHost> & { name: string }): TestHost {
  return {
    id: overrides.name,
    host: '10.0.0.1',
    username: 'root',
    port: 22,
    ...overrides,
  };
}

describe('normalizeSearchQuery', () => {
  it('trims and lowercases', () => {
    expect(normalizeSearchQuery('  Web01 ')).toBe('web01');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeSearchQuery('   ')).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(normalizeSearchQuery('')).toBe('');
  });

  it('is idempotent on already-normalized input', () => {
    expect(normalizeSearchQuery(normalizeSearchQuery('  Web01 '))).toBe('web01');
  });
});

describe('hostMatchesQuery', () => {
  const h = host({
    name: 'web01',
    host: '10.31.10.110',
    username: 'ubuntu',
    groupName: 'Web组',
    port: 2222,
  });

  it('returns true for an empty query (matches everything)', () => {
    expect(hostMatchesQuery(h, '')).toBe(true);
  });

  it('returns true for a whitespace-only query', () => {
    expect(hostMatchesQuery(h, '   ')).toBe(true);
  });

  it('matches the name case-insensitively', () => {
    expect(hostMatchesQuery(h, 'WEB')).toBe(true);
  });

  it('matches a substring of the name', () => {
    expect(hostMatchesQuery(h, 'eb0')).toBe(true);
  });

  it('matches the host (IP) field', () => {
    expect(hostMatchesQuery(h, '10.31')).toBe(true);
  });

  it('matches the username field', () => {
    expect(hostMatchesQuery(h, 'ubuntu')).toBe(true);
  });

  it('matches the groupName field (unicode-safe)', () => {
    expect(hostMatchesQuery(h, 'web组')).toBe(true);
  });

  it('matches the port as a string', () => {
    expect(hostMatchesQuery(h, '2222')).toBe(true);
  });

  it('returns false when no field matches', () => {
    expect(hostMatchesQuery(h, 'nopeXYZ')).toBe(false);
  });

  it('still matches by name when groupName is undefined', () => {
    const noGroup = host({ name: 'solo', groupName: undefined });
    expect(hostMatchesQuery(noGroup, 'solo')).toBe(true);
  });

  it('does not match on groupName when it is undefined', () => {
    const noGroup = host({ name: 'solo', groupName: undefined });
    expect(hostMatchesQuery(noGroup, 'Web组')).toBe(false);
  });

  it('matches when port is undefined (ignores missing port)', () => {
    const noPort = host({ name: 'noport', port: undefined });
    expect(hostMatchesQuery(noPort, 'noport')).toBe(true);
  });
});

describe('filterHosts', () => {
  const hosts: TestHost[] = [
    host({ name: 'web01', host: '10.31.10.110', username: 'ubuntu', groupName: 'Web', port: 22 }),
    host({ name: 'db01', host: '10.31.20.5', username: 'postgres', groupName: 'DB', port: 5432 }),
    host({ name: 'gpu01', host: '10.31.30.1', username: 'root', groupName: 'GPU', port: 22 }),
  ];

  it('returns the same array reference for an empty query (pass-through)', () => {
    expect(filterHosts(hosts, '')).toBe(hosts);
  });

  it('returns the same array reference for a whitespace-only query', () => {
    expect(filterHosts(hosts, '   ')).toBe(hosts);
  });

  it('filters by name substring', () => {
    expect(filterHosts(hosts, 'web').map((h) => h.name)).toEqual(['web01']);
  });

  it('filters by IP substring', () => {
    expect(filterHosts(hosts, '10.31.20').map((h) => h.name)).toEqual(['db01']);
  });

  it('filters by username', () => {
    expect(filterHosts(hosts, 'postgres').map((h) => h.name)).toEqual(['db01']);
  });

  it('filters by groupName', () => {
    expect(filterHosts(hosts, 'gpu').map((h) => h.name)).toEqual(['gpu01']);
  });

  it('returns all hosts matching a given port (substring)', () => {
    const result = filterHosts(hosts, '22').map((h) => h.name).sort();
    expect(result).toEqual(['gpu01', 'web01']);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterHosts(hosts, 'zzz')).toEqual([]);
  });

  it('is case-insensitive', () => {
    expect(filterHosts(hosts, 'WEB01').map((h) => h.name)).toEqual(['web01']);
  });

  it('does not mutate the input array', () => {
    const snapshot = [...hosts];
    filterHosts(hosts, 'web');
    expect(hosts).toEqual(snapshot);
  });

  it('returns a new array instance when filtering (not the input)', () => {
    expect(filterHosts(hosts, 'web')).not.toBe(hosts);
  });

  it('handles an empty hosts array', () => {
    expect(filterHosts([], 'web')).toEqual([]);
  });

  it('preserves the host object identity in the filtered output', () => {
    const result = filterHosts(hosts, 'web');
    expect(result[0]).toBe(hosts[0]);
  });
});
