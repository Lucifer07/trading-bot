const BaseConfirmation = require('./base-confirmation');

/**
 * DerivativesConfirmation
 * Validates funding rate, open interest, and long/short ratio
 */
class DerivativesConfirmation extends BaseConfirmation {
  constructor() {
    super('Derivatives Confirmation');
  }

  async evaluate(symbol, marketData, indicators, derivativesData, side) {
    const { fundingRate, openInterest, openInterestPrev, longShortRatio } = derivativesData;
    
    // Funding rate must be neutral (-0.01% to +0.01%)
    const fundingNeutral = fundingRate >= -0.0001 && fundingRate <= 0.0001;
    
    // Open interest must be growing
    const oiGrowing = openInterest > openInterestPrev;
    
    // Long/short ratio must be balanced (0.8 to 1.2)
    const ratioBalanced = longShortRatio >= 0.8 && longShortRatio <= 1.2;
    
    const passed = fundingNeutral && oiGrowing && ratioBalanced;
    
    let reason = '';
    if (!fundingNeutral) {
      reason = `Funding rate ${(fundingRate * 100).toFixed(4)}% outside neutral range`;
    } else if (!oiGrowing) {
      reason = 'Open interest not growing';
    } else if (!ratioBalanced) {
      reason = `Long/short ratio ${longShortRatio.toFixed(2)} imbalanced`;
    } else {
      reason = 'Derivatives data healthy';
    }
    
    return {
      name: this.name,
      passed,
      reason,
      details: {
        fundingRate: (fundingRate * 100).toFixed(4) + '%',
        fundingNeutral,
        openInterest: openInterest.toFixed(0),
        openInterestPrev: openInterestPrev.toFixed(0),
        oiGrowing,
        longShortRatio: longShortRatio.toFixed(2),
        ratioBalanced
      }
    };
  }
}

module.exports = DerivativesConfirmation;
