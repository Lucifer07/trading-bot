require('dotenv').config();
console.log('Loading logger...');
const logger = require('./utils/logger');
console.log('Logger loaded');
const { config, validateConfig } = require('./config');
console.log('Config loaded');
const BinanceFuturesAPI = require('./api/binance');
console.log('Binance API loaded');
const BinanceWebSocketClient = require('./api/binance-ws');
console.log('Binance WS loaded');
const WebSocketScanner = require('./api/ws-scanner');
console.log('WS Scanner loaded');
const RiskCalculator = require('./risk/calculator');
console.log('Risk Calculator loaded');
const { getDatabase } = require('./storage/db');
console.log('DB loaded');
const { getRedis } = require('./storage/redis');
console.log('Redis loaded');
const TelegramAlerts = require('./alerts/telegram');
console.log('Telegram loaded');
const AutoTrader = require('./trading/auto-trader');
console.log('AutoTrader loaded');
const SymbolScanner = require('./utils/symbol-scanner');
console.log('Symbol Scanner loaded');

class TradingBot {
  constructor() {
    console.log('TradingBot constructor: 1');
    this.config = config;
    this.isRunning = false;
    this.paperTrading = config.trading.paperTrading;
    this.tradingEnabled = config.trading.enabled;

    console.log('TradingBot constructor: 2');
    // Initialize components
    this.api = new BinanceFuturesAPI();
    console.log('TradingBot constructor: 3');
    this.ws = new BinanceWebSocketClient();
    console.log('TradingBot constructor: 4');
    this.wsScanner = new WebSocketScanner(); // WebSocket scanner for all symbols
    console.log('TradingBot constructor: 5');
    this.riskCalculator = new RiskCalculator();
    console.log('TradingBot constructor: 6');
    this.db = getDatabase();
    console.log('TradingBot constructor: 7');
    this.redis = getRedis();
    console.log('TradingBot constructor: 8');
    this.telegram = new TelegramAlerts();
    console.log('TradingBot constructor: 9');

    // State
    this.accountBalance = 0;
    this.openPositions = new Map();
    this.pendingOrders = new Map();

    // WebSocket data caches (to avoid REST API calls)
    this.klineCache = new Map(); // symbol -> klines array
    this.tickerCache = new Map(); // symbol -> ticker data
    this.bookTickerCache = new Map(); // symbol -> best bid/ask

    console.log('TradingBot constructor: 10');
    // Symbol Scanner (with WebSocket scanner)
    this.symbolScanner = new SymbolScanner(this.redis, this.telegram, this.wsScanner);
    console.log('TradingBot constructor: 11');

    // Auto-trading
    console.log('TradingBot constructor: 12 - Creating AutoTrader');
    this.autoTrader = new AutoTrader({
      api: this.api,
      riskCalculator: this.riskCalculator,
      db: this.db,
      telegram: this.telegram,
      redisClient: this.redis, // Add Redis client for multi-confirmation strategy
      paperTrading: this.paperTrading,
      tradingEnabled: this.tradingEnabled,
      useMultiConfirmation: true, // Enable multi-confirmation strategy
      scanInterval: 180000, // 3 minutes - sync with SymbolScanner
      symbolScanner: this.symbolScanner, // Pass scanner reference
      positionCache: this.openPositions, // Pass position cache from websocket
      bot: this, // Pass TradingBot instance for accessing cached data
    });
    console.log('TradingBot constructor: 13 - AutoTrader created');
  }

