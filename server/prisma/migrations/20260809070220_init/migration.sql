-- CreateTable
CREATE TABLE `shop_settings` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `name` VARCHAR(191) NOT NULL DEFAULT 'Francis Cutz',
    `timezone` VARCHAR(191) NOT NULL DEFAULT 'America/New_York',
    `phone` VARCHAR(191) NULL,
    `addressLine1` VARCHAR(191) NULL,
    `addressLine2` VARCHAR(191) NULL,
    `city` VARCHAR(191) NULL,
    `state` VARCHAR(191) NULL,
    `postalCode` VARCHAR(191) NULL,
    `slotGranularityMinutes` INTEGER NOT NULL DEFAULT 15,
    `bookingHorizonDays` INTEGER NOT NULL DEFAULT 30,
    `minimumNoticeMinutes` INTEGER NOT NULL DEFAULT 60,
    `walkInQueueEnabled` BOOLEAN NOT NULL DEFAULT true,
    `onlineBookingEnabled` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shop_hours` (
    `id` VARCHAR(191) NOT NULL,
    `dayOfWeek` INTEGER NOT NULL,
    `openMinute` INTEGER NOT NULL,
    `closeMinute` INTEGER NOT NULL,
    `isClosed` BOOLEAN NOT NULL DEFAULT false,

    INDEX `shop_hours_dayOfWeek_idx`(`dayOfWeek`),
    UNIQUE INDEX `shop_hours_dayOfWeek_openMinute_key`(`dayOfWeek`, `openMinute`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shop_closures` (
    `id` VARCHAR(191) NOT NULL,
    `startAt` DATETIME(3) NOT NULL,
    `endAt` DATETIME(3) NOT NULL,
    `reason` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `shop_closures_startAt_endAt_idx`(`startAt`, `endAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `users` (
    `id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `passwordHash` VARCHAR(191) NOT NULL,
    `firstName` VARCHAR(191) NOT NULL,
    `lastName` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `users_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_roles` (
    `userId` VARCHAR(191) NOT NULL,
    `role` ENUM('ADMIN', 'BARBER') NOT NULL,

    PRIMARY KEY (`userId`, `role`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sessions` (
    `id` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `userAgent` TEXT NULL,
    `ipAddress` VARCHAR(191) NULL,
    `revokedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `sessions_tokenHash_key`(`tokenHash`),
    INDEX `sessions_userId_idx`(`userId`),
    INDEX `sessions_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `devices` (
    `id` VARCHAR(191) NOT NULL,
    `label` VARCHAR(191) NOT NULL,
    `type` ENUM('KIOSK', 'DISPLAY') NOT NULL DEFAULT 'KIOSK',
    `tokenHash` VARCHAR(191) NOT NULL,
    `lastSeenAt` DATETIME(3) NULL,
    `revokedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `devices_tokenHash_key`(`tokenHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `barbers` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `displayName` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `bio` TEXT NULL,
    `avatarUrl` VARCHAR(191) NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `acceptsWalkIns` BOOLEAN NOT NULL DEFAULT true,
    `acceptsOnline` BOOLEAN NOT NULL DEFAULT true,
    `stripeAccountId` VARCHAR(191) NULL,
    `chargesEnabled` BOOLEAN NOT NULL DEFAULT false,
    `payoutsEnabled` BOOLEAN NOT NULL DEFAULT false,
    `detailsSubmitted` BOOLEAN NOT NULL DEFAULT false,
    `instantPayoutEligible` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `barbers_userId_key`(`userId`),
    UNIQUE INDEX `barbers_slug_key`(`slug`),
    UNIQUE INDEX `barbers_stripeAccountId_key`(`stripeAccountId`),
    INDEX `barbers_status_sortOrder_idx`(`status`, `sortOrder`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `chairs` (
    `id` VARCHAR(191) NOT NULL,
    `label` VARCHAR(191) NOT NULL,
    `barberId` VARCHAR(191) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,

    UNIQUE INDEX `chairs_label_key`(`label`),
    UNIQUE INDEX `chairs_barberId_key`(`barberId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `services` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `category` VARCHAR(191) NULL,
    `priceCents` INTEGER NOT NULL,
    `durationMinutes` INTEGER NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `bookableOnline` BOOLEAN NOT NULL DEFAULT true,
    `bookableWalkIn` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `services_isActive_sortOrder_idx`(`isActive`, `sortOrder`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `barber_services` (
    `barberId` VARCHAR(191) NOT NULL,
    `serviceId` VARCHAR(191) NOT NULL,

    INDEX `barber_services_serviceId_idx`(`serviceId`),
    PRIMARY KEY (`barberId`, `serviceId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `barber_schedules` (
    `id` VARCHAR(191) NOT NULL,
    `barberId` VARCHAR(191) NOT NULL,
    `dayOfWeek` INTEGER NOT NULL,
    `startMinute` INTEGER NOT NULL,
    `endMinute` INTEGER NOT NULL,

    INDEX `barber_schedules_barberId_dayOfWeek_idx`(`barberId`, `dayOfWeek`),
    UNIQUE INDEX `barber_schedules_barberId_dayOfWeek_startMinute_key`(`barberId`, `dayOfWeek`, `startMinute`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `schedule_exceptions` (
    `id` VARCHAR(191) NOT NULL,
    `barberId` VARCHAR(191) NOT NULL,
    `type` ENUM('TIME_OFF', 'BLOCK', 'EXTRA_HOURS') NOT NULL,
    `startAt` DATETIME(3) NOT NULL,
    `endAt` DATETIME(3) NOT NULL,
    `reason` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `schedule_exceptions_barberId_startAt_endAt_idx`(`barberId`, `startAt`, `endAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `clients` (
    `id` VARCHAR(191) NOT NULL,
    `phoneE164` VARCHAR(191) NOT NULL,
    `firstName` VARCHAR(191) NOT NULL,
    `lastName` VARCHAR(191) NULL,
    `email` VARCHAR(191) NULL,
    `notes` TEXT NULL,
    `visitCount` INTEGER NOT NULL DEFAULT 0,
    `noShowCount` INTEGER NOT NULL DEFAULT 0,
    `lastVisitAt` DATETIME(3) NULL,
    `isBlocked` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `clients_phoneE164_key`(`phoneE164`),
    INDEX `clients_lastName_firstName_idx`(`lastName`, `firstName`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `appointments` (
    `id` VARCHAR(191) NOT NULL,
    `clientId` VARCHAR(191) NOT NULL,
    `barberId` VARCHAR(191) NOT NULL,
    `chairId` VARCHAR(191) NULL,
    `startAt` DATETIME(3) NOT NULL,
    `endAt` DATETIME(3) NOT NULL,
    `durationMinutes` INTEGER NOT NULL,
    `priceCentsTotal` INTEGER NOT NULL,
    `status` ENUM('BOOKED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW') NOT NULL DEFAULT 'BOOKED',
    `source` ENUM('ONLINE', 'KIOSK', 'STAFF', 'WALK_IN', 'VOICE') NOT NULL DEFAULT 'ONLINE',
    `notes` TEXT NULL,
    `cancelToken` VARCHAR(191) NOT NULL,
    `cancelledAt` DATETIME(3) NULL,
    `cancelReason` VARCHAR(191) NULL,
    `createdByUserId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `appointments_cancelToken_key`(`cancelToken`),
    INDEX `appointments_barberId_startAt_endAt_idx`(`barberId`, `startAt`, `endAt`),
    INDEX `appointments_clientId_idx`(`clientId`),
    INDEX `appointments_status_startAt_idx`(`status`, `startAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `appointment_services` (
    `id` VARCHAR(191) NOT NULL,
    `appointmentId` VARCHAR(191) NOT NULL,
    `serviceId` VARCHAR(191) NOT NULL,
    `priceCents` INTEGER NOT NULL,
    `durationMinutes` INTEGER NOT NULL,
    `nameSnapshot` VARCHAR(191) NOT NULL,

    INDEX `appointment_services_appointmentId_idx`(`appointmentId`),
    INDEX `appointment_services_serviceId_idx`(`serviceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `barber_day_locks` (
    `barberId` VARCHAR(191) NOT NULL,
    `day` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`barberId`, `day`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `queue_entries` (
    `id` VARCHAR(191) NOT NULL,
    `clientId` VARCHAR(191) NOT NULL,
    `barberId` VARCHAR(191) NULL,
    `status` ENUM('WAITING', 'CALLED', 'IN_CHAIR', 'COMPLETED', 'CANCELLED', 'NO_SHOW') NOT NULL DEFAULT 'WAITING',
    `priority` INTEGER NOT NULL DEFAULT 0,
    `joinedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `calledAt` DATETIME(3) NULL,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `estimatedReadyAt` DATETIME(3) NULL,
    `durationMinutes` INTEGER NOT NULL,
    `priceCentsTotal` INTEGER NOT NULL,
    `source` ENUM('ONLINE', 'KIOSK', 'STAFF', 'WALK_IN', 'VOICE') NOT NULL DEFAULT 'KIOSK',
    `notes` TEXT NULL,
    `appointmentId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `queue_entries_appointmentId_key`(`appointmentId`),
    INDEX `queue_entries_status_priority_joinedAt_idx`(`status`, `priority`, `joinedAt`),
    INDEX `queue_entries_barberId_status_idx`(`barberId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `queue_entry_services` (
    `id` VARCHAR(191) NOT NULL,
    `queueEntryId` VARCHAR(191) NOT NULL,
    `serviceId` VARCHAR(191) NOT NULL,
    `priceCents` INTEGER NOT NULL,
    `durationMinutes` INTEGER NOT NULL,
    `nameSnapshot` VARCHAR(191) NOT NULL,

    INDEX `queue_entry_services_queueEntryId_idx`(`queueEntryId`),
    INDEX `queue_entry_services_serviceId_idx`(`serviceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payments` (
    `id` VARCHAR(191) NOT NULL,
    `barberId` VARCHAR(191) NOT NULL,
    `clientId` VARCHAR(191) NULL,
    `appointmentId` VARCHAR(191) NULL,
    `queueEntryId` VARCHAR(191) NULL,
    `method` ENUM('CARD_ONLINE', 'CARD_TERMINAL', 'CASH', 'OTHER') NOT NULL,
    `status` ENUM('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'VOIDED') NOT NULL DEFAULT 'PENDING',
    `amountCents` INTEGER NOT NULL,
    `tipCents` INTEGER NOT NULL DEFAULT 0,
    `totalCents` INTEGER NOT NULL,
    `currency` VARCHAR(191) NOT NULL DEFAULT 'USD',
    `stripePaymentIntentId` VARCHAR(191) NULL,
    `stripeChargeId` VARCHAR(191) NULL,
    `stripeAccountId` VARCHAR(191) NULL,
    `stripeFeeCents` INTEGER NULL,
    `netCents` INTEGER NULL,
    `failureReason` VARCHAR(191) NULL,
    `recordedByUserId` VARCHAR(191) NULL,
    `paidAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `payments_stripePaymentIntentId_key`(`stripePaymentIntentId`),
    UNIQUE INDEX `payments_stripeChargeId_key`(`stripeChargeId`),
    INDEX `payments_barberId_paidAt_idx`(`barberId`, `paidAt`),
    INDEX `payments_status_idx`(`status`),
    INDEX `payments_appointmentId_idx`(`appointmentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `refunds` (
    `id` VARCHAR(191) NOT NULL,
    `paymentId` VARCHAR(191) NOT NULL,
    `amountCents` INTEGER NOT NULL,
    `reason` VARCHAR(191) NULL,
    `stripeRefundId` VARCHAR(191) NULL,
    `createdByUserId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `refunds_stripeRefundId_key`(`stripeRefundId`),
    INDEX `refunds_paymentId_idx`(`paymentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payouts` (
    `id` VARCHAR(191) NOT NULL,
    `barberId` VARCHAR(191) NOT NULL,
    `stripePayoutId` VARCHAR(191) NOT NULL,
    `amountCents` INTEGER NOT NULL,
    `feeCents` INTEGER NOT NULL DEFAULT 0,
    `currency` VARCHAR(191) NOT NULL DEFAULT 'USD',
    `type` ENUM('STANDARD_AUTO', 'INSTANT') NOT NULL DEFAULT 'STANDARD_AUTO',
    `status` ENUM('PENDING', 'IN_TRANSIT', 'PAID', 'FAILED', 'CANCELED') NOT NULL DEFAULT 'PENDING',
    `arrivalDate` DATETIME(3) NULL,
    `failureReason` VARCHAR(191) NULL,
    `initiatedByUserId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `payouts_stripePayoutId_key`(`stripePayoutId`),
    INDEX `payouts_barberId_createdAt_idx`(`barberId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `rent_plans` (
    `id` VARCHAR(191) NOT NULL,
    `barberId` VARCHAR(191) NOT NULL,
    `amountCents` INTEGER NOT NULL,
    `cadence` ENUM('WEEKLY', 'MONTHLY') NOT NULL DEFAULT 'WEEKLY',
    `anchorDay` INTEGER NOT NULL,
    `startDate` DATE NOT NULL,
    `endDate` DATE NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `rent_plans_barberId_isActive_idx`(`barberId`, `isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `rent_charges` (
    `id` VARCHAR(191) NOT NULL,
    `barberId` VARCHAR(191) NOT NULL,
    `rentPlanId` VARCHAR(191) NULL,
    `periodStart` DATE NOT NULL,
    `periodEnd` DATE NOT NULL,
    `amountCents` INTEGER NOT NULL,
    `dueDate` DATE NOT NULL,
    `status` ENUM('DUE', 'PAID', 'PARTIAL', 'WAIVED') NOT NULL DEFAULT 'DUE',
    `note` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `rent_charges_barberId_status_idx`(`barberId`, `status`),
    UNIQUE INDEX `rent_charges_barberId_periodStart_key`(`barberId`, `periodStart`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `rent_payments` (
    `id` VARCHAR(191) NOT NULL,
    `rentChargeId` VARCHAR(191) NOT NULL,
    `amountCents` INTEGER NOT NULL,
    `method` ENUM('CASH', 'ZELLE', 'CHECK', 'CARD_MANUAL', 'OTHER') NOT NULL DEFAULT 'CASH',
    `paidAt` DATETIME(3) NOT NULL,
    `note` VARCHAR(191) NULL,
    `recordedByUserId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `rent_payments_rentChargeId_idx`(`rentChargeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `webhook_events` (
    `id` VARCHAR(191) NOT NULL,
    `stripeEventId` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `stripeAccount` VARCHAR(191) NULL,
    `payload` JSON NOT NULL,
    `processedAt` DATETIME(3) NULL,
    `error` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `webhook_events_stripeEventId_key`(`stripeEventId`),
    INDEX `webhook_events_type_idx`(`type`),
    INDEX `webhook_events_processedAt_idx`(`processedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_logs` (
    `id` VARCHAR(191) NOT NULL,
    `actorUserId` VARCHAR(191) NULL,
    `actorDeviceId` VARCHAR(191) NULL,
    `action` VARCHAR(191) NOT NULL,
    `entityType` VARCHAR(191) NOT NULL,
    `entityId` VARCHAR(191) NOT NULL,
    `before` JSON NULL,
    `after` JSON NULL,
    `ipAddress` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `audit_logs_entityType_entityId_idx`(`entityType`, `entityId`),
    INDEX `audit_logs_actorUserId_createdAt_idx`(`actorUserId`, `createdAt`),
    INDEX `audit_logs_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `user_roles` ADD CONSTRAINT `user_roles_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `barbers` ADD CONSTRAINT `barbers_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `chairs` ADD CONSTRAINT `chairs_barberId_fkey` FOREIGN KEY (`barberId`) REFERENCES `barbers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `barber_services` ADD CONSTRAINT `barber_services_barberId_fkey` FOREIGN KEY (`barberId`) REFERENCES `barbers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `barber_services` ADD CONSTRAINT `barber_services_serviceId_fkey` FOREIGN KEY (`serviceId`) REFERENCES `services`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `barber_schedules` ADD CONSTRAINT `barber_schedules_barberId_fkey` FOREIGN KEY (`barberId`) REFERENCES `barbers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `schedule_exceptions` ADD CONSTRAINT `schedule_exceptions_barberId_fkey` FOREIGN KEY (`barberId`) REFERENCES `barbers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `appointments` ADD CONSTRAINT `appointments_clientId_fkey` FOREIGN KEY (`clientId`) REFERENCES `clients`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `appointments` ADD CONSTRAINT `appointments_barberId_fkey` FOREIGN KEY (`barberId`) REFERENCES `barbers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `appointments` ADD CONSTRAINT `appointments_chairId_fkey` FOREIGN KEY (`chairId`) REFERENCES `chairs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `appointments` ADD CONSTRAINT `appointments_createdByUserId_fkey` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `appointment_services` ADD CONSTRAINT `appointment_services_appointmentId_fkey` FOREIGN KEY (`appointmentId`) REFERENCES `appointments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `appointment_services` ADD CONSTRAINT `appointment_services_serviceId_fkey` FOREIGN KEY (`serviceId`) REFERENCES `services`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `barber_day_locks` ADD CONSTRAINT `barber_day_locks_barberId_fkey` FOREIGN KEY (`barberId`) REFERENCES `barbers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `queue_entries` ADD CONSTRAINT `queue_entries_clientId_fkey` FOREIGN KEY (`clientId`) REFERENCES `clients`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `queue_entries` ADD CONSTRAINT `queue_entries_barberId_fkey` FOREIGN KEY (`barberId`) REFERENCES `barbers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `queue_entries` ADD CONSTRAINT `queue_entries_appointmentId_fkey` FOREIGN KEY (`appointmentId`) REFERENCES `appointments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `queue_entry_services` ADD CONSTRAINT `queue_entry_services_queueEntryId_fkey` FOREIGN KEY (`queueEntryId`) REFERENCES `queue_entries`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `queue_entry_services` ADD CONSTRAINT `queue_entry_services_serviceId_fkey` FOREIGN KEY (`serviceId`) REFERENCES `services`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_barberId_fkey` FOREIGN KEY (`barberId`) REFERENCES `barbers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_clientId_fkey` FOREIGN KEY (`clientId`) REFERENCES `clients`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_appointmentId_fkey` FOREIGN KEY (`appointmentId`) REFERENCES `appointments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_queueEntryId_fkey` FOREIGN KEY (`queueEntryId`) REFERENCES `queue_entries`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_recordedByUserId_fkey` FOREIGN KEY (`recordedByUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `refunds` ADD CONSTRAINT `refunds_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `payments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `refunds` ADD CONSTRAINT `refunds_createdByUserId_fkey` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payouts` ADD CONSTRAINT `payouts_barberId_fkey` FOREIGN KEY (`barberId`) REFERENCES `barbers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payouts` ADD CONSTRAINT `payouts_initiatedByUserId_fkey` FOREIGN KEY (`initiatedByUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rent_plans` ADD CONSTRAINT `rent_plans_barberId_fkey` FOREIGN KEY (`barberId`) REFERENCES `barbers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rent_charges` ADD CONSTRAINT `rent_charges_barberId_fkey` FOREIGN KEY (`barberId`) REFERENCES `barbers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rent_charges` ADD CONSTRAINT `rent_charges_rentPlanId_fkey` FOREIGN KEY (`rentPlanId`) REFERENCES `rent_plans`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rent_payments` ADD CONSTRAINT `rent_payments_rentChargeId_fkey` FOREIGN KEY (`rentChargeId`) REFERENCES `rent_charges`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rent_payments` ADD CONSTRAINT `rent_payments_recordedByUserId_fkey` FOREIGN KEY (`recordedByUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_actorUserId_fkey` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
