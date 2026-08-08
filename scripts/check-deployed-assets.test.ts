import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  describeFailure,
  extractReferences,
  bypassHeaders,
  findCanonicalOrigin,
  parseArgs,
  rewriteSelfOrigin,
} from './check-deployed-assets.ts';

const PAGE = 'https://preview.example.com/';

const urlsOfKind = (html: string, kind: 'asset' | 'page') =>
  extractReferences(html, PAGE)
    .filter((reference) => reference.kind === kind)
    .map((reference) => reference.url);

test('collects image, script and stylesheet references', () => {
  const html = `
    <link rel="stylesheet" href="/style.css">
    <script src="/app.js"></script>
    <img src="/images/hero.webp">
  `;
  assert.deepEqual(urlsOfKind(html, 'asset'), [
    'https://preview.example.com/style.css',
    'https://preview.example.com/app.js',
    'https://preview.example.com/images/hero.webp',
  ]);
});

test('collects every candidate in a srcset', () => {
  const html = '<img src="/a.webp" srcset="/a.webp 1x, /b.webp 2x">';
  assert.deepEqual(urlsOfKind(html, 'asset'), [
    'https://preview.example.com/a.webp',
    'https://preview.example.com/a.webp',
    'https://preview.example.com/b.webp',
  ]);
});

test('treats og:image as an asset and canonical as a page', () => {
  const html = `
    <meta property="og:image" content="https://preview.example.com/og.webp">
    <link rel="canonical" href="https://preview.example.com/about">
  `;
  assert.deepEqual(urlsOfKind(html, 'asset'), ['https://preview.example.com/og.webp']);
  assert.deepEqual(urlsOfKind(html, 'page'), ['https://preview.example.com/about']);
});

test('ignores preconnect and dns-prefetch, which name an origin not a file', () => {
  const html = `
    <link rel="preconnect" href="https://assets.tina.io" crossorigin>
    <link rel="dns-prefetch" href="https://api.pirsch.io">
    <link rel="icon" href="/favicon.svg">
  `;
  assert.deepEqual(urlsOfKind(html, 'asset'), ['https://preview.example.com/favicon.svg']);
});

test('ignores fragments and non-http schemes', () => {
  const html = `
    <a href="#main">skip</a>
    <a href="mailto:hi@example.com">mail</a>
    <a href="tel:+3200">call</a>
    <img src="data:image/gif;base64,R0lGOD">
    <a href="/real">real</a>
  `;
  assert.deepEqual(urlsOfKind(html, 'page'), ['https://preview.example.com/real']);
  assert.deepEqual(urlsOfKind(html, 'asset'), []);
});

test('decodes entity-escaped query strings', () => {
  const html = '<img src="/img.webp?a=1&amp;b=2">';
  assert.deepEqual(urlsOfKind(html, 'asset'), ['https://preview.example.com/img.webp?a=1&b=2']);
});

test('reads the canonical origin', () => {
  const html = '<link rel="canonical" href="https://www.example.be/some/page">';
  assert.equal(findCanonicalOrigin(html), 'https://www.example.be');
  assert.equal(findCanonicalOrigin('<link rel="icon" href="/favicon.svg">'), null);
});

test('points production self-references back at the deploy under test', () => {
  const base = new URL('https://preview.example.com/');
  const selfOrigins = new Set(['https://preview.example.com', 'https://www.example.be']);

  assert.equal(
    rewriteSelfOrigin('https://www.example.be/images/hero.webp', base, selfOrigins),
    'https://preview.example.com/images/hero.webp'
  );
});

test('leaves genuinely third-party assets alone', () => {
  const base = new URL('https://preview.example.com/');
  const selfOrigins = new Set(['https://preview.example.com', 'https://www.example.be']);

  assert.equal(
    rewriteSelfOrigin('https://assets.tina.io/abc/x.webp', base, selfOrigins),
    'https://assets.tina.io/abc/x.webp'
  );
});

test('flags any reference answering 4xx or 5xx', () => {
  assert.equal(describeFailure('asset', 404, 'text/html'), 'HTTP 404');
  assert.equal(describeFailure('page', 500, 'text/html'), 'HTTP 500');
});

test('flags an asset that answers 200 with an HTML fallback page', () => {
  const reason = describeFailure('asset', 200, 'text/html; charset=utf-8');
  assert.match(reason ?? '', /fallback page/);
});

test('accepts a healthy asset and a healthy page', () => {
  assert.equal(describeFailure('asset', 200, 'image/webp'), null);
  assert.equal(describeFailure('page', 200, 'text/html; charset=utf-8'), null);
});

/*
 * The regression this file exists for: the hero portrait shipped as
 * /images/__staging/main/__file/img-signal.webp, which Vercel answered with the
 * 404 page. Extraction plus classification has to turn that into a failure.
 */
test('catches the hero portrait regression end to end', () => {
  const html = '<img src="/images/__staging/main/__file/img-signal.webp" alt="portrait">';
  const [reference] = extractReferences(html, PAGE);

  assert.equal(reference.kind, 'asset');
  assert.equal(
    reference.url,
    'https://preview.example.com/images/__staging/main/__file/img-signal.webp'
  );
  assert.equal(describeFailure(reference.kind, 404, 'text/html; charset=utf-8'), 'HTTP 404');
});

test('keeps a flag value from being mistaken for the URL', () => {
  const parsed = parseArgs(['--max-pages', '10', 'https://preview.example.com']);
  assert.equal(parsed.baseUrl, 'https://preview.example.com');
  assert.equal(parsed.maxPages, 10);
});

test('takes flags in either order and ignores unknown ones', () => {
  const parsed = parseArgs(['https://x.test', '--concurrency', '4', '--verbose']);
  assert.deepEqual(parsed, { baseUrl: 'https://x.test', concurrency: 4 });
});

test('ignores a non-numeric or zero flag value so the default stands', () => {
  assert.equal(parseArgs(['https://x.test', '--max-pages', 'lots']).maxPages, undefined);
  assert.equal(parseArgs(['https://x.test', '--concurrency', '0']).concurrency, undefined);
});

const BYPASS = { origin: 'https://preview.example.com', secret: 's3cret' };

test('sends the bypass secret to the deployment origin', () => {
  assert.deepEqual(bypassHeaders('https://preview.example.com/a.webp', BYPASS), {
    'x-vercel-protection-bypass': 's3cret',
  });
});

/*
 * The security property. A crawl reaches whatever the pages reference, so a
 * secret leaking onto third-party requests would hand a live credential to a
 * CDN, a font host, or an analytics vendor.
 */
test('never sends the bypass secret to a third-party origin', () => {
  for (const url of [
    'https://assets.tina.io/abc/x.webp',
    'https://fonts.gstatic.com/s/x.woff2',
    'https://evil.example.com/pixel.gif',
    'http://preview.example.com/a.webp',
    'https://preview.example.com.evil.test/a.webp',
  ]) {
    assert.deepEqual(bypassHeaders(url, BYPASS), {}, `leaked to ${url}`);
  }
});

test('sends nothing when no bypass is configured', () => {
  assert.deepEqual(bypassHeaders('https://preview.example.com/a.webp', null), {});
});
