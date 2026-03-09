const BaseStrategy = require('./base-strategy');
const logger = require('../utils/logger');
const IndicatorCalculator = require('./indicator-calculator');
const DerivativesDataFetcher = require('./derivatives-fetcher');
const ConfirmationEngine = require('./confirmation-engine');
const TwoStageTakeProfitManager = require('./two-stage-tp-manager');

/**
 * MultiConfirmationStrategy
 * Advanced strategy requiring 4/5 confirmations to pass
 */
class MultiConfirmationStrategy extends BaseStrategy {
  constructor(config = {}) {
    super({
      name: 'Multi-Confirmation Momentum Swing',
      timeframe: config.timeframe || '1h',
      riskPercent: config.riskPercent || 2.0,
      minRiskRewardRatio: config.minRiskRewardRatio || 2.5,
      maxPositions: config.maxPositions || 2,
      enabled: config.enabled !== false,
    });

    // Initialize components
    this.indicatorCalculator = new IndicatorCalculator();
    this.derivativesFetcher = new DerivativesDataFetcher(
      config.binanceAPI,
      config.redisClient
    );
    this.confirmationEngine = new ConfirmationEngine({
      requiredConfirmations: config.requiredConfirmations || 4,
      binanceAPI: config.binanceAPI
    });
    this.tpManager = new TwoStageTakeProfitManager({
      tp1Ratio: 1.5,
      tp2Ratio: 2.5,
      trailingStopATRMultiplier: 1.0,
      stopLossATRMultiplier: 2.0
    });

    // Configuration
    this.requiredConfirmations = config.requiredConfirmations || 4;
    this.maxLeverage = config.maxLeverage || 3;
    this.useMultiTimeframe = config.useMultiTimeframe || false;
    this.useOrderBookImbalance = config.useOrderBookImbalance || false;
    this.useNewsIntegration = config.useNewsIntegration || true;

    logger.info('Multi-Confirmation Strategy initialized', {
      requiredConfirmations: this.requiredConfirmations,
      maxLeverage: this.maxLeverage,
      useMultiTimeframe: this.useMultiTimeframe,
      useOrderBookImbalance: this.useOrderBookImbalance,
      useNewsIntegration: this.useNewsIntegration
    });
  }

  /**
   * Main analysis method
   */
  async analyze(symbol, marketData) {
    try {
      logger.info(`📊 [Multi-Confirmation] Starting analysis for ${symbol}`);
      
      const { klines } = marketData;

      // Validate market data
      if (!klines || klines.length < 50) {
        logger.debug(`❌ [Multi-Confirmation] ${symbol}: Insufficient market data (${klines?.length} candles)`);
        return null;
      }

      // Calculate all indicators
      logger.info(`🔢 [Multi-Confirmation] ${symbol}: Calculating indicators...`);
      const indicators = await this.indicatorCalculator.calculateAll(symbol, marketData);
      if (!indicators) {
        logger.debug(`❌ [Multi-Confirmation] ${symbol}: Indicator calculation failed`);
        return null;
      }

      logger.info(`📈 [Multi-Confirmation] ${symbol}: Indicators - Price=${indicators.currentPrice.toFixed(6)}, EMA20=${indicators.ema20.toFixed(6)}, EMA50=${indicators.ema50.toFixed(6)}, RSI=${indicators.rsi.toFixed(2)}`);

      // Fetch derivatives data
      logger.info(`📡 [Multi-Confirmation] ${symbol}: Fetching derivatives data...`);
      const derivativesData = await this.derivativesFetcher.fetchAll(symbol);
      logger.info(`📊 [Multi-Confirmation] ${symbol}: Derivatives - Funding=${(derivativesData.fundingRate * 100).toFixed(4)}%, OI=${derivativesData.openInterest.toFixed(0)}, LS Ratio=${derivativesData.longShortRatio.toFixed(2)}`);

      // Determine initial trade side from indicators
      const side = this.determineInitialSide(indicators);
      if (!side) {
        logger.info(`❌ [Multi-Confirmation] ${symbol}: No clear initial direction from indicators`);
        return null;
      }

      logger.info(`🎯 [Multi-Confirmation] ${symbol}: Initial direction determined: ${side}`);

      // Evaluate all confirmations
      logger.info(`🔍 [Multi-Confirmation] ${symbol}: Evaluating 5 confirmation layers...`);
      const confirmationResults = await this.confirmationEngine.evaluateAll(
        symbol,
        marketData,
        indicators,
        derivativesData,
        side
      );

      logger.info(`📊 [Multi-Confirmation] ${symbol}: Confirmation results - Passed: ${confirmationResults.passedCount}/${confirmationResults.totalCount}, Required: ${this.requiredConfirmations}`);
      
      // Log each confirmation result
      confirmationResults.results.forEach(result => {
        const status = result.passed ? '✅' : '❌';
        logger.info(`${status} [Multi-Confirmation] ${symbol}: ${result.name} - ${result.reason}`);
      });

      // Check if threshold met (4+ confirmations)
      if (!confirmationResults.meetsThreshold) {
        logger.info(`❌ [Multi-Confirmation] ${symbol}: Threshold not met (${confirmationResults.passedCount}/${this.requiredConfirmations})`);
        return null;
      }

      logger.info(`✅ [Multi-Confirmation] ${symbol}: Threshold met! Generating signal...`);

      // Generate signal
      const signal = await this.generateSignal(
        symbol,
        marketData,
        indicators,
        derivativesData,
        confirmationResults,
        side
      );

      if (signal && signal.valid) {
        this.logSignal(signal);
      }

      return signal;

    } catch (error) {
      logger.error('Multi-Confirmation analysis error', {
        symbol,
        error: error.message,
        stack: error.stack
      });
      return null;
    }
  }

