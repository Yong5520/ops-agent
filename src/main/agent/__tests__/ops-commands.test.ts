import { describe, it, expect } from 'vitest';
import {
  buildTailLogCommand,
  buildSearchLogsCommand,
  buildJournalQueryCommand,
  buildProcessListCommand,
  buildServiceStatusCommand,
  buildDiskAnalysisCommand,
  buildNetworkConnectionsCommand,
} from '../ops-commands.js';

describe('buildTailLogCommand', () => {
  it('builds basic tail command', () => {
    expect(buildTailLogCommand('/var/log/syslog', 100, false)).toBe(
      "tail -n 100 '/var/log/syslog'",
    );
  });

  it('builds follow command with -f', () => {
    expect(buildTailLogCommand('/var/log/nginx/error.log', 50, true)).toBe(
      "tail -n 50 -f '/var/log/nginx/error.log'",
    );
  });

  it('defaults to 200 lines when not specified', () => {
    expect(buildTailLogCommand('/var/log/messages', undefined, false)).toBe(
      "tail -n 200 '/var/log/messages'",
    );
  });

  it('quotes paths with spaces', () => {
    expect(buildTailLogCommand('/var/log/my app.log', 10, false)).toBe(
      "tail -n 10 '/var/log/my app.log'",
    );
  });
});

describe('buildSearchLogsCommand', () => {
  it('builds basic grep with context', () => {
    const cmd = buildSearchLogsCommand('error', ['/var/log/syslog'], { contextLines: 3 });
    expect(cmd).toContain("grep -n -C 3 'error'");
    expect(cmd).toContain("'/var/log/syslog'");
  });

  it('adds -i for case-insensitive', () => {
    const cmd = buildSearchLogsCommand('ERROR', ['/var/log/syslog'], { caseInsensitive: true });
    expect(cmd).toContain('-i');
  });

  it('searches multiple files', () => {
    const cmd = buildSearchLogsCommand('timeout', ['/var/log/syslog', '/var/log/kern.log'], {});
    expect(cmd).toContain("'/var/log/syslog'");
    expect(cmd).toContain("'/var/log/kern.log'");
  });

  it('adds max-results via head', () => {
    const cmd = buildSearchLogsCommand('error', ['/var/log/syslog'], { maxResults: 10 });
    expect(cmd).toContain('head -n 10');
  });
});

describe('buildJournalQueryCommand', () => {
  it('builds basic journalctl with unit', () => {
    expect(buildJournalQueryCommand({ unit: 'nginx' })).toBe(
      'journalctl -u nginx --no-pager -n 100',
    );
  });

  it('adds priority filter', () => {
    expect(buildJournalQueryCommand({ unit: 'nginx', priority: 'err' })).toBe(
      'journalctl -u nginx -p err --no-pager -n 100',
    );
  });

  it('adds since filter', () => {
    const cmd = buildJournalQueryCommand({ unit: 'nginx', since: '1 hour ago' });
    expect(cmd).toContain("--since '1 hour ago'");
  });

  it('adds until filter', () => {
    const cmd = buildJournalQueryCommand({ unit: 'nginx', until: '2024-01-01' });
    expect(cmd).toContain("--until '2024-01-01'");
  });

  it('custom line count', () => {
    expect(buildJournalQueryCommand({ unit: 'sshd', lines: 500 })).toBe(
      'journalctl -u sshd --no-pager -n 500',
    );
  });

  it('no unit -> all units', () => {
    expect(buildJournalQueryCommand({ lines: 50 })).toBe('journalctl --no-pager -n 50');
  });
});

describe('buildProcessListCommand', () => {
  it('basic ps aux sorted by CPU', () => {
    expect(buildProcessListCommand({ sortBy: 'cpu' })).toBe('ps aux --sort=-%cpu | head -n 20');
  });

  it('sorted by memory', () => {
    expect(buildProcessListCommand({ sortBy: 'mem' })).toBe('ps aux --sort=-%mem | head -n 20');
  });

  it('with filter pattern', () => {
    expect(buildProcessListCommand({ sortBy: 'cpu', filter: 'nginx' })).toBe(
      "ps aux --sort=-%cpu | grep 'nginx' | head -n 20",
    );
  });

  it('custom top count', () => {
    expect(buildProcessListCommand({ sortBy: 'mem', top: 50 })).toBe(
      'ps aux --sort=-%mem | head -n 50',
    );
  });

  it('sorted by pid', () => {
    expect(buildProcessListCommand({ sortBy: 'pid' })).toBe('ps aux --sort=pid | head -n 20');
  });
});

describe('buildServiceStatusCommand', () => {
  it('specific unit', () => {
    expect(buildServiceStatusCommand('nginx')).toBe('systemctl status nginx --no-pager');
  });

  it('no unit -> list all failed', () => {
    expect(buildServiceStatusCommand()).toBe('systemctl --failed --no-pager');
  });
});

