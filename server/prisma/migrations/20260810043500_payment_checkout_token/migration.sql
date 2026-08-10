-- AlterTable
ALTER TABLE `payments` ADD COLUMN `checkoutTokenHash` VARCHAR(191) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `payments_checkoutTokenHash_key` ON `payments`(`checkoutTokenHash`);
