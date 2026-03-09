const BaseConfirmation = require('./base-confirmation');
const logger = require('../../utils/logger');

/**
 * MarketContextConfirmation
 * Validates BTC correlation for altcoins
 */
class MarketContextConfirmation extends BaseConfirmation {
  constructor(binanceAPI) {
    super('Market Context Confirmation');
    this.api = binanceAPI;
    this.btcCache = null;
    this.btcCacheTime = 0;
    this.btcCacheTTL = 60000; // 1 minute
  }

  /**
   * Get BTC price change
   */
  async getBTCPriceChange(period = '1h') {
    try {
      // Check cache
      if (this.btcCache && (Date.now() - this.btcCacheTime) < this.btcCacheTTL) {
        return this.btcCache;
      }
      
      // Fetch BTC ticker
      const ticker = await this.api.get24hrTicker('BTCUSDT');
      const priceChange = parseFloat(ticker.priceChangePercent);
      
      // Cache result
      this.btcCache = priceChange;
      this.btcCacheTime = Date.now();
      
      return priceChange;
    } catch (error) {
      logger.error('BTC price change fetch error', { error: error.message });
      return 0;
    }
  }

  async evaluate(symbol, marketData, indicators, derivativesData, side) {
    // Auto-pass for BTCUSDT
    if (symbol === 'BTCUSDT') {
      return {
        name: this.name,
        passed: true,
        reason: 'BTC symbol - auto pass',
        details: { symbol, autoPass: true }
      };
    }
    
    // Fetch BTC 1h price change
    const btcChange = await this.getBTCPriceChange('1h');
    
    // Check alignment
    const aligned = (side === 'LONG' && btcChange > 0) || (side === 'SHORT' && btcChange < 0);
    
    const reason = aligned 
      ? `BTC ${btcChange > 0 ? 'bullish' : 'bearish'} aligns with ${side}`
      : `BTC ${btcChange > 0 ? 'bullish' : 'bearish'} conflicts with ${side}`;
    
    return {
      name: this.name,
      passed: aligned,
      reason,
      details: {
        symbol,
        btcChange: btcChange.toFixed(2) + '%',
        side,
        aligned
      }
    };
  }
}

module.exports = MarketContextConfirmation;