  async start() {
    try {
      logger.info('🚀 Starting Binance Futures Trading Bot');
      logger.info('Configuration', {
        env: this.config.env,
        tradingEnabled: this.tradingEnabled,
        paperTrading: this.paperTrading,
        testnet: this.config.binance.testnet,
        leverage: this.config.trading.leverage,
      });

      // Validate configuration
      validateConfig();

      // Test database connection
      await this.db.testConnection();
      logger.info('✅ Database connected');

      // Test Redis connection
      await this.redis.testConnection();
      logger.info('✅ Redis connected');

      // Connect to WebSocket scanner (all symbols)
      await this.wsScanner.connect();
      const wsStats = this.wsScanner.getStats();
      logger.info('✅ WebSocket scanner connected', {
        totalSymbols: wsStats.totalSymbols,
        usdtSymbols: wsStats.usdtSymbols,
      });

      // Test Binance API connection
      const binanceStatus = await this.api.testConnection();
      if (binanceStatus.authenticated) {
        logger.info('✅ Binance API connected (authenticated)', {
          testnet: binanceStatus.testnet,
          canTrade: binanceStatus.canTrade,
          balance: binanceStatus.totalWalletBalance,
        });
        
        // Get detailed account info
        const accountInfo = await this.api.getAccountInfo();
        logger.info('Account Info', {
          totalBalance: accountInfo.totalWalletBalance,
          availableBalance: accountInfo.availableBalance,
          unrealizedPnL: accountInfo.totalUnrealizedProfit,
          openPositions: accountInfo.openPositionsCount,
        });
        
        // Send account info to Telegram
        if (this.telegram.enabled) {
          await this.telegram.sendAlert(
            'Binance Account Connected',
            `💰 Balance: $${accountInfo.totalWalletBalance.toFixed(2)}\n` +
            `💵 Available: $${accountInfo.availableBalance.toFixed(2)}\n` +
            `📊 Unrealized PnL: $${accountInfo.totalUnrealizedProfit.toFixed(2)}\n` +
            `📈 Open Positions: ${accountInfo.openPositionsCount}\n` +
            `🌐 Network: ${binanceStatus.testnet ? 'TESTNET' : 'MAINNET'}`,
            'INFO'
          );
        }
      } else {
        logger.warn('⚠️ Binance API connected (public only)', {
          testnet: binanceStatus.testnet,
          message: binanceStatus.message || binanceStatus.error,
        });
        
        if (!this.paperTrading) {
          throw new Error('Binance API authentication required for live trading. Please configure API keys.');
        }
      }

      // Test Telegram connection
      if (this.telegram.enabled) {
        await this.telegram.testConnection();
        logger.info('✅ Telegram connected');
      }

      // Check kill switch
      const killSwitch = await this.db.getKillSwitch();
      if (killSwitch?.activated) {
        logger.error('⛔ Kill switch is activated! Trading disabled.');
        await this.telegram.sendCriticalAlert('Kill switch is activated! Trading disabled.');
        return false;
      }

      // Get account balance
      if (!this.paperTrading) {
        try {
          this.accountBalance = await this.api.getTotalWalletBalance();
          console.log("")
          logger.info('Account balance', { balance: this.accountBalance });

          // Create snapshot
          await this.db.createSnapshot({
            balance: this.accountBalance,
            equity: this.accountBalance,
            unrealized_pnl: await this.api.getUnrealizedPnL(),
            open_positions_count: 0,
            total_risk_exposure: 0,
          });
        } catch (error) {
          logger.error('Failed to get account balance', { error: error.message });
          if (!this.paperTrading) {
            throw error;
          }
        }
      } else {
        // Use paper trading balance from config
        this.accountBalance = parseFloat(config.trading.paperTradingBalance) || 60.00;
        logger.info('Paper trading mode enabled', { balance: this.accountBalance });

        // Create initial snapshot
        await this.db.createSnapshot({
          balance: this.accountBalance,
          equity: this.accountBalance,
          unrealized_pnl: 0,
          open_positions_count: 0,
          total_risk_exposure: 0,
        });
      }

      // Subscribe to market data (optional)
      // this.subscribeToMarketData(['BTCUSDT', 'ETHUSDT']);

      // Subscribe to user data stream (if not paper trading)
      if (!this.paperTrading) {
        await this.subscribeToUserData();
      }

      this.isRunning = true;
      logger.info('✅ Trading bot started successfully');

      await this.telegram.sendAlert('Bot Started', 'Binance Futures Trading Bot is now running!', 'INFO');

      // Auto-start auto-trader if enabled
      if (this.tradingEnabled) {
        logger.info('🤖 Starting Auto Trader with integrated scanning');
        await this.startAutoTrader();
      }

      return true;
    } catch (error) {
      logger.error('Failed to start trading bot', { error: error.message, stack: error.stack });
      await this.telegram.sendErrorAlert(`Failed to start: ${error.message}`);
      return false;
    }
  }

  async stop() {
    try {
      logger.info('🛑 Stopping Binance Futures Trading Bot');

      this.isRunning = false;

      // Stop symbol scanner
      this.symbolScanner.stop();

      // Stop auto trader if running
      if (this.autoTrader.isRunning) {
        await this.autoTrader.stop();
      }

      // Close WebSocket connections
      this.ws.disconnectAll();
      this.wsScanner.disconnect();

      // Close database connection
      await this.db.close();

      // Close Redis connection
      await this.redis.close();

      logger.info('✅ Trading bot stopped');

      await this.telegram.sendAlert('Bot Stopped', 'Binance Futures Trading Bot has been stopped.', 'INFO');

      return true;
    } catch (error) {
      logger.error('Error stopping trading bot', { error: error.message });
      return false;
    }
  }

