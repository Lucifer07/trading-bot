-- Migration: Add leverage column to trades table
-- This adds support for dynamic leverage tracking

-- Add leverage column to trades table
ALTER TABLE trades 
ADD COLUMN IF NOT EXISTS leverage DECIMAL(5, 2) DEFAULT 3;

-- Add comment to leverage column
COMMENT ON COLUMN trades.leverage IS 'Leverage used for the trade (default: 3, supports dynamic leverage)';

-- Verify the column was added
SELECT column_name, data_type, column_default 
FROM information_schema.columns 
WHERE table_name = 'trades' 
AND column_name = 'leverage';