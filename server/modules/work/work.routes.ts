/**
 * HTTP surface of the Work dashboard, mounted at /api/work.
 *
 * Every route takes the project's path (`projectPath`) and only works for
 * projects that have an entry in ~/.config/kvn-work/projects.json.
 */

import express from 'express';
import type { Request, Response } from 'express';

import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

import { transitionIssue } from './services/jira.service.js';
import { linksService, type WorkItemType } from './services/links.service.js';
import { resolvedService } from './services/resolved.service.js';
import { markDone, postReply, unmarkDone } from './services/slack.service.js';
import { getSnapshot, markStale, patchSnapshot, warmAllProjects } from './services/snapshot.service.js';
import { todosService, type TodoStatus } from './services/todos.service.js';
import { getProjectConfig, readSecrets, type WorkProjectConfig } from './services/work-config.service.js';

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

const router = express.Router();

warmAllProjects();

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
    slack: config?.slack ? { lookbackDays: config.slack.lookbackDays ?? 7 } : null,
    todos: Boolean(config?.todos),
  }));
});

/** Everything the dashboard shows. Remote sources are cached for a minute; `refresh=1` skips the cache. */
router.get('/items', asyncHandler(async (req: Request, res: Response) => {
  const projectPath = readProjectPath(req.query.projectPath);
  const config = requireConfig(projectPath);
  const { snapshot, fetchedAt, refreshing } = await getSnapshot(projectPath, config, { force: req.query.refresh === '1' });
  // Resolved Slack mentions are hidden from the open list but kept, so they can be brought back.
  const resolvedSlack = resolvedService.keys(projectPath, 'slack');
  const slack = snapshot.slack
    ? { ...snapshot.slack, items: snapshot.slack.items.filter((m) => !resolvedSlack.has(m.id)) }
    : null;
  res.json(createApiSuccessResponse({
    todos: config.todos ? todosService.list(projectPath) : null,
    links: linksService.list(projectPath),
    ...snapshot,
    slack,
    slackResolved: snapshot.slack ? snapshot.slack.items.filter((m) => resolvedSlack.has(m.id)) : [],
    fetchedAt,
    refreshing,
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
  if (itemType !== 'jira' && itemType !== 'todo' && itemType !== 'slack') {
    throw new AppError('itemType must be jira, todo or slack.', { code: 'INVALID_REQUEST', statusCode: 400 });
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

function readSlackId(body: Record<string, unknown>): { projectPath: string; id: string } {
  const projectPath = readProjectPath(body.projectPath);
  const config = requireConfig(projectPath);
  if (!config.slack) throw new AppError('Slack is not set up for this project.', { code: 'WORK_NOT_CONFIGURED', statusCode: 404 });
  const id = typeof body.id === 'string' ? body.id : '';
  if (!/^[A-Z0-9]+:\d+\.\d+$/.test(id)) throw new AppError('Invalid Slack message id.', { code: 'INVALID_REQUEST', statusCode: 400 });
  return { projectPath, id };
}

async function slackAction<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new AppError((error as Error).message, { code: 'SLACK_ACTION_FAILED', statusCode: 502 });
  }
}

/** Hides items from the dashboard (or brings them back) without touching Slack or Jira. */
router.post('/resolve', asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const projectPath = readProjectPath(body.projectPath);
  requireConfig(projectPath);
  const itemType = body.itemType;
  if (itemType !== 'slack' && itemType !== 'jira' && itemType !== 'todo') {
    throw new AppError('itemType must be slack, jira or todo.', { code: 'INVALID_REQUEST', statusCode: 400 });
  }
  const keys = Array.isArray(body.itemKeys) ? body.itemKeys.filter((k): k is string => typeof k === 'string' && k.length > 0 && k.length < 200) : [];
  if (keys.length === 0 || keys.length > 500) throw new AppError('itemKeys is required.', { code: 'INVALID_REQUEST', statusCode: 400 });
  resolvedService.set(projectPath, itemType, keys, body.resolved !== false);
  res.json(createApiSuccessResponse({ count: keys.length, resolved: body.resolved !== false }));
}));

/** ✅ a Slack message as the user (or undo it with done=false). */
router.post('/slack/done', asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { projectPath, id } = readSlackId(body);
  const secrets = readSecrets();
  await slackAction(() => (body.done === false ? unmarkDone(secrets, id) : markDone(secrets, id)));
  if (body.done === false) {
    markStale(projectPath);
  } else {
    patchSnapshot(projectPath, (snap) => {
      if (snap.slack) snap.slack.items = snap.slack.items.filter((m) => m.id !== id);
    });
  }
  res.json(createApiSuccessResponse({ id, done: body.done !== false }));
}));

/** Replies in the message's thread, as the user. */
router.post('/slack/reply', asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { projectPath, id } = readSlackId(body);
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const threadTs = typeof body.threadTs === 'string' ? body.threadTs : '';
  if (!text) throw new AppError('text is required.', { code: 'INVALID_REQUEST', statusCode: 400 });
  const result = await slackAction(() => postReply(readSecrets(), id, threadTs, text.slice(0, 4000)));
  patchSnapshot(projectPath, (snap) => {
    if (snap.slack) snap.slack.items = snap.slack.items.filter((m) => m.id !== id);
  });
  res.json(createApiSuccessResponse({ id, ...result }));
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
    patchSnapshot(projectPath, (snap) => {
      const task = snap.jira?.items.find((t) => t.key === key);
      if (task) {
        task.status = result.to;
        task.updated = new Date().toISOString();
      }
    });
    res.json(createApiSuccessResponse({ key, ...result }));
  } catch (error) {
    throw new AppError((error as Error).message, { code: 'JIRA_TRANSITION_FAILED', statusCode: 502 });
  }
}));

export default router;
