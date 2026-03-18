-- =============================================
-- Run this in your Supabase SQL Editor
-- =============================================

-- 1. Vouchers table
CREATE TABLE IF NOT EXISTS vouchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wicode text UNIQUE NOT NULL,
  claimed boolean DEFAULT false,
  claimed_by text,
  claimed_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- 2. Claims log (audit trail)
CREATE TABLE IF NOT EXISTS claims_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number text NOT NULL,
  voucher_id uuid REFERENCES vouchers(id),
  message_id text,
  created_at timestamptz DEFAULT now()
);

-- 3. Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_vouchers_unclaimed ON vouchers (claimed) WHERE claimed = false;
CREATE INDEX IF NOT EXISTS idx_claims_phone ON claims_log (phone_number);

-- 4. Atomic claim function (prevents race conditions)
CREATE OR REPLACE FUNCTION claim_next_voucher(claimer_phone text)
RETURNS vouchers AS $$
DECLARE
  v vouchers;
BEGIN
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

-- 5. Enable Row Level Security
ALTER TABLE vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims_log ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users (admin dashboard) to read all data
CREATE POLICY "Authenticated users can read vouchers"
  ON vouchers FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert vouchers"
  ON vouchers FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can read claims"
  ON claims_log FOR SELECT
  TO authenticated
  USING (true);

-- Service role bypasses RLS automatically, so webhook functions work fine
