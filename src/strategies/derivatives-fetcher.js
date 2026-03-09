const logger = require('../utils/logger');

/**
 * DerivativesDataFetcher
 * Fetches and caches derivatives data from Binance
 */
class DerivativesDataFetcher {
  constructor(binanceAPI, redisClient) {
    this.api = binanceAPI;
    this.redis = redisClient;
    this.cacheTTL = 60; // 1 minute
  }

  /**
   * Get funding rate with caching
   */
  async getFundingRate(symbol) {
    const cacheKey = `funding:${symbol}`;
    
    try {
      // Check cache first (RedisClient already handles JSON parse)
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return cached; // Already parsed by RedisClient
      }
      
      // Fetch from API
      const data = await this.api.getFundingRate(symbol);
      const result = {
        fundingRate: parseFloat(data.lastFundingRate),
        nextFundingTime: data.nextFundingTime,
        markPrice: parseFloat(data.markPrice)
      };
      
      // Cache result using RedisClient wrapper
      await this.redis.set(cacheKey, result, this.cacheTTL);
      return result;
    } catch (error) {
      logger.error('Funding rate fetch error', { symbol, error: error.message });
      
      // Try to return cached data even if expired
      try {
        const cached = await this.redis.get(cacheKey);
        if (cached) {
          logger.warn('Using expired cache for funding rate', { symbol });
          return cached; // Already parsed by RedisClient
        }
      } catch (e) {
        // Ignore cache read errors
      }
      
      return { fundingRate: 0, nextFundingTime: 0, markPrice: 0 };
    }
  }

  /**
   * Get open interest with historical comparison
   */
  async getOpenInterest(symbol) {
    const cacheKey = `oi:${symbol}`;
    
    try {
      // Check cache first (RedisClient already handles JSON parse)
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return cached; // Already parsed by RedisClient
      }
      
      // Fetch current and historical OI in parallel
      const [current, historical] = await Promise.all([
        this.api.getOpenInterestStats(symbol),
        this.api.getOpenInterestHistory(symbol, '1h', 2)
      ]);
      
      const result = {
        current: parseFloat(current.openInterest),
        previous: historical.length > 0 ? parseFloat(historical[0].sumOpenInterest) : parseFloat(current.openInterest)
      };
      
      // Cache result using RedisClient wrapper
      await this.redis.set(cacheKey, result, this.cacheTTL);
      return result;
    } catch (error) {
      logger.error('Open interest fetch error', { symbol, error: error.message });
      
      // Try to return cached data even if expired
      try {
        const cached = await this.redis.get(cacheKey);
        if (cached) {
          logger.warn('Using expired cache for open interest', { symbol });
          return cached;
        }
      } catch (e) {
        // Ignore cache read errors
      }
      
      return { current: 0, previous: 0 };
    }
  }

  /**
   * Get long/short ratio with caching
   */
  async getLongShortRatio(symbol) {
    const cacheKey = `lsr:${symbol}`;
    
    try {
      // Check cache first
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return parseFloat(cached);
      }
      
      // Fetch from API
      const data = await this.api.getLongShortRatio(symbol, '1h', 1);
      const ratio = data.length > 0 ? parseFloat(data[0].longShortRatio) : 1.0;
      
      // Cache result using RedisClient wrapper
      await this.redis.set(cacheKey, ratio, this.cacheTTL);
      return ratio;
    } catch (error) {
      logger.error('Long/short ratio fetch error', { symbol, error: error.message });
      
      // Try to return cached data even if expired
      try {
        const cached = await this.redis.get(cacheKey);
        if (cached) {
          logger.warn('Using expired cache for long/short ratio', { symbol });
          return parseFloat(cached);
        }
      } catch (e) {
        // Ignore cache read errors
      }
      
      return 1.0;
    }
  }

  /**
   * Fetch all derivatives data in parallel
   */
  async fetchAll(symbol) {
    try {
      const [fundingData, openInterest, longShortRatio] = await Promise.all([
        this.getFundingRate(symbol),
        this.getOpenInterest(symbol),
        this.getLongShortRatio(symbol)
      ]);
      
      return {
        fundingRate: fundingData.fundingRate,
        nextFundingTime: fundingData.nextFundingTime,
        markPrice: fundingData.markPrice,
        openInterest: openInterest.current,
        openInterestPrev: openInterest.previous,
        longShortRatio
      };
    } catch (error) {
      logger.error('Derivatives data fetch error', { symbol, error: error.message });
      return {
        fundingRate: 0,
        nextFundingTime: 0,
        markPrice: 0,
        openInterest: 0,
        openInterestPrev: 0,
        longShortRatio: 1.0
      };
    }
  }
}

module.exports = DerivativesDataFetcher;
