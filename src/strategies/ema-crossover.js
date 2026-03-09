const BaseStrategy = require('./base-strategy');
const logger = require('../utils/logger');

class EMACrossoverStrategy extends BaseStrategy {
  constructor(config = {}) {
    super({
      name: 'EMA Crossover',
      timeframe: config.timeframe || '1h',
      riskPercent: config.riskPercent || 1,
      minRiskRewardRatio: config.minRiskRewardRatio || 2,
      maxPositions: config.maxPositions || 2,
      enabled: config.enabled !== false,
    });

    this.emaFast = config.emaFast || 9;
    this.emaSlow = config.emaSlow || 21;
    this.emaTrend = config.emaTrend || 50;

    logger.info('EMA Crossover Strategy initialized', {
      emaFast: this.emaFast,
      emaSlow: this.emaSlow,
      emaTrend: this.emaTrend,
    });
  }

  /**
   * Calculate EMA (Exponential Moving Average)
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
      logger.info(`📊 [EMA Crossover] Starting analysis for ${symbol}`);
      
      const { klines } = marketData;

      // Extract closing prices
      const closes = klines.map(k => parseFloat(k[4]));

      logger.debug(`[EMA Crossover] ${symbol}: Using ${closes.length} candles for calculation`);

      if (closes.length < Math.max(this.emaFast, this.emaSlow, this.emaTrend)) {
        logger.debug(`❌ [EMA Crossover] ${symbol}: Insufficient data (${closes.length} candles)`);
        return null;
      }

      // Calculate EMAs
      const emaFast = this.calculateEMA(closes, this.emaFast);
      const emaSlow = this.calculateEMA(closes, this.emaSlow);
      const emaTrend = this.calculateEMA(closes, this.emaTrend);

      // Previous EMAs (for crossover detection)
      const prevCloses = closes.slice(0, -1);
      const emaFastPrev = this.calculateEMA(prevCloses, this.emaFast);
      const emaSlowPrev = this.calculateEMA(prevCloses, this.emaSlow);
      const emaTrendPrev = this.calculateEMA(prevCloses, this.emaTrend);

      const currentPrice = closes[closes.length - 1];
      const prevPrice = prevCloses[prevCloses.length - 1];

      logger.info(`📈 [EMA Crossover] ${symbol}: Price=${currentPrice.toFixed(6)}, EMA9=${emaFast.toFixed(6)}, EMA21=${emaSlow.toFixed(6)}, EMA50=${emaTrend.toFixed(6)}`);
      logger.info(`📉 [EMA Crossover] ${symbol}: Previous - EMA9=${emaFastPrev.toFixed(6)}, EMA21=${emaSlowPrev.toFixed(6)}`);

      // Determine trend
      const isUpTrend = currentPrice > emaTrend;
      const isDownTrend = currentPrice < emaTrend;

      logger.info(`🎯 [EMA Crossover] ${symbol}: Trend=${isUpTrend ? 'UP' : isDownTrend ? 'DOWN' : 'SIDEWAYS'}`);

      // Detect crossovers
      const bullishCross = emaFastPrev <= emaSlowPrev && emaFast > emaSlow;
      const bearishCross = emaFastPrev >= emaSlowPrev && emaFast < emaSlow;

      logger.info(`🔍 [EMA Crossover] ${symbol}: Crossover check - Bullish=${bullishCross}, Bearish=${bearishCross}`);
      
      if (!bullishCross && !bearishCross) {
        const alignment = emaFast > emaSlow ? 'EMA9 > EMA21 (already bullish)' : 'EMA9 < EMA21 (already bearish)';
        logger.info(`❌ [EMA Crossover] ${symbol}: No fresh crossover detected. Current: ${alignment}`);
      }

      // Calculate confidence based on EMA alignment
      let confidence = 0;
      let side = 'NEUTRAL';
      let signal = null;

      if (bullishCross && isUpTrend) {
        // Strong bullish signal
        confidence = 0.8;
        side = 'LONG';
        signal = 'BUY';
        logger.info(`✅ [EMA Crossover] ${symbol}: STRONG BULLISH signal (crossover + uptrend), confidence=80%`);
      } else if (bullishCross) {
        // Moderate bullish signal
        confidence = 0.6;
        side = 'LONG';
        signal = 'BUY';
        logger.info(`✅ [EMA Crossover] ${symbol}: MODERATE BULLISH signal (crossover only), confidence=60%`);
      } else if (bearishCross && isDownTrend) {
        // Strong bearish signal
        confidence = 0.8;
        side = 'SHORT';
        signal = 'SELL';
        logger.info(`✅ [EMA Crossover] ${symbol}: STRONG BEARISH signal (crossover + downtrend), confidence=80%`);
      } else if (bearishCross) {
        // Moderate bearish signal
        confidence = 0.6;
        side = 'SHORT';
        signal = 'SELL';
        logger.info(`✅ [EMA Crossover] ${symbol}: MODERATE BEARISH signal (crossover only), confidence=60%`);
      } else {
        logger.info(`❌ [EMA Crossover] ${symbol}: No signal generated`);
      }

      // Generate indicators for confluence
      const indicators = {
        emaFast: { value: emaFast, signal: currentPrice > emaFast ? 'BULLISH' : 'BEARISH' },
        emaSlow: { value: emaSlow, signal: currentPrice > emaSlow ? 'BULLISH' : 'BEARISH' },
        emaTrend: { value: emaTrend, signal: currentPrice > emaTrend ? 'BULLISH' : 'BEARISH' },
        crossover: {
          value: signal,
          signal: bullishCross ? 'BULLISH' : bearishCross ? 'BEARISH' : 'NEUTRAL',
        },
      };

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
          volatility: atr / currentPrice,
        },
        valid: signal !== null && rrValidation.valid,
        riskRewardRatio: rrValidation.actualRatio,
        reasons: signal ? [signal] : [],
      };

      this.lastAnalysisTime = Date.now();

      if (result.valid) {
        this.logSignal(result);
      }

      return result;

    } catch (error) {
      logger.error('EMA Crossover analysis error', { symbol, error: error.message });
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

    // Average the true ranges
    const atr = trueRanges.slice(-period).reduce((sum, tr) => sum + tr, 0) / period;
    return atr;
  }
}

module.exports = EMACrossoverStrategy;
