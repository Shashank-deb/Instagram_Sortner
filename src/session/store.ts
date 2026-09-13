import { config } from '../config.js';
import { deleteMeta, getMeta, setMeta } from '../db/index.js';

export interface IgSession {
  sessionid: string;
  dsUserId: string;
  csrftoken: string;
  savedAt: number;
}

const KEY = 'ig_session';

/**
 * Session cookies live in the SQLite file (chmod 600) rather than in .env, so
 * `npm run login` can refresh them without the user hand-editing secrets. Env
 * vars still win when present, which keeps the "paste a cookie" path working
 * and makes the app usable from a secrets manager.
 */
export function loadSession(): IgSession | null {
  const { sessionid, dsUserId, csrftoken } = config.session;
  if (sessionid && dsUserId) {
    return { sessionid, dsUserId, csrftoken, savedAt: 0 };
  }
  const raw = getMeta(KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as IgSession;
    return parsed.sessionid && parsed.dsUserId ? parsed : null;
  } catch {
    return null;
  }
}

export function saveSession(session: Omit<IgSession, 'savedAt'>): void {
  setMeta(KEY, JSON.stringify({ ...session, savedAt: Math.floor(Date.now() / 1000) }));
}

export function clearSession(): void {
  deleteMeta(KEY);
}
