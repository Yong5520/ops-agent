// Registry of in-flight commands keyed by toolCallId (V3-07 Cycle B).
//
// When execReadTool starts a long-running command (tail -f, a slow grep, ...),
// it creates an AbortController, registers it here under the toolCallId, and
// passes controller.signal into execCommand. stop_tail (or the UI stop button)
// looks up the controller by toolCallId and aborts it - execCommand then closes
// the ssh2 stream and resolves with the partial output accumulated so far.
//
// Pure state module (a Map wrapper) so it is unit-testable without SSH/IPC.

export interface RunningCommandRegistry {
  /** Register the AbortController for an in-flight command. If a controller is
   * already registered for this toolCallId, it is aborted first (defensive -
   * toolCallIds should be unique, but we must not leak an orphaned command). */
  register(toolCallId: string, controller: AbortController): void;
  /** Abort the command for toolCallId and remove the entry. Safe no-op if the
   * id is unknown or already aborted/removed. */
  abort(toolCallId: string): void;
  /** Remove an entry WITHOUT aborting - cleanup for a command that finished
   * normally (execCommand resolved/rejected on its own). */
  unregister(toolCallId: string): void;
  /** True iff a controller is currently registered for toolCallId. */
  has(toolCallId: string): boolean;
  /** The registered controller, or undefined. */
  get(toolCallId: string): AbortController | undefined;
}

export function createRunningCommandRegistry(): RunningCommandRegistry {
  const controllers = new Map<string, AbortController>();

  return {
    register(toolCallId, controller) {
      const existing = controllers.get(toolCallId);
      if (existing && !existing.signal.aborted) {
        // Defensive: abort a previous in-flight command for the same id so it
        // does not leak. Should not happen in practice (toolCallIds are unique).
        existing.abort();
      }
      controllers.set(toolCallId, controller);
    },

    abort(toolCallId) {
      const controller = controllers.get(toolCallId);
      if (!controller) return; // unknown / already removed - safe no-op
      controllers.delete(toolCallId);
      if (!controller.signal.aborted) {
        controller.abort();
      }
    },

    unregister(toolCallId) {
      controllers.delete(toolCallId);
    },

    has(toolCallId) {
      return controllers.has(toolCallId);
    },

    get(toolCallId) {
      return controllers.get(toolCallId);
    },
  };
}

// Module-level singleton. The renderer's Stop button reaches the registry via
// an IPC handler (handlers.ts) that calls abortRunningCommand(toolCallId) -
// it cannot reach the per-run registry inside createTools, so a singleton is
// used. Safe because toolCallIds are globally unique and at most one agent run
// is active at a time.
const globalRegistry = createRunningCommandRegistry();

/** Abort the in-flight command for toolCallId, if any. Returns true if a
 * command was found and signaled to stop. Used by the stop-tool IPC handler. */
export function abortRunningCommand(toolCallId: string): boolean {
  if (!globalRegistry.has(toolCallId)) return false;
  globalRegistry.abort(toolCallId);
  return true;
}

/** Register a controller with the global singleton (used by execReadTool). */
export function registerRunningCommand(toolCallId: string, controller: AbortController): void {
  globalRegistry.register(toolCallId, controller);
}

/** Unregister a controller on normal completion (used by execReadTool). */
export function unregisterRunningCommand(toolCallId: string): void {
  globalRegistry.unregister(toolCallId);
}
