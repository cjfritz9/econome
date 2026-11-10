import pino from 'pino';

const SEVERITY: Record<string, string> = { trace: 'DEBUG', debug: 'DEBUG', info: 'INFO', warn: 'WARNING', error: 'ERROR', fatal: 'CRITICAL' };

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? 'info',
    messageKey: 'message',
    formatters: { level: (label) => ({ severity: SEVERITY[label] ?? 'DEFAULT' }) },
  },
  pino.destination(2),
);
