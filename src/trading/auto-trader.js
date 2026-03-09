const logger = require('../utils/logger');
const SignalAggregator = require('../signals/aggregator');
const { getDatabase } = require('../storage/db');
const { getTopSymbols } = require('../utils/symbol-scanner');
const NewsChecker = require('../utils/news-checker');
const { 
  SURVIVAL_CONFIG,
  getCurrentTier, 
  calculateRunway, 
  getMonthlyTarget, 
  isEmergencyMode,
  shouldActivateKillSwitch 
} = require('../config-survival');

/**
 * Auto Trader
 * Automatically scans market and executes trades based on signals
 */
class AutoTrader {
  constructor(config = {}) {
    this.config = config;
    this.db = getDatabase();
    this.api = config.api;
    this.riskCalculator = config.riskCalculator;
    this.paperTrading = config.paperTrading || false;
    this.tradingEnabled = config.tradingEnabled || false;

    // Survival tracking
    this.currentTier = null;
    this.consecutiveLosses = 0;
    this.monthlyPnL = 0;
    this.monthStartBalance = 0;
    this.emergencyMode = false;

    // Initialize with current balance
    this.updateTier(config.api.accountBalance || 60);

    // Initialize signal aggregator with tier-specific config + multi-confirmation support
    this.signalAggregator = new SignalAggregator({
      minConfidence: this.currentTier.minConfidence,
      minConfluence: this.currentTier.minRiskReward,
      maxPositions: this.currentTier.maxPositions,
      requiredAgreement: 0.67, // 2 out of 3 strategies must agree
      useMultiConfirmation: config.useMultiConfirmation !== false, // Enabled by default
      binanceAPI: config.api, // Pass API for derivatives data
      redisClient: config.redisClient, // Pass Redis for caching
    });

    // Initialize news checker for safety
    this.newsChecker = new NewsChecker({
      enabled: config.newsCheckEnabled !== false, // Enabled by default
      checkInterval: 1* 60 * 1000, // 15 minutes
      redisClient: config.redisClient, // Pass Redis for caching
    });

    // State
    // State
    this.isRunning = false;
    this.scanInterval = this.currentTier.scanInterval;
    this.symbols = []; // Will be populated by scanner
    this.openTrades = new Map();
    this.tradeCount = 0;
    this.lastScanTime = null;
    this.symbolScanner = config.symbolScanner; // Reference to scanner

    logger.info('🔥 SURVIVAL MODE Auto Trader initialized', {
      tier: this.currentTier.name,
      riskPerTrade: this.currentTier.riskPerTrade + '%',
      maxPositions: this.currentTier.maxPositions,
      minConfidence: (this.currentTier.minConfidence * 100) + '%',
      targetMonthly: this.currentTier.targetMonthly + '%',
      symbols: this.symbols,
      scanInterval: this.scanInterval / 1000 + 's',
      paperTrading: this.paperTrading,
      tradingEnabled: this.tradingEnabled,
      newsCheckEnabled: this.newsChecker.enabled,
    });
  }

  /**
   * Update tier based on current balance
   */
  updateTier(balance) {
    const newTier = getCurrentTier(balance);
    const oldTierName = this.currentTier?.name;
    
    if (!this.currentTier || newTier.name !== this.currentTier.name) {
      this.currentTier = newTier;
      this.scanInterval = newTier.scanInterval;
      this.symbols = newTier.symbols || this.symbols;
      
      // Update signal aggregator config
      if (this.signalAggregator) {
        this.signalAggregator.minConfidence = newTier.minConfidence;
        this.signalAggregator.minConfluence = newTier.minRiskReward;
        this.signalAggregator.maxPositions = newTier.maxPositions;
      }
      
      const runway = calculateRunway(balance);
      const monthlyTarget = getMonthlyTarget(balance);
      
      logger.info('🎯 Tier transition', {
        from: oldTierName || 'INIT',
        to: newTier.name,
        balance: balance.toFixed(2),
        runway: runway.toFixed(1) + ' months',
        monthlyTarget: '$' + monthlyTarget.toFixed(2),
        status: newTier.status,
      });
    }
    
    // Check emergency mode
    const drawdown = this.calculateDrawdown(balance);
    this.emergencyMode = isEmergencyMode(balance, drawdown);
    
    if (this.emergencyMode) {
      logger.warn('⚠️ EMERGENCY MODE ACTIVATED', {
        balance: balance.toFixed(2),
        drawdown: drawdown.toFixed(2) + '%',
        reason: balance < SURVIVAL_CONFIG.emergencyCapital ? 'Low capital' : 'High drawdown',
      });
    }
  }

