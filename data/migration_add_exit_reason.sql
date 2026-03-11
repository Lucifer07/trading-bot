-- Add exit_reason column to trades table
-- This column will store the reason why a trade was closed/failed

ALTER TABLE trades
ADD COLUMN IF NOT EXISTS exit_reason TEXT;

-- Add comment to column
COMMENT ON COLUMN trades.exit_reason IS 'Reason for trade exit or failure (e.g., Stop Loss, Take Profit, Orphan trade)';

-- Create index for exit_reason (useful for analytics)
CREATE INDEX IF NOT EXISTS idx_trades_exit_reason ON trades(exit_reason) WHERE exit_reason IS NOT NULL;

COMMIT;