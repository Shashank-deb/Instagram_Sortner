import { Router } from 'express';
import { z } from 'zod';
import { getStats, listAccounts, countArchivePlaceholders, type SortKey } from '../db/index.js';
import { getAvatar } from '../services/avatars.js';
import { unfollowQueue } from '../services/unfollow.js';

const listQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  status: z.enum(['following', 'unfollowed', 'gone', 'all']).default('following'),
  nonFollowers: z.coerce.boolean().optional(),
  private: z.coerce.boolean().optional(),
  verified: z.coerce.boolean().optional(),
  sort: z
    .enum(['username', 'full_name', 'follower_count', 'following_count', 'followed_at', 'first_seen_at'])
    .default('username'),
  direction: z.enum(['asc', 'desc']).default('asc'),
  limit: z.coerce.number().int().min(1).max(500).default(60),
  offset: z.coerce.number().int().min(0).default(0),
});

export const accountsRouter = Router();

accountsRouter.get('/accounts', (req, res) => {
  const query = listQuerySchema.parse(req.query);
  const { items, total } = listAccounts({
    search: query.search,
    status: query.status,
    onlyNonFollowers: query.nonFollowers,
    onlyPrivate: query.private,
    onlyVerified: query.verified,
    sort: query.sort as SortKey,
    direction: query.direction,
    limit: query.limit,
    offset: query.offset,
  });

  // Fold in queue state so a row can render as "unfollowing..." without the UI
  // having to join two endpoints itself.
  const pending = unfollowQueue.pending();
  res.json({
    total,
    offset: query.offset,
    limit: query.limit,
    items: items.map((account) => ({
      ...account,
      pendingAction: pending.get(account.pk) ?? null,
    })),
  });
});

accountsRouter.get('/stats', (_req, res) => {
  res.json({ ...getStats(), archivePlaceholders: countArchivePlaceholders() });
});

accountsRouter.get('/avatar/:pk', async (req, res, next) => {
  try {
    const { body, contentType } = await getAvatar(req.params.pk);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(body);
  } catch (err) {
    next(err);
  }
});