describe('buildDiskAnalysisCommand', () => {
  it('basic du with depth', () => {
    expect(buildDiskAnalysisCommand('/var', 1)).toBe(
      "du -h --max-depth=1 '/var' 2>/dev/null | sort -rh | head -n 20",
    );
  });

  it('default path is root', () => {
    expect(buildDiskAnalysisCommand(undefined, 2)).toBe(
      "du -h --max-depth=2 '/' 2>/dev/null | sort -rh | head -n 20",
    );
  });

  it('custom top count', () => {
    expect(buildDiskAnalysisCommand('/home', 1, 50)).toBe(
      "du -h --max-depth=1 '/home' 2>/dev/null | sort -rh | head -n 50",
    );
  });
});

describe('buildNetworkConnectionsCommand', () => {
  it('basic ss with tcp', () => {
    expect(buildNetworkConnectionsCommand({ protocol: 'tcp' })).toBe('ss -tunap');
  });

  it('filter by port', () => {
    expect(buildNetworkConnectionsCommand({ protocol: 'tcp', port: 80 })).toBe(
      "ss -tunap 'sport = :80'",
    );
  });

  it('filter by state', () => {
    expect(buildNetworkConnectionsCommand({ protocol: 'tcp', state: 'LISTEN' })).toBe(
      'ss -tunap state LISTEN',
    );
  });

  it('all protocols when not specified', () => {
    expect(buildNetworkConnectionsCommand({})).toBe('ss -tunap');
  });
});

// ── V3-06: parameter clamping ──────────────────────────────────────────────
// The model can pass arbitrarily large values (e.g. tail -n 999999) which would
// flood the context window with a single tool result. Each log-reading builder
// must clamp its count-like params to a safe maximum (and a sensible minimum)
// so the generated command can never request an unbounded read.
describe('V3-06 parameter clamping', () => {
  describe('buildTailLogCommand - lines clamped to [1, 2000]', () => {
    it('clamps an absurdly large line count down to the max', () => {
      expect(buildTailLogCommand('/var/log/syslog', 999_999, false)).toBe(
        "tail -n 2000 '/var/log/syslog'",
      );
    });

    it('clamps a zero/negative line count up to 1', () => {
      expect(buildTailLogCommand('/var/log/syslog', 0, false)).toBe("tail -n 1 '/var/log/syslog'");
      expect(buildTailLogCommand('/var/log/syslog', -5, false)).toBe("tail -n 1 '/var/log/syslog'");
    });

    it('preserves an in-range line count unchanged', () => {
      expect(buildTailLogCommand('/var/log/syslog', 500, false)).toBe(
        "tail -n 500 '/var/log/syslog'",
      );
    });

    it('clamps even when follow=true', () => {
      expect(buildTailLogCommand('/var/log/syslog', 99_999, true)).toBe(
        "tail -n 2000 -f '/var/log/syslog'",
      );
    });
  });

  describe('buildSearchLogsCommand - maxResults clamped to [1, 500], contextLines to [0, 10]', () => {
    it('clamps an absurdly large maxResults down to 500', () => {
      const cmd = buildSearchLogsCommand('error', ['/var/log/syslog'], { maxResults: 999_999 });
      expect(cmd).toContain('head -n 500');
      expect(cmd).not.toContain('head -n 999999');
    });

    it('clamps a zero/negative maxResults up to 1', () => {
      const cmd = buildSearchLogsCommand('error', ['/var/log/syslog'], { maxResults: 0 });
      expect(cmd).toContain('head -n 1');
    });

    it('clamps contextLines down to 10 (avoids grep -C 9999 explosion)', () => {
      const cmd = buildSearchLogsCommand('error', ['/var/log/syslog'], { contextLines: 9999 });
      expect(cmd).toContain('-C 10');
      expect(cmd).not.toContain('-C 9999');
    });

    it('preserves in-range maxResults and contextLines unchanged', () => {
      const cmd = buildSearchLogsCommand('error', ['/var/log/syslog'], {
        maxResults: 50,
        contextLines: 3,
      });
      expect(cmd).toContain('head -n 50');
      expect(cmd).toContain('-C 3');
    });
  });

  describe('buildJournalQueryCommand - lines clamped to [1, 2000]', () => {
    it('clamps an absurdly large line count down to the max', () => {
      expect(buildJournalQueryCommand({ unit: 'nginx', lines: 999_999 })).toBe(
        'journalctl -u nginx --no-pager -n 2000',
      );
    });

    it('clamps a zero/negative line count up to 1', () => {
      expect(buildJournalQueryCommand({ unit: 'nginx', lines: 0 })).toBe(
        'journalctl -u nginx --no-pager -n 1',
      );
    });

    it('preserves an in-range line count unchanged', () => {
      expect(buildJournalQueryCommand({ unit: 'nginx', lines: 500 })).toBe(
        'journalctl -u nginx --no-pager -n 500',
      );
    });
  });
});
