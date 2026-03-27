const logger = require('../utils/logger');

/**
 * MarketRegimeDetector
 * Classifies market conditions into: RANGING, WEAK_TREND, STRONG_TREND
 * Uses volatility, trend strength, and range expansion metrics
 */
class MarketRegimeDetector {
  constructor(config = {}) {
    this.minATR = config.minATR || 0.8; // 0.8% minimum volatility
    this.minSlope = config.minSlope || 0.5; // 0.5% minimum trend slope
    this.strongTrendSlope = config.strongTrendSlope || 2.0; // 2.0% for strong trend
    this.lookbackPeriods = config.lookbackPeriods || 50;
    this.priceEfficiencyThreshold = config.priceEfficiencyThreshold || 0.3;
  }

  /**
   * Calculate EMA (Exponential Moving Average)
   */
  calculateEMA(prices, period) {
    if (prices.length < period) return null;
    
    const k = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((sum, p) => sum + p, 0) / period;
    
    for (let i = period; i < prices.length; i++) {
      ema = prices[i] * k + ema * (1 - k);
    }
    
    return ema;
  }

  /**
   * Calculate EMA history for slope detection
   */
  calculateEMAHistory(prices, period, historyLength) {
    if (prices.length < period + historyLength) return [];
    
    const history = [];
    for (let i = prices.length - historyLength; i < prices.length; i++) {
      const ema = this.calculateEMA(prices.slice(0, i + 1), period);
      if (ema !== null) history.push(ema);
    }
    
    return history;
  }

  /**
   * Calculate slope of EMA
   */
  calculateSlope(emaHistory, periods = 10) {
    if (emaHistory.length < periods) return 0;
    
    const recent = emaHistory.slice(-periods);
    const first = recent[0];
    const last = recent[recent.length - 1];
    
    return (last - first) / first;
  }

  /**
   * Calculate ATR (Average True Range)
   */
  calculateATR(klines, period = 14) {
    if (klines.length < period + 1) return 0;
    
    const trueRanges = [];
    for (let i = 1; i < klines.length; i++) {
      const current = klines[i];
      const previous = klines[i - 1];
      
      const high = parseFloat(current[2]);
      const low = parseFloat(current[3]);
      const prevClose = parseFloat(previous[4]);
      
      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      trueRanges.push(tr);
    }
    
    return trueRanges.slice(-period).reduce((sum, tr) => sum + tr, 0) / period;
  }

  /**
   * Detect sideways/ranging market
   */
  detectSideways(marketData) {
    try {
      const { klines } = marketData;
      const closes = klines.map(k => parseFloat(k[4]));
      const recent = closes.slice(-this.lookbackPeriods);
      
      if (recent.length < this.lookbackPeriods) {
        return {
          isSideways: true,
          metrics: null,
          reason: 'Insufficient data'
        };
      }
      
      const currentPrice = closes[closes.length - 1];
      
      // 1. Range expansion metric
      const high = Math.max(...recent);
      const low = Math.min(...recent);
      const rangeExpansion = ((high - low) / low) * 100;
      
      // 2. Trend strength (slope)
      const ema20History = this.calculateEMAHistory(closes, 20, 10);
      const ema50History = this.calculateEMAHistory(closes, 50, 10);
      const ema20Slope = this.calculateSlope(ema20History, 10);
      const ema50Slope = this.calculateSlope(ema50History, 10);
      const slopePercent = Math.max(Math.abs(ema20Slope), Math.abs(ema50Slope)) * 100;
      
      // 3. Volatility compression
      const atr = this.calculateATR(klines.slice(-14));
      const atrPercent = (atr / currentPrice) * 100;
      
      // 4. Price efficiency (How much movement vs noise)
      const totalChange = Math.abs(recent[recent.length - 1] - recent[0]);
      const totalNoise = recent.reduce((sum, price, i) => 
        i > 0 ? sum + Math.abs(price - recent[i - 1]) : sum, 0
      );
      const efficiency = totalNoise > 0 ? totalChange / totalNoise : 0;
      
      // CLASSIFY
      const isSideways = 
        rangeExpansion < 2.0 &&      
        slopePercent < this.minSlope &&       
        atrPercent < this.minATR &&         
        efficiency < this.priceEfficiencyThreshold;
      
      const metrics = {
        rangeExpansion,
        slopePercent,
        ema20Slope: ema20Slope * 100,
        ema50Slope: ema50Slope * 100,
        atrPercent,
        efficiency
      };
      
      return {
        isSideways,
        metrics,
        reason: isSideways ? 'Market in ranging regime' : 'Market showing trend characteristics'
      };
      
    } catch (error) {
      logger.error('MarketRegimeDetector detectSideways error', { error: error.message });
      return {
        isSideways: true,
        metrics: null,
        reason: `Error: ${error.message}`
      };
    }
  }