  async subscribeToMarketData(symbols) {
    try {
      // Subscribe to klines (1h) for indicators
      this.ws.subscribeKlines(symbols, '1h', (data) => {
        if (data.e === 'kline' && data.k) {
          const kline = data.k;
          const symbol = kline.s;

          // Update kline cache
          if (!this.klineCache.has(symbol)) {
            this.klineCache.set(symbol, []);
          }

          const klineArray = [
            kline.t, // Open time
            parseFloat(kline.o), // Open
            parseFloat(kline.h), // High
            parseFloat(kline.l), // Low
            parseFloat(kline.c), // Close
            parseFloat(kline.v), // Volume
            kline.T, // Close time
            parseFloat(kline.q), // Quote asset volume
            kline.n, // Number of trades
            parseFloat(kline.v), // Taker buy base asset volume
            parseFloat(kline.q), // Taker buy quote asset volume
            kline.x ? 1 : 0, // Ignore
          ];

          const klines = this.klineCache.get(symbol);

          // Update last kline or add new one
          if (klines.length > 0 && klines[klines.length - 1][0] === kline.t) {
            klines[klines.length - 1] = klineArray;
          } else {
            klines.push(klineArray);
            // Keep only last 200 klines
            if (klines.length > 200) {
              klines.shift();
            }
          }

          logger.debug('Kline updated', { symbol, timestamp: kline.t, close: kline.c });
        }
      });

      // Subscribe to ticker for price updates
      this.ws.subscribeTicker(symbols, (data) => {
        if (data.e === '24hrTicker') {
          this.tickerCache.set(data.s, data);
          logger.debug('Ticker updated', { symbol: data.s, price: data.c });
        }
      });

      // Subscribe to book ticker for best bid/ask
      this.ws.subscribeBookTicker(symbols, (data) => {
        this.bookTickerCache.set(data.s, data);
        logger.debug('Book ticker updated', { symbol: data.s, bid: data.b, ask: data.a });
      });

      logger.info('✅ Subscribed to market data streams', {
        symbols,
        streams: ['klines_1h', 'ticker', 'bookTicker'],
      });
    } catch (error) {
      logger.error('Failed to subscribe to market data', { error: error.message });
    }
  }

  async subscribeToUserData() {
    try {
      const { listenKey } = await this.api.startUserDataStream();
      logger.info('User data stream created', { listenKey });

      this.ws.connectUserData(listenKey, this.api, async (message) => {
        logger.debug('User data received', { type: message.e });

        // Handle account updates
        if (message.e === 'ACCOUNT_UPDATE') {
          await this.handleAccountUpdate(message.a);
        }

        // Handle order updates
        if (message.e === 'ORDER_TRADE_UPDATE') {
          await this.handleOrderUpdate(message.o);
        }
      });

      logger.info('User data stream connected');
    } catch (error) {
      logger.error('Failed to subscribe to user data', { error: error.message });
    }
  }

  async handleAccountUpdate(accountData) {
    try {
      const balances = accountData.B || [];
      const positions = accountData.P || [];

      // Update account balance
      const totalWalletBalance = parseFloat(accountData?.T?.[0]?.wb) || 0;
      if (totalWalletBalance > 0) {
        this.accountBalance = totalWalletBalance;
        logger.debug('Account balance updated', { balance: this.accountBalance });
      }

      // Update open positions
      for (const pos of positions) {
        const positionSize = parseFloat(pos.ps);
        if (positionSize !== 0) {
          this.openPositions.set(pos.s, {
            symbol: pos.s,
            side: positionSize > 0 ? 'LONG' : 'SHORT',
            size: Math.abs(positionSize),
            entryPrice: parseFloat(pos.ep),
            markPrice: parseFloat(pos.mp || pos.ep), // Add mark price for current valuation
            unrealizedPnL: parseFloat(pos.up),
            percentage: parseFloat(pos.upnl),
          });
        } else {
          this.openPositions.delete(pos.s);
        }
      }

      logger.debug('Positions updated', { count: this.openPositions.size });

      // Create snapshot periodically
      await this.db.createSnapshot({
        balance: this.accountBalance,
        equity: this.accountBalance,
        unrealized_pnl: positions.reduce((sum, p) => sum + parseFloat(p.up), 0),
        open_positions_count: this.openPositions.size,
        total_risk_exposure: 0, // Calculate based on stop losses
      });
    } catch (error) {
      logger.error('Error handling account update', { error: error.message });
    }
  }

