import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, test } from 'node:test';

import { checkDeployment } from './check-deployed-assets.ts';

type Route = { status: number; type: string; body?: string };

const serve = async (routes: Record<string, Route>): Promise<{ url: string; server: Server }> => {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const route = routes[path] ?? { status: 404, type: 'text/html', body: '<html>404</html>' };
    res.writeHead(route.status, { 'content-type': route.type });
    res.end(route.body ?? '');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/`, server };
};

const servers: Server[] = [];
after(() => servers.forEach((server) => server.close()));

const check = async (routes: Record<string, Route>) => {
  const { url, server } = await serve(routes);
  servers.push(server);
  return checkDeployment({ baseUrl: url, maxPages: 10, concurrency: 4 });
};

const html = (body: string) => ({ status: 200, type: 'text/html; charset=utf-8', body });

test('passes a deploy whose references all resolve', async () => {
  const failures = await check({
    '/': html('<img src="/a.webp"><link rel="stylesheet" href="/s.css">'),
    '/a.webp': { status: 200, type: 'image/webp', body: 'x' },
    '/s.css': { status: 200, type: 'text/css', body: 'a{}' },
  });

  assert.deepEqual(failures, []);
});

test('reports an image that 404s', async () => {
  const failures = await check({ '/': html('<img src="/missing.webp">') });

  assert.equal(failures.length, 1);
  assert.match(failures[0].url, /missing\.webp$/);
  assert.equal(failures[0].reason, 'HTTP 404');
});

/*
 * The gate's worst failure mode, and the one a pure unit test cannot reach:
 * without an explicit guard the crawl ends having collected nothing, reports
 * no broken references, and waves a wholly broken deploy through.
 */
test('fails when the entry point itself is broken', async () => {
  const failures = await check({ '/': { status: 500, type: 'text/html', body: 'boom' } });

  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason, 'HTTP 500');
  assert.equal(failures[0].from, 'entry point');
});

test('fails when the entry point is not HTML at all', async () => {
  const failures = await check({ '/': { status: 200, type: 'application/json', body: '{}' } });

  assert.equal(failures.length, 1);
  assert.match(failures[0].reason, /rather than HTML/);
});

test('still reports a linked page that 404s, rather than aborting the crawl', async () => {
  const failures = await check({
    '/': html('<a href="/gone">gone</a><img src="/ok.webp">'),
    '/ok.webp': { status: 200, type: 'image/webp', body: 'x' },
  });

  assert.equal(failures.length, 1);
  assert.match(failures[0].url, /\/gone$/);
  assert.equal(failures[0].reason, 'HTTP 404');
});
