type Level = 'debug' | 'info' | 'warn' | 'error';

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? order.info;

function emit(level: Level, scope: string, message: string, extra?: unknown): void {
  if (order[level] < threshold) return;
  const stamp = new Date().toISOString();
  const line = `${stamp} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  const stream = level === 'error' || level === 'warn' ? console.error : console.log;
  if (extra === undefined) stream(line);
  else stream(line, extra);
}

export function createLogger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => emit('debug', scope, m, e),
    info: (m: string, e?: unknown) => emit('info', scope, m, e),
    warn: (m: string, e?: unknown) => emit('warn', scope, m, e),
    error: (m: string, e?: unknown) => emit('error', scope, m, e),
  };
}

export type Logger = ReturnType<typeof createLogger>;
