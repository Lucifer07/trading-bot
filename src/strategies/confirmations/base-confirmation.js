/**
 * BaseConfirmation
 * Abstract base class for all confirmation layers
 */
class BaseConfirmation {
  constructor(name) {
    this.name = name;
  }

  /**
   * Evaluate confirmation
   * Must be implemented by subclasses
   * 
   * @returns {Object} { name, passed, reason, details }
   */
  async evaluate(symbol, marketData, indicators, derivativesData, side) {
    throw new Error('evaluate() must be implemented by subclass');
  }
}

module.exports = BaseConfirmation;
