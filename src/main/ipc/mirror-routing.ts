// Pure routing decision for agent events that must reach BOTH the main
// window and any open activity-mirror windows (v24).
//
// Extracted from handlers.ts so the fan-out policy is unit-testable without
// importing electron.

export interface MirrorRoutingInput {
  /** The main (chat) window id. */
  mainWindowId: number;
  /** Window ids registered as open activity-mirror windows. */
  mirrorWindowIds: Set<number>;
  /** Ids of all currently-alive BrowserWindows. */
  allWindowIds: Set<number>;
}

/**
 * Which window ids an agent tool/mirror event should be sent to: the main
 * window plus every still-alive mirror window. Stale mirror ids (window
 * closed without deregistering) are dropped. Other windows (standalone
 * terminals) are left out - they don't render agent events.
 */
export function mirrorEventTargets(input: MirrorRoutingInput): number[] {
  const targets = new Set<number>([input.mainWindowId]);
  for (const id of input.mirrorWindowIds) {
    if (input.allWindowIds.has(id)) targets.add(id);
  }
  return [...targets];
}
