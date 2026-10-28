-- Schema-v2 phase 5: reviews with rating aggregates, and the customer in-app notification inbox. Expand-only.
ALTER TABLE "Shop" ADD COLUMN "ratingSum" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "ratingCount" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "ratingAvg" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Order" ADD COLUMN "isReviewed" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "Review" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "customerUserId" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "rating" SMALLINT NOT NULL,
  "comment" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Review_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Review_rating_range" CHECK ("rating" BETWEEN 1 AND 5),
  CONSTRAINT "Review_comment_length" CHECK ("comment" IS NULL OR char_length("comment") <= 1000)
);
-- One review per order; reviews are never edited or deleted in v1 (no update/delete API).
CREATE UNIQUE INDEX "Review_orderId_key" ON "Review"("orderId");
CREATE INDEX "Review_shopId_createdAt_idx" ON "Review"("shopId", "createdAt");
CREATE INDEX "Review_customerUserId_idx" ON "Review"("customerUserId");
ALTER TABLE "Review" ADD CONSTRAINT "Review_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Review" ADD CONSTRAINT "Review_customerUserId_fkey" FOREIGN KEY ("customerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Review" ADD CONSTRAINT "Review_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "UserNotification" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "orderId" TEXT,
  "dedupeKey" TEXT NOT NULL,
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserNotification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UserNotification_type_check" CHECK ("type" IN ('orderStatus', 'payment'))
);
CREATE UNIQUE INDEX "UserNotification_userId_dedupeKey_key" ON "UserNotification"("userId", "dedupeKey");
CREATE INDEX "UserNotification_userId_createdAt_idx" ON "UserNotification"("userId", "createdAt");
CREATE INDEX "UserNotification_userId_readAt_idx" ON "UserNotification"("userId", "readAt");
ALTER TABLE "UserNotification" ADD CONSTRAINT "UserNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