  /**
   * Calculate current drawdown
   */
  calculateDrawdown(currentBalance) {
    if (!this.monthStartBalance || this.monthStartBalance === 0) {
      return 0;
    }
    const peak = Math.max(this.monthStartBalance, currentBalance);
    return ((peak - currentBalance) / peak) * 100;
  }

  /**
   * Start auto trading with integrated scanning
   */
  async start() {
    if (this.isRunning) {
      logger.warn('Auto Trader already running');
      return false;
    }

    this.isRunning = true;
    logger.info('🚀 Starting Auto Trader with integrated scanning');

    // Load existing open trades
    await this.loadOpenTrades();

    // Start the main loop
    this.mainLoop();

    return true;
  }

  /**
   * Stop auto trading
   */
  async stop() {
    if (!this.isRunning) {
      logger.warn('Auto Trader not running');
      return false;
    }

    this.isRunning = false;
    logger.info('🛑 Stopping Auto Trader');

    return true;
  }

  /**
   * Main loop - scan then analyze continuously
   */
  async mainLoop() {
    while (this.isRunning) {
      try {
        logger.info('\n🔄 ========== Starting new cycle ==========');
        
        // 1. Scan symbols
        logger.info('📡 Step 1: Scanning symbols...');
        const scanResults = await this.symbolScanner.scanSymbols();
        
        if (!scanResults || scanResults.length === 0) {
          logger.warn('No scan results, waiting 10s before retry...');
          await this.sleep(10000);
          continue;
        }
        
        // 2. Update symbols from scan (top 10)
        const top10 = scanResults.slice(0, 10);
        this.symbols = top10.map(r => r.symbol);
        logger.info(`✅ Symbols updated: ${this.symbols.join(', ')}`);
        
        // 3. Send Telegram notification for top 5 (only if we have open trades)
        const openTrades = await this.db.getOpenTrades();
        if (openTrades.length > 0) {
          logger.info('📱 Step 2: Sending Telegram notification (have open trades)...');
          await this.sendTopOpportunitiesNotification(top10.slice(0, 5)).catch(err => {
            logger.error('Failed to send Telegram notification', { error: err.message });
          });
        } else {
          logger.info('⏭️  Step 2: Skipping Telegram notification (no open trades)');
        }
        
        // 4. Analyze symbols
        logger.info('🔍 Step 3: Analyzing symbols...');
        await this.scan();
        await this.manageOpenTrades();
        
        logger.info('✅ Cycle complete\n');
        
      } catch (error) {
        logger.error('Main loop error', { error: error.message, stack: error.stack });
        await this.sleep(10000); // Wait 10s on error
      }
    }
    
    logger.info('Main loop stopped');
  }

  /**
   * Scan all symbols for trading opportunities
   */
  async scan() {
    try {
      // Skip scan if no symbols available yet
      if (this.symbols.length === 0) {
        logger.debug('No symbols available yet, skipping scan');
        return;
      }

      this.lastScanTime = Date.now();

      logger.info('🔍 Scanning market', {
        symbols: this.symbols.length,
        symbolList: this.symbols.join(', '),
        timestamp: new Date(this.lastScanTime).toISOString(),
      });

      // Get open positions from database
      const openTrades = await this.db.getOpenTrades();

      // SEQUENTIAL SCAN with delay to avoid rate limits
      for (const symbol of this.symbols) {
        try {
          await this.scanSymbol(symbol, openTrades);
          // Small delay between symbols to avoid rate limits (200ms)
          await this.sleep(200);
        } catch (error) {
          logger.error('Symbol scan error', { symbol, error: error.message });
        }
      }

      logger.info('✅ Scan complete', {
        timestamp: new Date().toISOString(),
      });

    } catch (error) {
      logger.error('Scan loop error', { error: error.message, stack: error.stack });
    }
  }

