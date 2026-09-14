import http from 'node:http';
import { spawnSync } from 'node:child_process';
const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ user: { username: 'doctor_demo' } }));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${srv.address().port}`;
const out = spawnSync('npx', ['tsx', 'src/cli/doctor.ts', '--verify'], {
  env: { ...process.env, NO_COLOR: '1', PROVIDER: 'web', IG_BASE_URL: url,
         IG_SESSIONID: 'abcdefghijklmno', IG_DS_USER_ID: '12345', IG_CSRFTOKEN: 'tok',
         DATA_DIR: process.argv[2] + '/doc5' },
  encoding: 'utf8',
});
const section = out.stdout.split('Live check')[1] ?? out.stdout;
console.log('Live check' + section.split('Summary')[0]);
srv.close();
