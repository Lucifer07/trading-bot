const logger = require('../utils/logger');
const EMACrossoverStrategy = require('../strategies/ema-crossover');
const RSIStrategy = require('../strategies/rsi-strategy');
const MultiConfirmationStrategy = require('../strategies/multi-confirmation-strategy');

class SignalAggregator {
  constructor(config = {}) {
    this.minConfidence = config.minConfidence || 0.75; // Lowered from 0.7 for survival mode
    this.minConfluence = config.minConfluence || 2.5;  // Lowered from 2 for survival mode
    this.maxPositions = config.maxPositions || 2;      // Reduced from 3 for survival mode
    this.requiredAgreement = config.requiredAgreement || 0.67; // 2 out of 3 strategies must agree

    // Store config for multi-confirmation strategy
    this.config = config;

    // Initialize strategies - HYBRID APPROACH
    this.strategies = [
      // Original strategies (proven and working)
      new EMACrossoverStrategy({
        enabled: true,
        riskPercent: 1.5,  // Increased from 0.8 for survival mode
        maxPositions: 2,
      }),
      new RSIStrategy({
        enabled: true,
        riskPercent: 1.5,  // Increased from 0.8 for survival mode
        maxPositions: 2,
      }),
      // New advanced multi-confirmation strategy
      new MultiConfirmationStrategy({
        enabled: config.useMultiConfirmation !== false, // Enabled by default
        riskPercent: 2.0,
        maxPositions: 2,
        requiredConfirmations: 4,
        binanceAPI: config.binanceAPI,
        redisClient: config.redisClient,
        useMultiTimeframe: false, // Disabled for now
        useOrderBookImbalance: false, // Disabled for now
        useNewsIntegration: true,
      }),
    ];

    logger.info('🔥 HYBRID STRATEGY Signal Aggregator initialized', {
      strategiesCount: this.strategies.length,
      strategies: this.strategies.map(s => s.name),
      minConfidence: this.minConfidence,
      minConfluence: this.minConfluence,
      requiredAgreement: this.requiredAgreement,
      maxPositions: this.maxPositions,
    });
  }

  /**
   * Analyze symbol using all strategies and aggregate signals
   */
  async analyzeSymbol(symbol, marketData, openPositions) {
    try {
      logger.info(`\n${'='.repeat(80)}`);
      logger.info(`🎯 [Signal Aggregator] Analyzing ${symbol}`);
      logger.info(`${'='.repeat(80)}`);
      
      // Check if should trade this symbol
      const tradeCheck = await this.shouldTrade(symbol, openPositions);
      if (!tradeCheck.shouldTrade) {
        logger.info(`⏭️  [Signal Aggregator] ${symbol}: Skipping - ${tradeCheck.reason}`);
        return null;
      }

      logger.info(`✅ [Signal Aggregator] ${symbol}: Pre-checks passed, analyzing with ${this.strategies.length} strategies...`);

      // PARALLEL: Get signals from all strategies at once
      const signalPromises = this.strategies.map(strategy =>
        strategy.analyze(symbol, marketData)
          .then(signal => {
            if (signal && signal.valid) {
              logger.info(`✅ [Signal Aggregator] ${symbol}: ${strategy.name} generated ${signal.side} signal (confidence: ${(signal.confidence * 100).toFixed(0)}%)`);
              return signal;
            } else {
              logger.info(`❌ [Signal Aggregator] ${symbol}: ${strategy.name} - No valid signal`);
              return null;
            }
          })
          .catch(error => {
            logger.error(`❌ [Signal Aggregator] ${symbol}: ${strategy.name} error - ${error.message}`);
            return null;
          })
      );

      const signalResults = await Promise.all(signalPromises);
      const signals = signalResults.filter(s => s !== null);

      logger.info(`\n📊 [Signal Aggregator] ${symbol}: Strategy Results Summary:`);
      logger.info(`   Total strategies: ${this.strategies.length}`);
      logger.info(`   Signals generated: ${signals.length}`);
      logger.info(`   Required agreement: ${(this.requiredAgreement * 100).toFixed(0)}% (${Math.ceil(this.strategies.length * this.requiredAgreement)}/${this.strategies.length})`);

      // If no signals, return null
      if (signals.length === 0) {
        logger.info(`❌ [Signal Aggregator] ${symbol}: No valid signals from any strategy\n`);
        return null;
      }

      // Aggregate signals
      const aggregated = await this.aggregateSignals(signals, symbol, marketData, openPositions);

      if (aggregated) {
        logger.info('Aggregated signal generated', {
          symbol,
          side: aggregated.side,
          confidence: aggregated.confidence,
          strategies: signals.map(s => s.strategy),
        });
      }

      return aggregated;

    } catch (error) {
      logger.error('Signal aggregation error', { symbol, error: error.message });
      return null;
    }
  }

