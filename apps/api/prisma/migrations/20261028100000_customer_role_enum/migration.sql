-- Schema-v2 phase 1 (1/2): additive enum value only. Kept in its own migration because Postgres cannot use a new enum value
-- in the same transaction that adds it (the CHECK constraints in the next migration reference it). Irreversible but inert if unused.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'CUSTOMER';
