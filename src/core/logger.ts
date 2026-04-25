import { appendFile, mkdir } from 'fs/promises';
import { resolve } from 'path';

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
type InputLogLevel = 'debug' | 'info' | 'warn' | 'error';

interface Logger {
  info: (message: string, ...meta: unknown[]) => void;
  warn: (message: string, ...meta: unknown[]) => void;
  error: (message: string, ...meta: unknown[]) => void;
  debug: (message: string, ...meta: unknown[]) => void;
}

const logsDir = resolve(process.cwd(), 'logs');
let initPromise: Promise<void> | null = null;
const logLevelPriority: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};
let currentLogLevel: LogLevel = 'DEBUG';

function ensureLogsDir(): Promise<void> {
  if (!initPromise) {
    initPromise = mkdir(logsDir, { recursive: true }).then(() => undefined);
  }
  return initPromise;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatMeta(meta: unknown[]): string {
  if (meta.length === 0) {
    return '';
  }

  const parts = meta.map((item) => {
    if (item instanceof Error) {
      return item.stack || item.message;
    }

    if (typeof item === 'string') {
      return item;
    }

    try {
      return JSON.stringify(item);
    } catch {
      return String(item);
    }
  });

  return ` ${parts.join(' ')}`;
}

function normalizeLogLevel(level?: string): LogLevel {
  const normalized = (level || '').toLowerCase() as InputLogLevel;
  if (normalized === 'error') {
    return 'ERROR';
  }
  if (normalized === 'warn') {
    return 'WARN';
  }
  if (normalized === 'info') {
    return 'INFO';
  }
  return 'DEBUG';
}

export function setLogLevel(level?: string): void {
  currentLogLevel = normalizeLogLevel(level);
}

export function getLogLevel(): LogLevel {
  return currentLogLevel;
}

async function writeLogLine(line: string, date: Date): Promise<void> {
  try {
    await ensureLogsDir();
    const filePath = resolve(logsDir, `${formatDate(date)}.log`);
    await appendFile(filePath, line, 'utf-8');
  } catch (err) {
    console.error('[Logger] Failed to write log file:', err);
  }
}

function log(scope: string, level: LogLevel, message: string, meta: unknown[]): void {
  if (logLevelPriority[level] < logLevelPriority[currentLogLevel]) {
    return;
  }

  const now = new Date();
  const suffix = formatMeta(meta);
  const line = `${now.toISOString()} [${level}] [${scope}] ${message}${suffix}\n`;

  const consoleLine = `[${scope}] ${message}`;
  if (level === 'ERROR') {
    console.error(consoleLine, ...meta);
  } else if (level === 'WARN') {
    console.warn(consoleLine, ...meta);
  } else {
    console.log(consoleLine, ...meta);
  }

  void writeLogLine(line, now);
}

export function createLogger(scope: string): Logger {
  return {
    info: (message: string, ...meta: unknown[]) => log(scope, 'INFO', message, meta),
    warn: (message: string, ...meta: unknown[]) => log(scope, 'WARN', message, meta),
    error: (message: string, ...meta: unknown[]) => log(scope, 'ERROR', message, meta),
    debug: (message: string, ...meta: unknown[]) => log(scope, 'DEBUG', message, meta),
  };
}
