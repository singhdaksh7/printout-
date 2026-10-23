-- Additive: optional Firebase phone sign-in identity for shop owners. No existing table is altered.
CREATE TABLE "UserPhoneIdentity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "firebaseUid" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSignInAt" TIMESTAMP(3),
    "lastAuthTime" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPhoneIdentity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserPhoneIdentity_userId_key" ON "UserPhoneIdentity"("userId");
CREATE UNIQUE INDEX "UserPhoneIdentity_firebaseUid_key" ON "UserPhoneIdentity"("firebaseUid");
CREATE UNIQUE INDEX "UserPhoneIdentity_phoneE164_key" ON "UserPhoneIdentity"("phoneE164");

ALTER TABLE "UserPhoneIdentity" ADD CONSTRAINT "UserPhoneIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
