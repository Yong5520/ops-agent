// A host grouped under its folder name, with the hosts in that folder.
export interface HostGroup<T> {
  group: string;
  hosts: T[];
}

// Group hosts by their `groupName` (falling back to 'default'), unioned with
// any explicitly-created folders (which may be empty), and return an ordered
// list: 'default' first, then the rest alphabetical. Shared by the Settings
// host list and the session target-host selector so both render the same
// grouped/collapsible structure. Generic over the host shape so it works for
// HostConfig and lighter test fixtures.
export function groupHostsByFolder<T extends { groupName?: string }>(
  hosts: T[],
  groups: string[],
): HostGroup<T>[] {
  const grouped = new Map<string, T[]>();
  for (const h of hosts) {
    const key = h.groupName || 'default';
    const arr = grouped.get(key) ?? [];
    arr.push(h);
    grouped.set(key, arr);
  }
  // Include explicitly-created folders that currently hold no hosts.
  for (const g of groups) {
    if (!grouped.has(g)) grouped.set(g, []);
  }
  const ordered = Array.from(grouped.keys());
  ordered.sort((a, b) => {
    if (a === 'default') return -1;
    if (b === 'default') return 1;
    return a.localeCompare(b);
  });
  return ordered.map((g) => ({ group: g, hosts: grouped.get(g) ?? [] }));
}