  /**
   * Aggregate multiple signals into a single trading decision
   */
  async aggregateSignals(signals, symbol, marketData, openPositions) {
    try {
      logger.info(`\n🔄 [Signal Aggregator] ${symbol}: Aggregating ${signals.length} signals...`);
      
      // Count bullish and bearish signals
      const bullishSignals = signals.filter(s => s.side === 'LONG');
      const bearishSignals = signals.filter(s => s.side === 'SHORT');

      const totalSignals = signals.length;
      const bullishCount = bullishSignals.length;
      const bearishCount = bearishSignals.length;

      logger.info(`   📊 Vote count: LONG=${bullishCount}, SHORT=${bearishCount}`);
      
      // List which strategies voted for what
      if (bullishCount > 0) {
        const bullishStrategies = bullishSignals.map(s => s.strategy).join(', ');
        logger.info(`   📈 LONG votes from: ${bullishStrategies}`);
      }
      if (bearishCount > 0) {
        const bearishStrategies = bearishSignals.map(s => s.strategy).join(', ');
        logger.info(`   📉 SHORT votes from: ${bearishStrategies}`);
      }

      // Check if there's enough agreement
      const bullishAgreement = bullishCount / totalSignals;
      const bearishAgreement = bearishCount / totalSignals;

      logger.info(`   🎯 Agreement: LONG=${(bullishAgreement * 100).toFixed(0)}%, SHORT=${(bearishAgreement * 100).toFixed(0)}%`);

      let side = 'NEUTRAL';
      let agreement = 0;

      if (bullishAgreement >= this.requiredAgreement && bullishAgreement > bearishAgreement) {
        side = 'LONG';
        agreement = bullishAgreement;
        logger.info(`   ✅ Direction: LONG (${(agreement * 100).toFixed(0)}% agreement)`);
      } else if (bearishAgreement >= this.requiredAgreement && bearishAgreement > bullishAgreement) {
        side = 'SHORT';
        agreement = bearishAgreement;
        logger.info(`   ✅ Direction: SHORT (${(agreement * 100).toFixed(0)}% agreement)`);
      }

      // If no clear agreement, return null
      if (side === 'NEUTRAL') {
        logger.info(`   ❌ No clear agreement (need ${(this.requiredAgreement * 100).toFixed(0)}%)`);
        logger.info(`❌ [Signal Aggregator] ${symbol}: REJECTED - Insufficient agreement\n`);
        return null;
      }

      // Calculate aggregated confidence
      const signalsForSide = side === 'LONG' ? bullishSignals : bearishSignals;
      const avgConfidence = signalsForSide.reduce((sum, s) => sum + s.confidence, 0) / signalsForSide.length;

      logger.info(`   📊 Average confidence: ${(avgConfidence * 100).toFixed(1)}% (min required: ${(this.minConfidence * 100).toFixed(0)}%)`);

      // Check minimum confidence
      if (avgConfidence < this.minConfidence) {
        logger.info(`   ❌ Confidence too low: ${(avgConfidence * 100).toFixed(1)}% < ${(this.minConfidence * 100).toFixed(0)}%`);
        logger.info(`❌ [Signal Aggregator] ${symbol}: REJECTED - Low confidence\n`);
        return null;
      }

      // Aggregate entry price (average of all signals)
      const avgEntryPrice = signalsForSide.reduce((sum, s) => sum + s.entryPrice, 0) / signalsForSide.length;

      // Aggregate stop loss (use the safest - closest to entry)
      const stopLosses = signalsForSide.map(s => s.stopLoss);
      let bestStopLoss;
      if (side === 'LONG') {
        bestStopLoss = Math.max(...stopLosses); // Highest stop loss (safer)
      } else {
        bestStopLoss = Math.min(...stopLosses); // Lowest stop loss (safer)
      }

      // Aggregate take profit (average)
      const takeProfits = signalsForSide.map(s => s.takeProfit);
      const avgTakeProfit = takeProfits.reduce((sum, tp) => sum + tp, 0) / takeProfits.length;

      // Calculate risk-reward ratio
      const riskAmount = Math.abs(avgEntryPrice - bestStopLoss);
      const rewardAmount = Math.abs(avgTakeProfit - avgEntryPrice);
      const riskRewardRatio = rewardAmount / riskAmount;

      logger.info(`   💰 Risk/Reward: ${riskRewardRatio.toFixed(2)}:1 (min required: ${this.minConfluence}:1)`);
      logger.info(`   📍 Entry: ${avgEntryPrice.toFixed(6)}, SL: ${bestStopLoss.toFixed(6)}, TP: ${avgTakeProfit.toFixed(6)}`);

      // Check minimum risk-reward ratio
      if (riskRewardRatio < this.minConfluence) {
        logger.info(`   ❌ Risk/Reward too low: ${riskRewardRatio.toFixed(2)} < ${this.minConfluence}`);
        logger.info(`❌ [Signal Aggregator] ${symbol}: REJECTED - Poor risk/reward\n`);
        return null;
      }

      // Collect all reasons
      const allReasons = signalsForSide.flatMap(s => s.reasons || []);

      // Aggregate indicators
      const indicators = {
        emaFast: { value: 0, signal: 'NEUTRAL' },
        emaSlow: { value: 0, signal: 'NEUTRAL' },
        emaTrend: { value: 0, signal: 'NEUTRAL' },
        rsi: { value: 0, signal: 'NEUTRAL' },
      };

      for (const signal of signalsForSide) {
        if (signal.indicators.emaFast) {
          indicators.emaFast = signal.indicators.emaFast;
        }
        if (signal.indicators.emaSlow) {
          indicators.emaSlow = signal.indicators.emaSlow;
        }
        if (signal.indicators.emaTrend) {
          indicators.emaTrend = signal.indicators.emaTrend;
        }
        if (signal.indicators.rsi) {
          indicators.rsi = signal.indicators.rsi;
        }
      }

      const result = {
        symbol,
        side,
        entryPrice: avgEntryPrice,
        stopLoss: bestStopLoss,
        takeProfit: avgTakeProfit,
        confidence: avgConfidence,
        agreement: agreement * 100,
        riskRewardRatio,
        indicators,
        strategy: 'Aggregated',
        timestamp: Date.now(),
        valid: true,
        reasons: allReasons,
        signalsCount: signalsForSide.length,
        strategies: signalsForSide.map(s => s.strategy),
      };

      logger.info(`\n✅ [Signal Aggregator] ${symbol}: SIGNAL GENERATED!`);
      logger.info(`   Direction: ${side}`);
      logger.info(`   Confidence: ${(avgConfidence * 100).toFixed(1)}%`);
      logger.info(`   Agreement: ${(agreement * 100).toFixed(0)}%`);
      logger.info(`   R/R Ratio: ${riskRewardRatio.toFixed(2)}:1`);
      logger.info(`   Strategies: ${signalsForSide.map(s => s.strategy).join(', ')}`);
      logger.info(`${'='.repeat(80)}\n`);

      return result;

    } catch (error) {
      logger.error('Signal aggregation error', { symbol, error: error.message });
      return null;
    }
  }

