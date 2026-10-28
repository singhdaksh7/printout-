-- Schema-v2 phase 1 (2/2): customer identity foundation. Expand-only: no DROP, no data rewrite, no type change.

-- Customer email is optional; staff (owner/admin) keep a mandatory email. Existing rows all have an email, so the CHECK validates.
ALTER TABLE "User" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "User" ADD CONSTRAINT "User_email_required_for_staff" CHECK ("role" = 'CUSTOMER' OR "email" IS NOT NULL);
-- A customer never belongs to a shop (owners and admins are unaffected).
ALTER TABLE "User" ADD CONSTRAINT "User_customer_has_no_shop" CHECK ("role" <> 'CUSTOMER' OR "shopId" IS NULL);

ALTER TABLE "User"
  ADD COLUMN "addressLine1" TEXT,
  ADD COLUMN "addressLine2" TEXT,
  ADD COLUMN "city" TEXT,
  ADD COLUMN "state" TEXT,
  ADD COLUMN "pincode" TEXT,
  ADD COLUMN "latitude" DOUBLE PRECISION,
  ADD COLUMN "longitude" DOUBLE PRECISION,
  ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD CONSTRAINT "User_latitude_range" CHECK ("latitude" IS NULL OR ("latitude" >= -90 AND "latitude" <= 90));
ALTER TABLE "User" ADD CONSTRAINT "User_longitude_range" CHECK ("longitude" IS NULL OR ("longitude" >= -180 AND "longitude" <= 180));
ALTER TABLE "User" ADD CONSTRAINT "User_coordinates_paired" CHECK (("latitude" IS NULL) = ("longitude" IS NULL));

CREATE TABLE "UserRoleGrant" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" "Role" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserRoleGrant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UserRoleGrant_userId_role_key" ON "UserRoleGrant"("userId", "role");
CREATE INDEX "UserRoleGrant_role_idx" ON "UserRoleGrant"("role");
ALTER TABLE "UserRoleGrant" ADD CONSTRAINT "UserRoleGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Restartable backfill: one grant per existing user for their primary role. md5-based id keeps the script free of extensions.
INSERT INTO "UserRoleGrant" ("id", "userId", "role")
SELECT 'ug' || md5(u."id" || ':' || u."role"::text), u."id", u."role" FROM "User" u
ON CONFLICT ("userId", "role") DO NOTHING;

-- Every owner already has a default shop (User.shopId); make that ownership explicit in Membership for rows created after the first backfill.
INSERT INTO "Membership" ("id", "shopId", "userId", "role")
SELECT 'mb' || md5(u."shopId" || ':' || u."id"), u."shopId", u."id", 'OWNER'
FROM "User" u WHERE u."role" = 'SHOP_OWNER' AND u."shopId" IS NOT NULL
ON CONFLICT ("shopId", "userId") DO NOTHING;
