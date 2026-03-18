-- =============================================
-- Run this in your Supabase SQL Editor
-- Fixes race conditions and adds safety constraints
-- =============================================

-- 1. Unique index on claims_log.phone_number — prevents double claims at DB level
CREATE UNIQUE INDEX IF NOT EXISTS idx_claims_phone_unique ON claims_log (phone_number);

-- 2. Index on vouchers.claimed_by for fast phone lookups
CREATE INDEX IF NOT EXISTS idx_vouchers_claimed_by ON vouchers (claimed_by) WHERE claimed_by IS NOT NULL;

-- 3. Replace the claim function — now checks if phone already claimed INSIDE the transaction
CREATE OR REPLACE FUNCTION claim_next_voucher(claimer_phone text)
RETURNS vouchers AS $$
DECLARE
  v vouchers;
  existing vouchers;
BEGIN
  -- First check if this phone already has a voucher (inside the transaction)
  SELECT * INTO existing
  FROM vouchers
  WHERE claimed_by = claimer_phone
  LIMIT 1;

  IF existing.id IS NOT NULL THEN
    -- Already claimed — return NULL to signal "no new claim"
    RETURN NULL;
  END IF;

  -- Select and lock the first unclaimed voucher
  SELECT * INTO v
  FROM vouchers
  WHERE claimed = false
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v.id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Mark as claimed
  UPDATE vouchers
  SET claimed = true,
      claimed_by = claimer_phone,
      claimed_at = now()
  WHERE id = v.id;

  RETURN v;
END;
$$ LANGUAGE plpgsql;
