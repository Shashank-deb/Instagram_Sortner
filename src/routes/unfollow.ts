import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { getAccount } from '../db/index.js';
import { unfollowQueue } from '../services/unfollow.js';

export const unfollowRouter = Router();

const confirmSchema = z.object({
  /**
   * The UI must echo back the username it showed in the confirmation dialog.
   * If the list shifted under the user between render and click, the mismatch
   * stops the wrong account from being unfollowed.
   */
  confirmUsername: z.string().min(1),
});

unfollowRouter.post('/unfollow/:pk', (req, res, next) => {
  try {
    const { confirmUsername } = confirmSchema.parse(req.body ?? {});
    const account = getAccount(req.params.pk);
    if (!account) throw new AppError('Unknown account.', 404, 'not_found');
    if (account.username.toLowerCase() !== confirmUsername.toLowerCase()) {
      throw new AppError(
        `Confirmation mismatch: this row is @${account.username}, not @${confirmUsername}. Refresh and retry.`,
        409,
        'confirm_mismatch',
      );
    }
    const { action } = unfollowQueue.enqueue(account.pk);
    res.status(202).json({ action, queue: unfollowQueue.state });
  } catch (err) {
    next(err);
  }
});

unfollowRouter.delete('/unfollow/:id', (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) throw new AppError('Invalid action id.', 400);
    res.json({ canceled: unfollowQueue.cancel(id), queue: unfollowQueue.state });
  } catch (err) {
    next(err);
  }
});

unfollowRouter.get('/queue', (_req, res) => {
  res.json({
    state: unfollowQueue.state,
    pending: [...unfollowQueue.pending().values()],
    history: unfollowQueue.history(30),
  });
});

unfollowRouter.post('/queue/resume', (_req, res) => {
  unfollowQueue.resume();
  res.json({ state: unfollowQueue.state });
});

unfollowRouter.post('/queue/pause', (_req, res) => {
  unfollowQueue.pause('Paused from the dashboard.');
  res.json({ state: unfollowQueue.state });
});

unfollowRouter.delete('/queue', (_req, res) => {
  res.json({ canceled: unfollowQueue.cancelAll(), state: unfollowQueue.state });
});
