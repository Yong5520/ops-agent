import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoisted mocks - referenced inside vi.mock factories, so they must be
// created with vi.hoisted (vi.mock is hoisted above imports).
const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  getCachedHostFacts: vi.fn(),
  refreshHostFactsInBackground: vi.fn(),
}));

vi.mock('ai', () => ({
  generateText: (...args: unknown[]) => mocks.generateText(...args),
}));

vi.mock('../facts.js', () => ({
  getCachedHostFacts: (...args: unknown[]) => mocks.getCachedHostFacts(...args),
  refreshHostFactsInBackground: (...args: unknown[]) => mocks.refreshHostFactsInBackground(...args),
}));

vi.mock('../providers.js', () => ({
  getActiveModel: () => ({ modelId: 'test-model' }),
}));

vi.mock('../../storage/hosts.js', () => ({
  hostsStore: { get: (id: string) => ({ id, name: 'host1' }) },
}));

vi.mock('../../storage/models.js', () => ({
  modelsStore: { getActive: () => null },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

import { parseCommandResponse, generateCommand, clearCommandCache } from '../ai-command.js';

describe('parseCommandResponse', () => {
  it('parses valid JSON response', () => {
    const raw = '{"command":"du -sh .","explanation":"统计目录大小","safetyLevel":"read"}';
    const result = parseCommandResponse(raw);
    expect(result.command).toBe('du -sh .');
    expect(result.explanation).toBe('统计目录大小');
    expect(result.safetyLevel).toBe('read');
  });

  it('extracts JSON from surrounding text', () => {
    const raw = `好的，这是命令：
{"command":"free -h","explanation":"显示内存使用","safetyLevel":"read"}
希望对您有帮助。`;
    const result = parseCommandResponse(raw);
    expect(result.command).toBe('free -h');
    expect(result.explanation).toBe('显示内存使用');
    expect(result.safetyLevel).toBe('read');
  });

  it('extracts JSON from markdown code block', () => {
    const raw = '```json\n{"command":"df -h","explanation":"磁盘使用","safetyLevel":"read"}\n```';
    const result = parseCommandResponse(raw);
    expect(result.command).toBe('df -h');
    expect(result.explanation).toBe('磁盘使用');
    expect(result.safetyLevel).toBe('read');
  });

  it('normalizes safetyLevel to lowercase', () => {
    const raw = '{"command":"reboot","explanation":"重启","safetyLevel":"SUDO"}';
    const result = parseCommandResponse(raw);
    expect(result.safetyLevel).toBe('sudo');
  });

  it('defaults unknown safetyLevel to write', () => {
    const raw = '{"command":"touch /tmp/x","explanation":"创建文件","safetyLevel":"unknown"}';
    const result = parseCommandResponse(raw);
    expect(result.safetyLevel).toBe('write');
  });

  it('defaults missing safetyLevel to write', () => {
    const raw = '{"command":"touch /tmp/x","explanation":"创建文件"}';
    const result = parseCommandResponse(raw);
    expect(result.safetyLevel).toBe('write');
  });

  it('falls back to raw text as command when JSON parse fails', () => {
    const raw = 'du -sh .';
    const result = parseCommandResponse(raw);
    expect(result.command).toBe('du -sh .');
    expect(result.explanation).toBe('');
    expect(result.safetyLevel).toBe('write');
  });

  it('handles empty response gracefully', () => {
    const result = parseCommandResponse('');
    expect(result.command).toBe('');
    expect(result.explanation).toBe('');
    expect(result.safetyLevel).toBe('write');
  });

  it('trims whitespace from command and explanation', () => {
    const raw = '{"command":"  ls -la  ","explanation":"  列出文件  ","safetyLevel":"read"}';
    const result = parseCommandResponse(raw);
    expect(result.command).toBe('ls -la');
    expect(result.explanation).toBe('列出文件');
  });
});

describe('generateCommand - caching & non-blocking facts', () => {
  beforeEach(() => {
    clearCommandCache();
    mocks.generateText.mockReset();
    mocks.getCachedHostFacts.mockReset();
    mocks.getCachedHostFacts.mockReturnValue(null);
    mocks.refreshHostFactsInBackground.mockReset();
  });

  it('does not block on host facts: uses cache only, refreshes in background when cold', async () => {
    mocks.getCachedHostFacts.mockReturnValue(null);
    mocks.generateText.mockResolvedValue({
      text: '{"command":"ls","explanation":"列出","safetyLevel":"read"}',
    });

    await generateCommand({ naturalLanguage: '列出文件', hostId: 'h1' });

    // Cold cache -> background refresh kicked off (never awaited)
    expect(mocks.refreshHostFactsInBackground).toHaveBeenCalledWith('h1', 'host1');
    // Model was still called immediately (did not wait for facts)
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
  });

  it('uses cached facts (no SSH, no background refresh) when cache is warm', async () => {
    mocks.getCachedHostFacts.mockReturnValue({
      hostId: 'h1',
      hostName: 'host1',
      os: 'Ubuntu 22.04 LTS',
      kernel: '5.15.0',
      cpuCores: '4',
      memoryTotal: '8Gi',
      diskInfo: '/',
      failedUnits: [],
      recentDmesg: [],
      cachedAt: Date.now(),
    });
    mocks.generateText.mockResolvedValue({
      text: '{"command":"cat /etc/os-release","explanation":"查看OS","safetyLevel":"read"}',
    });

    await generateCommand({ naturalLanguage: '查看系统版本', hostId: 'h1' });

    expect(mocks.refreshHostFactsInBackground).not.toHaveBeenCalled();
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    const args = mocks.generateText.mock.calls[0][0] as { system?: string };
    expect(args.system).toContain('Ubuntu 22.04 LTS');
  });

  it('returns cached result on repeat without calling the model again', async () => {
    mocks.generateText.mockResolvedValue({
      text: '{"command":"du -sh .","explanation":"目录大小","safetyLevel":"read"}',
    });

    const first = await generateCommand({ naturalLanguage: '统计目录大小' });
    const second = await generateCommand({ naturalLanguage: '统计目录大小' });

    expect(first.command).toBe('du -sh .');
    expect(second.command).toBe('du -sh .');
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
  });

  it('normalizes input before caching (trim + lowercase)', async () => {
    mocks.generateText.mockResolvedValue({
      text: '{"command":"df -h","explanation":"磁盘","safetyLevel":"read"}',
    });

    await generateCommand({ naturalLanguage: '  查看磁盘  ' });
    await generateCommand({ naturalLanguage: '查看磁盘' });

    expect(mocks.generateText).toHaveBeenCalledTimes(1);
  });

  it('does not cache empty/failed generations', async () => {
    mocks.generateText.mockResolvedValue({ text: '' });

    const first = await generateCommand({ naturalLanguage: '???' });
    const second = await generateCommand({ naturalLanguage: '???' });

    expect(first.command).toBe('');
    expect(second.command).toBe('');
    expect(mocks.generateText).toHaveBeenCalledTimes(2);
  });

  it('passes maxTokens 1024 and an abort signal to generateText', async () => {
    mocks.generateText.mockResolvedValue({
      text: '{"command":"pwd","explanation":"当前目录","safetyLevel":"read"}',
    });

    await generateCommand({ naturalLanguage: '当前目录' });

    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    const args = mocks.generateText.mock.calls[0][0] as {
      maxTokens?: number;
      abortSignal?: AbortSignal;
    };
    expect(args.maxTokens).toBe(1024);
    expect(args.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('retries with a larger budget when the response is truncated (no complete JSON)', async () => {
    mocks.generateText
      .mockResolvedValueOnce({ text: '{"command":"du -sh .","explana' }) // truncated, no closing }
      .mockResolvedValueOnce({
        text: '{"command":"du -sh .","explanation":"目录大小","safetyLevel":"read"}',
      });

    const result = await generateCommand({ naturalLanguage: '目录大小' });

    expect(mocks.generateText).toHaveBeenCalledTimes(2);
    expect(result.command).toBe('du -sh .');
    const firstArgs = mocks.generateText.mock.calls[0][0] as { maxTokens: number };
    const secondArgs = mocks.generateText.mock.calls[1][0] as { maxTokens: number };
    expect(firstArgs.maxTokens).toBe(1024);
    expect(secondArgs.maxTokens).toBe(2048);
  });

  it('does not cache when both attempts produce truncated JSON', async () => {
    mocks.generateText.mockResolvedValue({ text: '{"command":"du","explana' }); // always truncated

    await generateCommand({ naturalLanguage: '大小' });
    expect(mocks.generateText).toHaveBeenCalledTimes(2); // initial + 1 retry

    await generateCommand({ naturalLanguage: '大小' });
    // Not cached -> 2 more calls (initial + retry) on the second invocation
    expect(mocks.generateText).toHaveBeenCalledTimes(4);
  });

  it('surfaces a friendly error on timeout', async () => {
    mocks.generateText.mockRejectedValue(new Error('The operation was aborted due to timeout'));

    await expect(generateCommand({ naturalLanguage: '慢命令' })).rejects.toThrow(/超时/);
  });
});
