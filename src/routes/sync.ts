import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { lastSyncRun } from '../db/index.js';
import { activeProvider, archiveProvider } from '../providers/index.js';
import { syncService } from '../services/sync.js';

export const syncRouter = Router();

const syncBodySchema = z.object({
  enrich: z.boolean().default(false),
  enrichLimit: z.number().int().min(1).max(200).default(25),
});

syncRouter.get('/sync', (_req, res) => {
  res.json({ progress: syncService.status, last: lastSyncRun() });
});

syncRouter.post('/sync', async (req, res, next) => {
  try {
    const options = syncBodySchema.parse(req.body ?? {});
    if (syncService.status.running) {
      res.status(409).json({ error: 'A sync is already running.', progress: syncService.status });
      return;
    }
    // Kick it off and answer immediately; the UI polls GET /sync for progress.
    syncService.run(activeProvider(), options).catch(() => undefined);
    res.status(202).json({ progress: syncService.status });
  } catch (err) {
    next(err);
  }
});

syncRouter.post('/sync/cancel', (_req, res) => {
  res.json({ canceled: syncService.cancel() });
});

/**
 * Archive upload. The body is the raw file (the browser posts the File object
 * directly), which avoids a multipart dependency for a single-file endpoint.
 */
syncRouter.post('/import', async (req, res, next) => {
  try {
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new AppError('Empty upload. Post the export .zip (or following.json) as the request body.', 400);
    }
    const filename = typeof req.query['filename'] === 'string' ? req.query['filename'] : 'upload.zip';
    const counts = archiveProvider.load(body, filename);
    const progress = await syncService.run(archiveProvider);
    res.json({ counts, progress });
  } catch (err) {
    next(err);
  }
});