  /**
   * Scan a single symbol
   */
  async scanSymbol(symbol, openTrades) {
    try {
      // SAFETY CHECK: Check news before analyzing
      const newsSafety = await this.newsChecker.checkTradingSafety(symbol);
      
      if (!newsSafety.safe) {
        logger.warn('⚠️ Trading paused due to news', {
          symbol,
          reason: newsSafety.reason,
          riskLevel: newsSafety.riskLevel,
          sentiment: newsSafety.sentiment,
        });
        return;
      }
      
      // Log if news sentiment is concerning but still tradeable
      if (newsSafety.riskLevel === 'MEDIUM') {
        logger.info('⚠️ Elevated news risk', {
          symbol,
          sentiment: newsSafety.sentiment,
          reason: newsSafety.reason,
        });
      }

      // Get market data
      const marketData = await this.fetchMarketData(symbol);
      if (!marketData) {
        logger.debug('No market data', { symbol });
        return;
      }

      logger.debug(`Market data for ${symbol}: fromCache=${marketData.fromCache}, price=${marketData.currentPrice.toFixed(6)}, klines=${marketData.klines.length}`);

      // Generate signal
      const signal = await this.signalAggregator.analyzeSymbol(symbol, marketData, openTrades);

      if (signal && signal.valid && signal.confidence >= 0.75) {
        // Add news sentiment to signal
        signal.newsSentiment = newsSafety.sentiment;
        signal.newsRiskLevel = newsSafety.riskLevel;
        
        // Execute trade
        await this.executeTrade(signal, openTrades);
      }

    } catch (error) {
      logger.error('Symbol scan error', { symbol, error: error.message });
    }
  }

  /**
   * Fetch market data from Redis (cached by SymbolScanner) or Binance
   */
  async fetchMarketData(symbol) {
      try {
        // Try to get from Redis first (from SymbolScanner)
        const cachedData = await this.getSymbolDataFromRedis(symbol);
        
        if (cachedData && cachedData.klines && cachedData.klines.length >= 50) {
          logger.debug(`Using cached market data for ${symbol} (age: ${this.getCacheAge(cachedData.scannedAt)}s)`);
          
          // Fetch recent trades separately (not cached by scanner)
          const trades = await this.api.getRecentTrades(symbol, 100).catch(() => null);
          
          return {
            symbol,
            klines: cachedData.klines,
            trades: trades || [],
            currentPrice: cachedData.price,
            volume: cachedData.volume,
            quoteVolume: cachedData.volume, // Same as volume for futures
            high: parseFloat(cachedData.ticker?.highPrice || cachedData.price),
            low: parseFloat(cachedData.ticker?.lowPrice || cachedData.price),
            change: cachedData.priceChange,
            fromCache: true,
          };
        }
        
        // Fallback: Fetch from Binance if not in cache
        logger.debug(`Cache miss for ${symbol}, fetching from Binance`);
        
        // PARALLEL: Fetch all market data at once (including trades for CVD)
        const [klines, ticker, ticker24h, trades] = await Promise.all([
          this.api.getKlines(symbol, '1h', 200),
          this.api.getTickerPrice(symbol),
          this.api.get24hrTicker(symbol),
          this.api.getRecentTrades(symbol, 100).catch(() => null) // Graceful fallback
        ]);

        const currentPrice = parseFloat(ticker.price);

        return {
          symbol,
          klines,
          trades: trades || [], // Include trades for CVD calculation
          currentPrice,
          volume: parseFloat(ticker24h.volume),
          quoteVolume: parseFloat(ticker24h.quoteVolume),
          high: parseFloat(ticker24h.highPrice),
          low: parseFloat(ticker24h.lowPrice),
          change: parseFloat(ticker24h.priceChangePercent),
          fromCache: false,
        };

      } catch (error) {
        logger.error('Fetch market data error', { symbol, error: error.message });
        return null;
      }
    }

