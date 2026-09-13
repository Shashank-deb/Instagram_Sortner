import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { getMeta } from '../db/index.js';
import { activeProvider, webProvider } from '../providers/index.js';
import { browserLogin } from '../session/browserLogin.js';
import { clearSession, loadSession, saveSession } from '../session/store.js';

export const sessionRouter = Router();

const cookieSchema = z.object({
  sessionid: z.string().min(10),
  dsUserId: z.string().regex(/^\d+$/, 'ds_user_id should be a numeric string'),
  csrftoken: z.string().default(''),
});

sessionRouter.get('/session', (_req, res) => {
  const session = loadSession();
  const provider = activeProvider();
  res.json({
    provider: provider.name,
    capabilities: provider.capabilities,
    connected: session !== null,
    /** Never echo the cookie back; the UI only needs to know one exists. */
    dsUserId: session?.dsUserId ?? null,
    savedAt: session?.savedAt ?? null,
    selfUsername: getMeta('self_username'),
    lastSyncAt: getMeta('last_sync_at') ? Number(getMeta('last_sync_at')) : null,
    login: browserLogin.status,
    limits: config.limits,
  });
});

sessionRouter.post('/session', (req, res, next) => {
  try {
    const body = cookieSchema.parse(req.body ?? {});
    saveSession(body);
    webProvider.refresh();
    res.json({ connected: true });
  } catch (err) {
    next(err);
  }
});

sessionRouter.delete('/session', (_req, res) => {
  clearSession();
  webProvider.refresh();
  res.json({ connected: false });
});

sessionRouter.post('/session/login', (_req, res) => {
  res.status(202).json({ login: browserLogin.start() });
});

sessionRouter.post('/session/login/cancel', (_req, res) => {
  browserLogin.cancel();
  res.json({ login: browserLogin.status });
});

sessionRouter.get('/session/verify', async (_req, res, next) => {
  try {
    webProvider.refresh();
    const who = await webProvider.whoami();
    res.json({ ok: true, ...who });
  } catch (err) {
    next(err);
  }
});
