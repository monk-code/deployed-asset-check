/*
 * Fails when a deployed page references something that does not resolve.
 *
 * This runs against a deployed URL rather than dist/, and that is the whole
 * point. CI builds Tina with `--local`, so the CDN rewrite that turns a stored
 * `/images/x.webp` into an `assets.tina.io` URL never happens locally — a
 * dist-based check cannot see the class of bug this exists to catch. Only a
 * real deploy runs the real content pipeline.
 *
 * Two things count as broken:
 *   - any reference answering >= 400
 *   - an *asset* answering with text/html, which means the host served a
 *     fallback page instead of the file (a 200 that is really a 404)
 *
 * External `<a>` links are deliberately not checked: they rot on someone
 * else's schedule and would turn this into a flaky gate. External *assets*
 * are checked, because the page visibly breaks when they disappear.
 */

interface Reference {
  url: string;
  kind: 'asset' | 'page';
  from: string;
}

interface Failure extends Reference {
  reason: string;
}

const SKIPPED_SCHEMES = /^(data|mailto|tel|javascript|blob|about):/i;

const DOCUMENT_RELS = new Set(['canonical', 'alternate', 'prev', 'next', 'up', 'author']);

// These name an origin to warm a connection to, not a resource to fetch.
const HINT_RELS = new Set(['preconnect', 'dns-prefetch']);

const META_ASSET_KEYS = new Set([
  'og:image',
  'og:image:url',
  'og:image:secure_url',
  'twitter:image',
]);

const parseAttrs = (raw: string): Map<string, string> => {
  const attrs = new Map<string, string>();
  const pattern = /([:a-zA-Z_][-:.a-zA-Z0-9_]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  for (const match of raw.matchAll(pattern)) {
    attrs.set(match[1].toLowerCase(), match[3] ?? match[4] ?? match[5] ?? '');
  }
  return attrs;
};

const parseSrcset = (value: string): string[] =>
  value
    .split(',')
    .map((entry) => entry.trim().split(/\s+/)[0])
    .filter(Boolean);

const decodeEntities = (value: string): string =>
  value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));

export const extractReferences = (html: string, pageUrl: string): Reference[] => {
  const found: Reference[] = [];

  const add = (raw: string | undefined, kind: Reference['kind']) => {
    if (!raw) return;
    const value = decodeEntities(raw.trim());
    if (!value || value.startsWith('#') || SKIPPED_SCHEMES.test(value)) return;
    try {
      found.push({ url: new URL(value, pageUrl).href, kind, from: pageUrl });
    } catch {
      // An unparseable URL is a broken reference in its own right, but the
      // browser would ignore it too, so it is not worth failing a deploy over.
    }
  };

  for (const match of html.matchAll(/<([a-zA-Z][-a-zA-Z0-9]*)\b([^>]*)>/g)) {
    const tag = match[1].toLowerCase();
    const attrs = parseAttrs(match[2]);

    switch (tag) {
      case 'img':
      case 'source':
        add(attrs.get('src'), 'asset');
        for (const candidate of parseSrcset(attrs.get('srcset') ?? '')) add(candidate, 'asset');
        break;
      case 'script':
      case 'iframe':
      case 'embed':
      case 'video':
      case 'audio':
      case 'track':
        add(attrs.get('src'), 'asset');
        break;
      case 'object':
        add(attrs.get('data'), 'asset');
        break;
      case 'use':
        add(attrs.get('href') ?? attrs.get('xlink:href'), 'asset');
        break;
      case 'link': {
        const rels = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/);
        if (rels.some((rel) => HINT_RELS.has(rel))) break;
        const isDocument = rels.some((rel) => DOCUMENT_RELS.has(rel));
        add(attrs.get('href'), isDocument ? 'page' : 'asset');
        break;
      }
      case 'a':
        add(attrs.get('href'), 'page');
        break;
      case 'meta': {
        const key = (attrs.get('property') ?? attrs.get('name') ?? '').toLowerCase();
        if (META_ASSET_KEYS.has(key)) add(attrs.get('content'), 'asset');
        break;
      }
    }
  }

  return found;
};

/*
 * A preview deploy still renders canonical and og:image as absolute production
 * URLs, so checking them literally would test production rather than the build
 * under review — and would fail on any PR that adds a new image, because the
 * file does not reach production until merge. Those are self-references, so
 * point them back at the deploy actually being tested.
 */
export const rewriteSelfOrigin = (url: string, base: URL, selfOrigins: Set<string>): string => {
  const parsed = new URL(url);
  if (parsed.origin === base.origin || !selfOrigins.has(parsed.origin)) return parsed.href;
  return new URL(parsed.pathname + parsed.search, base).href;
};

export const findCanonicalOrigin = (html: string): string | null => {
  for (const match of html.matchAll(/<link\b([^>]*)>/g)) {
    const attrs = parseAttrs(match[1]);
    if ((attrs.get('rel') ?? '').toLowerCase() !== 'canonical') continue;
    try {
      return new URL(decodeEntities(attrs.get('href') ?? '')).origin;
    } catch {
      return null;
    }
  }
  return null;
};

export const describeFailure = (
  kind: Reference['kind'],
  status: number,
  contentType: string | null
): string | null => {
  if (status >= 400) return `HTTP ${status}`;
  if (kind === 'asset' && /^text\/html\b/i.test(contentType ?? '')) {
    return `HTTP ${status} but served text/html — host returned a fallback page, not the file`;
  }
  return null;
};

const request = async (url: string, method: 'HEAD' | 'GET'): Promise<Response> =>
  fetch(url, { method, redirect: 'follow', headers: { 'user-agent': 'monkcode-asset-check' } });

