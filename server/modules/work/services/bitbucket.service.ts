/**
 * Bitbucket Cloud client for the Work dashboard: open pull requests across
 * the project's repos, split into the user's own and the team's.
 *
 * Auth is Basic `<atlassian email>:<scoped API token>` (read:pullrequest).
 */

import type { BitbucketProjectConfig, WorkSecrets } from './work-config.service.js';

export type PullRequest = {
  repo: string;
  id: number;
  title: string;
  url: string;
  author: string;
  authorAccountId: string | null;
  isMine: boolean;
  sourceBranch: string;
  destinationBranch: string;
  /** Jira keys found in the branch name or title, e.g. ["GOL-3540"]. */
  issueKeys: string[];
  commentCount: number;
  taskCount: number;
  approvals: number;
  reviewers: Array<{ name: string; approved: boolean }>;
  createdOn: string;
  updatedOn: string;
  draft: boolean;
};

const ISSUE_KEY = /\b([A-Z][A-Z0-9]+-\d+)\b/gi;

function issueKeysIn(...texts: string[]): string[] {
  const keys = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(ISSUE_KEY)) keys.add(match[1].toUpperCase());
  }
  return [...keys];
}

export async function listOpenPullRequests(
  secrets: WorkSecrets,
  config: BitbucketProjectConfig,
): Promise<PullRequest[]> {
  const { ATLASSIAN_EMAIL, BITBUCKET_API_TOKEN } = secrets;
  if (!ATLASSIAN_EMAIL || !BITBUCKET_API_TOKEN) {
    throw new Error('Bitbucket is not configured: ATLASSIAN_EMAIL and BITBUCKET_API_TOKEN are needed in secrets.env.');
  }
  const auth = `Basic ${Buffer.from(`${ATLASSIAN_EMAIL}:${BITBUCKET_API_TOKEN}`).toString('base64')}`;
  const myAccountId = secrets.ATLASSIAN_ACCOUNT_ID || null;

  const fields = [
    'values.id', 'values.title', 'values.draft', 'values.links.html.href',
    'values.author.display_name', 'values.author.account_id',
    'values.source.branch.name', 'values.destination.branch.name',
    'values.comment_count', 'values.task_count',
    'values.participants.user.display_name', 'values.participants.role', 'values.participants.approved',
    'values.created_on', 'values.updated_on',
  ].join(',');

  type Raw = {
    id: number;
    title: string;
    draft?: boolean;
    links: { html: { href: string } };
    author: { display_name: string; account_id?: string };
    source: { branch: { name: string } };
    destination: { branch: { name: string } };
    comment_count: number;
    task_count: number;
    participants?: Array<{ user: { display_name: string }; role: string; approved: boolean }>;
    created_on: string;
    updated_on: string;
  };

  const perRepo = await Promise.all(config.repos.map(async (repo) => {
    const url = `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(config.workspace)}/${encodeURIComponent(repo)}/pullrequests?state=OPEN&pagelen=50&fields=${encodeURIComponent(fields)}`;
    const response = await fetch(url, {
      headers: { Authorization: auth, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404) return [];
    if (!response.ok) {
      throw new Error(`Bitbucket ${repo} ${response.status}: ${(await response.text().catch(() => '')).slice(0, 200)}`);
    }
    const data = (await response.json()) as { values: Raw[] };
    return data.values.map((pr): PullRequest => {
      const participants = pr.participants ?? [];
      return {
        repo,
        id: pr.id,
        title: pr.title,
        url: pr.links.html.href,
        author: pr.author.display_name,
        authorAccountId: pr.author.account_id ?? null,
        isMine: Boolean(myAccountId && pr.author.account_id === myAccountId),
        sourceBranch: pr.source.branch.name,
        destinationBranch: pr.destination.branch.name,
        issueKeys: issueKeysIn(pr.source.branch.name, pr.title),
        commentCount: pr.comment_count,
        taskCount: pr.task_count,
        approvals: participants.filter((p) => p.approved).length,
        reviewers: participants
          .filter((p) => p.role === 'REVIEWER')
          .map((p) => ({ name: p.user.display_name, approved: p.approved })),
        createdOn: pr.created_on,
        updatedOn: pr.updated_on,
        draft: Boolean(pr.draft),
      };
    });
  }));

  return perRepo.flat().sort((a, b) => b.updatedOn.localeCompare(a.updatedOn));
}
