-- Schema-v2 phase 4 (1/2): additive REJECTED order status (decision D7). Own migration: Postgres cannot use a new enum value in the
-- transaction that adds it. Nothing sets this value until ORDER_REJECT_ENABLED is turned on (clients must tolerate it first).
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'REJECTED';
