// Unit tests for RunningCommandRegistry (V3-07 Cycle B).
//
// The registry maps a toolCallId to the AbortController for an in-flight
// command (tail -f, long grep, ...). stop_tail (or the UI stop button) looks
// up the controller by toolCallId and aborts it, which makes execCommand
// close the ssh2 stream and resolve with the partial output accumulated so
// far. Pure state module - no SSH, no IPC - so it runs directly in vitest.
import { describe, it, expect, vi } from 'vitest';
import {
  createRunningCommandRegistry,
  registerRunningCommand,
  unregisterRunningCommand,
  abortRunningCommand,
} from '../running-command-registry.js';

describe('RunningCommandRegistry', () => {
  it('register stores a controller and abort() triggers it', () => {
    const registry = createRunningCommandRegistry();
    const controller = new AbortController();
    const onAbort = vi.fn();
    controller.signal.addEventListener('abort', onAbort);

    registry.register('tc-1', controller);
    registry.abort('tc-1');

    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(controller.signal.aborted).toBe(true);
  });

  it('abort removes the entry so a second abort is a no-op', () => {
    const registry = createRunningCommandRegistry();
    const controller = new AbortController();
    const onAbort = vi.fn();
    controller.signal.addEventListener('abort', onAbort);

    registry.register('tc-2', controller);
    registry.abort('tc-2');
    registry.abort('tc-2'); // already removed - must not throw or double-fire

    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(registry.has('tc-2')).toBe(false);
  });

  it('abort of an unknown toolCallId is a safe no-op (no throw)', () => {
    const registry = createRunningCommandRegistry();
    expect(() => registry.abort('never-registered')).not.toThrow();
  });

  it('has() reflects registration state', () => {
    const registry = createRunningCommandRegistry();
    expect(registry.has('tc-3')).toBe(false);
    registry.register('tc-3', new AbortController());
    expect(registry.has('tc-3')).toBe(true);
  });

  it('unregister removes an entry without aborting', () => {
    const registry = createRunningCommandRegistry();
    const controller = new AbortController();
    const onAbort = vi.fn();
    controller.signal.addEventListener('abort', onAbort);

    registry.register('tc-4', controller);
    registry.unregister('tc-4');

    expect(registry.has('tc-4')).toBe(false);
    // unregister is a cleanup, NOT an abort - the command keeps running.
    expect(onAbort).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(false);
  });

  it('registering a second controller for the same toolCallId aborts the first', () => {
    // Should not happen in practice (toolCallIds are unique), but if it does we
    // must not leak an orphaned running command - abort the previous one.
    const registry = createRunningCommandRegistry();
    const first = new AbortController();
    const second = new AbortController();
    const firstOnAbort = vi.fn();
    first.signal.addEventListener('abort', firstOnAbort);

    registry.register('tc-5', first);
    registry.register('tc-5', second);

    expect(firstOnAbort).toHaveBeenCalledTimes(1);
    expect(registry.get('tc-5')).toBe(second);
  });

  it('get() returns the registered controller or undefined', () => {
    const registry = createRunningCommandRegistry();
    expect(registry.get('tc-6')).toBeUndefined();
    const controller = new AbortController();
    registry.register('tc-6', controller);
    expect(registry.get('tc-6')).toBe(controller);
  });
});

// ── V3-07 Cycle C: module-level singleton accessors ─────────────────────
// The global singleton is what the stop-tool IPC handler reaches via
// abortRunningCommand. These tests cover the public contract the renderer's
// Stop button depends on. They share the singleton, so each test uses a
// unique toolCallId and cleans up via unregister to avoid cross-test bleed.
describe('global singleton accessors', () => {
  it('abortRunningCommand returns false for an unregistered id', () => {
    expect(abortRunningCommand('singleton-unknown')).toBe(false);
  });

  it('registerRunningCommand + abortRunningCommand aborts the controller', () => {
    const id = 'singleton-running';
    const controller = new AbortController();
    const onAbort = vi.fn();
    controller.signal.addEventListener('abort', onAbort);

    registerRunningCommand(id, controller);
    expect(abortRunningCommand(id)).toBe(true);
    expect(onAbort).toHaveBeenCalledTimes(1);
    // Entry is removed by abort, so a second abort returns false.
    expect(abortRunningCommand(id)).toBe(false);

    unregisterRunningCommand(id); // cleanup (harmless no-op after abort)
  });

  it('unregisterRunningCommand removes without aborting', () => {
    const id = 'singleton-cleanup';
    const controller = new AbortController();
    const onAbort = vi.fn();
    controller.signal.addEventListener('abort', onAbort);

    registerRunningCommand(id, controller);
    unregisterRunningCommand(id);
    expect(abortRunningCommand(id)).toBe(false); // already removed
    expect(onAbort).not.toHaveBeenCalled();
  });
});
