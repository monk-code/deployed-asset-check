import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readVerdict } from './wait-for-vercel-preview.ts';

test('returns the preview URL once Vercel reports success', () => {
  const verdict = readVerdict({
    state: 'success',
    environment_url: 'https://site-git-branch-team.vercel.app',
  });
  assert.deepEqual(verdict, { kind: 'ready', url: 'https://site-git-branch-team.vercel.app' });
});

test('keeps waiting while the deployment is pending or building', () => {
  assert.equal(readVerdict({ state: 'pending' }).kind, 'waiting');
  assert.equal(readVerdict({ state: 'in_progress' }).kind, 'waiting');
  assert.equal(readVerdict(undefined).kind, 'waiting');
});

test('stops on a failed deployment rather than waiting out the timeout', () => {
  assert.equal(readVerdict({ state: 'failure' }).kind, 'failed');
  assert.equal(readVerdict({ state: 'error' }).kind, 'failed');
});

/*
 * A success with no URL would otherwise hand an empty string to the checker,
 * which would then crawl nothing and pass — the gate silently doing nothing is
 * worse than the gate erroring.
 */
test('treats success without a URL as a failure', () => {
  const verdict = readVerdict({ state: 'success', environment_url: null });
  assert.equal(verdict.kind, 'failed');
});
