/**
 * Auth contracts.
 *
 * Nothing here carries a secret at rest: no `passwordHash`, no `tokenHash`, no
 * `csrfTokenHash`. The two plaintext credentials that do appear — a pairing code and
 * a device token — are returned exactly once at creation and never retrievable again.
 */

import { z } from 'zod';

import { DEVICE_TYPE, ROLE } from '../enums.js';

export const loginRequestSchema = z.object({
  email: z.email({ error: 'Enter a valid email address.' }),
  password: z.string().min(1, { error: 'Enter your password.' }),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** Mirrors `MIN_PASSWORD_LENGTH` in the server auth service. */
export const MIN_PASSWORD_LENGTH = 10;

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1, { error: 'Enter your current password.' }),
  newPassword: z
    .string()
    .min(MIN_PASSWORD_LENGTH, {
      error: `Your new password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    }),
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

/** The signed-in staff member, as returned by `GET /api/auth/me`. */
export const sessionUserDtoSchema = z.object({
  id: z.string(),
  email: z.email(),
  firstName: z.string(),
  lastName: z.string(),
  /** A set — the owner is both ADMIN and BARBER. */
  roles: z.array(z.enum(Object.values(ROLE) as [string, ...string[]])),
  /** Present when this user also cuts hair; scopes "my day", "my earnings", "my rent". */
  barberId: z.string().nullable(),
  /** True after an admin reset — the UI must force a password change before anything else. */
  mustChangePassword: z.boolean(),
});
export type SessionUserDto = z.infer<typeof sessionUserDtoSchema>;

export const loginResponseSchema = z.object({
  user: sessionUserDtoSchema,
  /**
   * Also delivered as a JS-readable cookie; returned here so a client can hold it in
   * memory instead of re-reading `document.cookie` on every mutation.
   */
  csrfToken: z.string(),
  expiresAt: z.iso.datetime(),
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

// --- Devices -----------------------------------------------------------------

export const deviceTypeSchema = z.enum(Object.values(DEVICE_TYPE) as [string, ...string[]]);

export const deviceDtoSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: deviceTypeSchema,
  /** Derived state, so the admin UI never has to reason about null token columns. */
  status: z.enum(['PENDING', 'PAIRED', 'REVOKED']),
  pairedAt: z.iso.datetime().nullable(),
  lastSeenAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type DeviceDto = z.infer<typeof deviceDtoSchema>;

export const createDeviceRequestSchema = z.object({
  label: z.string().trim().min(1).max(60),
  type: deviceTypeSchema,
});
export type CreateDeviceRequest = z.infer<typeof createDeviceRequestSchema>;

export const pairingCodeDtoSchema = z.object({
  deviceId: z.string(),
  label: z.string(),
  type: deviceTypeSchema,
  /** Plaintext, shown to the admin once. Only its hash is stored. */
  pairingCode: z.string(),
  expiresAt: z.iso.datetime(),
});
export type PairingCodeDto = z.infer<typeof pairingCodeDtoSchema>;

/**
 * What `POST /devices` hands back for a VOICE line: the token itself, once.
 *
 * A different shape from `PairingCodeDto` because it is a different secret with a
 * different life. A pairing code expires in fifteen minutes and is exchanged for
 * something else; this IS the credential, it never expires, and the only way to stop it
 * is to revoke it. The admin UI has to say so, which it cannot do if both arrive
 * looking the same.
 */
export const voiceCredentialDtoSchema = z.object({
  deviceId: z.string(),
  label: z.string(),
  type: z.literal(DEVICE_TYPE.VOICE),
  /** Plaintext, shown exactly once. Only its hash is stored, so it cannot be re-read. */
  deviceToken: z.string(),
});
export type VoiceCredentialDto = z.infer<typeof voiceCredentialDtoSchema>;

/**
 * The two things creating a device can return, discriminated by `type`.
 *
 * A union rather than one shape with both fields optional: a client that forgets to
 * check which it got should fail to compile, not render an empty "pairing code" box for
 * a phone line.
 */
export const createdDeviceResponseSchema = z.discriminatedUnion('type', [
  pairingCodeDtoSchema.extend({ type: z.literal(DEVICE_TYPE.KIOSK) }),
  pairingCodeDtoSchema.extend({ type: z.literal(DEVICE_TYPE.DISPLAY) }),
  voiceCredentialDtoSchema,
]);
export type CreatedDeviceResponse = z.infer<typeof createdDeviceResponseSchema>;

export const pairDeviceRequestSchema = z.object({
  /** Accepts "4820-1937" or "48201937"; the server normalizes. */
  pairingCode: z.string().trim().min(4).max(20),
});
export type PairDeviceRequest = z.infer<typeof pairDeviceRequestSchema>;

export const pairDeviceResponseSchema = z.object({
  deviceId: z.string(),
  label: z.string(),
  type: deviceTypeSchema,
  /** Plaintext, returned once so the tablet can store it. Never retrievable again. */
  deviceToken: z.string(),
});
export type PairDeviceResponse = z.infer<typeof pairDeviceResponseSchema>;

export const temporaryPasswordDtoSchema = z.object({
  userId: z.string(),
  /** Read aloud to the staff member in person — v1 has no email or SMS channel. */
  temporaryPassword: z.string(),
});
export type TemporaryPasswordDto = z.infer<typeof temporaryPasswordDtoSchema>;
