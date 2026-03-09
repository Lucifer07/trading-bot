const logger = require('../utils/logger');
const EMACrossoverStrategy = require('../strategies/ema-crossover');
const RSIStrategy = require('../strategies/rsi-strategy');

class SignalAggregator {
  constructor(config = {}) {
    this.minConfidence = config.minConfidence || 0.75; // Lowered from 0.7 for survival mode
    this.minConfluence = config.minConfluence || 2.5;  // Lowered from 2 for survival mode
    this.maxPositions = config.maxPositions || 2;      // Reduced from 3 for survival mode
    this.requiredAgreement = config.requiredAgreement || 1.0; // Increased from 0.6 - BOTH must agree

    // Initialize strategies
    this.strategies = [
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
    ];

    logger.info('🔥 SURVIVAL MODE Signal Aggregator initialized', {
      strategiesCount: this.strategies.length,
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
      // Check if should trade this symbol
      const tradeCheck = await this.shouldTrade(symbol, openPositions);
      if (!tradeCheck.shouldTrade) {
        logger.debug('Skipping symbol analysis', { symbol, reason: tradeCheck.reason });
        return null;
      }

      // PARALLEL: Get signals from all strategies at once
      const signalPromises = this.strategies.map(strategy =>
        strategy.analyze(symbol, marketData)
          .then(signal => (signal && signal.valid) ? signal : null)
          .catch(error => {
            logger.error('Strategy analysis error', {
              strategy: strategy.name,
              symbol,
              error: error.message,
            });
            return null;
          })
      );

      const signalResults = await Promise.all(signalPromises);
      const signals = signalResults.filter(s => s !== null);

      // If no signals, return null
      if (signals.length === 0) {
        logger.debug('No valid signals', { symbol });
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
      // Count bullish and bearish signals
      const bullishSignals = signals.filter(s => s.side === 'LONG');
      const bearishSignals = signals.filter(s => s.side === 'SHORT');

      const totalSignals = signals.length;
      const bullishCount = bullishSignals.length;
      const bearishCount = bearishSignals.length;

      // Check if there's enough agreement
      const bullishAgreement = bullishCount / totalSignals;
      const bearishAgreement = bearishCount / totalSignals;

      let side = 'NEUTRAL';
      let agreement = 0;

      if (bullishAgreement >= this.requiredAgreement && bullishAgreement > bearishAgreement) {
        side = 'LONG';
        agreement = bullishAgreement;
      } else if (bearishAgreement >= this.requiredAgreement && bearishAgreement > bullishAgreement) {
        side = 'SHORT';
        agreement = bearishAgreement;
      }

      // If no clear agreement, return null
      if (side === 'NEUTRAL') {
        logger.debug('No clear agreement on direction', {
          symbol,
          bullishCount,
          bearishCount,
          totalSignals,
        });
        return null;
      }

      // Calculate aggregated confidence
      const signalsForSide = side === 'LONG' ? bullishSignals : bearishSignals;
      const avgConfidence = signalsForSide.reduce((sum, s) => sum + s.confidence, 0) / signalsForSide.length;

      // Check minimum confidence
      if (avgConfidence < this.minConfidence) {
        logger.debug('Confidence too low', { symbol, avgConfidence, minConfidence: this.minConfidence });
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

      // Check minimum risk-reward ratio
      if (riskRewardRatio < this.minConfluence) {
        logger.debug('Risk-reward ratio too low', {
          symbol,
          riskRewardRatio,
          minRatio: this.minConfluence,
        });
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
