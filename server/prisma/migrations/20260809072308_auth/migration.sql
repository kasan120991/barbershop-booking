-- AlterTable
ALTER TABLE `devices` ADD COLUMN `createdByUserId` VARCHAR(191) NULL,
    ADD COLUMN `pairedAt` DATETIME(3) NULL,
    ADD COLUMN `pairingCodeExpiresAt` DATETIME(3) NULL,
    ADD COLUMN `pairingCodeHash` VARCHAR(191) NULL,
    MODIFY `tokenHash` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `sessions` ADD COLUMN `csrfTokenHash` VARCHAR(191) NOT NULL;

-- AlterTable
ALTER TABLE `users` ADD COLUMN `failedLoginAttempts` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `lastLoginAt` DATETIME(3) NULL,
    ADD COLUMN `lockedAt` DATETIME(3) NULL,
    ADD COLUMN `mustChangePassword` BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX `devices_pairingCodeHash_key` ON `devices`(`pairingCodeHash`);
