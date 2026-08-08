# deployed-asset-check

A merge gate that fails when a deployed page references something that does not resolve.

## Why it runs against a deploy

It grew out of a real incident. A homepage hero portrait shipped to production as:

```html
<img src="/images/__staging/main/__file/img-signal.webp">
```

which answered `404`. Three layers could plausibly have caught it. None could:

| Layer | Why it was blind |
| --- | --- |
| Build / typecheck | The site builds its CMS client in local mode, so the CDN rewrite that produced the bad path never happens. A `dist/`-based check is green. |
| Visual regression | Snapshots run against `localhost` — same local build, same blind spot. |
| Sentry | A failed `<img>` is a resource error, not an exception. `window.onerror` never fires, and a static site has no server runtime either. |

The only place the real content pipeline runs is a real deploy. So that is what this checks.

## Use it

```yaml
# .github/workflows/deployed-assets.yml
name: Deployed assets

on:
  pull_request:
    types: [opened, synchronize, reopened]

concurrency:
  group: deployed-assets-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  deployed-assets:
    permissions:
      contents: read
      deployments: read
    uses: monk-code/deployed-asset-check/.github/workflows/asset-check.yml@v1
```

> **The `permissions` block is required.** A called workflow may only narrow the caller's
> permissions, never widen them, and the default token is `read` — which covers contents and
> metadata but *not* deployments. Omit it and the run fails at startup with no job and no log
> saying why.

No secrets, no Vercel API token, no `pnpm install`. Vercel publishes each preview as a GitHub
Deployment whose ref is the head SHA, so the built-in token is enough to find the URL.

The job id in your caller is the status check name. To actually gate merges, add it to the
branch ruleset — otherwise it reports and auto-merge sails past it.

### If the project has Deployment Protection on

Protected previews redirect every path to Vercel SSO, so there is nothing to check — the run fails
saying so. Generate a **Protection Bypass for Automation** secret (Vercel → Project → Settings →
Deployment Protection), store it as a repository secret, and pass it through:

```yaml
jobs:
  deployed-assets:
    permissions:
      contents: read
      deployments: read
    uses: monk-code/deployed-asset-check/.github/workflows/asset-check.yml@v1
    secrets:
      vercel_protection_bypass: ${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}
```

The secret is sent to the deployment's own origin and to **nothing else**. A crawl reaches whatever
the pages reference — a CMS asset CDN, Google Fonts, an analytics script — and attaching a
credential to those requests would hand it to third parties. That scoping is a pure function with
its own tests, including one that stands up a second server and asserts it never sees the header.

### Inputs

| Input | Default | Purpose |
| --- | --- | --- |
| `sha` | PR head | Commit to find a preview for. |
| `max-pages` | `50` | Upper bound on pages crawled. |
| `concurrency` | `8` | Parallel requests while checking references. |

## What counts as broken

- Anything answering **>= 400**.
- An **asset** answering **200 with `text/html`** — a host serving its fallback page instead of
  the file, which is a 404 wearing a 200.

## What it deliberately does not check

**External `<a>` links.** They rot on someone else's schedule, and a merge gate that fails
because a third party reorganised their blog is a gate people learn to ignore.

External **assets** *are* checked, because the page visibly breaks when they disappear.

## Absolute self-references

A preview still renders `canonical` and `og:image` as production URLs. Checking those literally
would test production rather than the build under review — and would fail on every PR that adds
an image, since the file only reaches production at merge.

So references to the site's own origin are pointed back at the deploy being tested. That origin
is discovered from the page's own `canonical` tag, so there is nothing to configure per site.

## Running it by hand

```bash
node scripts/check-deployed-assets.ts https://example.com --max-pages 20
```

Exits `1` and prints each broken reference with the page that referenced it.

## Development

```bash
node --test 'scripts/**/*.test.ts'
```

Zero dependencies. The scripts are TypeScript run directly by Node 24's type stripping.
