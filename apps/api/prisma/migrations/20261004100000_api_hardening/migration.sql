-- DropIndex
ALTER TABLE "Order" DROP CONSTRAINT "Order_orderNumber_key";

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "clientRequestId" TEXT;

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "orderCounter" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "renewsAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "Order_shopId_createdAt_idx" ON "Order"("shopId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_shopId_orderNumber_key" ON "Order"("shopId", "orderNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Order_shopId_clientRequestId_key" ON "Order"("shopId", "clientRequestId");

-- CreateIndex
CREATE INDEX "OrderStatusHistory_orderId_createdAt_idx" ON "OrderStatusHistory"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
