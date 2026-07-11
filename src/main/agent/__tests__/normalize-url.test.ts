import { describe, it, expect } from 'vitest';
import { normalizeBaseURL } from '../providers.js';

describe('normalizeBaseURL', () => {
  it('uses default when endpoint is undefined', () => {
    expect(normalizeBaseURL(undefined, 'https://api.openai.com/v1')).toBe(
      'https://api.openai.com/v1',
    );
  });

  it('uses default when endpoint is empty', () => {
    expect(normalizeBaseURL('', 'https://api.openai.com/v1')).toBe(
      'https://api.openai.com/v1',
    );
  });

  it('trims trailing slashes', () => {
    expect(normalizeBaseURL('https://example.com/v1/', 'default')).toBe(
      'https://example.com/v1',
    );
  });

  it('auto-appends /v1 when missing (New API bare host)', () => {
    expect(normalizeBaseURL('http://10.114.22.18:3000', 'default')).toBe(
      'http://10.114.22.18:3000/v1',
    );
  });

  it('auto-appends /v1 to bare host with port', () => {
    expect(normalizeBaseURL('http://localhost:8080', 'default')).toBe(
      'http://localhost:8080/v1',
    );
  });

  it('does NOT append /v1 when already present', () => {
    expect(normalizeBaseURL('http://10.114.22.18:3000/v1', 'default')).toBe(
      'http://10.114.22.18:3000/v1',
    );
  });

  it('does NOT append /v1 when /v2 is present', () => {
    expect(normalizeBaseURL('https://api.example.com/v2', 'default')).toBe(
      'https://api.example.com/v2',
    );
  });

  it('does NOT append /v1 when /v1/ is present (trailing slash trimmed)', () => {
    expect(normalizeBaseURL('https://api.openai.com/v1/', 'default')).toBe(
      'https://api.openai.com/v1',
    );
  });

  it('appends /v1 to bare HTTPS URL', () => {
    expect(normalizeBaseURL('https://my-api.example.com', 'default')).toBe(
      'https://my-api.example.com/v1',
    );
  });

  it('preserves /api/plan/v1 path (glm case)', () => {
    expect(normalizeBaseURL('https://ark.cn-beijing.volces.com/api/plan/v1', 'default')).toBe(
      'https://ark.cn-beijing.volces.com/api/plan/v1',
    );
  });

  it('preserves /api/plan/v1 path with trailing slash', () => {
    expect(
      normalizeBaseURL('https://ark.cn-beijing.volces.com/api/plan/v1/', 'default'),
    ).toBe('https://ark.cn-beijing.volces.com/api/plan/v1');
  });
});
