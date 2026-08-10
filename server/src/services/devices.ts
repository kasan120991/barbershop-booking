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

/**
 * What a device looks like in the audit trail.
 *
 * Built by picking fields rather than by spreading the row and deleting the secrets,
 * for the same reason the DTO mappers do: a column added to `Device` later would
 * otherwise appear in the log by default, and the two columns that must never appear
 * are exactly the two a future change is most likely to add beside.
 *
 * `pairingCodeHash` in particular is a *live* credential's hash while a screen is
 * pending — copying it into a second table with different retention is strictly worse
 * than leaving it in one place.
 */
export interface AuditableDevice {
  label: string;
  type: DeviceType;
  pairedAt: Date | null;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}

function auditable(device: {
  label: string;
  type: DeviceType;
  pairedAt: Date | null;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}): AuditableDevice {
  return {
    label: device.label,
    type: device.type,
    pairedAt: device.pairedAt,
    lastSeenAt: device.lastSeenAt,
    revokedAt: device.revokedAt,
  };
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

/**
 * Revoking clears the token outright, so a stolen tablet cannot be re-enabled.
 *
 * Returns what it was and what it became, for the audit trail. Neither snapshot may
 * carry `tokenHash` or `pairingCodeHash` — see `auditable`.
 */
export async function revokeDevice(deviceId: string): Promise<{
  before: AuditableDevice;
  after: AuditableDevice;
}> {
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) throw new NotFoundError('Device not found.');

  const updated = await prisma.device.update({
    where: { id: deviceId },
    data: {
      revokedAt: new Date(),
      tokenHash: null,
      pairingCodeHash: null,
      pairingCodeExpiresAt: null,
    },
  });

  return { before: auditable(device), after: auditable(updated) };
}

/**
 * Removes a revoked screen from the list for good.
 *
 * **Revoked first, always.** Deleting a live device would silently unpair a tablet
 * sitting in the shop, and the person clicking has no way to see that happen. Revoking
 * is the deliberate step that stops it working and already says so; this only tidies up
 * afterwards. Two steps rather than one is the whole safety property, so the check is
 * here in the service and not in the confirm dialog.
 *
 * Returns the deleted row so the caller can put its label in the audit trail —
 * `AuditLog.actorDeviceId` is a bare string with no foreign key, so every queue join a
 * kiosk ever made points at an id that this delete is about to make unresolvable. The
 * label is then the only thing left that can say which screen by the door that was.
 */
export async function deleteRevokedDevice(deviceId: string): Promise<AuditableDevice> {
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) throw new NotFoundError('Device not found.');

  if (device.revokedAt === null) {
    throw new ConflictError('Revoke this screen before removing it.');
  }

  await prisma.device.delete({ where: { id: deviceId } });
  return auditable(device);
}

export async function listDevices() {
  return prisma.device.findMany({ orderBy: [{ revokedAt: 'asc' }, { createdAt: 'desc' }] });
}
