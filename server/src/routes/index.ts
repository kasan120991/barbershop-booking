import { Router } from 'express';

import { authRouter } from './auth.js';
import { barberRouter } from './barbers.js';
import { bookingRouter } from './booking.js';
import { catalogRouter } from './catalog.js';
import { connectRouter } from './connect.js';
import { deviceRouter } from './devices.js';
import { healthRouter } from './health.js';
import { paymentRouter } from './payments.js';
import { payoutRouter } from './payouts.js';
import { queueRouter } from './queue.js';
import { rentRouter } from './rent.js';
import { staffRouter } from './staff.js';

/** Everything mounted under `API_PREFIX`. New resource routers get registered here. */
export const apiRouter: Router = Router();

apiRouter.use(healthRouter);
apiRouter.use(authRouter);
apiRouter.use(deviceRouter);
apiRouter.use(staffRouter);
apiRouter.use(catalogRouter);
apiRouter.use(barberRouter);
apiRouter.use(connectRouter);
apiRouter.use(paymentRouter);
apiRouter.use(payoutRouter);
apiRouter.use(rentRouter);
apiRouter.use(bookingRouter);
apiRouter.use(queueRouter);
