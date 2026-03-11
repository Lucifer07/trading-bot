-- Trading Database Schema (Simplified - without uuid-ossp extension)

-- Trade records
CREATE TABLE IF NOT EXISTS trades (
    id SERIAL PRIMARY KEY,
    trade_id VARCHAR(100) UNIQUE NOT NULL,
    symbol VARCHAR(50) NOT NULL,
    side VARCHAR(10) NOT NULL CHECK (side IN ('LONG', 'SHORT')),
    entry_price DECIMAL(20, 8) NOT NULL,
    exit_price DECIMAL(20, 8),
    quantity DECIMAL(20, 8) NOT NULL,
    stop_loss DECIMAL(20, 8) NOT NULL,
    take_profit DECIMAL(20, 8),
    risk_amount DECIMAL(20, 8) NOT NULL,
    risk_percent DECIMAL(5, 2) NOT NULL,
    profit_loss DECIMAL(20, 8),
    profit_loss_percent DECIMAL(10, 2),
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'OPEN', 'CLOSED', 'CANCELLED', 'PARTIAL', 'FAILED')),
    entry_time TIMESTAMP NOT NULL DEFAULT NOW(),
    exit_time TIMESTAMP,
    duration_seconds INTEGER,
    strategy VARCHAR(100),
    indicators JSONB,
    notes TEXT,
    exchange_order_ids JSONB,
    orders_placed_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Create indexes for trades
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_entry_time ON trades(entry_time DESC);
CREATE INDEX IF NOT EXISTS idx_trades_trade_id ON trades(trade_id);

-- Order records
CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    order_id VARCHAR(100) UNIQUE NOT NULL,
    trade_id VARCHAR(100) REFERENCES trades(trade_id) ON DELETE SET NULL,
    exchange_order_id VARCHAR(100),
    symbol VARCHAR(50) NOT NULL,
    side VARCHAR(10) NOT NULL CHECK (side IN ('BUY', 'SELL')),
    order_type VARCHAR(20) NOT NULL CHECK (order_type IN ('MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT')),
    price DECIMAL(20, 8),
    quantity DECIMAL(20, 8) NOT NULL,
    filled_quantity DECIMAL(20, 8) DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'OPEN', 'FILLED', 'PARTIALLY_FILLED', 'CANCELLED', 'REJECTED')),
    exchange_status VARCHAR(50),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    filled_at TIMESTAMP
);

-- Create indexes for orders
CREATE INDEX IF NOT EXISTS idx_orders_trade_id ON orders(trade_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_exchange_order_id ON orders(exchange_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_order_id ON orders(order_id);

-- Account snapshots (for P/L tracking)
CREATE TABLE IF NOT EXISTS account_snapshots (
    id SERIAL PRIMARY KEY,
    balance DECIMAL(20, 8) NOT NULL,
    equity DECIMAL(20, 8) NOT NULL,
    unrealized_pnl DECIMAL(20, 8) NOT NULL,
    open_positions_count INTEGER NOT NULL DEFAULT 0,
    total_risk_exposure DECIMAL(20, 8) NOT NULL DEFAULT 0,
    recorded_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Create index for account snapshots
CREATE INDEX IF NOT EXISTS idx_account_snapshots_recorded_at ON account_snapshots(recorded_at DESC);

-- System events (audit trail)
CREATE TABLE IF NOT EXISTS system_events (
    id SERIAL PRIMARY KEY,
    event_type VARCHAR(50) NOT NULL,
    severity VARCHAR(20) NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'ERROR', 'CRITICAL')),
    message TEXT NOT NULL,
    data JSONB,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Create index for system events
CREATE INDEX IF NOT EXISTS idx_system_events_event_type ON system_events(event_type);
CREATE INDEX IF NOT EXISTS idx_system_events_severity ON system_events(severity);
CREATE INDEX IF NOT EXISTS idx_system_events_created_at ON system_events(created_at DESC);

-- Performance metrics
CREATE TABLE IF NOT EXISTS performance_metrics (
    id SERIAL PRIMARY KEY,
    period VARCHAR(20) NOT NULL CHECK (period IN ('DAILY', 'WEEKLY', 'MONTHLY')),
    period_start TIMESTAMP NOT NULL,
    period_end TIMESTAMP NOT NULL,
    total_trades INTEGER NOT NULL DEFAULT 0,
    winning_trades INTEGER NOT NULL DEFAULT 0,
    losing_trades INTEGER NOT NULL DEFAULT 0,
    win_rate DECIMAL(5, 2) NOT NULL DEFAULT 0,
    total_profit DECIMAL(20, 8) NOT NULL DEFAULT 0,
    total_loss DECIMAL(20, 8) NOT NULL DEFAULT 0,
    net_profit DECIMAL(20, 8) NOT NULL DEFAULT 0,
    max_drawdown DECIMAL(20, 8) NOT NULL DEFAULT 0,
    profit_factor DECIMAL(10, 2),
    average_risk_reward DECIMAL(10, 2),
    sharpe_ratio DECIMAL(10, 2),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Create index for performance metrics
CREATE INDEX IF NOT EXISTS idx_performance_metrics_period ON performance_metrics(period, period_start DESC);

-- Kill switch state
CREATE TABLE IF NOT EXISTS kill_switch (
    id SERIAL PRIMARY KEY,
    activated BOOLEAN NOT NULL DEFAULT false,
    reason TEXT,
    activated_at TIMESTAMP,
    deactivated_at TIMESTAMP,
    activated_by VARCHAR(100),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Insert initial kill switch record
INSERT INTO kill_switch (id) VALUES (DEFAULT)
ON CONFLICT DO NOTHING;

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers for updated_at
DROP TRIGGER IF EXISTS update_trades_updated_at ON trades;
CREATE TRIGGER update_trades_updated_at BEFORE UPDATE ON trades
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_orders_updated_at ON orders;
CREATE TRIGGER update_orders_updated_at BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_kill_switch_updated_at ON kill_switch;
CREATE TRIGGER update_kill_switch_updated_at BEFORE UPDATE ON kill_switch
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
