-- Migration: Add PENDING and FAILED status to trades table
-- Date: 2025-03-10

-- Drop existing check constraint
ALTER TABLE trades DROP CONSTRAINT IF EXISTS trades_status_check;

-- Add new check constraint with PENDING and FAILED
ALTER TABLE trades
ADD CONSTRAINT trades_status_check
CHECK (status IN ('PENDING', 'OPEN', 'CLOSED', 'CANCELLED', 'PARTIAL', 'FAILED'));

-- Add new columns for order tracking
ALTER TABLE trades
ADD COLUMN IF NOT EXISTS exchange_order_ids JSONB,
ADD COLUMN IF NOT EXISTS orders_placed_at TIMESTAMP;

-- Update trades created before migration (set FAILED if no orders exist)
UPDATE trades
SET status = 'FAILED',
    exit_time = NOW(),
    notes = COALESCE(notes, '') || ' [Marked FAILED during migration - no orders found]'
WHERE status = 'OPEN'
AND trade_id NOT IN (
    SELECT DISTINCT trade_id FROM orders
    WHERE exchange_order_id IS NOT NULL
);

-- Create index for PENDING trades
CREATE INDEX IF NOT EXISTS idx_trades_status_pending ON trades(status) WHERE status = 'PENDING';

-- Create index for FAILED trades
CREATE INDEX IF NOT EXISTS idx_trades_status_failed ON trades(status) WHERE status = 'FAILED';

COMMENT ON COLUMN trades.exchange_order_ids IS 'JSON array of exchange order IDs for this trade';
COMMENT ON COLUMN trades.orders_placed_at IS 'Timestamp when all orders were successfully placed';

-- Add comment for status values
COMMENT ON COLUMN trades.status IS 'Trade status: PENDING (orders being placed), OPEN (position active), CLOSED (position closed), CANCELLED (order cancelled), PARTIAL (partial fill), FAILED (order placement failed)';
