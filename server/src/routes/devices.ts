/**
 * Kiosk and display device management.
 *
 * `POST /devices/pair` is intentionally unauthenticated — the tablet has no
 * credential yet, which is the entire point of pairing. It is protected instead by
 * the code being short-lived, single-use, and rate-limited, and by the fact that
 * redeeming one grants only queue access.
 */

import {
  createDeviceRequestSchema,
  pairDeviceRequestSchema,
  type DeviceDto,
  type PairDeviceResponse,
  type PairingCodeDto,
  ROLE,
} from '@francis/shared';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import { isTest } from '../config/env.js';
import type { DeviceType, Role } from '../generated/prisma/enums.js';
import { UnauthenticatedError } from '../lib/errors.js';
import { pathParam } from '../lib/http.js';
import { toDeviceDto } from '../mappers/auth.js';
import { requireRole } from '../middleware/require-auth.js';
import {
  createPairingCode,
  listDevices,
  redeemPairingCode,
  revokeDevice,
} from '../services/devices.js';

export const deviceRouter: Router = Router();

/** Brute-forcing an 8-digit code is the only real attack here; this makes it impractical. */
const pairRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => isTest,
});

deviceRouter.post('/devices', requireRole(ROLE.ADMIN as Role), async (req, res) => {
  if (req.auth?.kind !== 'user') throw new UnauthenticatedError();

  const { label, type } = createDeviceRequestSchema.parse(req.body);

  const created = await createPairingCode({
    label,
    type: type as DeviceType,
    createdByUserId: req.auth.userId,
  });

  const body: PairingCodeDto = {
    deviceId: created.deviceId,
    label: created.label,
    type: created.type,
    pairingCode: created.pairingCode,
    expiresAt: created.expiresAt.toISOString(),
  };

  res.status(201).json(body);
});

deviceRouter.post('/devices/pair', pairRateLimit, async (req, res) => {
  const { pairingCode } = pairDeviceRequestSchema.parse(req.body);

  const paired = await redeemPairingCode(pairingCode);

  const body: PairDeviceResponse = {
    deviceId: paired.deviceId,
    label: paired.label,
    type: paired.type,
    deviceToken: paired.deviceToken,
  };

  res.status(200).json(body);
});

deviceRouter.get('/devices', requireRole(ROLE.ADMIN as Role), async (_req, res) => {
  const devices = await listDevices();
  const body: DeviceDto[] = devices.map(toDeviceDto);
  res.json({ devices: body });
});

deviceRouter.post('/devices/:deviceId/revoke', requireRole(ROLE.ADMIN as Role), async (req, res) => {
  await revokeDevice(pathParam(req, 'deviceId'));
  res.status(204).send();
});