  async handleOrderUpdate(orderData) {
    try {
      const orderId = orderData.i;
      const status = orderData.X;

      logger.info('Order update', {
        orderId,
        symbol: orderData.s,
        status,
        filledQty: orderData.z,
        price: orderData.p,
      });

      // Update order in database
      if (this.pendingOrders.has(orderId)) {
        const order = this.pendingOrders.get(orderId);
        order.status = this.mapOrderStatus(status);
        order.filledQuantity = parseFloat(orderData.z);
        order.exchangeStatus = status;

        await this.db.updateOrder(order.order_id, {
          status: order.status,
          filled_quantity: order.filled_quantity,
          exchange_status: order.exchange_status,
          filled_at: order.status === 'FILLED' ? new Date() : null,
        });

        if (order.status === 'FILLED' || order.status === 'CANCELLED') {
          this.pendingOrders.delete(orderId);
        }
      }
    } catch (error) {
      logger.error('Error handling order update', { error: error.message });
    }
  }

  mapOrderStatus(binaneStatus) {
    const statusMap = {
      'NEW': 'PENDING',
      'PARTIALLY_FILLED': 'PARTIALLY_FILLED',
      'FILLED': 'FILLED',
      'CANCELED': 'CANCELLED',
      'REJECTED': 'REJECTED',
      'EXPIRED': 'CANCELLED',
    };
    return statusMap[binaneStatus] || 'PENDING';
  }

  // Trading methods
  async calculateTradeParams(symbol, side, entryPrice, stopLoss, riskPercent = 1) {
    try {
      // Validate risk percent
      if (riskPercent > this.config.risk.maxPositionSizePercent) {
        throw new Error(`Risk percent ${riskPercent}% exceeds maximum ${this.config.risk.maxPositionSizePercent}%`);
      }

      // Get exchange info for tick size
      const exchangeInfo = await this.api.getExchangeInfo(symbol);
      const tickSize = parseFloat(exchangeInfo.symbols[0].filters.find(f => f.filterType === 'PRICE_FILTER').tickSize);

      // Calculate position size
      const positionResult = this.riskCalculator.calculatePositionSize(
        this.accountBalance,
        riskPercent,
        entryPrice,
        stopLoss,
        tickSize
      );

      if (!positionResult.valid) {
        throw new Error('Calculated position size exceeds risk limits');
      }

      // Calculate take profit
      const takeProfit = this.riskCalculator.calculateTakeProfit(
        entryPrice,
        stopLoss,
        this.config.trading.defaultRiskRewardRatio,
        side,
        tickSize
      );

      // Validate risk-reward ratio
      const rrResult = this.riskCalculator.validateRiskReward(
        entryPrice,
        stopLoss,
        takeProfit,
        this.config.trading.minRiskRewardRatio
      );

      if (!rrResult.valid) {
        throw new Error(`Risk-reward ratio ${rrResult.actualRatio.toFixed(2)} is below minimum ${this.config.trading.minRiskRewardRatio}`);
      }

      return {
        ...positionResult,
        takeProfit,
        riskRewardRatio: rrResult.actualRatio,
      };
    } catch (error) {
      logger.error('Failed to calculate trade params', { error: error.message });
      throw error;
    }
  }

