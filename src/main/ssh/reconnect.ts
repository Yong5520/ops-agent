// Reconnect strategy for SSH terminal sessions.
//
// When a terminal stream closes unexpectedly (not user-initiated), we attempt
// to re-establish the connection with exponential backoff. The delays are:
//   attempt 0 -> 1s
//   attempt 1 -> 3s
//   attempt 2 -> 10s
// After MAX_RECONNECT_ATTEMPTS failures, we give up and notify the user.

export const MAX_RECONNECT_ATTEMPTS = 3;

const BACKOFF_DELAYS = [1000, 3000, 10000] as const;

export function getReconnectDelay(attempt: number): number {
  if (attempt < 0 || attempt >= BACKOFF_DELAYS.length) return 0;
  return BACKOFF_DELAYS[attempt];
}

export function shouldAttemptReconnect(sessionClosed: boolean, attempt: number): boolean {
  if (sessionClosed) return false;
  return attempt < MAX_RECONNECT_ATTEMPTS;
}
