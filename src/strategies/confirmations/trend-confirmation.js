const BaseConfirmation = require('./base-confirmation');

/**
 * TrendConfirmation
 * Validates EMA 20/50 alignment and trend strength
 */
class TrendConfirmation extends BaseConfirmation {
  constructor() {
    super('Trend Confirmation');
  }

  /**
   * Calculate slope to detect flatness
   */
  calculateSlope(emaHistory, periods = 5) {
    if (emaHistory.length < periods) return 0;
    
    const recent = emaHistory.slice(-periods);
    const first = recent[0];
    const last = recent[recent.length - 1];
    
    return (last - first) / first;
  }

  async evaluate(symbol, marketData, indicators, derivativesData, side) {
    const { ema20, ema50, currentPrice, ema20History, ema50History } = indicators;
    
    // Check EMA alignment
    const bullishAlignment = currentPrice > ema20 && currentPrice > ema50 && ema20 > ema50;
    const bearishAlignment = currentPrice < ema20 && currentPrice < ema50 && ema20 < ema50;
    
    // Check EMA slope (not flat) - threshold ±0.1%
    const ema20Slope = this.calculateSlope(ema20History, 5);
    const ema50Slope = this.calculateSlope(ema50History, 5);
    const isFlat = Math.abs(ema20Slope) < 0.001 && Math.abs(ema50Slope) < 0.001;
    
    const passed = !isFlat && (
      (side === 'LONG' && bullishAlignment) ||
      (side === 'SHORT' && bearishAlignment)
    );
    
    let reason = '';
    if (isFlat) {
      reason = 'EMAs are flat - no clear trend';
    } else if (passed) {
      reason = `EMA alignment confirmed for ${side}`;
    } else {
      reason = `EMA alignment failed for ${side}`;
    }
    
    return {
      name: this.name,
      passed,
      reason,
      details: {
        ema20: ema20.toFixed(2),
        ema50: ema50.toFixed(2),
        currentPrice: currentPrice.toFixed(2),
        ema20Slope: (ema20Slope * 100).toFixed(3) + '%',
        ema50Slope: (ema50Slope * 100).toFixed(3) + '%',
        isFlat
      }
    };
  }
}

module.exports = TrendConfirmation;