/*
 * HEAD first to avoid pulling image bodies, but never fail on HEAD alone —
 * some hosts answer it with 403/405 while the resource is fine. A GET is the
 * authority, so only a failing HEAD costs a second round trip.
 */
const probe = async (
  url: string,
  attempts = 3
): Promise<{ status: number; type: string | null }> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      let response = await request(url, 'HEAD');
      if (response.status >= 400) response = await request(url, 'GET');
      return { status: response.status, type: response.headers.get('content-type') };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw lastError;
};

const mapWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
};

const isHtml = (contentType: string | null): boolean => /^text\/html\b/i.test(contentType ?? '');

interface Options {
  baseUrl: string;
  maxPages: number;
  concurrency: number;
}

export const checkDeployment = async ({
  baseUrl,
  maxPages,
  concurrency,
}: Options): Promise<Failure[]> => {
  const base = new URL(baseUrl);
  const selfOrigins = new Set([base.origin]);

  const queue: string[] = [base.href];
  const visitedPages = new Set<string>([base.href]);
  const references = new Map<string, Reference>();

  while (queue.length > 0 && visitedPages.size <= maxPages) {
    const pageUrl = queue.shift() as string;
    const response = await request(pageUrl, 'GET');
    const contentType = response.headers.get('content-type');

    /*
     * Vercel Deployment Protection answers every path with a redirect to its
     * own SSO app, which is itself a perfectly healthy site. Following that and
     * carrying on means crawling Vercel's login page and reporting its assets
     * as this deploy's broken references — 84 of them, on the first real run.
     */
    if (pageUrl === base.href && new URL(response.url).origin !== base.origin) {
      return [
        {
          url: pageUrl,
          kind: 'page',
          from: 'entry point',
          reason:
            `entry point redirected to ${new URL(response.url).origin}, so this is not the ` +
            'deploy under test. Vercel Deployment Protection does this — either disable it ' +
            'for preview deployments or supply a protection bypass.',
        },
      ];
    }

    if (!response.ok || !isHtml(contentType)) {
      /*
       * A linked page that fails is already reported, because it was reached as
       * a reference and gets probed like any other. The entry point is not — so
       * skipping it here would end the crawl with nothing collected and pass a
       * wholly broken deploy. Fail loudly instead.
       */
      if (pageUrl !== base.href) continue;

      return [
        {
          url: pageUrl,
          kind: 'page',
          from: 'entry point',
          reason: response.ok
            ? `entry point served ${contentType ?? 'no content-type'} rather than HTML`
            : `HTTP ${response.status}`,
        },
      ];
    }

    const html = await response.text();

    const canonicalOrigin = findCanonicalOrigin(html);
    if (canonicalOrigin) selfOrigins.add(canonicalOrigin);

    for (const reference of extractReferences(html, pageUrl)) {
      const url = rewriteSelfOrigin(reference.url, base, selfOrigins);
      const sameOrigin = new URL(url).origin === base.origin;

      // External page links rot independently of this repo; see the header.
      if (reference.kind === 'page' && !sameOrigin) continue;

      if (!references.has(url)) references.set(url, { ...reference, url });

      const crawlable = reference.kind === 'page' && sameOrigin;
      if (crawlable && !visitedPages.has(url) && visitedPages.size < maxPages) {
        visitedPages.add(url);
        queue.push(url);
      }
    }
  }

  const targets = [...references.values()];
  console.log(
    `Checked ${visitedPages.size} page(s), ${targets.length} unique reference(s) on ${base.origin}`
  );

  const outcomes = await mapWithConcurrency(targets, concurrency, async (reference) => {
    try {
      const { status, type } = await probe(reference.url);
      const reason = describeFailure(reference.kind, status, type);
      return reason ? { ...reference, reason } : null;
    } catch (error) {
      return { ...reference, reason: `request failed: ${(error as Error).message}` };
    }
  });

  return outcomes.filter((outcome): outcome is Failure => outcome !== null);
};

const NUMERIC_FLAGS = new Map([
  ['--max-pages', 'maxPages'],
  ['--concurrency', 'concurrency'],
] as const);

/*
 * Consumes each flag's value with the flag rather than scanning for the first
 * bare argument, so `--max-pages 10 <url>` cannot mistake `10` for the URL.
 */
export const parseArgs = (argv: string[]): Partial<Options> => {
  const parsed: Partial<Options> = {};

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const key = NUMERIC_FLAGS.get(arg as never);

    if (key) {
      const value = Number(argv[++index]);
      if (Number.isFinite(value) && value > 0) parsed[key] = value;
      continue;
    }
    if (arg.startsWith('--')) continue;
    parsed.baseUrl ??= arg;
  }

  return parsed;
};

// import.meta.main is Node 24; guards the CLI so the tests can import this file.
if (import.meta.main) {
  const { baseUrl, maxPages = 50, concurrency = 8 } = parseArgs(process.argv.slice(2));

  if (!baseUrl) {
    console.error('usage: check-deployed-assets.ts <url> [--max-pages N] [--concurrency N]');
    process.exit(2);
  }

  const failures = await checkDeployment({ baseUrl, maxPages, concurrency });

  if (failures.length === 0) {
    console.log('No broken references.');
    process.exit(0);
  }

  console.error(`\n${failures.length} broken reference(s):\n`);
  for (const failure of failures) {
    console.error(`  ${failure.reason}`);
    console.error(`    ${failure.url}`);
    console.error(`    referenced by ${failure.from}\n`);
  }
  process.exit(1);
}
