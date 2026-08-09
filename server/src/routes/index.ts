import { Router } from 'express';

import { healthRouter } from './health.js';

/** Everything mounted under `API_PREFIX`. New resource routers get registered here. */
export const apiRouter: Router = Router();

apiRouter.use(healthRouter);
