/*
 * Resolves the preview URL for a commit, waiting for Vercel to finish.
 *
 * Vercel's git integration publishes each preview as a GitHub Deployment whose
 * ref is the head SHA, so the URL is readable with the built-in Actions token.
 * That keeps this free of a Vercel API token and of any third-party action.
 */

import { appendFileSync } from 'node:fs';

export type Verdict =
  | { readonly kind: 'ready'; readonly url: string }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'failed'; readonly reason: string };

interface DeploymentStatus {
  state?: string;
  environment_url?: string | null;
}

export const readVerdict = (status: DeploymentStatus | undefined): Verdict => {
  switch (status?.state) {
    case 'success':
      return status.environment_url
        ? { kind: 'ready', url: status.environment_url }
        : { kind: 'failed', reason: 'Vercel reported success without a preview URL' };
    case 'failure':
    case 'error':
      return {
        kind: 'failed',
        reason: 'The Vercel preview failed to deploy, so its assets cannot be checked',
      };
    default:
      return { kind: 'waiting' };
  }
};

const api = async <T>(path: string, token: string): Promise<T | null> => {
  try {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'monkcode-preview-wait',
      },
    });

    /*
     * Never poll through an auth failure. Without `deployments: read` on the
     * calling job every read is a 403, which is indistinguishable from "not
     * deployed yet" — the run would sit for the whole timeout and then blame
     * Vercel for a permissions mistake.
     */
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `GitHub answered ${response.status} for ${path}. The calling job needs ` +
          'permissions: { contents: read, deployments: read }.'
      );
    }

    return response.ok ? ((await response.json()) as T) : null;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('GitHub answered')) throw error;
    // Fails open: a transient 5xx costs one poll, not the whole run.
    return null;
  }
};

interface WaitOptions {
  repository: string;
  sha: string;
  token: string;
  attempts?: number;
  intervalMs?: number;
}

export const waitForPreview = async ({
  repository,
  sha,
  token,
  attempts = 60,
  intervalMs = 15_000,
}: WaitOptions): Promise<string> => {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const deployments = await api<{ id: number }[]>(
      `/repos/${repository}/deployments?sha=${sha}`,
      token
    );
    const id = deployments?.[0]?.id;

    if (id !== undefined) {
      const statuses = await api<DeploymentStatus[]>(
        `/repos/${repository}/deployments/${id}/statuses`,
        token
      );
      const verdict = readVerdict(statuses?.[0]);

      if (verdict.kind === 'ready') return verdict.url;
      if (verdict.kind === 'failed') throw new Error(verdict.reason);
    }

    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out waiting for a Vercel preview of ${sha}`);
};

if (import.meta.main) {
  const { GITHUB_REPOSITORY, GITHUB_OUTPUT } = process.env;
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const sha = process.env.SHA;

  if (!GITHUB_REPOSITORY || !token || !sha) {
    console.error('GITHUB_REPOSITORY, SHA and GH_TOKEN (or GITHUB_TOKEN) are all required');
    process.exit(2);
  }

  try {
    const url = await waitForPreview({ repository: GITHUB_REPOSITORY, sha, token });
    console.log(`Preview: ${url}`);
    if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `url=${url}\n`);
  } catch (error) {
    console.error(`::error::${(error as Error).message}`);
    process.exit(1);
  }
}
