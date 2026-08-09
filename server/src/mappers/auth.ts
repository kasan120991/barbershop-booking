/**
 * Auth DTO mappers.
 *
 * Same rule as `mappers/catalog.ts`: every field is listed explicitly and no Prisma
 * model is ever spread. Here the stakes are higher — a spread would forward
 * `passwordHash`, and on a device it would forward `tokenHash`, handing out the very
 * credential the hash exists to protect.
 */

import type { DeviceDto, SessionUserDto } from '@francis/shared';

import type { DeviceModel, UserModel } from '../generated/prisma/models.js';
import type { Role } from '../generated/prisma/enums.js';

export function toSessionUserDto(
  user: Pick<UserModel, 'id' | 'email' | 'firstName' | 'lastName' | 'mustChangePassword'>,
  roles: Role[],
  barberId: string | null,
): SessionUserDto {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    roles,
    barberId,
    mustChangePassword: user.mustChangePassword,
  };
}

/**
 * Collapses the nullable token/code columns into one status the admin UI can render
 * directly, so no frontend has to know that "paired" means "tokenHash is not null".
 */
function deviceStatus(device: DeviceModel): DeviceDto['status'] {
  if (device.revokedAt !== null) return 'REVOKED';
  if (device.tokenHash !== null) return 'PAIRED';
  return 'PENDING';
}

export function toDeviceDto(device: DeviceModel): DeviceDto {
  return {
    id: device.id,
    label: device.label,
    type: device.type,
    status: deviceStatus(device),
    pairedAt: device.pairedAt?.toISOString() ?? null,
    lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
    createdAt: device.createdAt.toISOString(),
  };
}
