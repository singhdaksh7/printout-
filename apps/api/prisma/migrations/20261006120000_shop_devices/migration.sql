-- CreateEnum
CREATE TYPE "DevicePlatform" AS ENUM ('ANDROID', 'WINDOWS');

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- AlterTable
ALTER TABLE "OrderStatusHistory" ADD COLUMN     "actorDeviceId" TEXT;

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "actorDeviceId" TEXT,
ADD COLUMN     "actorType" TEXT;

-- CreateTable
CREATE TABLE "ShopDevice" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" "DevicePlatform" NOT NULL,
    "status" "DeviceStatus" NOT NULL DEFAULT 'ACTIVE',
    "credentialHash" TEXT NOT NULL,
    "credentialVersion" INTEGER NOT NULL DEFAULT 1,
    "appVersion" TEXT,
    "osVersion" TEXT,
    "pushToken" TEXT,
    "pushTokenUpdatedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevicePairingCode" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "usedByDeviceId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DevicePairingCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopDevice_credentialHash_key" ON "ShopDevice"("credentialHash");

-- CreateIndex
CREATE INDEX "ShopDevice_shopId_status_idx" ON "ShopDevice"("shopId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DevicePairingCode_codeHash_key" ON "DevicePairingCode"("codeHash");

-- CreateIndex
CREATE INDEX "DevicePairingCode_shopId_expiresAt_idx" ON "DevicePairingCode"("shopId", "expiresAt");

-- AddForeignKey
ALTER TABLE "ShopDevice" ADD CONSTRAINT "ShopDevice_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevicePairingCode" ADD CONSTRAINT "DevicePairingCode_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