  /**
   * Determine initial trade side from indicators
   */
  determineInitialSide(indicators) {
    const { ema20, ema50, currentPrice, rsi } = indicators;

    // Bullish: price above EMAs and RSI in neutral zone
    const bullish = currentPrice > ema20 && currentPrice > ema50 && ema20 > ema50;
    
    // Bearish: price below EMAs and RSI in neutral zone
    const bearish = currentPrice < ema20 && currentPrice < ema50 && ema20 < ema50;

    if (bullish) return 'LONG';
    if (bearish) return 'SHORT';
    return null;
  }

  /**
   * Generate signal from confirmation results
   */
  async generateSignal(symbol, marketData, indicators, derivativesData, confirmationResults, side) {
    try {
      const { currentPrice, atr } = indicators;

      // Calculate stop loss using ATR
      const stopLoss = this.tpManager.calculateStopLoss(currentPrice, atr, side);

      // Calculate two-stage take profit levels
      const tpLevels = this.tpManager.calculateTakeProfitLevels(
        currentPrice,
        stopLoss,
        side,
        atr
      );

      // Calculate risk-reward ratio
      const riskAmount = Math.abs(currentPrice - stopLoss);
      const rewardAmount = Math.abs(tpLevels.tp2 - currentPrice);
      const riskRewardRatio = rewardAmount / riskAmount;

      // Validate risk-reward
      const rrValidation = this.validateRiskReward(currentPrice, stopLoss, tpLevels.tp2);
      if (!rrValidation.valid) {
        logger.debug('Risk-reward validation failed', {
          symbol,
          riskRewardRatio: rrValidation.actualRatio
        });
        return null;
      }

      // Build confirmation summary
      const confirmationSummary = {};
      for (const result of confirmationResults.results) {
        confirmationSummary[result.name] = {
          passed: result.passed,
          reason: result.reason,
          details: result.details
        };
      }

      // Create signal object
      const signal = {
        symbol,
        side,
        entryPrice: currentPrice,
        stopLoss,
        takeProfit: tpLevels.tp2, // For compatibility
        tp1: tpLevels.tp1,
        tp2: tpLevels.tp2,
        trailingStopDistance: tpLevels.trailingStopDistance,
        breakeven: tpLevels.breakeven,
        confidence: confirmationResults.confidence / 100,
        strategy: this.name,
        timestamp: Date.now(),
        valid: true,
        confirmations: confirmationSummary,
        passedConfirmations: confirmationResults.passedCount,
        requiredConfirmations: this.requiredConfirmations,
        indicators: {
          ema20: indicators.ema20,
          ema50: indicators.ema50,
          rsi: indicators.rsi,
          macd: indicators.macd,
          macdSignal: indicators.macdSignal,
          macdHistogram: indicators.macdHistogram,
          atr: indicators.atr,
          volume: indicators.volume,
          avgVolume: indicators.avgVolume,
          cvd: indicators.cvd
        },
        derivativesData: {
          fundingRate: derivativesData.fundingRate,
          openInterest: derivativesData.openInterest,
          openInterestPrev: derivativesData.openInterestPrev,
          longShortRatio: derivativesData.longShortRatio
        },
        riskRewardRatio: rrValidation.actualRatio,
        reasons: confirmationResults.results.filter(r => r.passed).map(r => r.reason)
      };

      return signal;

    } catch (error) {
      logger.error('Signal generation error', {
        symbol,
        error: error.message
      });
      return null;
    }
  }
}

module.exports = MultiConfirmationStrategy;