  /**
   * Get symbol data from Redis (cached by SymbolScanner)
   */
  async getSymbolDataFromRedis(symbol) {
    try {
      const { getRedis } = require('../storage/redis');
      const redis = getRedis();
      return await redis.hget('symbol_scan:symbols', symbol);
    } catch (error) {
      logger.debug('Failed to get symbol from Redis', { symbol, error: error.message });
      return null;
    }
  }

  /**
   * Calculate cache age in seconds
   */
  getCacheAge(scannedAt) {
    if (!scannedAt) return 999;
    const age = (Date.now() - new Date(scannedAt).getTime()) / 1000;
    return Math.floor(age);
  }

  /**
   * Execute a trade
   */
  async executeTrade(signal, openTrades) {
    try {
      if (!this.tradingEnabled) {
        logger.info('Trading disabled, skipping trade', { symbol: signal.symbol });
        return;
      }

      // Get account balance
      let accountBalance;
      if (this.paperTrading) {
        accountBalance = this.api.accountBalance || 60.00;
      } else {
        accountBalance = await this.api.getTotalWalletBalance();
      }

      // Update tier based on current balance
      this.updateTier(accountBalance);

      // Check emergency mode
      if (this.emergencyMode) {
        logger.warn('Emergency mode active, using ultra-conservative parameters');
        // In emergency mode, only trade if confidence is very high
        if (signal.confidence < 0.90) {
          logger.info('Signal confidence too low for emergency mode', {
            symbol: signal.symbol,
            confidence: signal.confidence,
            required: 0.90,
          });
          return;
        }
      }

      // Check kill switch
      const drawdown = this.calculateDrawdown(accountBalance);
      if (shouldActivateKillSwitch(accountBalance, drawdown, this.consecutiveLosses)) {
        logger.error('🚨 KILL SWITCH TRIGGERED', {
          balance: accountBalance.toFixed(2),
          drawdown: drawdown.toFixed(2) + '%',
          consecutiveLosses: this.consecutiveLosses,
        });
        await this.db.activateKillSwitch('Survival thresholds breached');
        return;
      }

      const killSwitch = await this.db.getKillSwitch();
      if (killSwitch?.activated) {
        logger.warn('Kill switch active, skipping trade');
        return;
      }

      // Calculate position size using tier-specific risk
      const tickSize = 0.01;
      const riskPercent = this.emergencyMode ? 0.5 : this.currentTier.riskPerTrade;

      // Calculate position size WITH FEES (critical for survival!)
      const positionResult = this.riskCalculator.calculatePositionSizeWithFees(
        accountBalance,
        riskPercent,
        signal.entryPrice,
        signal.stopLoss,
        tickSize,
        5, // leverage
        24 // expected holding time in hours
      );

      if (!positionResult.valid) {
        logger.warn('Position size exceeds risk limits', { symbol: signal.symbol });
        return;
      }

      // Create trade record
      const { v4: uuidv4 } = require('uuid');
      const tradeId = uuidv4();

      const trade = await this.db.createTrade({
        trade_id: tradeId,
        symbol: signal.symbol,
        side: signal.side,
        entry_price: signal.entryPrice,
        quantity: positionResult.positionSize,
        stop_loss: signal.stopLoss,
        take_profit: signal.takeProfit,
        risk_amount: positionResult.riskAmount,
        risk_percent: positionResult.riskPercent,
        strategy: `Auto-Trading-${this.currentTier.name}`,
        notes: JSON.stringify({
          ...signal,
          tier: this.currentTier.name,
          emergencyMode: this.emergencyMode,
        }),
      });

      logger.info('🎯 Trade executed', {
        tradeId,
        symbol: signal.symbol,
        side: signal.side,
        tier: this.currentTier.name,
        entryPrice: signal.entryPrice,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        quantity: positionResult.positionSize,
        riskAmount: positionResult.riskAmount.toFixed(2),
        riskPercent: riskPercent + '%',
        confidence: (signal.confidence * 100).toFixed(1) + '%',
        paperTrading: this.paperTrading,
        emergencyMode: this.emergencyMode,
      });

      if (this.paperTrading) {
        await this.executePaperOrders(trade, positionResult);
      } else {
        await this.executeBinanceOrders(trade, positionResult);
      }

      this.tradeCount++;
      this.openTrades.set(tradeId, trade);

    } catch (error) {
      logger.error('Execute trade error', {
        symbol: signal.symbol,
        error: error.message,
        stack: error.stack,
      });
    }
  }

