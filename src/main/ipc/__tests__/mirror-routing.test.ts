import { describe, it, expect } from 'vitest';
import { mirrorEventTargets } from '../mirror-routing.js';

describe('mirrorEventTargets (v24: which windows get an agent/mirror event)', () => {
  it('without mirror windows, only the main window is targeted', () => {
    const targets = mirrorEventTargets({
      mainWindowId: 1,
      mirrorWindowIds: new Set<number>(),
      allWindowIds: new Set<number>([1]),
    });
    expect(targets).toEqual([1]);
  });

  it('mirror windows are added to the fan-out alongside the main window', () => {
    const targets = mirrorEventTargets({
      mainWindowId: 1,
      mirrorWindowIds: new Set<number>([7, 9]),
      allWindowIds: new Set<number>([1, 7, 9]),
    });
    expect(targets).toEqual([1, 7, 9]);
  });

  it('stale mirror window ids (window already closed) are dropped', () => {
    const targets = mirrorEventTargets({
      mainWindowId: 1,
      mirrorWindowIds: new Set<number>([7, 12]),
      allWindowIds: new Set<number>([1, 7]),
    });
    expect(targets).toEqual([1, 7]);
  });

  it('other windows (standalone terminals) are excluded', () => {
    const targets = mirrorEventTargets({
      mainWindowId: 1,
      mirrorWindowIds: new Set<number>([9]),
      allWindowIds: new Set<number>([1, 5, 9]),
    });
    expect(targets).toEqual([1, 9]);
  });
});