  /**
   * Classify market regime
   */
  classify(marketData, adx = null) {
    try {
      const { klines } = marketData;
      const closes = klines.map(k => parseFloat(k[4]));
      const currentPrice = closes[closes.length - 1];
      
      // Calculate volatility
      const atr = this.calculateATR(klines.slice(-14));
      const volatility = (atr / currentPrice) * 100;
      
      // Calculate trend strength
      const ema20History = this.calculateEMAHistory(closes, 20, 10);
      const ema50History = this.calculateEMAHistory(closes, 50, 10);
      const ema20Slope = this.calculateSlope(ema20History, 10);
      const ema50Slope = this.calculateSlope(ema50History, 10);
      const trendStrength = Math.max(Math.abs(ema20Slope), Math.abs(ema50Slope)) * 100;
      
      // Get ADX if available
      const adxValue = adx || 0;
      
      // Determine regime
      let regime = 'RANGING';
      let confidence = 0;
      let reasons = [];
      
      const isLowVolatility = volatility < this.minATR;
      const isWeakTrend = trendStrength < this.minSlope;
      const isWeakADX = adxValue > 0 && adxValue < 25;
      
      if (isLowVolatility && isWeakTrend) {
        regime = 'RANGING';
        confidence = 0.9;
        reasons.push('Low volatility');
        reasons.push('Weak/no trend');
      } else if (trendStrength > this.strongTrendSlope && !isWeakADX) {
        regime = 'STRONG_TREND';
        confidence = 0.85;
        reasons.push('Strong trend detected');
        if (adxValue >= 25) {
          reasons.push('ADX confirms trend strength');
        }
      } else {
        regime = 'WEAK_TREND';
        confidence = 0.7;
        reasons.push('Moderate trend strength');
      }
      
      return {
        regime,
        confidence,
        reasons,
        metrics: {
          volatility,
          trendStrength,
          ema20Slope: ema20Slope * 100,
          ema50Slope: ema50Slope * 100,
          adx: adxValue,
          atr
        },
        thresholds: {
          minATR: this.minATR,
          minSlope: this.minSlope,
          strongTrendSlope: this.strongTrendSlope
        }
      };
      
    } catch (error) {
      logger.error('MarketRegimeDetector classify error', { error: error.message });
      return {
        regime: 'RANGING',
        confidence: 1.0,
        reasons: ['Error in classification - defaulting to RANGING'],
        metrics: null,
        thresholds: null
      };
    }
  }

  /**
   * Check if market is tradeable based on regime
   */
  isTradeable(regimeData) {
    if (regimeData.regime === 'RANGING') {
      logger.warn('🚫 Market not tradeable: RANGING regime', {
        reasons: regimeData.reasons,
        confidence: regimeData.confidence
      });
      return false;
    }
    
    logger.info('✅ Market is tradeable:', {
      regime: regimeData.regime,
      confidence: regimeData.confidence,
      reasons: regimeData.reasons
    });
    
    return true;
  }
}

module.exports = MarketRegimeDetector;