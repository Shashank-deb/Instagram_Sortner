import http from 'node:http';
import { AddressInfo } from 'node:net';

export interface MockUser {
  pk: string;
  username: string;
  full_name: string;
  profile_pic_url: string;
  is_private: boolean;
  is_verified: boolean;
}

export interface MockOptions {
  following: MockUser[];
  followers?: MockUser[];
  pageSize?: number;
  /** Force the next N responses to a given status/body. */
  fail?: { times: number; status: number; body: string };
}

export interface MockServer {
  url: string;
  close(): Promise<void>;
  unfollowed: string[];
  requests: string[];
  options: MockOptions;
}

/** A stand-in for instagram.com's private web endpoints, good enough to drive the real client. */
export async function startMockInstagram(options: MockOptions): Promise<MockServer> {
  const unfollowed: string[] = [];
  const requests: string[] = [];
  const pageSize = options.pageSize ?? 3;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push(`${req.method} ${url.pathname}`);

    const send = (status: number, body: unknown, contentType = 'application/json') => {
      res.writeHead(status, { 'content-type': contentType });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    if (options.fail && options.fail.times > 0) {
      options.fail.times -= 1;
      send(options.fail.status, options.fail.body, 'text/plain');
      return;
    }

    if (!req.headers.cookie?.includes('sessionid=')) {
      send(401, { message: 'login_required' });
      return;
    }

    const friendships = /^\/api\/v1\/friendships\/\d+\/(following|followers)\/$/.exec(url.pathname);
    if (friendships) {
      const source = friendships[1] === 'following' ? options.following : (options.followers ?? []);
      const start = Number(url.searchParams.get('max_id') ?? '0');
      const slice = source.slice(start, start + pageSize);
      const next = start + pageSize;
      send(200, { users: slice, next_max_id: next < source.length ? String(next) : null, status: 'ok' });
      return;
    }

    const destroy = /^\/api\/v1\/friendships\/destroy\/([^/]+)\/$/.exec(url.pathname);
    if (destroy && req.method === 'POST') {
      unfollowed.push(destroy[1]!);
      send(200, { status: 'ok', friendship_status: { following: false } });
      return;
    }

    if (url.pathname === '/api/v1/users/web_profile_info/') {
      const username = url.searchParams.get('username') ?? '';
      send(200, {
        data: {
          user: {
            full_name: `${username} full`,
            profile_pic_url: `https://scontent.cdninstagram.com/${username}.jpg`,
            edge_followed_by: { count: username.length * 1000 },
            edge_follow: { count: username.length * 10 },
          },
        },
      });
      return;
    }

    if (/^\/api\/v1\/users\/\d+\/info\/$/.test(url.pathname)) {
      send(200, { user: { username: 'testuser' } });
      return;
    }

    send(404, { message: 'not found' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    unfollowed,
    requests,
    options,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export function makeUsers(count: number): MockUser[] {
  return Array.from({ length: count }, (_, i) => ({
    pk: String(1000 + i),
    username: `user${i}`,
    full_name: `User Number ${i}`,
    profile_pic_url: `https://scontent.cdninstagram.com/u${i}.jpg`,
    is_private: i % 3 === 0,
    is_verified: i % 5 === 0,
  }));
}
