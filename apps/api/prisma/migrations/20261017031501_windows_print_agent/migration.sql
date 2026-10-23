-- CreateEnum
CREATE TYPE "PrinterConnectivity" AS ENUM ('ONLINE', 'OFFLINE', 'ERROR', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "DevicePrintJobStatus" AS ENUM ('QUEUED', 'CLAIMED', 'DOWNLOADING', 'SUBMITTING', 'SUBMITTED_TO_SPOOLER', 'PRINT_INITIATED', 'FAILED', 'CANCEL_REQUESTED', 'CANCELED', 'NEEDS_RECONCILIATION');

-- AlterTable
ALTER TABLE "ShopDevice" ADD COLUMN     "credentialRotatedAt" TIMESTAMP(3),
ADD COLUMN     "previousCredentialHash" TEXT,
ADD COLUMN     "previousCredentialValidUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "DevicePrinter" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "driverName" TEXT,
    "connectivity" "PrinterConnectivity" NOT NULL DEFAULT 'UNKNOWN',
    "statusDetail" TEXT,
    "supportsColour" BOOLEAN NOT NULL DEFAULT false,
    "supportsDuplex" BOOLEAN NOT NULL DEFAULT false,
    "paperSizes" JSONB,
    "present" BOOLEAN NOT NULL DEFAULT true,
    "authorized" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "lastReportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DevicePrinter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevicePrintJob" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "printerId" TEXT NOT NULL,
    "status" "DevicePrintJobStatus" NOT NULL DEFAULT 'QUEUED',
    "statusBeforeCancel" "DevicePrintJobStatus",
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "leaseId" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "clientRequestId" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "submittingAt" TIMESTAMP(3),
    "spoolerJobId" INTEGER,
    "spoolerState" TEXT,
    "printInitiatedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "requestedByUserId" TEXT,
    "cancelRequestedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DevicePrintJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DevicePrinter_shopId_isDefault_idx" ON "DevicePrinter"("shopId", "isDefault");

-- CreateIndex
CREATE UNIQUE INDEX "DevicePrinter_deviceId_name_key" ON "DevicePrinter"("deviceId", "name");

-- CreateIndex
CREATE INDEX "DevicePrintJob_shopId_orderId_idx" ON "DevicePrintJob"("shopId", "orderId");

-- CreateIndex
CREATE INDEX "DevicePrintJob_deviceId_status_idx" ON "DevicePrintJob"("deviceId", "status");

-- CreateIndex
CREATE INDEX "DevicePrintJob_shopId_status_createdAt_idx" ON "DevicePrintJob"("shopId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DevicePrintJob_shopId_clientRequestId_key" ON "DevicePrintJob"("shopId", "clientRequestId");

-- CreateIndex
CREATE INDEX "ShopDevice_previousCredentialHash_idx" ON "ShopDevice"("previousCredentialHash");

-- AddForeignKey
ALTER TABLE "DevicePrinter" ADD CONSTRAINT "DevicePrinter_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevicePrinter" ADD CONSTRAINT "DevicePrinter_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ShopDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevicePrintJob" ADD CONSTRAINT "DevicePrintJob_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevicePrintJob" ADD CONSTRAINT "DevicePrintJob_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ShopDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevicePrintJob" ADD CONSTRAINT "DevicePrintJob_printerId_fkey" FOREIGN KEY ("printerId") REFERENCES "DevicePrinter"("id") ON DELETE CASCADE ON UPDATE CASCADE;
