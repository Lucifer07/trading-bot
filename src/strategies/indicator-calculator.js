const logger = require('../utils/logger');

/**
 * IndicatorCalculator
 * Calculates all technical indicators for multi-confirmation strategy
 */
class IndicatorCalculator {
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
   * Calculate slope of EMA to detect flatness
   */
  calculateSlope(emaHistory, periods = 5) {
    if (emaHistory.length < periods) return 0;
    
    const recent = emaHistory.slice(-periods);
    const first = recent[0];
    const last = recent[recent.length - 1];
    
    return (last - first) / first;
  }

  /**
   * Calculate RSI (Relative Strength Index)
   */
  calculateRSI(prices, period = 14) {
    if (prices.length < period + 1) return 50;
    
    let gains = 0;
    let losses = 0;
    
    // Calculate initial average gain/loss (first 14 periods)
    for (let i = 1; i <= period; i++) {
      const change = prices[i] - prices[i - 1];
      if (change > 0) {
        gains += change;
      } else {
        losses += Math.abs(change);
      }
    }
    
    const avgGain = gains / period;
    const avgLoss = losses / period;
    
    if (avgLoss === 0) return 100;
    
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  /**
   * Calculate MACD (Moving Average Convergence Divergence)
   */
  calculateMACD(prices, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    if (prices.length < slowPeriod) return null;
    
    const emaFast = this.calculateEMA(prices, fastPeriod);
    const emaSlow = this.calculateEMA(prices, slowPeriod);
    const macdLine = emaFast - emaSlow;
    
    // Calculate signal line (EMA of MACD)
    const macdHistory = this.calculateMACDHistory(prices, fastPeriod, slowPeriod);
    const signalLine = this.calculateEMA(macdHistory, signalPeriod);
    
    const histogram = macdLine - signalLine;
    
    return { macd: macdLine, signal: signalLine, histogram };
  }

  /**
   * Calculate MACD history
   */
  calculateMACDHistory(prices, fastPeriod, slowPeriod) {
    const history = [];
    const minLength = Math.max(fastPeriod, slowPeriod);
    
    for (let i = minLength; i <= prices.length; i++) {
      const slice = prices.slice(0, i);
      const emaFast = this.calculateEMA(slice, fastPeriod);
      const emaSlow = this.calculateEMA(slice, slowPeriod);
      if (emaFast !== null && emaSlow !== null) {
        history.push(emaFast - emaSlow);
      }
    }
    
    return history;
  }

  /**
   * Calculate MACD signal line history
   */
  calculateMACDSignalHistory(prices, fastPeriod, slowPeriod, signalPeriod) {
    const macdHistory = this.calculateMACDHistory(prices, fastPeriod, slowPeriod);
    const history = [];
    
    for (let i = signalPeriod; i <= macdHistory.length; i++) {
      const slice = macdHistory.slice(0, i);
      const signal = this.calculateEMA(slice, signalPeriod);
      if (signal !== null) {
        history.push(signal);
      }
    }
    
    return history;
  }

  /**
   * Detect crossover in MACD
   */
  detectCross(macdHistory, signalHistory, periods = 3) {
    if (macdHistory.length < periods || signalHistory.length < periods) return false;
    
    const recentMacd = macdHistory.slice(-periods);
    const recentSignal = signalHistory.slice(-periods);
    
    // Check if sign changed
    for (let i = 1; i < periods; i++) {
      const prevDiff = recentMacd[i - 1] - recentSignal[i - 1];
      const currDiff = recentMacd[i] - recentSignal[i];
      
      if ((prevDiff < 0 && currDiff > 0) || (prevDiff > 0 && currDiff < 0)) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Calculate ATR (Average True Range)
   */
  calculateATR(klines, period = 14) {
    if (klines.length < period + 1) return 0;
    
    const trueRanges = [];
    for (let i = 1; i < klines.length; i++) {
      const high = parseFloat(klines[i][2]);
      const low = parseFloat(klines[i][3]);
      const prevClose = parseFloat(klines[i - 1][4]);
      
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
   * Calculate CVD (Cumulative Volume Delta)
   */
  calculateCVD(trades, periods = 10) {
    if (!trades || trades.length === 0) return 0;
    
    let cvd = 0;
    const recentTrades = trades.slice(-periods);
    
    for (const trade of recentTrades) {
      const volume = parseFloat(trade.qty);
      // If buyer is maker, it's a sell (subtract), otherwise it's a buy (add)
      cvd += trade.isBuyerMaker ? -volume : volume;
    }
    
    // Normalize by total volume
    const totalVolume = recentTrades.reduce((sum, t) => sum + parseFloat(t.qty), 0);
    return totalVolume > 0 ? cvd / totalVolume : 0;
  }

  /**
   * Calculate all indicators at once
   */
  async calculateAll(symbol, marketData) {
    try {
      const { klines, trades } = marketData;
      const closes = klines.map(k => parseFloat(k[4]));
      const volumes = klines.map(k => parseFloat(k[5]));
      
      logger.info(`[IndicatorCalculator] ${symbol}: Calculating with ${closes.length} candles, current price=${closes[closes.length - 1].toFixed(6)}`);
      
      const ema20History = this.calculateEMAHistory(closes, 20, 10);
      const ema50History = this.calculateEMAHistory(closes, 50, 10);
      const macdHistory = this.calculateMACDHistory(closes, 12, 26);
      const macdSignalHistory = this.calculateMACDSignalHistory(closes, 12, 26, 9);
      const macdData = this.calculateMACD(closes);
      
      // Calculate previous MACD histogram
      let macdHistogramPrev = 0;
      if (macdHistory.length >= 2 && macdSignalHistory.length >= 2) {
        macdHistogramPrev = macdHistory[macdHistory.length - 2] - macdSignalHistory[macdSignalHistory.length - 2];
      }
      
      const rsi = this.calculateRSI(closes, 14);
      logger.info(`[IndicatorCalculator] ${symbol}: RSI=${rsi.toFixed(2)} (calculated from ${closes.length} candles)`);
      
      return {
        ema20: this.calculateEMA(closes, 20),
        ema50: this.calculateEMA(closes, 50),
        ema20History,
        ema50History,
        rsi,
        macd: macdData?.macd || 0,
        macdSignal: macdData?.signal || 0,
        macdHistogram: macdData?.histogram || 0,
        macdHistory,
        macdSignalHistory,
        macdHistogramPrev,
        atr: this.calculateATR(klines, 14),
        volume: volumes[volumes.length - 1],
        avgVolume: volumes.slice(-20).reduce((sum, v) => sum + v, 0) / 20,
        cvd: trades ? this.calculateCVD(trades, 10) : 0,
        currentPrice: closes[closes.length - 1]
      };
    } catch (error) {
      logger.error('Indicator calculation error', { symbol, error: error.message });
      return null;
    }
  }
}

module.exports = IndicatorCalculator;
