-- CreateTable
CREATE TABLE "ShopNotification" (
    "id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "shopId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "orderId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopNotification_seq_key" ON "ShopNotification"("seq");

-- CreateIndex
CREATE INDEX "ShopNotification_shopId_seq_idx" ON "ShopNotification"("shopId", "seq");

-- CreateIndex
CREATE INDEX "ShopNotification_shopId_readAt_idx" ON "ShopNotification"("shopId", "readAt");

-- CreateIndex
CREATE INDEX "ShopNotification_createdAt_idx" ON "ShopNotification"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShopNotification_shopId_dedupeKey_key" ON "ShopNotification"("shopId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "ShopNotification" ADD CONSTRAINT "ShopNotification_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopNotification" ADD CONSTRAINT "ShopNotification_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
