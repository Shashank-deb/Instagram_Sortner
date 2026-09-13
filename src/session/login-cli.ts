/**
 * `npm run login` - capture Instagram session cookies through a real browser.
 * Useful when the dashboard runs headless on another machine but you want to do
 * the login where you can actually see the window.
 */
import { browserLogin } from './browserLogin.js';
import { sleep } from '../core/ratelimit.js';

browserLogin.start(10 * 60 * 1000);

let lastMessage = '';
for (;;) {
  const state = browserLogin.status;
  if (state.message !== lastMessage) {
    lastMessage = state.message;
    console.log(state.message);
  }
  if (!state.running && state.finishedAt !== null) {
    if (state.error) {
      console.error(`\nLogin failed: ${state.error}`);
      process.exit(1);
    }
    console.log(`\nSession stored${state.username ? ` for @${state.username}` : ''}.`);
    console.log('Set PROVIDER=web in your .env, then start the app with `npm run dev`.');
    process.exit(0);
  }
  await sleep(500);
}
