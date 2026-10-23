-- Additive: shared user-profile API, phone self-onboarding and FCM registration. No column is dropped or retyped.
ALTER TABLE "User" ADD COLUMN "passwordSet" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN "lastLoginAt" TIMESTAMP(3);
ALTER TABLE "Shop" ADD COLUMN "pincode" TEXT;

ALTER TABLE "Session" ADD COLUMN "familyId" TEXT;
ALTER TABLE "Session" ADD COLUMN "deviceId" TEXT;
CREATE INDEX "Session_familyId_idx" ON "Session"("familyId");

CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "userId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'user',
    "subjectProvider" TEXT,
    "subjectUid" TEXT,
    "subjectPhone" TEXT,
    "subjectEmail" TEXT,
    "tokenHash" TEXT NOT NULL,
    "sessionId" TEXT,
    "deviceId" TEXT NOT NULL,
    "clientType" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "rotatedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");
CREATE INDEX "RefreshToken_familyId_idx" ON "RefreshToken"("familyId");
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");
CREATE INDEX "RefreshToken_subjectUid_idx" ON "RefreshToken"("subjectUid");
CREATE INDEX "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "FcmRegistration" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "shopId" TEXT,
    "installationId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "tokenCipher" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "revokedAt" TIMESTAMP(3),
    "lastRegisteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSuccessAt" TIMESTAMP(3),
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FcmRegistration_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FcmRegistration_tokenHash_key" ON "FcmRegistration"("tokenHash");
CREATE UNIQUE INDEX "FcmRegistration_userId_installationId_key" ON "FcmRegistration"("userId", "installationId");
CREATE INDEX "FcmRegistration_shopId_idx" ON "FcmRegistration"("shopId");
ALTER TABLE "FcmRegistration" ADD CONSTRAINT "FcmRegistration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PhoneOnboardingGrant" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'phone',
    "firebaseUid" TEXT NOT NULL,
    "phoneE164" TEXT,
    "email" TEXT,
    "authTime" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "familyId" TEXT,
    "deviceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhoneOnboardingGrant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PhoneOnboardingGrant_tokenHash_key" ON "PhoneOnboardingGrant"("tokenHash");
CREATE INDEX "PhoneOnboardingGrant_familyId_idx" ON "PhoneOnboardingGrant"("familyId");
CREATE INDEX "PhoneOnboardingGrant_firebaseUid_idx" ON "PhoneOnboardingGrant"("firebaseUid");
CREATE INDEX "PhoneOnboardingGrant_expiresAt_idx" ON "PhoneOnboardingGrant"("expiresAt");

CREATE TABLE "UserGoogleIdentity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "firebaseUid" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSignInAt" TIMESTAMP(3),
    "lastAuthTime" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserGoogleIdentity_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UserGoogleIdentity_userId_key" ON "UserGoogleIdentity"("userId");
CREATE UNIQUE INDEX "UserGoogleIdentity_firebaseUid_key" ON "UserGoogleIdentity"("firebaseUid");
ALTER TABLE "UserGoogleIdentity" ADD CONSTRAINT "UserGoogleIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
