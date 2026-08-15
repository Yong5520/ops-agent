// A host (or host-like object) whose fields can be searched. Generic so it
// works for the full HostConfig as well as lighter test fixtures, mirroring
// the groupHostsByFolder pattern in host-groups.ts.
export interface SearchableHost {
  name: string;
  host: string;
  username: string;
  groupName?: string;
  port?: number;
}

// Normalize a raw search query: trim surrounding whitespace and lowercase.
// Whitespace-only input collapses to '' so callers can treat "no query" as a
// single empty-string case.
export function normalizeSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

// True if any searchable field of `host` contains the (normalized) query.
// An empty/whitespace query matches everything. Matching is case-insensitive
// substring across name / host / username / groupName / port. Undefined
// optional fields (groupName, port) are simply skipped.
export function hostMatchesQuery(host: SearchableHost, query: string): boolean {
  const q = normalizeSearchQuery(query);
  if (!q) return true;
  const fields = [
    host.name,
    host.host,
    host.username,
    host.groupName,
    host.port != null ? String(host.port) : '',
  ];
  return fields.some((field) => field != null && field.toLowerCase().includes(q));
}

// Filter a list of hosts by a search query. An empty/whitespace query returns
// the original array unchanged (no copy) so "no search" is a zero-cost
// pass-through and callers can cheaply detect it. Otherwise a new filtered
// array is returned; the input is never mutated.
export function filterHosts<T extends SearchableHost>(hosts: T[], query: string): T[] {
  const q = normalizeSearchQuery(query);
  if (!q) return hosts;
  return hosts.filter((h) => hostMatchesQuery(h, q));
}