  async executeTrade(symbol, side, entryPrice, stopLoss, riskPercent = 1, strategy = 'Manual') {
    try {
      if (!this.tradingEnabled) {
        throw new Error('Trading is disabled');
      }

      if (this.isKillSwitchActive()) {
        throw new Error('Kill switch is active');
      }

      // Calculate trade parameters
      const params = await this.calculateTradeParams(symbol, side, entryPrice, stopLoss, riskPercent);

      // Check position correlation
      const openTrades = await this.db.getOpenTrades();
      const correlationCheck = this.riskCalculator.checkPositionCorrelation(
        openTrades,
        symbol,
        this.config.trading.maxCorrelatedPositions
      );

      if (!correlationCheck.allowed) {
        throw new Error(`Cannot open position: too many correlated positions (${correlationCheck.correlatedCount}/${correlationCheck.maxCorrelated})`);
      }

      // Create trade record
      const { v4: uuidv4 } = require('uuid');
      const tradeId = uuidv4();
      const trade = await this.db.createTrade({
        trade_id: tradeId,
        symbol,
        side,
        entry_price: entryPrice,
        quantity: params.positionSize,
        stop_loss: stopLoss,
        take_profit: params.takeProfit,
        risk_amount: params.riskAmount,
        risk_percent: params.riskPercent,
        strategy,
      });

      logger.info('Trade record created', { tradeId, symbol, side });

      // Execute order (if not paper trading)
      if (!this.paperTrading) {
        // Set leverage
        await this.api.changeLeverage(symbol, this.config.trading.leverage);

        // Place market order
        const orderSide = side === 'LONG' ? 'BUY' : 'SELL';
        const order = await this.api.createMarketOrder(symbol, orderSide, params.positionSize);

        // Create order record
        const { v4: uuidv4 } = require('uuid');
        const orderId = uuidv4();
        await this.db.createOrder({
          order_id: orderId,
          trade_id: tradeId,
          exchange_order_id: order.orderId.toString(),
          symbol,
          side: orderSide,
          order_type: 'MARKET',
          quantity: params.positionSize,
          status: 'FILLED',
          filled_quantity: params.positionSize,
        });

        // Place stop loss order
        const stopLossSide = side === 'LONG' ? 'SELL' : 'BUY';
        const slOrder = await this.api.createStopLossOrder(symbol, stopLossSide, params.positionSize, stopLoss);

        // Place take profit order
        const tpSide = side === 'LONG' ? 'SELL' : 'BUY';
        const tpOrder = await this.api.createTakeProfitOrder(symbol, tpSide, params.positionSize, params.takeProfit);

        logger.info('Orders placed', {
          marketOrder: order.orderId,
          stopLoss: slOrder.orderId,
          takeProfit: tpOrder.orderId,
        });

        await this.telegram.sendOrderConfirmation(order);
      }

      // Send alert
      await this.telegram.sendTradeEntry(trade);

      logger.info('Trade executed successfully', { tradeId, symbol, side, quantity: params.positionSize });

      return trade;
    } catch (error) {
      logger.error('Failed to execute trade', { error: error.message, stack: error.stack });
      await this.telegram.sendErrorAlert(`Trade execution failed: ${error.message}`);
      throw error;
    }
  }

  async isKillSwitchActive() {
    const killSwitch = await this.db.getKillSwitch();
    return killSwitch?.activated || false;
  }

  async startAutoTrader() {
    try {
      logger.info('🤖 Starting Auto Trader');
      const started = await this.autoTrader.start();

      if (started) {
        await this.telegram.sendAlert('Auto Trading', 'Auto-trading has been started!', 'INFO');
        logger.info('✅ Auto Trader started');
      }

      return started;
    } catch (error) {
      logger.error('Failed to start auto trader', { error: error.message });
      await this.telegram.sendErrorAlert(`Failed to start auto trader: ${error.message}`);
      throw error;
    }
  }

  async stopAutoTrader() {
    try {
      logger.info('🛑 Stopping Auto Trader');
      const stopped = await this.autoTrader.stop();

      if (stopped) {
        await this.telegram.sendAlert('Auto Trading', 'Auto-trading has been stopped.', 'INFO');
        logger.info('✅ Auto Trader stopped');
      }

      return stopped;
    } catch (error) {
      logger.error('Failed to stop auto trader', { error: error.message });
      throw error;
    }
  }

  async getAutoTraderStats() {
    return this.autoTrader.getStats();
  }

  // Symbol Scanner methods
  async getLatestScan() {
    return await this.symbolScanner.getLatestScan();
  }

  async getTop20Symbols() {
    return await this.symbolScanner.getTop20();
  }

  async getSymbolData(symbol) {
    return await this.symbolScanner.getSymbolData(symbol);
  }

  async runSymbolScan() {
    return await this.symbolScanner.scanSymbols();
  }

  async activateKillSwitch(reason) {
    try {
      const killSwitch = await this.db.activateKillSwitch(reason, 'Sebas');
      this.tradingEnabled = false;

      logger.error('Kill switch activated', { reason });

      await this.telegram.sendKillSwitchActivated(reason);

      return killSwitch;
    } catch (error) {
      logger.error('Failed to activate kill switch', { error: error.message });
      throw error;
    }
  }

  async deactivateKillSwitch() {
    try {
      const killSwitch = await this.db.deactivateKillSwitch('Sebas');
      this.tradingEnabled = this.config.trading.enabled;

      logger.info('Kill switch deactivated');

      await this.telegram.sendAlert('Kill Switch', 'Kill switch has been deactivated. Trading can resume.', 'INFO');

      return killSwitch;
    } catch (error) {
      logger.error('Failed to deactivate kill switch', { error: error.message });
      throw error;
    }
  }

