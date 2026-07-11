import { describe, it, expect } from 'vitest';
import { getReconnectDelay, MAX_RECONNECT_ATTEMPTS, shouldAttemptReconnect } from '../reconnect.js';

describe('reconnect strategy', () => {
  describe('getReconnectDelay', () => {
    it('returns 1000ms for first attempt (attempt=0)', () => {
      expect(getReconnectDelay(0)).toBe(1000);
    });

    it('returns 3000ms for second attempt (attempt=1)', () => {
      expect(getReconnectDelay(1)).toBe(3000);
    });

    it('returns 10000ms for third attempt (attempt=2)', () => {
      expect(getReconnectDelay(2)).toBe(10000);
    });

    it('returns 0 for out-of-range attempts', () => {
      expect(getReconnectDelay(3)).toBe(0);
      expect(getReconnectDelay(99)).toBe(0);
    });
  });

  describe('MAX_RECONNECT_ATTEMPTS', () => {
    it('is 3', () => {
      expect(MAX_RECONNECT_ATTEMPTS).toBe(3);
    });
  });

  describe('shouldAttemptReconnect', () => {
    it('returns true when session not closed and attempt within limit', () => {
      expect(shouldAttemptReconnect(false, 0)).toBe(true);
      expect(shouldAttemptReconnect(false, 1)).toBe(true);
      expect(shouldAttemptReconnect(false, 2)).toBe(true);
    });

    it('returns false when session was closed by user', () => {
      expect(shouldAttemptReconnect(true, 0)).toBe(false);
      expect(shouldAttemptReconnect(true, 2)).toBe(false);
    });

    it('returns false when attempt exceeds max', () => {
      expect(shouldAttemptReconnect(false, 3)).toBe(false);
      expect(shouldAttemptReconnect(false, 10)).toBe(false);
    });
  });
});
