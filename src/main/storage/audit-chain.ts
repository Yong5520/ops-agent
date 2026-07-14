// Audit log hash chain for tamper detection.
// Each audit log row stores:
//   - prev_hash: the row_hash of the previous row (empty string for genesis)
//   - row_hash: SHA-256 of (content + prev_hash)
//
// If any row is modified or deleted, the chain breaks and verifyChain()
// reports the broken row(s).
//
// Content is a concatenation of the fields that should be tamper-evident:
// command, command_type, authorization, host_name, host_ip, created_at.

import { createHash } from 'node:crypto';

export interface ChainRow {
  id: string;
  content: string;
  prevHash: string;
  rowHash: string;
}

// Compute the SHA-256 hash for a single row.
export function computeRowHash(content: string, prevHash: string): string {
  return createHash('sha256')
    .update(content)
    .update(prevHash)
    .digest('hex');
}

// Verify a chain of rows. Returns an array of broken row IDs.
// A row is "broken" if:
//   1. Its rowHash doesn't match computeRowHash(content, prevHash), OR
//   2. Its prevHash doesn't match the previous row's rowHash
export function verifyChain(rows: ChainRow[]): ChainRow[] {
  if (rows.length === 0) return [];

  const broken: ChainRow[] = [];
  let expectedPrevHash = '';

  for (const row of rows) {
    // Check 1: prevHash must match the previous row's rowHash
    if (row.prevHash !== expectedPrevHash) {
      broken.push(row);
      // Update expectedPrevHash to this row's rowHash so we can
      // continue checking subsequent rows
      expectedPrevHash = row.rowHash;
      continue;
    }

    // Check 2: rowHash must match recomputed hash
    const recomputed = computeRowHash(row.content, row.prevHash);
    if (recomputed !== row.rowHash) {
      broken.push(row);
    }

    expectedPrevHash = row.rowHash;
  }

  return broken;
}
