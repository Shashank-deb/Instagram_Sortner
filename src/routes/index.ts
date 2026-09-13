import express, { type NextFunction, type Request, type Response, Router } from 'express';
import { ZodError } from 'zod';
import { config } from '../config.js';
import { AppError } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import { getStats, lastSyncRun } from '../db/index.js';
import { activeProvider, readLimiter } from '../providers/index.js';
import { syncService } from '../services/sync.js';
import { unfollowQueue } from '../services/unfollow.js';
import { accountsRouter } from './accounts.js';
import { sessionRouter } from './session.js';
import { syncRouter } from './sync.js';
import { unfollowRouter } from './unfollow.js';

const log = createLogger('api');

/** Constant-time-ish comparison so the token is not guessable byte by byte. */
function tokenMatches(provided: string): boolean {
  const expected = config.appToken;
  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}

function requireToken(req: Request, res: Response, next: NextFunction): void {
  if (!config.appToken) {
    next();
    return;
  }
  const provided =
    (req.get('x-app-token') ?? '') || (typeof req.query['token'] === 'string' ? req.query['token'] : '');
  if (provided && tokenMatches(provided)) {
    next();
    return;
  }
  res.status(401).json({ error: 'Missing or invalid app token.', code: 'unauthorized' });
}

export function createApiRouter(): Router {
  const api = Router();

  api.use(requireToken);
  // The archive upload arrives as raw bytes; everything else is JSON.
  api.use('/import', express.raw({ type: '*/*', limit: '512mb' }));
  api.use(express.json({ limit: '1mb' }));

  api.get('/health', (_req, res) => {
    res.json({ ok: true, provider: activeProvider().name });
  });

  api.get('/status', (_req, res) => {
    const provider = activeProvider();
    res.json({
      provider: provider.name,
      capabilities: provider.capabilities,
      stats: getStats(),
      sync: { progress: syncService.status, last: lastSyncRun() },
      queue: unfollowQueue.state,
      reads: readLimiter.usage(),
    });
  });

  api.use(accountsRouter);
  api.use(syncRouter);
  api.use(unfollowRouter);
  api.use(sessionRouter);

  api.use((req, res) => {
    res.status(404).json({ error: `No such endpoint: ${req.method} ${req.path}`, code: 'not_found' });
  });

  api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({
        error: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
        code: 'validation',
      });
      return;
    }
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    const message = err instanceof Error ? err.message : 'Unexpected error';
    log.error(`unhandled: ${message}`, err);
    res.status(500).json({ error: message, code: 'internal' });
  });

  return api;
}
