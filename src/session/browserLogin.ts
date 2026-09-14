import fs from 'node:fs';
import { config } from '../config.js';
import { AppError } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import { sleep } from '../core/ratelimit.js';
import { saveSession } from './store.js';

const log = createLogger('login');

export interface LoginState {
  running: boolean;
  message: string;
  startedAt: number | null;
  finishedAt: number | null;
  username: string | null;
  error: string | null;
}

interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
}

/**
 * Opens a real Chromium window at instagram.com and waits for *you* to log in.
 *
 * The app never sees or stores your password, and 2FA / "was this you?" prompts
 * are handled in the normal UI. All we take at the end are the session cookies
 * the browser already holds, which is also what makes this survivable: the
 * session looks like an ordinary browser session because it is one.
 */
class BrowserLogin {
  private state: LoginState = idle();
  private inflight: Promise<void> | null = null;
  private cancelRequested = false;

  get status(): LoginState {
    return { ...this.state };
  }

  cancel(): void {
    this.cancelRequested = true;
  }

  start(timeoutMs = 5 * 60 * 1000): LoginState {
    if (this.inflight) return this.status;
    this.cancelRequested = false;
    this.state = {
      running: true,
      message: 'Launching browser…',
      startedAt: Math.floor(Date.now() / 1000),
      finishedAt: null,
      username: null,
      error: null,
    };
    this.inflight = this.run(timeoutMs)
      .catch((err: Error) => {
        this.state.error = err.message;
        this.state.message = 'Login failed.';
        log.error(err.message);
      })
      .finally(() => {
        this.state.running = false;
        this.state.finishedAt = Math.floor(Date.now() / 1000);
        this.inflight = null;
      });
    return this.status;
  }

  private async run(timeoutMs: number): Promise<void> {
    const chromium = await loadPlaywright();
    fs.mkdirSync(config.browserProfileDir, { recursive: true });

    let context: IgContext;
    try {
      context = await chromium.launchPersistentContext(config.browserProfileDir, {
        headless: false,
        viewport: { width: 1180, height: 900 },
        args: ['--disable-blink-features=AutomationControlled'],
      });
    } catch (err) {
      throw describeLaunchFailure(err as Error);
    }

    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded' });
      this.state.message = 'Waiting for you to log in in the browser window…';

      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (this.cancelRequested) throw new AppError('Login canceled.', 499, 'canceled');
        if (Date.now() > deadline) throw new AppError('Timed out waiting for login.', 408, 'timeout');

        const cookies = (await context.cookies('https://www.instagram.com')) as PlaywrightCookie[];
        const byName = new Map(cookies.map((c) => [c.name, c.value]));
        const sessionid = byName.get('sessionid');
        const dsUserId = byName.get('ds_user_id');

        if (sessionid && dsUserId) {
          saveSession({ sessionid, dsUserId, csrftoken: byName.get('csrftoken') ?? '' });
          this.state.message = 'Session captured. You can close the browser window.';
          this.state.username = await readUsername(page);
          log.info('captured session cookies');
          return;
        }

        await sleep(1500);
      }
    } finally {
      await context.close().catch(() => undefined);
    }
  }
}

/**
 * Instagram embeds the logged-in username in the page's bootstrap JSON. Passed
 * as a source string rather than a closure so this file needs no DOM lib types.
 */
async function readUsername(page: IgPage): Promise<string | null> {
  try {
    return await page.evaluate(
      '(() => { const m = /"username":"([^"]+)"/.exec(document.documentElement.innerHTML); return m ? m[1] : null; })()',
    );
  } catch {
    return null;
  }
}

/** Playwright is an optional dependency: the archive-only path does not need it. */
async function loadPlaywright() {
  try {
    const mod = (await import('playwright')) as { chromium: PlaywrightChromium };
    return mod.chromium;
  } catch {
    throw new AppError(
      'Playwright is not installed. Run `npm install playwright && npx playwright install chromium`, ' +
        'or paste session cookies manually in Settings.',
      501,
      'missing_dependency',
    );
  }
}

/**
 * Minimal structural types for the slice of Playwright we touch, so the package
 * can stay an optional dependency without its types being required to compile.
 */
interface IgPage {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  evaluate(expression: string): Promise<string | null>;
}

interface IgContext {
  pages(): IgPage[];
  newPage(): Promise<IgPage>;
  cookies(url: string): Promise<unknown[]>;
  close(): Promise<void>;
}

interface PlaywrightChromium {
  launchPersistentContext(dir: string, options: Record<string, unknown>): Promise<IgContext>;
}

/**
 * Playwright reports a missing browser with a multi-line ASCII banner that is
 * unreadable once it reaches the dashboard. Translate the cases we can act on
 * into a single sentence naming the command to run.
 */
function describeLaunchFailure(err: Error): AppError {
  const message = err.message ?? '';

  if (/Executable doesn't exist|playwright install/i.test(message)) {
    return new AppError(
      'Playwright is installed but its Chromium browser is not. Run this once, in the project folder: ' +
        'npx playwright install chromium',
      501,
      'missing_browser',
    );
  }

  if (/Missing X server|no display|DISPLAY/i.test(message)) {
    return new AppError(
      'No desktop session is available, so a browser window cannot be shown. Log in on a machine with a ' +
        'desktop, then paste the cookies in Settings.',
      501,
      'headless_host',
    );
  }

  // Keep the first line only: the rest is Playwright's banner art.
  return new AppError(`Could not launch the browser: ${message.split('\n')[0]}`, 500, 'launch_failed');
}

function idle(): LoginState {
  return { running: false, message: 'Not started.', startedAt: null, finishedAt: null, username: null, error: null };
}

export const browserLogin = new BrowserLogin();
