/**
 * Kiosk and display device pairing.
 *
 * A device has no user behind it, so its token grants a deliberately narrow scope:
 * join the queue and read the board. It must never reach client history, phone
 * numbers, or payment. That scope is enforced by the route middleware; this module
 * only owns the credential lifecycle.
 *
 * Lifecycle: admin creates a pending row with a short-lived code -> the tablet
 * redeems the code once, which clears it and sets a token -> the token works until
 * an admin revokes it.
 */

import { isTest } from '../config/env.js';
import type { DeviceType } from '../generated/prisma/enums.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { generatePairingCode, generateToken, hashToken, normalizePairingCode } from '../lib/tokens.js';

/**
 * Long enough to walk a tablet over and type it in, short enough that a code left on
 * a screen does not stay usable.
 */
export const PAIRING_CODE_TTL_MINUTES = 15;

export interface CreatedPairingCode {
  deviceId: string;
  label: string;
  type: DeviceType;
  /** Plaintext, returned exactly once. Only the hash is stored. */
  pairingCode: string;
  expiresAt: Date;
}

export interface PairedDevice {
  deviceId: string;
  label: string;
  type: DeviceType;
  /** Plaintext, returned exactly once so the tablet can store it. */
  deviceToken: string;
}

export interface ResolvedDevice {
  deviceId: string;
  label: string;
  type: DeviceType;
}

export async function createPairingCode(input: {
  label: string;
  type: DeviceType;
  createdByUserId: string;
}): Promise<CreatedPairingCode> {
  const pairingCode = generatePairingCode();
  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MINUTES * 60 * 1000);

  const device = await prisma.device.create({
    data: {
      label: input.label,
      type: input.type,
      pairingCodeHash: hashToken(pairingCode),
      pairingCodeExpiresAt: expiresAt,
      createdByUserId: input.createdByUserId,
    },
  });

  return {
    deviceId: device.id,
    label: device.label,
    type: device.type,
    pairingCode,
    expiresAt,
  };
}

/**
 * Exchanges a pairing code for a device token.
 *
 * Single-use is enforced by clearing `pairingCodeHash` in the same update that sets
 * the token, and by scoping that update with `pairingCodeHash` still matching. Two
 * tablets racing on the same code means one update matches zero rows and fails.
 */
export async function redeemPairingCode(codeInput: string): Promise<PairedDevice> {
  const code = normalizePairingCode(codeInput);
  const codeHash = hashToken(code);

  const device = await prisma.device.findUnique({ where: { pairingCodeHash: codeHash } });
  if (!device) throw new NotFoundError('That pairing code is not valid.');

  if (device.revokedAt !== null) {
    throw new ConflictError('That pairing code is no longer valid.');
  }

  if (device.pairingCodeExpiresAt === null || device.pairingCodeExpiresAt.getTime() <= Date.now()) {
    throw new ConflictError('That pairing code has expired. Ask an admin for a new one.');
  }

  const deviceToken = generateToken();

  const result = await prisma.device.updateMany({
    // Re-assert the code in the WHERE clause so a concurrent redemption loses.
    where: { id: device.id, pairingCodeHash: codeHash },
    data: {
      tokenHash: hashToken(deviceToken),
      pairingCodeHash: null,
      pairingCodeExpiresAt: null,
      pairedAt: new Date(),
    },
  });

  if (result.count === 0) {
    throw new ConflictError('That pairing code has already been used.');
  }

  return {
    deviceId: device.id,
    label: device.label,
    type: device.type,
    deviceToken,
  };
}

/** Null for unknown or revoked tokens; callers treat that as unauthenticated. */
export async function resolveDeviceToken(rawToken: string): Promise<ResolvedDevice | null> {
  const device = await prisma.device.findUnique({
    where: { tokenHash: hashToken(rawToken) },
  });

  if (!device) return null;
  if (device.revokedAt !== null) return null;

  return { deviceId: device.id, label: device.label, type: device.type };
}

/**
 * Best-effort activity stamp; never blocks the request path.
 *
 * Skipped under test for the same reason as `touchSession`: an un-awaited UPDATE can
 * still be running when the next test deletes the row, which InnoDB resolves as a
 * deadlock. Nothing asserts `lastSeenAt`.
 */
export function touchDevice(deviceId: string): void {
  if (isTest) return;
  void prisma.device
    .update({ where: { id: deviceId }, data: { lastSeenAt: new Date() } })
    .catch(() => undefined);
}

/** Revoking clears the token outright, so a stolen tablet cannot be re-enabled. */
export async function revokeDevice(deviceId: string): Promise<void> {
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) throw new NotFoundError('Device not found.');

  await prisma.device.update({
    where: { id: deviceId },
    data: {
      revokedAt: new Date(),
      tokenHash: null,
      pairingCodeHash: null,
      pairingCodeExpiresAt: null,
    },
  });
}

export async function listDevices() {
  return prisma.device.findMany({ orderBy: [{ revokedAt: 'asc' }, { createdAt: 'desc' }] });
}
