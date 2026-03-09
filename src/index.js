require('dotenv').config();
const logger = require('./utils/logger');
const { config, validateConfig } = require('./config');
const BinanceFuturesAPI = require('./api/binance');
const BinanceWebSocketClient = require('./api/binance-ws');
const RiskCalculator = require('./risk/calculator');
const { getDatabase } = require('./storage/db');
const { getRedis } = require('./storage/redis');
const TelegramAlerts = require('./alerts/telegram');
const AutoTrader = require('./trading/auto-trader');
const SymbolScanner = require('./utils/symbol-scanner');

class TradingBot {
  constructor() {
    this.config = config;
    this.isRunning = false;
    this.paperTrading = config.trading.paperTrading;
    this.tradingEnabled = config.trading.enabled;

    // Initialize components
    this.api = new BinanceFuturesAPI();
    this.ws = new BinanceWebSocketClient();
    this.riskCalculator = new RiskCalculator();
    this.db = getDatabase();
    this.redis = getRedis();
    this.telegram = new TelegramAlerts();

    // State
    this.accountBalance = 0;
    this.openPositions = new Map();
    this.pendingOrders = new Map();

    // Symbol Scanner
    this.symbolScanner = new SymbolScanner(this.redis, this.telegram);

    // Auto-trading
    this.autoTrader = new AutoTrader({
      api: this.api,
      riskCalculator: this.riskCalculator,
      db: this.db,
      telegram: this.telegram,
      paperTrading: this.paperTrading,
      tradingEnabled: this.tradingEnabled,
      scanInterval: 60000, // 1 minute
      symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'],
    });
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

      // Start symbol scanner (runs every 5 minutes)
      this.symbolScanner.start(5);
      logger.info('✅ Symbol scanner started (interval: 5 minutes)');

      // Auto-trading needs to be started manually via startAutoTrader()
      logger.info('Auto-trading ready (call startAutoTrader() to begin)');

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
      if (this.autoTrader.isRunning()) {
        await this.autoTrader.stop();
      }

      // Close WebSocket connections
      this.ws.disconnectAll();

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
      this.ws.subscribeMiniTicker(symbols, (data) => {
        logger.debug('Mini ticker update', { symbol: data.s, price: data.c });
        // Process ticker data for signals
      });

      logger.info('Subscribed to market data', { symbols });
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
}

// Main execution
async function main() {
  const bot = new TradingBot();

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
  const started = await bot.start();

  if (!started) {
    logger.error('Failed to start bot');
    process.exit(1);
  }

  // Keep the process running
  logger.info('Bot is running. Press Ctrl+C to stop.');
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
