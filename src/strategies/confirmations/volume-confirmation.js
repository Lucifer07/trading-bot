const BaseConfirmation = require('./base-confirmation');

/**
 * VolumeConfirmation
 * Validates volume ratio and CVD
 */
class VolumeConfirmation extends BaseConfirmation {
  constructor() {
    super('Volume Confirmation');
  }

  async evaluate(symbol, marketData, indicators, derivativesData, side) {
    const { volume, avgVolume, cvd } = indicators;
    
    // Volume must be 1.5x average
    const volumeRatio = volume / avgVolume;
    const volumeValid = volumeRatio > 1.5;
    
    // CVD must align with direction
    const cvdValid = (side === 'LONG' && cvd > 0) || (side === 'SHORT' && cvd < 0);
    
    const passed = volumeValid && cvdValid;
    
    let reason = '';
    if (!volumeValid) {
      reason = `Volume ratio ${volumeRatio.toFixed(2)}x below threshold (1.5x)`;
    } else if (!cvdValid) {
      reason = `CVD ${cvd.toFixed(3)} not aligned with ${side}`;
    } else {
      reason = 'Volume and CVD confirmed';
    }
    
    return {
      name: this.name,
      passed,
      reason,
      details: {
        volume: volume.toFixed(0),
        avgVolume: avgVolume.toFixed(0),
        volumeRatio: volumeRatio.toFixed(2),
        volumeValid,
        cvd: cvd.toFixed(3),
        cvdValid
      }
    };
  }
}

module.exports = VolumeConfirmation;
