import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { createLogger } from './core/logger.js';
import { startRateEventPruner } from './core/ratelimit.js';
import { createApiRouter } from './routes/index.js';
import { unfollowQueue } from './services/unfollow.js';

const log = createLogger('server');
const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..', 'web');

const app = express();
app.disable('x-powered-by');

// This app holds a live Instagram session, so it must never be framed or have
// its responses sniffed into something executable.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use('/api', createApiRouter());
app.use(express.static(webRoot, { index: 'index.html', maxAge: '1h' }));
app.get('*', (_req, res) => {
  res.sendFile(path.join(webRoot, 'index.html'));
});

startRateEventPruner();
unfollowQueue.start();

const server = app.listen(config.port, config.host, () => {
  log.info(`provider=${config.provider} db=${config.dbPath}`);
  log.info(`dashboard at http://${config.host}:${config.port}`);
  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && !config.appToken) {
    log.warn('HOST is not loopback and APP_TOKEN is empty: anyone who can reach this port controls your account.');
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