  /**
   * Check if should trade this symbol
   */
  async shouldTrade(symbol, openPositions) {
    // Check if already have position for this symbol
    const hasPosition = openPositions.some(pos => pos.symbol === symbol);
    if (hasPosition) {
      return { shouldTrade: false, reason: 'Already have position' };
    }

    // Check max positions limit
    if (openPositions.length >= this.maxPositions) {
      return { shouldTrade: false, reason: 'Max positions reached' };
    }

    return { shouldTrade: true };
  }

  /**
   * Add a new strategy
   */
  addStrategy(strategy) {
    this.strategies.push(strategy);
    logger.info('Strategy added to aggregator', { strategy: strategy.name });
  }

  /**
   * Remove a strategy
   */
  removeStrategy(strategyName) {
    this.strategies = this.strategies.filter(s => s.name !== strategyName);
    logger.info('Strategy removed from aggregator', { strategyName });
  }

  /**
   * Get strategy statistics
   */
  getStrategyStats() {
    return {
      totalStrategies: this.strategies.length,
      strategies: this.strategies.map(s => ({
        name: s.name,
        enabled: s.enabled,
        timeframe: s.timeframe,
        riskPercent: s.riskPercent,
        maxPositions: s.maxPositions,
      })),
    };
  }
}

module.exports = SignalAggregator;
