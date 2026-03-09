require('dotenv').config();

const config = {
  env: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',
  serverPort: parseInt(process.env.SERVER_PORT) || 3000,

  // Binance Futures
  binance: {
    baseUrl: process.env.BINANCE_FUTURES_BASE_URL || 'https://fapi.binance.com',
    wsUrl: process.env.BINANCE_FUTURES_WS_URL || 'wss://fstream.binance.com/ws',
    apiKey: process.env.BINANCE_FUTURES_API_KEY || '',
    secretKey: process.env.BINANCE_FUTURES_SECRET_KEY || '',
    testnet: process.env.BINANCE_FUTURES_BASE_URL?.includes('testnet') || false,
  },

  // Database
  postgres: {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT) || 5432,
    database: process.env.POSTGRES_DB || 'trading_db',
    user: process.env.POSTGRES_USER || 'trading',
    password: process.env.POSTGRES_PASSWORD || 'trading_secure_pass',
  },

  // Redis
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || null,
  },

  // Risk Management
  risk: {
    maxPositionSizePercent: parseFloat(process.env.MAX_POSITION_SIZE_PERCENT) || 2,
    maxTotalOpenRiskPercent: parseFloat(process.env.MAX_TOTAL_OPEN_RISK_PERCENT) || 10,
    maxDailyLossPercent: parseFloat(process.env.MAX_DAILY_LOSS_PERCENT) || 5,
    stopLossBufferATR: parseInt(process.env.STOP_LOSS_BUFFER_ATR) || 2,
  },

  // Trading
  trading: {
    enabled: process.env.TRADING_ENABLED === 'true',
    paperTrading: process.env.PAPER_TRADING !== 'false',
    paperTradingBalance: parseFloat(process.env.PAPER_TRADING_BALANCE) || 60.00,
    leverage: parseInt(process.env.LEVERAGE) || 5,
    defaultMarginType: process.env.DEFAULT_MARGIN_TYPE || 'CROSS',
    defaultPositionMode: process.env.DEFAULT_POSITION_MODE || 'HEDGE',
    defaultRiskRewardRatio: parseFloat(process.env.DEFAULT_RISK_REWARD_RATIO) || 2,
    minRiskRewardRatio: parseFloat(process.env.MIN_RISK_REWARD_RATIO) || 1.5,
    maxCorrelatedPositions: parseInt(process.env.MAX_CORRELATED_POSITIONS) || 1,
  },

  // Telegram
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },

  // Discord
  discord: {
    botToken: process.env.DISCORD_BOT_TOKEN || '',
    channelId: process.env.DISCORD_CHANNEL_ID || '',
  },

  // Security
  security: {
    apiWhitelistIP: process.env.API_WHITELIST_IP?.split(',') || ['127.0.0.1', 'localhost'],
    enableKillSwitch: process.env.ENABLE_KILL_SWITCH !== 'false',
    maxRetries: parseInt(process.env.MAX_RETRIES) || 3,
    orderReplyTimeout: parseInt(process.env.ORDER_REPLY_TIMEOUT) || 5000,
  },
};

// Validate required configuration
function validateConfig() {
  const errors = [];

  if (config.env === 'production') {
    if (!config.binance.apiKey) errors.push('BINANCE_FUTURES_API_KEY is required in production');
    if (!config.binance.secretKey) errors.push('BINANCE_FUTURES_SECRET_KEY is required in production');
  }

  if (errors.length > 0) {
    console.error('Configuration errors:');
    errors.forEach(err => console.error(`  - ${err}`));
    throw new Error('Invalid configuration');
  }

  return true;
}

module.exports = {
  config,
  validateConfig,
};
