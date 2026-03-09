/**
 * TwoStageTakeProfitManager
 * Calculates two-stage TP levels and manages trailing stops
 */
class TwoStageTakeProfitManager {
  constructor(config = {}) {
    this.tp1Ratio = config.tp1Ratio || 1.5;
    this.tp2Ratio = config.tp2Ratio || 2.5;
    this.trailingStopATRMultiplier = config.trailingStopATRMultiplier || 1.0;
    this.stopLossATRMultiplier = config.stopLossATRMultiplier || 2.0;
  }

  /**
   * Calculate take profit levels
   */
  calculateTakeProfitLevels(entryPrice, stopLoss, side, atr) {
    const riskAmount = Math.abs(entryPrice - stopLoss);
    
    let tp1, tp2;
    if (side === 'LONG') {
      tp1 = entryPrice + (riskAmount * this.tp1Ratio);
      tp2 = entryPrice + (riskAmount * this.tp2Ratio);
    } else {
      tp1 = entryPrice - (riskAmount * this.tp1Ratio);
      tp2 = entryPrice - (riskAmount * this.tp2Ratio);
    }
    
    return {
      tp1: this.roundToTickSize(tp1, 0.01),
      tp2: this.roundToTickSize(tp2, 0.01),
      trailingStopDistance: atr * this.trailingStopATRMultiplier,
      breakeven: entryPrice
    };
  }

  /**
   * Calculate stop loss based on ATR
   */
  calculateStopLoss(entryPrice, atr, side) {
    let stopLoss;
    if (side === 'LONG') {
      stopLoss = entryPrice - (atr * this.stopLossATRMultiplier);
    } else {
      stopLoss = entryPrice + (atr * this.stopLossATRMultiplier);
    }
    
    return this.roundToTickSize(stopLoss, 0.01);
  }

  /**
   * Round to tick size
   */
  roundToTickSize(price, tickSize) {
    const decimalPlaces = this.countDecimalPlaces(tickSize);
    const multiplier = Math.pow(10, decimalPlaces);
    return Math.floor(price * multiplier) / multiplier;
  }

  /**
   * Count decimal places
   */
  countDecimalPlaces(value) {
    if (value === 0) return 0;
    const str = value.toString();
    if (str.indexOf('.') === -1) return 0;
    return str.split('.')[1].length;
  }
}

module.exports = TwoStageTakeProfitManager;
