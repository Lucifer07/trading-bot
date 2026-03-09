const BaseConfirmation = require('./base-confirmation');

/**
 * MomentumConfirmation
 * Validates RSI and MACD agreement
 */
class MomentumConfirmation extends BaseConfirmation {
  constructor() {
    super('Momentum Confirmation');
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

  async evaluate(symbol, marketData, indicators, derivativesData, side) {
    const { rsi, macdHistogram, macdHistogramPrev, macdHistory, macdSignalHistory } = indicators;
    
    // RSI must be in neutral zone (40-60)
    const rsiValid = rsi >= 40 && rsi <= 60;
    
    // MACD histogram must be growing
    const histogramGrowing = macdHistogram > macdHistogramPrev;
    
    // MACD signal line crossed within last 3 periods
    const signalCrossed = this.detectCross(macdHistory, macdSignalHistory, 3);
    
    const macdValid = histogramGrowing && signalCrossed;
    
    // Both must agree
    const passed = rsiValid && macdValid;
    
    let reason = '';
    if (!rsiValid) {
      reason = `RSI ${rsi.toFixed(1)} outside neutral zone (40-60)`;
    } else if (!histogramGrowing) {
      reason = 'MACD histogram not growing';
    } else if (!signalCrossed) {
      reason = 'No recent MACD signal crossover';
    } else {
      reason = 'RSI and MACD aligned';
    }
    
    return {
      name: this.name,
      passed,
      reason,
      details: {
        rsi: rsi.toFixed(1),
        rsiValid,
        macdHistogram: macdHistogram.toFixed(4),
        macdHistogramPrev: macdHistogramPrev.toFixed(4),
        histogramGrowing,
        signalCrossed,
        macdValid
      }
    };
  }
}

module.exports = MomentumConfirmation;
