/**
 * HTTP surface of the Work dashboard, mounted at /api/work.
 *
 * Every route takes the project's path (`projectPath`) and only works for
 * projects that have an entry in ~/.config/kvn-work/projects.json.
 */

import express from 'express';
import type { Request, Response } from 'express';

import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

import { listOpenPullRequests, type PullRequest } from './services/bitbucket.service.js';
import { listMyTasks, transitionIssue, type JiraTask } from './services/jira.service.js';
import { linksService, type WorkItemType } from './services/links.service.js';
import { todosService, type TodoStatus } from './services/todos.service.js';
import { getProjectConfig, readSecrets, type WorkProjectConfig } from './services/work-config.service.js';

type SourceResult<T> = { items: T; error: string | null; fetchedAt: string };

type RemoteSnapshot = {
  jira: SourceResult<JiraTask[]> | null;
  pullRequests: SourceResult<PullRequest[]> | null;
};

const CACHE_TTL_MS = 60_000;
const snapshotCache = new Map<string, { at: number; value: Promise<RemoteSnapshot> }>();

function readProjectPath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError('projectPath is required.', { code: 'INVALID_REQUEST', statusCode: 400 });
  }
  return value;
}

function requireConfig(projectPath: string): WorkProjectConfig {
  const config = getProjectConfig(projectPath);
  if (!config) {
    throw new AppError('Work is not set up for this project.', { code: 'WORK_NOT_CONFIGURED', statusCode: 404 });
  }
  return config;
}

async function settle<T>(load: () => Promise<T>, fallback: T): Promise<SourceResult<T>> {
  const fetchedAt = new Date().toISOString();
  try {
    return { items: await load(), error: null, fetchedAt };
  } catch (error) {
    console.warn('[work]', (error as Error).message);
    return { items: fallback, error: (error as Error).message, fetchedAt };
  }
}

function loadSnapshot(projectPath: string, config: WorkProjectConfig, force: boolean): Promise<RemoteSnapshot> {
  const cached = snapshotCache.get(projectPath);
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const secrets = readSecrets();
  const value = (async (): Promise<RemoteSnapshot> => {
    const [jira, pullRequests] = await Promise.all([
      config.jira ? settle(() => listMyTasks(secrets, config.jira!), [] as JiraTask[]) : Promise.resolve(null),
      config.bitbucket ? settle(() => listOpenPullRequests(secrets, config.bitbucket!), [] as PullRequest[]) : Promise.resolve(null),
    ]);
    return { jira, pullRequests };
  })();
  snapshotCache.set(projectPath, { at: Date.now(), value });
  // A failed load should not stay cached for a full minute.
  value.then((snap) => {
    if (snap.jira?.error || snap.pullRequests?.error) {
      setTimeout(() => {
        if (snapshotCache.get(projectPath)?.value === value) snapshotCache.delete(projectPath);
      }, 10_000);
    }
  }).catch(() => snapshotCache.delete(projectPath));
  return value;
}

const router = express.Router();

/** Which Work sources a project has; `enabled: false` hides the Work tab. */
router.get('/config', (req: Request, res: Response) => {
  const projectPath = typeof req.query.projectPath === 'string' ? req.query.projectPath : '';
  const config = getProjectConfig(projectPath);
  res.json(createApiSuccessResponse({
    enabled: Boolean(config),
    name: config?.name ?? null,
    jira: config?.jira
      ? {
          projectKey: config.jira.projectKey,
          statuses: config.jira.statuses,
          collapsedStatuses: config.jira.collapsedStatuses ?? [],
          actions: config.jira.actions,
        }
      : null,
    bitbucket: config?.bitbucket ? { workspace: config.bitbucket.workspace, repos: config.bitbucket.repos } : null,
    todos: Boolean(config?.todos),
  }));
});

/** Everything the dashboard shows. Remote sources are cached for a minute; `refresh=1` skips the cache. */
router.get('/items', asyncHandler(async (req: Request, res: Response) => {
  const projectPath = readProjectPath(req.query.projectPath);
  const config = requireConfig(projectPath);
  const snapshot = await loadSnapshot(projectPath, config, req.query.refresh === '1');
  res.json(createApiSuccessResponse({
    todos: config.todos ? todosService.list(projectPath) : null,
    links: linksService.list(projectPath),
    ...snapshot,
  }));
}));

