// Lightweight logger that prefixes messages with timestamps and level.
// Avoid pulling in a full logger dependency for the MVP.

type Level = 'debug' | 'info' | 'warn' | 'error';

function format(level: Level, args: unknown[]): string {
  const ts = new Date().toISOString();
  return `[${ts}] [${level.toUpperCase()}] ${args
    .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
    .join(' ')}`;
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function write(level: Level, args: unknown[]): void {
  const line = format(level, args);
  if (level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export const logger = {
  debug: (...args: unknown[]) => write('debug', args),
  info: (...args: unknown[]) => write('info', args),
  warn: (...args: unknown[]) => write('warn', args),
  error: (...args: unknown[]) => write('error', args),
};
