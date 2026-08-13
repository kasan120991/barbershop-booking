-- AlterTable
ALTER TABLE `devices` MODIFY `type` ENUM('KIOSK', 'DISPLAY', 'VOICE') NOT NULL DEFAULT 'KIOSK';

-- AlterTable
ALTER TABLE `shop_settings` ADD COLUMN `voiceBookingEnabled` BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE `voice_tool_calls` (
    `id` VARCHAR(191) NOT NULL,
    `toolCallId` VARCHAR(191) NOT NULL,
    `callId` VARCHAR(191) NULL,
    `name` VARCHAR(191) NOT NULL,
    `result` TEXT NULL,
    `isError` BOOLEAN NOT NULL DEFAULT false,
    `completedAt` DATETIME(3) NULL,
    `entityType` VARCHAR(191) NULL,
    `entityId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `voice_tool_calls_toolCallId_key`(`toolCallId`),
    INDEX `voice_tool_calls_callId_idx`(`callId`),
    INDEX `voice_tool_calls_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
