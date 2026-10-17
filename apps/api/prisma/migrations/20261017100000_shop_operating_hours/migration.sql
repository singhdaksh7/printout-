-- Shop operating hours (additive, backward compatible). Existing shops keep ACCEPT + no schedule = unchanged behaviour.
-- CreateEnum
CREATE TYPE "AfterHoursPolicy" AS ENUM ('ACCEPT', 'BLOCK');

-- AlterTable
ALTER TABLE "ShopSettings"
  ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  ADD COLUMN "operatingHours" JSONB,
  ADD COLUMN "specialClosures" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "temporaryClosure" JSONB,
  ADD COLUMN "reopenUntil" TIMESTAMP(3),
  ADD COLUMN "afterHoursPolicy" "AfterHoursPolicy" NOT NULL DEFAULT 'ACCEPT';
