import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execHttpHook } from '../http-executor.js';
import type { HookConfig, HookInput } from '../../../../shared/types.js';

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ permissionDecision: 'deny', blockMessage: 'blocked' }));
    } else if (req.url === '/error') {
      res.writeHead(500);
      res.end('Internal Server Error');
    } else if (req.url === '/slow') {
      setTimeout(() => {
        res.writeHead(200);
        res.end(JSON.stringify({ permissionDecision: 'pass' }));
      }, 5000);
    } else if (req.url === '/invalid') {
      res.writeHead(200);
      res.end('not json');
    } else if (req.url === '/empty') {
      res.writeHead(200);
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://localhost:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const baseInput: HookInput = {
  id: 'h1',
  name: 'test',
  event: 'PreToolUse',
  type: 'http',
  config: { name: 'test', event: 'PreToolUse', type: 'http', url: '', timeoutMs: 5000 },
  condition: { toolName: '*' },
  enabled: true,
  createdAt: '2026-01-01',
  input: { command: 'rm -rf /' },
};

describe('execHttpHook', () => {
  it('parses JSON response from 200 OK', async () => {
    const config: HookConfig = { ...baseInput.config, url: `${baseUrl}/ok` };
    const result = await execHttpHook(config, baseInput);
    expect(result).toEqual({ permissionDecision: 'deny', blockMessage: 'blocked' });
  });

  it('returns null on 500 response', async () => {
    const config: HookConfig = { ...baseInput.config, url: `${baseUrl}/error` };
    const result = await execHttpHook(config, baseInput);
    expect(result).toBeNull();
  });

  it('returns null on timeout', async () => {
    const config: HookConfig = { ...baseInput.config, url: `${baseUrl}/slow`, timeoutMs: 100 };
    const result = await execHttpHook(config, baseInput);
    expect(result).toBeNull();
  }, 10000);

  it('returns null on invalid JSON response', async () => {
    const config: HookConfig = { ...baseInput.config, url: `${baseUrl}/invalid` };
    const result = await execHttpHook(config, baseInput);
    expect(result).toBeNull();
  });

  it('returns null on empty response body', async () => {
    const config: HookConfig = { ...baseInput.config, url: `${baseUrl}/empty` };
    const result = await execHttpHook(config, baseInput);
    expect(result).toBeNull();
  });
});
