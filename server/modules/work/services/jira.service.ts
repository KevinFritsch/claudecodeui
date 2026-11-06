/**
 * Jira Cloud client for the Work dashboard.
 *
 * Scoped API tokens only work through the api.atlassian.com gateway
 * (`/ex/jira/<cloudId>/rest/api/3`), never on the site URL, with Basic auth
 * `<atlassian email>:<token>`.
 */

import type { JiraProjectConfig, WorkSecrets } from './work-config.service.js';

export type JiraTask = {
  key: string;
  summary: string;
  status: string;
  statusCategory: string;
  issueType: string;
  issueTypeIcon: string | null;
  priority: string | null;
  priorityIcon: string | null;
  updated: string;
  url: string;
};

type JiraCredentials = { base: string; auth: string };

function credentials(secrets: WorkSecrets): JiraCredentials {
  const { ATLASSIAN_EMAIL, JIRA_API_TOKEN, JIRA_CLOUD_ID } = secrets;
  if (!ATLASSIAN_EMAIL || !JIRA_API_TOKEN || !JIRA_CLOUD_ID) {
    throw new Error('Jira is not configured: ATLASSIAN_EMAIL, JIRA_API_TOKEN and JIRA_CLOUD_ID are needed in secrets.env.');
  }
  return {
    base: `https://api.atlassian.com/ex/jira/${JIRA_CLOUD_ID}/rest/api/3`,
    auth: `Basic ${Buffer.from(`${ATLASSIAN_EMAIL}:${JIRA_API_TOKEN}`).toString('base64')}`,
  };
}

async function jiraFetch<T>(creds: JiraCredentials, pathAndQuery: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${creds.base}${pathAndQuery}`, {
    ...init,
    headers: {
      Authorization: creds.auth,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Jira ${response.status}: ${text.slice(0, 300)}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

let siteUrlCache: string | null = null;

async function siteUrl(creds: JiraCredentials): Promise<string> {
  if (siteUrlCache) return siteUrlCache;
  const info = await jiraFetch<{ baseUrl: string }>(creds, '/serverInfo');
  siteUrlCache = info.baseUrl.replace(/\/+$/, '');
  return siteUrlCache;
}

const quote = (value: string) => `"${value.replace(/"/g, '\\"')}"`;

export async function listMyTasks(secrets: WorkSecrets, config: JiraProjectConfig): Promise<JiraTask[]> {
  const creds = credentials(secrets);
  const site = await siteUrl(creds);
  const jql = [
    `project = ${quote(config.projectKey)}`,
    'assignee = currentUser()',
    `status in (${config.statuses.map(quote).join(', ')})`,
  ].join(' AND ') + ' ORDER BY updated DESC';

  const tasks: JiraTask[] = [];
  let nextPageToken: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const params = new URLSearchParams({
      jql,
      fields: 'summary,status,issuetype,priority,updated',
      maxResults: '100',
    });
    if (nextPageToken) params.set('nextPageToken', nextPageToken);
    type SearchResponse = {
      issues: Array<{
        key: string;
        fields: {
          summary: string;
          status: { name: string; statusCategory?: { key: string } };
          issuetype?: { name: string; iconUrl?: string };
          priority?: { name: string; iconUrl?: string } | null;
          updated: string;
        };
      }>;
      nextPageToken?: string;
      isLast?: boolean;
    };
    const data = await jiraFetch<SearchResponse>(creds, `/search/jql?${params}`);
    for (const issue of data.issues) {
      tasks.push({
        key: issue.key,
        summary: issue.fields.summary,
        status: issue.fields.status.name,
        statusCategory: issue.fields.status.statusCategory?.key ?? '',
        issueType: issue.fields.issuetype?.name ?? '',
        issueTypeIcon: issue.fields.issuetype?.iconUrl ?? null,
        priority: issue.fields.priority?.name ?? null,
        priorityIcon: issue.fields.priority?.iconUrl ?? null,
        updated: issue.fields.updated,
        url: `${site}/browse/${issue.key}`,
      });
    }
    if (data.isLast !== false || !data.nextPageToken) break;
    nextPageToken = data.nextPageToken;
  }
  return tasks;
}

/**
 * Moves an issue to the status named `toStatus`, matching either the
 * transition's own name or its target status (Jira names them differently,
 * e.g. transition "Canceled" → status "Cancelled").
 */
export async function transitionIssue(secrets: WorkSecrets, key: string, toStatus: string): Promise<{ from: string; to: string }> {
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) throw new Error('Invalid issue key.');
  const creds = credentials(secrets);
  const issue = await jiraFetch<{ fields: { status: { name: string } } }>(creds, `/issue/${key}?fields=status`);
  const from = issue.fields.status.name;
  const { transitions } = await jiraFetch<{ transitions: Array<{ id: string; name: string; to: { name: string } }> }>(
    creds,
    `/issue/${key}/transitions`,
  );
  const wanted = toStatus.toLowerCase();
  const match = transitions.find((t) => t.to.name.toLowerCase() === wanted)
    ?? transitions.find((t) => t.name.toLowerCase() === wanted);
  if (!match) {
    throw new Error(`${key} cannot move to "${toStatus}" from "${from}".`);
  }
  await jiraFetch(creds, `/issue/${key}/transitions`, {
    method: 'POST',
    body: JSON.stringify({ transition: { id: match.id } }),
  });
  return { from, to: match.to.name };
}
