import express from 'express';
import type { Request, Response } from 'express';

import {
  getSessionWarmupState,
  runSessionWarmupNow,
  saveSessionWarmupConfig,
} from '@/modules/session-warmup/services/session-warmup.service.js';
import { asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

const router = express.Router();

router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(createApiSuccessResponse(getSessionWarmupState()));
  }),
);

router.put(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse(saveSessionWarmupConfig(req.body)));
  }),
);

router.post(
  '/run',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(createApiSuccessResponse(await runSessionWarmupNow()));
  }),
);

export default router;
