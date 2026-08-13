-- AlterTable
ALTER TABLE `appointments` ADD COLUMN `startedAt` DATETIME(3) NULL;

-- Backfill appointments that are already in progress.
--
-- Leaving these null would leave the bug unfixed for exactly the appointments that expose
-- it: a client is in the chair right now and the estimator would still have nothing to
-- read. `updatedAt` rather than `startAt`, because for an in-progress appointment the last
-- write was almost always the one that started it — and `startAt` would reinstate the very
-- fiction being fixed, claiming a cut began at the time it was booked for rather than the
-- time somebody sat down.
UPDATE `appointments`
SET `startedAt` = `updatedAt`
WHERE `status` = 'IN_PROGRESS' AND `startedAt` IS NULL;
