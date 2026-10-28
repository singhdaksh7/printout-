-- Schema-v2 phase 2: shop discovery profile, admin verification, paper options and photos. Expand-only.
ALTER TABLE "Shop"
  ADD COLUMN "addressLine2" TEXT,
  ADD COLUMN "city" TEXT,
  ADD COLUMN "state" TEXT,
  ADD COLUMN "country" TEXT NOT NULL DEFAULT 'IN',
  ADD COLUMN "latitude" DOUBLE PRECISION,
  ADD COLUMN "longitude" DOUBLE PRECISION,
  ADD COLUMN "isVerified" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "verifiedAt" TIMESTAMP(3),
  ADD COLUMN "verifiedBy" TEXT;
ALTER TABLE "Shop" ADD CONSTRAINT "Shop_latitude_range" CHECK ("latitude" IS NULL OR ("latitude" >= -90 AND "latitude" <= 90));
ALTER TABLE "Shop" ADD CONSTRAINT "Shop_longitude_range" CHECK ("longitude" IS NULL OR ("longitude" >= -180 AND "longitude" <= 180));
ALTER TABLE "Shop" ADD CONSTRAINT "Shop_coordinates_paired" CHECK (("latitude" IS NULL) = ("longitude" IS NULL));
CREATE INDEX "Shop_isVerified_status_idx" ON "Shop"("isVerified", "status");
CREATE INDEX "Shop_latitude_longitude_idx" ON "Shop"("latitude", "longitude");

-- Existing live shops must not disappear from discovery: backfill them as verified (restartable: only rows not yet verified).
UPDATE "Shop" SET "isVerified" = true, "verifiedAt" = now() WHERE "status" = 'ACTIVE' AND "isVerified" = false AND "verifiedAt" IS NULL;

CREATE TABLE "ShopPaperOption" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  CONSTRAINT "ShopPaperOption_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ShopPaperOption_kind_check" CHECK ("kind" IN ('paperSize', 'paperType'))
);
CREATE UNIQUE INDEX "ShopPaperOption_shopId_kind_value_key" ON "ShopPaperOption"("shopId", "kind", "value");
ALTER TABLE "ShopPaperOption" ADD CONSTRAINT "ShopPaperOption_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ShopImage" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "imageKey" TEXT NOT NULL,
  "contentType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ShopImage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ShopImage_imageKey_key" ON "ShopImage"("imageKey");
CREATE INDEX "ShopImage_shopId_sortOrder_idx" ON "ShopImage"("shopId", "sortOrder");
ALTER TABLE "ShopImage" ADD CONSTRAINT "ShopImage_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Paper sizes already priced by a shop are advertised as its supported sizes (no paper types are invented).
INSERT INTO "ShopPaperOption" ("id", "shopId", "kind", "value")
SELECT 'po' || md5(r."shopId" || ':paperSize:' || r."paperSize"), r."shopId", 'paperSize', r."paperSize"
FROM (SELECT DISTINCT "shopId", "paperSize" FROM "PricingRule" WHERE "active" = true) r
ON CONFLICT ("shopId", "kind", "value") DO NOTHING;
