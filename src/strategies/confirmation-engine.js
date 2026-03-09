const logger = require('../utils/logger');
const TrendConfirmation = require('./confirmations/trend-confirmation');
const MomentumConfirmation = require('./confirmations/momentum-confirmation');
const VolumeConfirmation = require('./confirmations/volume-confirmation');
const MarketContextConfirmation = require('./confirmations/market-context-confirmation');
const DerivativesConfirmation = require('./confirmations/derivatives-confirmation');

/**
 * ConfirmationEngine
 * Orchestrates all confirmation layers
 */
class ConfirmationEngine {
  constructor(config = {}) {
    this.requiredPasses = config.requiredConfirmations || 4;
    
    // Initialize all confirmation layers
    this.confirmations = [
      new TrendConfirmation(),
      new MomentumConfirmation(),
      new VolumeConfirmation(),
      new MarketContextConfirmation(config.binanceAPI),
      new DerivativesConfirmation()
    ];
    
    logger.info('ConfirmationEngine initialized', {
      totalLayers: this.confirmations.length,
      requiredPasses: this.requiredPasses
    });
  }

  /**
   * Evaluate all confirmation layers in parallel
   */
  async evaluateAll(symbol, marketData, indicators, derivativesData, side) {
    try {
      logger.info(`   🔍 [Confirmation Engine] Evaluating ${this.confirmations.length} layers for ${side} signal...`);
      
      // Execute all confirmations in parallel
      const results = await Promise.all(
        this.confirmations.map(confirmation =>
          confirmation.evaluate(symbol, marketData, indicators, derivativesData, side)
            .then(result => {
              const status = result.passed ? '✅' : '❌';
              logger.info(`      ${status} ${result.name}: ${result.reason}`);
              if (result.details && Object.keys(result.details).length > 0) {
                logger.debug(`         Details: ${JSON.stringify(result.details)}`);
              }
              return result;
            })
            .catch(error => {
              logger.error(`      ❌ ${confirmation.name}: Error - ${error.message}`);
              return {
                name: confirmation.name,
                passed: false,
                reason: `Error: ${error.message}`,
                details: {}
              };
            })
        )
      );
      
      // Count passed confirmations
      const passedCount = results.filter(r => r.passed).length;
      const passedNames = results.filter(r => r.passed).map(r => r.name);
      const failedNames = results.filter(r => !r.passed).map(r => r.name);
      
      // Calculate confidence score
      const confidence = (passedCount / this.confirmations.length) * 100;
      
      logger.info(`   📊 [Confirmation Engine] Results: ${passedCount}/${this.confirmations.length} passed (${confidence.toFixed(0)}%)`);
      logger.info(`      ✅ Passed: ${passedNames.join(', ') || 'None'}`);
      logger.info(`      ❌ Failed: ${failedNames.join(', ') || 'None'}`);
      
      return {
        results,
        passedCount,
        totalCount: this.confirmations.length,
        confidence,
        meetsThreshold: passedCount >= this.requiredPasses
      };
    } catch (error) {
      logger.error('ConfirmationEngine evaluation error', {
        symbol,
        error: error.message
      });
      return {
        results: [],
        passedCount: 0,
        totalCount: this.confirmations.length,
        confidence: 0,
        meetsThreshold: false
      };
    }
  }
}

module.exports = ConfirmationEngine;
