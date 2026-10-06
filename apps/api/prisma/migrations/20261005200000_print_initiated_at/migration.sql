-- Additive only: no backfill. Historical rows keep their existing printedAt/deleteAfter untouched.
ALTER TABLE "Document" ADD COLUMN "printInitiatedAt" TIMESTAMP(3);
