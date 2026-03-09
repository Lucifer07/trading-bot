const BaseStrategy = require('./base-strategy');
const logger = require('../utils/logger');

class RSIStrategy extends BaseStrategy {
  constructor(config = {}) {
    super({
      name: 'RSI Momentum',
      timeframe: config.timeframe || '1h',
      riskPercent: config.riskPercent || 1,
      minRiskRewardRatio: config.minRiskRewardRatio || 2,
      maxPositions: config.maxPositions || 2,
      enabled: config.enabled !== false,
    });

    this.rsiPeriod = config.rsiPeriod || 14;
    this.oversoldLevel = config.oversoldLevel || 30;
    this.overboughtLevel = config.overboughtLevel || 70;
    this.emaTrend = config.emaTrend || 50;

    logger.info('RSI Strategy initialized', {
      rsiPeriod: this.rsiPeriod,
      oversoldLevel: this.oversoldLevel,
      overboughtLevel: this.overboughtLevel,
    });
  }

  /**
   * Calculate RSI (Relative Strength Index)
   */
  calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return 50;

    let gains = 0;
    let losses = 0;

    // Calculate initial average gain/loss
    for (let i = 1; i <= period; i++) {
      const change = closes[i] - closes[i - 1];
      if (change > 0) {
        gains += change;
      } else {
        losses += Math.abs(change);
      }
    }

    const avgGain = gains / period;
    const avgLoss = losses / period;

    // Calculate RSI using smoothed averages
    let rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));

    return rsi;
  }

  /**
   * Calculate EMA for trend filtering
   */
  calculateEMA(prices, period) {
    const k = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((sum, price) => sum + price, 0) / period;

    for (let i = period; i < prices.length; i++) {
      ema = prices[i] * k + ema * (1 - k);
    }

    return ema;
  }

  /**
   * Analyze market data and generate signal
   */
  async analyze(symbol, marketData) {
    try {
      const { klines } = marketData;

      // Extract closing prices
      const closes = klines.map(k => parseFloat(k[4]));

      if (closes.length < this.rsiPeriod + this.emaTrend + 1) {
        return null;
      }

      // Calculate RSI
      const rsi = this.calculateRSI(closes, this.rsiPeriod);

      // Previous RSI (for divergence detection)
      const prevCloses = closes.slice(0, -1);
      const prevRsi = this.calculateRSI(prevCloses, this.rsiPeriod);

      // Calculate trend EMA
      const emaTrend = this.calculateEMA(closes, this.emaTrend);
      const currentPrice = closes[closes.length - 1];

      // Determine trend
      const isUpTrend = currentPrice > emaTrend;
      const isDownTrend = currentPrice < emaTrend;

      // Detect RSI signals
      const rsiOversold = rsi < this.oversoldLevel && prevRsi >= this.oversoldLevel;
      const rsiOverbought = rsi > this.overboughtLevel && prevRsi <= this.overboughtLevel;

      // Bullish divergence (price makes lower low, RSI makes higher low)
      const recentHigh = Math.max(...closes.slice(-20));
      const recentLow = Math.min(...closes.slice(-20));
      const bullishDivergence = currentPrice < recentLow * 0.99 && rsi > prevRsi;

      // Bearish divergence (price makes higher high, RSI makes lower high)
      const bearishDivergence = currentPrice > recentHigh * 1.01 && rsi < prevRsi;

      let confidence = 0;
      let side = 'NEUTRAL';
      let signal = null;
      let reasons = [];

      if (rsiOversold && isUpTrend) {
        // Strong buy signal - oversold in uptrend
        confidence = 0.85;
        side = 'LONG';
        signal = 'BUY';
        reasons.push('RSI oversold');
        reasons.push('Uptrend confirmed');
      } else if (bullishDivergence) {
        // Strong divergence signal
        confidence = 0.8;
        side = 'LONG';
        signal = 'BUY';
        reasons.push('Bullish divergence');
      } else if (rsiOverbought && isDownTrend) {
        // Strong sell signal - overbought in downtrend
        confidence = 0.85;
        side = 'SHORT';
        signal = 'SELL';
        reasons.push('RSI overbought');
        reasons.push('Downtrend confirmed');
      } else if (bearishDivergence) {
        // Strong divergence signal
        confidence = 0.8;
        side = 'SHORT';
        signal = 'SELL';
        reasons.push('Bearish divergence');
      } else if (rsi < this.oversoldLevel) {
        // Moderate buy - just oversold
        confidence = 0.5;
        side = 'LONG';
        signal = 'BUY';
        reasons.push('RSI oversold (weak)');
      } else if (rsi > this.overboughtLevel) {
        // Moderate sell - just overbought
        confidence = 0.5;
        side = 'SHORT';
        signal = 'SELL';
        reasons.push('RSI overbought (weak)');
      }

      // Calculate support/resistance levels
      const low = Math.min(...closes.slice(-50));
      const high = Math.max(...closes.slice(-50));
      const atr = this.calculateATR(klines.slice(-14));

      // Determine stop loss and take profit
      let stopLoss, takeProfit;
      if (side === 'LONG') {
        stopLoss = Math.max(low, currentPrice - (atr * 2));
        stopLoss = Math.floor(stopLoss * 100) / 100;
      } else if (side === 'SHORT') {
        stopLoss = Math.min(high, currentPrice + (atr * 2));
        stopLoss = Math.floor(stopLoss * 100) / 100;
      }

      takeProfit = this.calculateTakeProfit(currentPrice, stopLoss, this.minRiskRewardRatio, side, 0.01);

      // Validate risk-reward
      const rrValidation = this.validateRiskReward(currentPrice, stopLoss, takeProfit);

      // Generate indicators for confluence
      const indicators = {
        rsi: {
          value: rsi,
          signal: rsi < this.oversoldLevel ? 'BULLISH' : rsi > this.overboughtLevel ? 'BEARISH' : 'NEUTRAL',
        },
        emaTrend: {
          value: emaTrend,
          signal: currentPrice > emaTrend ? 'BULLISH' : 'BEARISH',
        },
        divergence: {
          value: bullishDivergence ? 'BULLISH' : bearishDivergence ? 'BEARISH' : 'NEUTRAL',
          signal: bullishDivergence ? 'BULLISH' : bearishDivergence ? 'BEARISH' : 'NEUTRAL',
        },
      };

      const result = {
        symbol,
        side,
        entryPrice: currentPrice,
        stopLoss,
        takeProfit,
        confidence,
        indicators,
        strategy: this.name,
        timestamp: Date.now(),
        marketConditions: {
          trend: isUpTrend ? 'UP' : isDownTrend ? 'DOWN' : 'SIDEWAYS',
          rsiLevel: rsi,
          volatility: atr / currentPrice,
        },
        valid: signal !== null && rrValidation.valid,
        riskRewardRatio: rrValidation.actualRatio,
        reasons,
      };

      this.lastAnalysisTime = Date.now();

      if (result.valid) {
        this.logSignal(result);
      }

      return result;

    } catch (error) {
      logger.error('RSI Strategy analysis error', { symbol, error: error.message });
      return null;
    }
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

    const atr = trueRanges.slice(-period).reduce((sum, tr) => sum + tr, 0) / period;
    return atr;
  }
}

module.exports = RSIStrategy;
