/**
 * Admin actions on staff accounts.
 *
 * Password reset returns the temporary password in the response body because there is
 * no other channel — v1 sends no email or SMS, so the admin reads it to the barber in
 * person. It is shown once and is not retrievable afterwards.
 */

import { ROLE, type TemporaryPasswordDto } from '@francis/shared';
import { Router } from 'express';

import type { Role } from '../generated/prisma/enums.js';
import { pathParam } from '../lib/http.js';
import { requireRole } from '../middleware/require-auth.js';
import { adminResetPassword, unlockUser } from '../services/auth.js';

export const staffRouter: Router = Router();

staffRouter.post(
  '/staff/:userId/reset-password',
  requireRole(ROLE.ADMIN as Role),
  async (req, res) => {
    const userId = pathParam(req, 'userId');
    const temporaryPassword = await adminResetPassword(userId);

    const body: TemporaryPasswordDto = { userId, temporaryPassword };
    res.status(200).json(body);
  },
);

staffRouter.post('/staff/:userId/unlock', requireRole(ROLE.ADMIN as Role), async (req, res) => {
  await unlockUser(pathParam(req, 'userId'));
  res.status(204).send();
});