  // Get cached klines or fallback to REST API
  async getKlines(symbol, interval = '1h', limit = 200) {
    try {
      // Try to get from cache first
      if (this.klineCache.has(symbol)) {
        const cachedKlines = this.klineCache.get(symbol);

        if (cachedKlines.length >= limit) {
          logger.debug('Using cached klines', { symbol, count: cachedKlines.length });
          return cachedKlines.slice(-limit);
        } else {
          logger.debug('Cache has insufficient klines, falling back to API', {
            symbol,
            cached: cachedKlines.length,
            required: limit,
          });
        }
      }

      // Fallback to REST API
      logger.debug('Fetching klines from REST API', { symbol, interval, limit });
      const klines = await this.api.getKlines(symbol, interval, limit);

      // Update cache
      this.klineCache.set(symbol, klines);

      return klines;
    } catch (error) {
      logger.error('Failed to get klines', { symbol, error: error.message });
      throw error;
    }
  }

  // Get cached ticker or fallback to REST API
  async getTicker(symbol) {
    try {
      // Try to get from cache first
      if (this.tickerCache.has(symbol)) {
        const ticker = this.tickerCache.get(symbol);
        logger.debug('Using cached ticker', { symbol, price: ticker.c });
        return ticker;
      }

      // Fallback to REST API
      logger.debug('Fetching ticker from REST API', { symbol });
      const ticker = await this.api.getTickerPrice(symbol);

      // Update cache
      this.tickerCache.set(symbol, { s: symbol, c: ticker.price, ...ticker });

      return { s: symbol, c: ticker.price, ...ticker };
    } catch (error) {
      logger.error('Failed to get ticker', { symbol, error: error.message });
      throw error;
    }
  }

  // Get cached book ticker or fallback to REST API
  async getBookTicker(symbol) {
    try {
      // Try to get from cache first
      if (this.bookTickerCache.has(symbol)) {
        const bookTicker = this.bookTickerCache.get(symbol);
        logger.debug('Using cached book ticker', { symbol, bid: bookTicker.b, ask: bookTicker.a });
        return bookTicker;
      }

      // Fallback to REST API
      logger.debug('Fetching book ticker from REST API', { symbol });
      const bookTicker = await this.api.getBookTicker(symbol);

      // Update cache
      this.bookTickerCache.set(symbol, bookTicker);

      return bookTicker;
    } catch (error) {
      logger.error('Failed to get book ticker', { symbol, error: error.message });
      throw error;
    }
  }

  // Subscribe to symbols' market data
  async subscribeToSymbols(symbols) {
    if (!symbols || symbols.length === 0) {
      logger.warn('No symbols to subscribe to');
      return;
    }

    // Disconnect existing connections for old symbols
    this.ws.disconnectAll();

    // Subscribe to new symbols
    await this.subscribeToMarketData(symbols);

    // Clear caches for old symbols
    const newSymbolSet = new Set(symbols);
    for (const symbol of this.klineCache.keys()) {
      if (!newSymbolSet.has(symbol)) {
        this.klineCache.delete(symbol);
        this.tickerCache.delete(symbol);
        this.bookTickerCache.delete(symbol);
      }
    }

    logger.info('Subscribed to symbols', {
      symbols,
      klineCacheSize: this.klineCache.size,
      tickerCacheSize: this.tickerCache.size,
      bookTickerCacheSize: this.bookTickerCache.size,
    });
  }
}

// Main execution
async function main() {
  console.log('main: Starting');
  const bot = new TradingBot();
  console.log('main: Bot created');

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Received SIGINT, shutting down...');
    await bot.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down...');
    await bot.stop();
    process.exit(0);
  });

  // Start the bot
  console.log('main: Calling bot.start()');
  const started = await bot.start();
  console.log('main: bot.start() returned:', started);

  if (!started) {
    logger.error('Failed to start bot');
    process.exit(1);
  }

  // Keep the process running
  console.log('main: About to keep process running');
  logger.info('Bot is running. Press Ctrl+C to stop.');

  // Keep the process alive - this promise never resolves
  console.log('main: Waiting forever...');
  return new Promise(() => {});
}

// Export for use in other modules
module.exports = { TradingBot };

// Run if executed directly
if (require.main === module) {
  main().catch((error) => {
    logger.error('Fatal error', { error: error.message, stack: error.stack });
    process.exit(1);
  });
}
