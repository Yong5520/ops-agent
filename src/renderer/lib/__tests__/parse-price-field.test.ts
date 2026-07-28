// Unit tests for the price-field parser used by ModelConfigSection (V3-01 Cycle 5).
//
// Pure function - mirrors the cost-tracking.test.ts pattern. The Settings form
// collects per-million-token pricing as free-text strings; parsePriceField
// normalizes them into number | undefined for the ModelProviderInput payload
// (undefined = "not configured" -> estimated_usd = 0, tokens still persisted).
import { describe, it, expect } from 'vitest';
import { parsePriceField } from '../parse-price-field.js';

describe('parsePriceField', () => {
  it('returns undefined for empty / whitespace-only input', () => {
    expect(parsePriceField('')).toBeUndefined();
    expect(parsePriceField('   ')).toBeUndefined();
    expect(parsePriceField('\t')).toBeUndefined();
  });

  it('parses a plain integer string', () => {
    expect(parsePriceField('3')).toBe(3);
    expect(parsePriceField('15')).toBe(15);
  });

  it('parses a decimal string', () => {
    expect(parsePriceField('0.3')).toBe(0.3);
    expect(parsePriceField('3.75')).toBe(3.75);
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(parsePriceField('  3 ')).toBe(3);
    expect(parsePriceField(' 0.30 ')).toBe(0.3);
  });

  it('returns undefined for non-numeric input (no NaN leaks into the DB)', () => {
    expect(parsePriceField('abc')).toBeUndefined();
    expect(parsePriceField('3 dollars')).toBeUndefined();
    expect(parsePriceField('$3')).toBeUndefined();
  });

  it('allows zero (free tier / cache-read at 0 cost)', () => {
    expect(parsePriceField('0')).toBe(0);
    expect(parsePriceField('0.0')).toBe(0);
  });

  it('returns undefined for negative values (pricing is non-negative)', () => {
    expect(parsePriceField('-1')).toBeUndefined();
    expect(parsePriceField('-0.5')).toBeUndefined();
  });

  it('rejects Infinity / NaN-producing strings', () => {
    expect(parsePriceField('Infinity')).toBeUndefined();
    expect(parsePriceField('NaN')).toBeUndefined();
  });
});
