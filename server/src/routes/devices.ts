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
  DEVICE_TYPE,
  pairDeviceRequestSchema,
  type DeviceDto,
  type PairDeviceResponse,
  type PairingCodeDto,
  type VoiceCredentialDto,
  ROLE,
} from '@francis/shared';
import { Router } from 'express';

import type { DeviceType, Role } from '../generated/prisma/enums.js';
import { UnauthenticatedError } from '../lib/errors.js';
import { pathParam } from '../lib/http.js';
import { limiter } from '../lib/rate-limit.js';
import { toDeviceDto } from '../mappers/auth.js';
import { requireRole } from '../middleware/require-auth.js';
import { auditContext, recordAudit } from '../services/audit.js';
import {
  createPairingCode,
  createVoiceCredential,
  deleteRevokedDevice,
  listDevices,
  redeemPairingCode,
  revokeDevice,
} from '../services/devices.js';

export const deviceRouter: Router = Router();

/** Brute-forcing an 8-digit code is the only real attack here; this makes it impractical. */
const pairRateLimit = limiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: 'Too many pairing attempts. Wait a few minutes, then ask for a fresh code.',
});

/**
 * Creating a screen hands back a pairing code; creating a voice line hands back the
 * token itself.
 *
 * The branch is here rather than in two routes because it is one act — an admin issuing
 * a credential to a machine — and the audit row, the role check and the "shown once"
 * handling are identical. What differs is only which secret a device with no screen can
 * be given, which `createVoiceCredential` explains.
 */
deviceRouter.post('/devices', requireRole(ROLE.ADMIN as Role), async (req, res) => {
  if (req.auth?.kind !== 'user') throw new UnauthenticatedError();

  const { label, type } = createDeviceRequestSchema.parse(req.body);

  if (type === DEVICE_TYPE.VOICE) {
    const voice = await createVoiceCredential({ label, createdByUserId: req.auth.userId });

    // Picked fields, never `after: voice` — that object carries the live token.
    await recordAudit(auditContext(req), {
      action: 'device.created',
      entityType: 'Device',
      entityId: voice.deviceId,
      after: { label: voice.label, type: voice.type },
    });

    const voiceBody: VoiceCredentialDto = {
      deviceId: voice.deviceId,
      label: voice.label,
      type: DEVICE_TYPE.VOICE,
      deviceToken: voice.deviceToken,
    };

    res.status(201).json(voiceBody);
    return;
  }

  const created = await createPairingCode({
    label,
    type: type as DeviceType,
    createdByUserId: req.auth.userId,
  });

  // Deliberately not `after: created` — that object carries the plaintext pairing code,
  // and the audit trail is not a place to keep a live credential.
  await recordAudit(auditContext(req), {
    action: 'device.created',
    entityType: 'Device',
    entityId: created.deviceId,
    after: { label: created.label, type: created.type },
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
  const deviceId = pathParam(req, 'deviceId');

  const { before, after } = await revokeDevice(deviceId);

  await recordAudit(auditContext(req), {
    action: 'device.revoked',
    entityType: 'Device',
    entityId: deviceId,
    before,
    after,
  });

  res.status(204).send();
});

/**
 * Tidying up. Refuses anything not already revoked — see `deleteRevokedDevice` — so a
 * working screen cannot be unpaired by a stray click on a list row.
 */
deviceRouter.delete('/devices/:deviceId', requireRole(ROLE.ADMIN as Role), async (req, res) => {
  const deviceId = pathParam(req, 'deviceId');

  const deleted = await deleteRevokedDevice(deviceId);

  await recordAudit(auditContext(req), {
    action: 'device.deleted',
    entityType: 'Device',
    entityId: deviceId,
    // The last chance to record what an `actorDeviceId` in an older row referred to.
    before: deleted,
  });

  res.status(204).send();
});
