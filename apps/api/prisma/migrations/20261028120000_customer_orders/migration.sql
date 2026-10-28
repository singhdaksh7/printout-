-- Schema-v2 phase 3: customer-owned uploads and orders. Expand-only; guest QR rows keep NULLs and behave exactly as before.
ALTER TABLE "Document" ADD COLUMN "uploaderUserId" TEXT;
ALTER TABLE "Order" ADD COLUMN "customerUserId" TEXT, ADD COLUMN "note" TEXT;
ALTER TABLE "Order" ADD CONSTRAINT "Order_note_length" CHECK ("note" IS NULL OR char_length("note") <= 500);
ALTER TABLE "Document" ADD CONSTRAINT "Document_uploaderUserId_fkey" FOREIGN KEY ("uploaderUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_customerUserId_fkey" FOREIGN KEY ("customerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Document_uploaderUserId_createdAt_idx" ON "Document"("uploaderUserId", "createdAt");
CREATE INDEX "Order_customerUserId_createdAt_idx" ON "Order"("customerUserId", "createdAt");
