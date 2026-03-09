# Binance Futures Trading Bot

Bot trading otomatis untuk Binance Futures dengan fitur risk management, technical analysis, dan symbol scanner.

## Features

- ✅ **Symbol Scanner**: Scan otomatis semua USDT perpetual futures setiap 5 menit
- ✅ **Auto Trading**: Trading otomatis berdasarkan strategi teknikal
- ✅ **Risk Management**: Position sizing, stop loss, take profit otomatis
- ✅ **Technical Analysis**: RSI, EMA, ATR, dan trend detection
- ✅ **News Safety Filter**: Cek berita sebelum trade untuk hindari volatilitas ekstrem
- ✅ **Paper Trading**: Mode simulasi untuk testing strategi
- ✅ **Telegram Alerts**: Notifikasi real-time untuk semua aktivitas
- ✅ **Database Logging**: PostgreSQL untuk tracking semua trades
- ✅ **Redis Caching**: Cache data market untuk akses cepat
- ✅ **Kill Switch**: Emergency stop untuk menghentikan semua trading
- ✅ **Survival Mode**: Tier-based risk management untuk modal kecil

## Quick Start

### 1. Installation

```bash
npm install
```

### 2. Configuration

Copy `.env.example` ke `.env` dan isi dengan credentials Anda:

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Binance Futures API
BINANCE_FUTURES_BASE_URL=https://testnet.binancefuture.com
BINANCE_FUTURES_API_KEY=your_api_key
BINANCE_FUTURES_SECRET_KEY=your_secret_key

# Database
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=trading_db
POSTGRES_USER=trading
POSTGRES_PASSWORD=your_password

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# Telegram
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# Trading Settings
TRADING_ENABLED=false
PAPER_TRADING=true
PAPER_TRADING_BALANCE=60.00
LEVERAGE=5
```

### 3. Database Setup

```bash
# Create database
psql -U postgres -c "CREATE DATABASE trading_db;"

# Run migrations
psql -U postgres -d trading_db -f data/init_v2.sql
```

### 4. Run Bot

```bash
# Start bot
node src/index.js

# Test symbol scanner
node test-scanner.js

# Run standalone scanner
node symbol-scanner.js
```

## Symbol Scanner

Symbol scanner adalah fitur utama yang memindai semua USDT perpetual futures dan memberikan ranking berdasarkan profit potential.

### Cara Kerja

1. **Automatic Scan**: Berjalan otomatis setiap 5 menit
2. **Technical Analysis**: Analisis RSI, EMA, ATR, dan trend untuk setiap symbol
3. **Scoring**: Memberikan score 0-100 berdasarkan volatility, volume, trend, dan price change
4. **Redis Storage**: Hasil disimpan di Redis untuk akses cepat
5. **Telegram Notification**: Top 5 opportunities dikirim ke Telegram

### Menggunakan Scanner

```javascript
const { TradingBot } = require('./src/index');

const bot = new TradingBot();
await bot.start(); // Scanner otomatis dimulai

// Get latest scan results
const latestScan = await bot.getLatestScan();
console.log(`Total symbols: ${latestScan.count}`);

// Get top 20 symbols
const top20 = await bot.getTop20Symbols();
console.log('Top symbol:', top20[0].symbol);

// Get specific symbol data
const btcData = await bot.getSymbolData('BTCUSDT');
console.log('BTC Score:', btcData.profitPotential);

// Run manual scan
const results = await bot.runSymbolScan();
```

Lihat [SYMBOL_SCANNER.md](SYMBOL_SCANNER.md) untuk dokumentasi lengkap.

## Trading

### Manual Trading

```javascript
const bot = new TradingBot();
await bot.start();

// Execute trade
await bot.executeTrade(
  'BTCUSDT',      // symbol
  'LONG',         // side (LONG/SHORT)
  45000,          // entry price
  44000,          // stop loss
  1,              // risk percent (1%)
  'Manual'        // strategy name
);
```

### Auto Trading

```javascript
const bot = new TradingBot();
await bot.start();

// Start auto trader
await bot.startAutoTrader();

// Stop auto trader
await bot.stopAutoTrader();

