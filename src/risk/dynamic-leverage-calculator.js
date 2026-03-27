const logger = require('../utils/logger');

/**
 * DynamicLeverageCalculator
 * Calculates optimal leverage based on:
 * 1. Account balance (risk-based tiers)
 * 2. Market regime (RANGING, WEAK_TREND, STRONG_TREND)
 * 3. Volatility (ATR)
 * 4. Trend strength (ADX)
 * 5. Signal confidence
 */
class DynamicLeverageCalculator {
  constructor(config = {}) {
    this.maxLeverage = config.maxLeverage || 20;
    this.minLeverage = config.minLeverage || 1;
    this.defaultLeverage = config.defaultLeverage || 3;

    // Balance tiers for leverage scaling
    this.balanceTiers = config.balanceTiers || [
      { maxBalance: 100, maxLeverage: 20, defaultLeverage: 5 },
      { maxBalance: 500, maxLeverage: 15, defaultLeverage: 4 },
      { maxBalance: 1000, maxLeverage: 10, defaultLeverage: 3 },
      { maxBalance: 5000, maxLeverage: 5, defaultLeverage: 2 },
      { maxBalance: Infinity, maxLeverage: 3, defaultLeverage: 1 },
    ];

    // Market regime multipliers
    this.regimeMultipliers = config.regimeMultipliers || {
      'RANGING': 0.3,      // 30% of max leverage
      'WEAK_TREND': 0.6,   // 60% of max leverage
      'STRONG_TREND': 1.0,  // 100% of max leverage
    };

    // Volatility multipliers (ATR percentage)
    this.volatilityRanges = config.volatilityRanges || [
      { maxATR: 0.5, multiplier: 0.4 },   // Very low volatility
      { maxATR: 1.0, multiplier: 0.6 },   // Low volatility
      { maxATR: 2.0, multiplier: 0.8 },   // Normal volatility
      { maxATR: 3.0, multiplier: 1.0 },   // High volatility
      { maxATR: Infinity, multiplier: 0.7 }, // Very high volatility
    ];

    // ADX (trend strength) multipliers
    this.adxRanges = config.adxRanges || [
      { maxADX: 20, multiplier: 0.5 },    // Very weak/no trend
      { maxADX: 25, multiplier: 0.7 },    // Weak trend
      { maxADX: 35, multiplier: 0.9 },    // Moderate trend
      { maxADX: 50, multiplier: 1.0 },    // Strong trend
      { maxADX: Infinity, multiplier: 0.8 }, // Very strong trend
    ];

    // Signal confidence multipliers
    this.confidenceRanges = config.confidenceRanges || [
      { maxConfidence: 0.75, multiplier: 0.5 },  // Low confidence
      { maxConfidence: 0.85, multiplier: 0.8 },  // Medium confidence
      { maxConfidence: 0.90, multiplier: 0.9 },  // High confidence
      { maxConfidence: Infinity, multiplier: 1.0 }, // Very high confidence
    ];

    logger.info('DynamicLeverageCalculator initialized', {
      maxLeverage: this.maxLeverage,
      minLeverage: this.minLeverage,
      defaultLeverage: this.defaultLeverage,
      balanceTiers: this.balanceTiers.length,
      regimeMultipliers: Object.keys(this.regimeMultipliers),
    });
  }

  /**
   * Get balance tier based on current balance
   */
  getBalanceTier(balance) {
    for (const tier of this.balanceTiers) {
      if (balance <= tier.maxBalance) {
        return tier;
      }
    }
    return this.balanceTiers[this.balanceTiers.length - 1];
  }

  /**
   * Calculate leverage based on balance
   */
  calculateBalanceBasedLeverage(balance) {
    const tier = this.getBalanceTier(balance);
    return tier.defaultLeverage;
  }

  /**
   * Get regime multiplier based on market regime
   */
  getRegimeMultiplier(regime) {
    return this.regimeMultipliers[regime] || 0.5;
  }

  /**
   * Get volatility multiplier based on ATR percentage
   */
  getVolatilityMultiplier(atrPercent) {
    for (const range of this.volatilityRanges) {
      if (atrPercent < range.maxATR) {
        return range.multiplier;
      }
    }
    return this.volatilityRanges[this.volatilityRanges.length - 1].multiplier;
  }

  /**
   * Get ADX multiplier based on trend strength
   */
  getADXMutiplier(adx) {
    for (const range of this.adxRanges) {
      if (adx < range.maxADX) {
        return range.multiplier;
      }
    }
    return this.adxRanges[this.adxRanges.length - 1].multiplier;
  }

  /**
   * Get confidence multiplier based on signal confidence
   */
  getConfidenceMultiplier(confidence) {
    for (const range of this.confidenceRanges) {
      if (confidence < range.maxConfidence) {
        return range.multiplier;
      }
    }
    return this.confidenceRanges[this.confidenceRanges.length - 1].multiplier;
  }

