-- Schema-v2 phase 4 (2/2): customer-to-shop payment tracking (cash / UPI reference). No gateway, no platform billing, expand-only.
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'UPI');
CREATE TYPE "PaymentStatus" AS ENUM ('UNPAID', 'PENDING_VERIFICATION', 'PAID', 'REFUNDED');

ALTER TABLE "Shop" ADD COLUMN "upiId" TEXT, ADD COLUMN "acceptedPaymentMethods" "PaymentMethod"[] NOT NULL DEFAULT ARRAY['CASH']::"PaymentMethod"[];
ALTER TABLE "Order" ADD COLUMN "paymentMethod" "PaymentMethod", ADD COLUMN "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'UNPAID', ADD COLUMN "upiTxnRef" TEXT;
-- One UTR per shop (NULLs are distinct in PostgreSQL, so orders without a reference never collide).
CREATE UNIQUE INDEX "Order_shopId_upiTxnRef_key" ON "Order"("shopId", "upiTxnRef");

CREATE TABLE "OrderPaymentEvent" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "fromStatus" "PaymentStatus",
  "toStatus" "PaymentStatus" NOT NULL,
  "upiTxnRef" TEXT,
  "amountPaise" INTEGER,
  "reason" TEXT,
  "actorUserId" TEXT,
  "actorRole" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderPaymentEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrderPaymentEvent_event_check" CHECK ("event" IN ('UPI_SUBMITTED', 'UPI_VERIFIED', 'UPI_REJECTED', 'CASH_RECEIVED', 'REFUND_RECORDED')),
  CONSTRAINT "OrderPaymentEvent_actor_check" CHECK ("actorRole" IN ('CUSTOMER', 'SHOP_OWNER', 'PLATFORM_ADMIN')),
  CONSTRAINT "OrderPaymentEvent_amount_check" CHECK ("amountPaise" IS NULL OR "amountPaise" >= 0)
);
CREATE INDEX "OrderPaymentEvent_orderId_createdAt_idx" ON "OrderPaymentEvent"("orderId", "createdAt");
CREATE INDEX "OrderPaymentEvent_shopId_createdAt_idx" ON "OrderPaymentEvent"("shopId", "createdAt");
ALTER TABLE "OrderPaymentEvent" ADD CONSTRAINT "OrderPaymentEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Append-only evidence: payment events can be inserted, never changed or removed.
CREATE FUNCTION "order_payment_event_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'OrderPaymentEvent rows are append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "OrderPaymentEvent_append_only" BEFORE UPDATE OR DELETE ON "OrderPaymentEvent" FOR EACH ROW EXECUTE FUNCTION "order_payment_event_immutable"();
