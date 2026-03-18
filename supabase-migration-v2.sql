-- =============================================
-- Run this in your Supabase SQL Editor
-- Fixes race conditions and adds safety constraints
-- =============================================

-- 1. Unique index on claims_log.phone_number — prevents double claims at DB level
CREATE UNIQUE INDEX IF NOT EXISTS idx_claims_phone_unique ON claims_log (phone_number);

-- 2. Index on vouchers.claimed_by for fast phone lookups
CREATE INDEX IF NOT EXISTS idx_vouchers_claimed_by ON vouchers (claimed_by) WHERE claimed_by IS NOT NULL;

-- 3. Replace the claim function — advisory lock serializes by phone number
--    This prevents parallel webhook deliveries from claiming multiple vouchers
CREATE OR REPLACE FUNCTION claim_next_voucher(claimer_phone text)
RETURNS vouchers AS $$
DECLARE
  v vouchers;
BEGIN
  -- Force all concurrent requests for the same phone to wait in line
  PERFORM pg_advisory_xact_lock(hashtext(claimer_phone));

  -- Now safe to check — no other transaction for this phone can be running
  IF EXISTS (SELECT 1 FROM vouchers WHERE claimed_by = claimer_phone) THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v
  FROM vouchers
  WHERE claimed = false
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v.id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE vouchers
  SET claimed = true,
      claimed_by = claimer_phone,
      claimed_at = now()
  WHERE id = v.id;

  RETURN v;
END;
$$ LANGUAGE plpgsql;