  /**
   * Calculate dynamic leverage based on all factors
   */
  calculateLeverage(balance, signal, marketData) {
    try {
      logger.info(`🔢 [Dynamic Leverage] Calculating optimal leverage...`);

      // 1. Get base leverage from balance tier
      const balanceTier = this.getBalanceTier(balance);
      const baseLeverage = balanceTier.defaultLeverage;

      // 2. Get market regime from signal
      const marketRegime = signal.marketRegime?.regime || 'RANGING';
      const regimeMultiplier = this.getRegimeMultiplier(marketRegime);

      // 3. Get volatility from market data
      const atrPercent = marketData.metrics?.volatility || 
                        signal.marketRegime?.metrics?.volatility || 1.0;
      const volatilityMultiplier = this.getVolatilityMultiplier(atrPercent);

      // 4. Get ADX from market data
      const adx = marketData.metrics?.adx || 
                 signal.marketRegime?.metrics?.adx || 20;
      const adxMultiplier = this.getADXMutiplier(adx);

      // 5. Get confidence from signal
      const confidence = signal.confidence || 0.75;
      const confidenceMultiplier = this.getConfidenceMultiplier(confidence);

      // 6. Calculate final leverage
      let leverage = baseLeverage * regimeMultiplier * volatilityMultiplier * adxMultiplier * confidenceMultiplier;

      // 7. Apply min/max constraints
      leverage = Math.max(this.minLeverage, Math.min(this.maxLeverage, leverage));

      // 8. Round to nearest whole number
      leverage = Math.round(leverage);

      logger.info(`📊 [Dynamic Leverage] Calculation breakdown:`, {
        balance: balance.toFixed(2),
        balanceTier: `$0-${balanceTier.maxBalance}`,
        baseLeverage: baseLeverage.toFixed(1),
        marketRegime,
        regimeMultiplier: regimeMultiplier.toFixed(2),
        atrPercent: atrPercent.toFixed(2) + '%',
        volatilityMultiplier: volatilityMultiplier.toFixed(2),
        adx: adx.toFixed(2),
        adxMultiplier: adxMultiplier.toFixed(2),
        confidence: (confidence * 100).toFixed(1) + '%',
        confidenceMultiplier: confidenceMultiplier.toFixed(2),
        calculatedLeverage: baseLeverage * regimeMultiplier * volatilityMultiplier * adxMultiplier * confidenceMultiplier,
        finalLeverage: leverage,
      });

      return {
        leverage,
        breakdown: {
          balance,
          balanceTier,
          baseLeverage,
          marketRegime,
          regimeMultiplier,
          atrPercent,
          volatilityMultiplier,
          adx,
          adxMultiplier,
          confidence,
          confidenceMultiplier,
          calculation: {
            base: baseLeverage,
            afterRegime: baseLeverage * regimeMultiplier,
            afterVolatility: baseLeverage * regimeMultiplier * volatilityMultiplier,
            afterADX: baseLeverage * regimeMultiplier * volatilityMultiplier * adxMultiplier,
            afterConfidence: baseLeverage * regimeMultiplier * volatilityMultiplier * adxMultiplier * confidenceMultiplier,
            final: leverage,
          },
        },
      };

    } catch (error) {
      logger.error('DynamicLeverageCalculator error', { error: error.message });
      return {
        leverage: this.defaultLeverage,
        breakdown: { error: error.message },
      };
    }
  }

  /**
   * Validate leverage against exchange limits
   */
  validateLeverage(leverage, symbolInfo) {
    if (!symbolInfo) {
      logger.warn('No symbol info available, cannot validate leverage');
      return { valid: true, leverage };
    }

    const maxSymbolLeverage = symbolInfo.maxLeverage || 125;
    
    if (leverage > maxSymbolLeverage) {
      logger.warn(`Leverage ${leverage}x exceeds symbol max ${maxSymbolLeverage}x, reducing`);
      return {
        valid: true,
        leverage: Math.min(leverage, maxSymbolLeverage),
        reason: `Capped at symbol max ${maxSymbolLeverage}x`,
      };
    }

    return { valid: true, leverage };
  }

  /**
   * Get leverage statistics for logging
   */
  getLeverageStats(leverage, breakdown) {
    return {
      leverage,
      balanceTier: breakdown.balanceTier?.maxBalance || 'N/A',
      marketRegime: breakdown.marketRegime || 'N/A',
      volatility: breakdown.atrPercent || 'N/A',
      adx: breakdown.adx || 'N/A',
      confidence: breakdown.confidence || 'N/A',
      regimeMultiplier: breakdown.regimeMultiplier,
      volatilityMultiplier: breakdown.volatilityMultiplier,
      adxMultiplier: breakdown.adxMultiplier,
      confidenceMultiplier: breakdown.confidenceMultiplier,
    };
  }
}

module.exports = DynamicLeverageCalculator;