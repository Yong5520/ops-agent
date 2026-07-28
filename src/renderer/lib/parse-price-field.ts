// Parse a free-text per-million-token price field into number | undefined.
//
// Used by ModelConfigSection (V3-01 Cycle 5) to collect model pricing from the
// Settings form. undefined means "not configured" - the backend then computes
// estimated_usd = 0 but still persists the token totals. Pricing is
// non-negative; negatives and non-numeric input collapse to undefined so no
// NaN / negative leaks into the DB.
export function parsePriceField(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;

  const num = Number(trimmed);
  // Number('') === 0, but we already handled empty above. Reject NaN, Infinity,
  // and negatives. Allow 0 (free tier / zero-cost cache read).
  if (!Number.isFinite(num) || num < 0) return undefined;
  return num;
}
