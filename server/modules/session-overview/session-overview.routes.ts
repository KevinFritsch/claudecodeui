import express from 'express';
import type { Request, Response } from 'express';

import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

import { listSessionCards } from './session-overview.service.js';

const router = express.Router();

/** Kvn: a project's sessions as cards; `q` searches titles and everything said in them. */
router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
  if (!projectId) throw new AppError('projectId is required.', { code: 'INVALID_REQUEST', statusCode: 400 });
  const query = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
  const limit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : undefined;
  res.json(createApiSuccessResponse(await listSessionCards(projectId, { query, limit })));
}));

export default router;