router.post('/todos', asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const projectPath = readProjectPath(body.projectPath);
  requireConfig(projectPath);
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) throw new AppError('text is required.', { code: 'INVALID_REQUEST', statusCode: 400 });
  res.status(201).json(createApiSuccessResponse(todosService.create(projectPath, text.slice(0, 2000))));
}));

router.patch('/todos/:id', asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const status = body.status;
  if (status !== undefined && !['open', 'done', 'cancelled'].includes(status as string)) {
    throw new AppError('status must be open, done or cancelled.', { code: 'INVALID_REQUEST', statusCode: 400 });
  }
  const text = typeof body.text === 'string' && body.text.trim() ? body.text.trim().slice(0, 2000) : undefined;
  const updated = todosService.update(id, { status: status as TodoStatus | undefined, text });
  if (!updated) throw new AppError('To-do not found.', { code: 'NOT_FOUND', statusCode: 404 });
  res.json(createApiSuccessResponse(updated));
}));

router.delete('/todos/:id', asyncHandler(async (req: Request, res: Response) => {
  if (!todosService.remove(Number(req.params.id))) {
    throw new AppError('To-do not found.', { code: 'NOT_FOUND', statusCode: 404 });
  }
  res.json(createApiSuccessResponse({ deleted: true }));
}));

function readLinkBody(body: Record<string, unknown>): { projectPath: string; itemType: WorkItemType; itemKey: string; sessionId: string } {
  const projectPath = readProjectPath(body.projectPath);
  requireConfig(projectPath);
  const itemType = body.itemType;
  if (itemType !== 'jira' && itemType !== 'todo') {
    throw new AppError('itemType must be jira or todo.', { code: 'INVALID_REQUEST', statusCode: 400 });
  }
  const itemKey = typeof body.itemKey === 'string' || typeof body.itemKey === 'number' ? String(body.itemKey).trim() : '';
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  if (!itemKey || !sessionId) {
    throw new AppError('itemKey and sessionId are required.', { code: 'INVALID_REQUEST', statusCode: 400 });
  }
  return { projectPath, itemType, itemKey, sessionId };
}

/** Attaches a chat session to a Jira task or to-do. */
router.post('/links', asyncHandler(async (req: Request, res: Response) => {
  const link = readLinkBody((req.body ?? {}) as Record<string, unknown>);
  linksService.add(link.projectPath, link.itemType, link.itemKey, link.sessionId);
  res.status(201).json(createApiSuccessResponse({ linked: true }));
}));

router.delete('/links', asyncHandler(async (req: Request, res: Response) => {
  const link = readLinkBody((req.body ?? {}) as Record<string, unknown>);
  linksService.remove(link.projectPath, link.itemType, link.itemKey, link.sessionId);
  res.json(createApiSuccessResponse({ linked: false }));
}));

/** Moves a Jira issue to another status by name; answers with the status it came from so the UI can undo. */
router.post('/jira/:key/transition', asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const projectPath = readProjectPath(body.projectPath);
  const config = requireConfig(projectPath);
  if (!config.jira) throw new AppError('Jira is not set up for this project.', { code: 'WORK_NOT_CONFIGURED', statusCode: 404 });
  const to = typeof body.to === 'string' ? body.to : '';
  if (!to) throw new AppError('to is required.', { code: 'INVALID_REQUEST', statusCode: 400 });
  const key = String(req.params.key).toUpperCase();
  if (!key.startsWith(`${config.jira.projectKey}-`)) {
    throw new AppError(`Only ${config.jira.projectKey} issues can be moved here.`, { code: 'INVALID_REQUEST', statusCode: 400 });
  }
  try {
    const result = await transitionIssue(readSecrets(), key, to);
    snapshotCache.delete(projectPath);
    res.json(createApiSuccessResponse({ key, ...result }));
  } catch (error) {
    throw new AppError((error as Error).message, { code: 'JIRA_TRANSITION_FAILED', statusCode: 502 });
  }
}));

export default router;