  /**
   * Execute orders on Binance
   */
  async executeBinanceOrders(trade, positionResult) {
    try {
      // Set leverage
      await this.api.changeLeverage(trade.symbol, 3); // 3x leverage

      // Place market order
      const orderSide = trade.side === 'LONG' ? 'BUY' : 'SELL';
      const marketOrder = await this.api.createMarketOrder(trade.symbol, orderSide, positionResult.positionSize);

      // Create order record
      const { v4: uuidv4 } = require('uuid');
      const orderId = uuidv4();

      await this.db.createOrder({
        order_id: orderId,
        trade_id: trade.trade_id,
        exchange_order_id: marketOrder.orderId.toString(),
        symbol: trade.symbol,
        side: orderSide,
        order_type: 'MARKET',
        quantity: positionResult.positionSize,
        status: 'FILLED',
        filled_quantity: positionResult.positionSize,
      });

      // Place stop loss order
      const stopLossSide = trade.side === 'LONG' ? 'SELL' : 'BUY';
      const slOrder = await this.api.createStopLossOrder(trade.symbol, stopLossSide, positionResult.positionSize, trade.stop_loss);

      // Place take profit order
      const takeProfitSide = trade.side === 'LONG' ? 'SELL' : 'BUY';
      const tpOrder = await this.api.createTakeProfitOrder(trade.symbol, takeProfitSide, positionResult.positionSize, trade.take_profit);

      logger.info('✅ Orders placed on Binance', {
        marketOrderId: marketOrder.orderId,
        stopLossOrderId: slOrder.orderId,
        takeProfitOrderId: tpOrder.orderId,
      });

    } catch (error) {
      logger.error('Execute Binance orders error', {
        symbol: trade.symbol,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Execute orders in paper trading mode
   */
  async executePaperOrders(trade, positionResult) {
    try {
      // Simulate order execution
      const { v4: uuidv4 } = require('uuid');

      // Create simulated market order
      const marketOrderId = uuidv4();
      await this.db.createOrder({
        order_id: marketOrderId,
        trade_id: trade.trade_id,
        exchange_order_id: 'PAPER-' + marketOrderId,
        symbol: trade.symbol,
        side: trade.side === 'LONG' ? 'BUY' : 'SELL',
        order_type: 'MARKET',
        quantity: positionResult.positionSize,
        status: 'FILLED',
        filled_quantity: positionResult.positionSize,
        created_at: new Date(),
        updated_at: new Date(),
        filled_at: new Date(),
      });

      // Create simulated stop loss order
      const slOrderId = uuidv4();
      await this.db.createOrder({
        order_id: slOrderId,
        trade_id: trade.trade_id,
        exchange_order_id: 'PAPER-SL-' + slOrderId,
        symbol: trade.symbol,
        side: trade.side === 'LONG' ? 'SELL' : 'BUY',
        order_type: 'STOP_MARKET',
        quantity: positionResult.positionSize,
        price: trade.stop_loss,
        status: 'OPEN',
        created_at: new Date(),
        updated_at: new Date(),
      });

      // Create simulated take profit order
      const tpOrderId = uuidv4();
      await this.db.createOrder({
        order_id: tpOrderId,
        trade_id: trade.trade_id,
        exchange_order_id: 'PAPER-TP-' + tpOrderId,
        symbol: trade.symbol,
        side: trade.side === 'LONG' ? 'SELL' : 'BUY',
        order_type: 'TAKE_PROFIT_MARKET',
        quantity: positionResult.positionSize,
        price: trade.take_profit,
        status: 'OPEN',
        created_at: new Date(),
        updated_at: new Date(),
      });

      logger.info('📝 Paper orders simulated', {
        marketOrderId,
        stopLossOrderId: slOrderId,
        takeProfitOrderId: tpOrderId,
      });

    } catch (error) {
      logger.error('Execute paper orders error', {
        symbol: trade.symbol,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Manage open trades
   */
  async manageOpenTrades() {
      try {
        const openTrades = await this.db.getOpenTrades();

        // PARALLEL: Check all trades at once
        const checkPromises = openTrades.map(trade =>
          this.checkTradeStatus(trade).catch(error => {
            logger.error('Manage trade error', {
              tradeId: trade.trade_id,
              error: error.message,
            });
            return null;
          })
        );

        await Promise.all(checkPromises);

      } catch (error) {
        logger.error('Manage open trades error', { error: error.message });
      }
    }

  /**
   * Check trade status
   */
  async checkTradeStatus(trade) {
    try {
      // Get current price
      const ticker = await this.api.getTickerPrice(trade.symbol);
      const currentPrice = parseFloat(ticker.price);

      // Check if stop loss or take profit hit
      let shouldClose = false;
      let exitReason = '';

      if (trade.side === 'LONG') {
        if (currentPrice <= trade.stop_loss) {
          shouldClose = true;
          exitReason = 'Stop Loss';
        } else if (currentPrice >= trade.take_profit) {
          shouldClose = true;
          exitReason = 'Take Profit';
        }
      } else {
        if (currentPrice >= trade.stop_loss) {
          shouldClose = true;
          exitReason = 'Stop Loss';
        } else if (currentPrice <= trade.take_profit) {
          shouldClose = true;
          exitReason = 'Take Profit';
        }
      }

      if (shouldClose) {
        await this.closeTrade(trade, currentPrice, exitReason);
      }

    } catch (error) {
      logger.error('Check trade status error', {
        tradeId: trade.trade_id,
        error: error.message,
      });
    }
  }

  /**
   * Close a trade
   */
  async closeTrade(trade, exitPrice, reason) {
    try {
      // Calculate profit/loss
      const priceDifference = trade.side === 'LONG'
        ? exitPrice - trade.entry_price
        : trade.entry_price - exitPrice;

      const profitLoss = priceDifference * trade.quantity;
      const profitLossPercent = (profitLoss / (trade.entry_price * trade.quantity)) * 100;

      // Update consecutive losses counter
      if (profitLoss < 0) {
        this.consecutiveLosses++;
      } else {
        this.consecutiveLosses = 0; // Reset on win
      }

      // Update monthly P/L
      this.monthlyPnL += profitLoss;

      // Update trade record
      const durationSeconds = Math.floor((Date.now() - new Date(trade.entry_time).getTime()) / 1000);

      await this.db.updateTrade(trade.trade_id, {
        exit_price: exitPrice,
        profit_loss: profitLoss,
        profit_loss_percent: profitLossPercent,
        status: 'CLOSED',
        exit_time: new Date(),
        duration_seconds: durationSeconds,
        notes: `${reason} - ${trade.notes || ''}`,
      });

      // Update account balance and create snapshot
      if (this.paperTrading) {
        // Paper trading: update local balance
        this.api.accountBalance += profitLoss;

        // Update tier after balance change
        this.updateTier(this.api.accountBalance);

        await this.db.createSnapshot({
          balance: this.api.accountBalance,
          equity: this.api.accountBalance,
          unrealized_pnl: 0,
          open_positions_count: this.openTrades.size - 1,
          total_risk_exposure: 0,
        });
      } else {
        // Live trading: get real balance from Binance
        try {
          const balance = await this.api.getTotalWalletBalance();
          const unrealizedPnL = await this.api.getUnrealizedPnL();
          const positions = await this.api.getPositions();
          
          // Update tier after balance change
          this.updateTier(balance);
          
          await this.db.createSnapshot({
            balance: balance,
            equity: balance + unrealizedPnL,
            unrealized_pnl: unrealizedPnL,
            open_positions_count: positions.filter(p => parseFloat(p.positionAmt) !== 0).length,
            total_risk_exposure: 0,
          });
          
          logger.info('Account snapshot created', {
            balance: balance.toFixed(2),
            equity: (balance + unrealizedPnL).toFixed(2),
            unrealizedPnL: unrealizedPnL.toFixed(2),
          });
        } catch (error) {
          logger.error('Failed to create account snapshot', { error: error.message });
        }
      }

      const currentBalance = this.paperTrading ? this.api.accountBalance : await this.api.getTotalWalletBalance();
      const runway = calculateRunway(currentBalance);
      const monthlyTarget = getMonthlyTarget(currentBalance);
      const monthlyProgress = (this.monthlyPnL / monthlyTarget) * 100;

      logger.info('🔄 Trade closed', {
        tradeId: trade.trade_id,
        symbol: trade.symbol,
        tier: this.currentTier.name,
        exitPrice,
        reason,
        profitLoss: profitLoss.toFixed(2),
        profitLossPercent: profitLossPercent.toFixed(2),
        duration: `${Math.floor(durationSeconds / 3600)}h ${Math.floor((durationSeconds % 3600) / 60)}m`,
        consecutiveLosses: this.consecutiveLosses,
        monthlyPnL: this.monthlyPnL.toFixed(2),
        monthlyTarget: monthlyTarget.toFixed(2),
        monthlyProgress: monthlyProgress.toFixed(1) + '%',
        runway: runway.toFixed(1) + ' months',
        newBalance: currentBalance.toFixed(2),
        paperTrading: this.paperTrading,
      });

      // Remove from open trades
      this.openTrades.delete(trade.trade_id);

    } catch (error) {
      logger.error('Close trade error', {
        tradeId: trade.trade_id,
        error: error.message,
      });
    }
  }

  /**
   * Load existing open trades
   */
  async loadOpenTrades() {
    try {
      const openTrades = await this.db.getOpenTrades();

      for (const trade of openTrades) {
        this.openTrades.set(trade.trade_id, trade);
      }

      logger.info('Loaded open trades', { count: openTrades.length });

    } catch (error) {
      logger.error('Load open trades error', { error: error.message });
    }
  }

  /**
   * Get statistics with survival metrics
   */
  getStats() {
    const currentBalance = this.paperTrading ? this.api.accountBalance : 0;
    const runway = calculateRunway(currentBalance);
    const monthlyTarget = getMonthlyTarget(currentBalance);
    const monthlyProgress = monthlyTarget > 0 ? (this.monthlyPnL / monthlyTarget) * 100 : 0;
    const drawdown = this.calculateDrawdown(currentBalance);

    return {
      // Basic stats
      isRunning: this.isRunning,
      scanInterval: this.scanInterval,
      symbols: this.symbols,
      totalTrades: this.tradeCount,
      openTrades: this.openTrades.size,
      lastScanTime: this.lastScanTime,
      paperTrading: this.paperTrading,
      tradingEnabled: this.tradingEnabled,
      
      // Survival metrics
      survival: {
        tier: this.currentTier.name,
        status: this.currentTier.status,
        balance: currentBalance.toFixed(2),
        runway: runway.toFixed(1) + ' months',
        runwayDays: Math.floor(runway * 30),
        monthlyPnL: this.monthlyPnL.toFixed(2),
        monthlyTarget: monthlyTarget.toFixed(2),
        monthlyProgress: monthlyProgress.toFixed(1) + '%',
        drawdown: drawdown.toFixed(2) + '%',
        consecutiveLosses: this.consecutiveLosses,
        emergencyMode: this.emergencyMode,
        serverCost: SURVIVAL_CONFIG.serverCostMonthly,
      },
      
      // Tier config
      tierConfig: {
        riskPerTrade: this.currentTier.riskPerTrade + '%',
        maxPositions: this.currentTier.maxPositions,
        minConfidence: (this.currentTier.minConfidence * 100) + '%',
        minRiskReward: this.currentTier.minRiskReward + ':1',
        targetMonthly: this.currentTier.targetMonthly + '%',
      },
      
      // Strategy stats
      strategyStats: this.signalAggregator.getStrategyStats(),
    };
  }

  /**
   * Sleep utility
   */
  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Update symbols from scan results and trigger immediate analysis
   * Called by SymbolScanner after each scan completes
   */
  async updateSymbolsFromScan(scanResults) {
    try {
      if (!scanResults || scanResults.length === 0) {
        logger.warn('No scan results to update symbols');
        // Notify completion even if no results
        if (this.scanCompleteCallback) {
          this.scanCompleteCallback();
        }
        return;
      }

      // Get top 10 symbols
      const top10 = scanResults.slice(0, 10);
      const newSymbols = top10.map(r => r.symbol);

      const oldSymbols = this.symbols;
      this.symbols = newSymbols;

      logger.info('📊 Symbols updated from scan results', {
        oldSymbols: oldSymbols.length > 0 ? oldSymbols.join(', ') : 'none',
        newSymbols: this.symbols.join(', '),
        top5RSI: top10.slice(0, 5).map(r => `${r.symbol}:${r.rsi.toFixed(2)}`).join(', ')
      });

      // Send Telegram notification for top 5 (non-blocking)
      this.sendTopOpportunitiesNotification(top10.slice(0, 5)).catch(err => {
        logger.error('Failed to send Telegram notification', { error: err.message });
      });

      // Analyze symbols immediately (this is the actual work)
      logger.info('🔍 Starting analysis of top 10 symbols...');
      await this.scan();
      await this.manageOpenTrades();
      logger.info('✅ Analysis complete');

      // Notify SymbolScanner that we're done
      if (this.scanCompleteCallback) {
        logger.debug('Notifying SymbolScanner that analysis is complete');
        this.scanCompleteCallback();
      }

    } catch (error) {
      logger.error('Failed to update symbols from scan', { error: error.message });
      // Always notify completion even on error to avoid deadlock
      if (this.scanCompleteCallback) {
        this.scanCompleteCallback();
      }
    }
  }

  /**
   * Send Telegram notification for top opportunities
   */
  async sendTopOpportunitiesNotification(topResults) {
    try {
      const telegram = this.config.telegram;
      if (!telegram || !telegram.enabled) {
        return;
      }

      let message = `🔍 *Symbol Scanner - Top Opportunities*\n\n`;

      for (let i = 0; i < topResults.length; i++) {
        const r = topResults[i];
        const trendIcon = r.trend === 'UP' ? '🟢' : r.trend === 'DOWN' ? '🔴' : '⚪';

        message += `*${i + 1}. ${r.symbol}*\n`;
        message += `💰 Price: $${r.price.toFixed(r.price < 1 ? 6 : 2)}\n`;
        message += `📈 Change: ${r.priceChange >= 0 ? '+' : ''}${r.priceChange.toFixed(2)}%\n`;
        message += `🌊 Volatility: ${(r.volatility * 100).toFixed(2)}%\n`;
        message += `📊 RSI: ${r.rsi.toFixed(2)}\n`;
        message += `${trendIcon} Trend: ${r.trend}\n`;
        message += `⭐ Score: ${r.profitPotential.toFixed(0)}/100\n\n`;
      }

      message += `_Scan completed at ${new Date().toLocaleTimeString()}_`;

      await telegram.sendAlert('Symbol Scanner', message, 'INFO');
      logger.info('Top opportunities sent to Telegram');

    } catch (error) {
      logger.error('Failed to send notification', { error: error.message });
    }
  }

  /**
   * Sleep utility
   */
  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

}

module.exports = AutoTrader;
