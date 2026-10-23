-- Admin two-factor authentication. Purely additive: three new tables, no change to existing tables or data.
-- Existing admins and sessions are unaffected until an admin enrolls.

CREATE TABLE "AdminTwoFactor" (
    "userId" TEXT NOT NULL,
    "secretEnc" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "enabledAt" TIMESTAMP(3),
    "lastUsedStep" BIGINT NOT NULL DEFAULT 0,
    "recoveryAckAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminTwoFactor_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "AdminRecoveryCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminRecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdminLoginChallenge" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialFp" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminLoginChallenge_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminRecoveryCode_userId_usedAt_idx" ON "AdminRecoveryCode"("userId", "usedAt");
CREATE UNIQUE INDEX "AdminLoginChallenge_tokenHash_key" ON "AdminLoginChallenge"("tokenHash");
CREATE INDEX "AdminLoginChallenge_userId_idx" ON "AdminLoginChallenge"("userId");
CREATE INDEX "AdminLoginChallenge_expiresAt_idx" ON "AdminLoginChallenge"("expiresAt");

ALTER TABLE "AdminTwoFactor" ADD CONSTRAINT "AdminTwoFactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdminRecoveryCode" ADD CONSTRAINT "AdminRecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdminLoginChallenge" ADD CONSTRAINT "AdminLoginChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