// Get stats
const stats = await bot.getAutoTraderStats();
console.log(stats);
```

## Risk Management

Bot menggunakan risk management yang ketat:

- **Position Sizing**: Otomatis berdasarkan account balance dan risk percent
- **Stop Loss**: Wajib untuk setiap trade
- **Take Profit**: Otomatis berdasarkan risk-reward ratio
- **Max Position Size**: Default 2% per trade
- **Max Total Risk**: Default 10% dari account
- **Max Daily Loss**: Default 5% dari account
- **Correlation Check**: Maksimal 1 posisi per symbol group

## Configuration

### Trading Settings

```env
# Enable/disable trading
TRADING_ENABLED=false

# Paper trading mode
PAPER_TRADING=true
PAPER_TRADING_BALANCE=60.00

# Leverage
LEVERAGE=5

# Risk management
MAX_POSITION_SIZE_PERCENT=2
MAX_TOTAL_OPEN_RISK_PERCENT=10
MAX_DAILY_LOSS_PERCENT=5

# Risk-reward ratio
DEFAULT_RISK_REWARD_RATIO=2
MIN_RISK_REWARD_RATIO=1.5

# Position limits
MAX_CORRELATED_POSITIONS=1
```

## Telegram Alerts

Bot mengirim notifikasi untuk:

- Bot started/stopped
- Symbol scan results (top 5 opportunities)
- Trade entry/exit
- Order confirmations
- Risk alerts
- Kill switch activation
- Errors

## Kill Switch

Emergency stop untuk menghentikan semua trading:

```javascript
// Activate kill switch
await bot.activateKillSwitch('Market crash detected');

// Deactivate kill switch
await bot.deactivateKillSwitch();
```

## Database Schema

Bot menggunakan PostgreSQL untuk tracking:

- `trades`: Semua trade records
- `orders`: Order history
- `account_snapshots`: Balance snapshots
- `kill_switch`: Kill switch status
- `system_logs`: System events

## Redis Keys

Data di-cache di Redis:

- `symbol_scan:latest`: Latest scan results
- `symbol_scan:top20`: Top 20 symbols
- `symbol_scan:symbols`: Individual symbol data
- `open_positions`: Active positions
- `pending_orders`: Pending orders
- `system_status`: System status

## Testing

```bash
# Test symbol scanner
node test-scanner.js

# Test database connection
node -e "require('./src/storage/db').getDatabase().testConnection()"

# Test Redis connection
node -e "require('./src/storage/redis').getRedis().testConnection()"
```

## Architecture

```
src/
├── index.js              # Main bot entry point
├── config.js             # Configuration
├── api/
│   ├── binance.js        # Binance REST API
│   └── binance-ws.js     # Binance WebSocket
├── strategies/
│   ├── base-strategy.js  # Base strategy class
│   ├── ema-crossover.js  # EMA crossover strategy
│   └── rsi-strategy.js   # RSI strategy
├── trading/
│   └── auto-trader.js    # Auto trading engine
├── risk/
│   └── calculator.js     # Risk calculations
├── storage/
│   ├── db.js             # PostgreSQL client
│   └── redis.js          # Redis client
├── alerts/
│   └── telegram.js       # Telegram notifications
└── utils/
    ├── logger.js         # Winston logger
    ├── crypto.js         # Encryption utilities
    └── symbol-scanner.js # Symbol scanner
```

## Security

- API keys encrypted at rest
- IP whitelist untuk API access
- Rate limiting
- Kill switch untuk emergency stop
- Paper trading mode untuk testing

## Performance

- Symbol scan: ~30-60 detik untuk ~200 symbols
- Redis caching untuk akses cepat
- WebSocket untuk real-time updates
- Efficient database queries

## Troubleshooting

### Scanner tidak berjalan

```javascript
// Check status
console.log('Scanner running:', bot.symbolScanner.isRunning());

// Restart
bot.symbolScanner.stop();
bot.symbolScanner.start(5);
```

### Database connection error

```bash
# Check PostgreSQL status
sudo systemctl status postgresql

# Test connection
psql -U trading -d trading_db
```

### Redis connection error

```bash
# Check Redis status
sudo systemctl status redis

# Test connection
redis-cli ping
```

## License

MIT

## Support

Untuk pertanyaan dan support, hubungi developer.
