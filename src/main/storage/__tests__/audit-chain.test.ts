import { describe, it, expect } from 'vitest';
import { computeRowHash, verifyChain, type ChainRow } from '../audit-chain.js';

describe('computeRowHash', () => {
  it('produces a 64-char hex SHA-256 hash', () => {
    const hash = computeRowHash('some content', 'genesis');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic - same content + prevHash = same hash', () => {
    const h1 = computeRowHash('content', 'prev0');
    const h2 = computeRowHash('content', 'prev0');
    expect(h1).toBe(h2);
  });

  it('changes when content changes', () => {
    const h1 = computeRowHash('content-a', 'prev0');
    const h2 = computeRowHash('content-b', 'prev0');
    expect(h1).not.toBe(h2);
  });

  it('changes when prevHash changes', () => {
    const h1 = computeRowHash('content', 'prev-a');
    const h2 = computeRowHash('content', 'prev-b');
    expect(h1).not.toBe(h2);
  });

  it('produces genesis hash for empty prevHash', () => {
    const hash = computeRowHash('first row', '');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('verifyChain', () => {
  function makeRow(id: string, content: string, prevHash: string, rowHash?: string): ChainRow {
    return {
      id,
      content,
      prevHash,
      rowHash: rowHash ?? computeRowHash(content, prevHash),
    };
  }

  it('returns empty array for valid chain', () => {
    const rows: ChainRow[] = [
      makeRow('1', 'cmd-a', ''),
      makeRow('2', 'cmd-b', computeRowHash('cmd-a', '')),
      makeRow('3', 'cmd-c', computeRowHash('cmd-b', computeRowHash('cmd-a', ''))),
    ];
    const broken = verifyChain(rows);
    expect(broken).toEqual([]);
  });

  it('detects tampered content in middle row', () => {
    const h1 = computeRowHash('cmd-a', '');
    const h2 = computeRowHash('cmd-b', h1);
    const rows: ChainRow[] = [
      makeRow('1', 'cmd-a', ''),
      // Row 2: prevHash is correct (h1), but content was tampered from 'cmd-b' to 'TAMPERED'
      { id: '2', content: 'TAMPERED', prevHash: h1, rowHash: h2 },
      makeRow('3', 'cmd-c', h2),
    ];
    const broken = verifyChain(rows);
    expect(broken.length).toBe(1);
    expect(broken[0].id).toBe('2');
  });

  it('detects broken prevHash link', () => {
    const h1 = computeRowHash('cmd-a', '');
    const h2 = computeRowHash('cmd-b', h1);
    const h3 = computeRowHash('cmd-c', h2);
    // Row 3 has wrong prevHash (should be h2, but is 'WRONG')
    const rows: ChainRow[] = [
      makeRow('1', 'cmd-a', ''),
      makeRow('2', 'cmd-b', h1),
      { id: '3', content: 'cmd-c', prevHash: 'WRONG', rowHash: h3 },
    ];
    const broken = verifyChain(rows);
    expect(broken.length).toBe(1);
    expect(broken[0].id).toBe('3');
  });

  it('detects multiple broken rows', () => {
    const h1 = computeRowHash('cmd-a', '');
    const h2 = computeRowHash('cmd-b', h1);
    const rows: ChainRow[] = [
      makeRow('1', 'cmd-a', ''),
      { id: '2', content: 'TAMPERED', prevHash: h1, rowHash: h2 },
      { id: '3', content: 'also-tampered', prevHash: 'wrong', rowHash: 'deadbeef' },
    ];
    const broken = verifyChain(rows);
    expect(broken.length).toBe(2);
    expect(broken.map((b) => b.id)).toEqual(['2', '3']);
  });

  it('returns empty array for empty chain', () => {
    expect(verifyChain([])).toEqual([]);
  });

  it('handles single valid row', () => {
    const rows: ChainRow[] = [makeRow('1', 'only-row', '')];
    expect(verifyChain(rows)).toEqual([]);
  });
});
