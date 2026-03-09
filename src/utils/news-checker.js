const logger = require('./logger');
const axios = require('axios');

/**
 * News Checker
 * Checks crypto news sentiment before trading to avoid volatile events
 */
class NewsChecker {
  constructor(config = {}) {
    this.enabled = config.enabled !== false;
    this.checkInterval = config.checkInterval || 15 * 60 * 1000; // 15 minutes
    this.newsCache = new Map();
    this.lastCheckTime = null;
    
    // News sources (CryptoPanic API v2)
    this.apiKey = process.env.CRYPTOPANIC_API_KEY || null;
    this.apiPlan = process.env.CRYPTOPANIC_API_PLAN || 'developer'; // development, growth, enterprise
    
    this.sources = {
      // API format: https://cryptopanic.com/api/{plan}/posts/
      cryptoPanic: `https://cryptopanic.com/api/${this.apiPlan}/v2/posts/`,
    };
    
    // High-impact keywords that should pause trading
    this.highImpactKeywords = [
      'hack', 'hacked', 'exploit', 'exploited', 'vulnerability',
      'sec', 'lawsuit', 'regulation', 'ban', 'banned',
      'crash', 'dump', 'collapse', 'bankrupt', 'bankruptcy',
      'emergency', 'halt', 'suspended', 'investigation',
      'fraud', 'scam', 'rug pull', 'exit scam',
      'fed', 'interest rate', 'fomc', 'cpi', 'inflation'
    ];
    
    // Medium-impact keywords that increase caution
    this.mediumImpactKeywords = [
      'volatility', 'volatile', 'uncertainty', 'concern',
      'warning', 'alert', 'risk', 'fear',
      'sell-off', 'selling pressure', 'liquidation',
      'whale', 'large transfer', 'exchange outflow'
    ];
    
    logger.info('News Checker initialized', {
      enabled: this.enabled,
      checkInterval: this.checkInterval / 1000 + 's',
      hasCryptoPanicKey: !!this.apiKey,
      apiPlan: this.apiPlan,
    });
  }

  /**
   * Check if it's safe to trade based on recent news
   * @param {string} symbol - Trading symbol (e.g., 'BTCUSDT')
   * @returns {Object} Safety assessment
   */
  async checkTradingSafety(symbol) {
    if (!this.enabled) {
      return {
        safe: true,
        reason: 'News checking disabled',
        sentiment: 'NEUTRAL',
        confidence: 1.0,
      };
    }

    try {
      // Extract base asset (BTC from BTCUSDT)
      const baseAsset = symbol.replace('USDT', '').replace('BUSD', '');
      
      // Check if we need to refresh news
      const shouldRefresh = !this.lastCheckTime || 
        (Date.now() - this.lastCheckTime) > this.checkInterval;
      
      if (shouldRefresh) {
        await this.fetchLatestNews();
        this.lastCheckTime = Date.now();
      }
      
      // Analyze news for this symbol
      const analysis = this.analyzeNewsForSymbol(baseAsset);
      
      // Determine if safe to trade
      const isSafe = analysis.riskLevel !== 'HIGH' && analysis.sentiment !== 'VERY_NEGATIVE';
      
      logger.info('News safety check', {
        symbol,
        safe: isSafe,
        riskLevel: analysis.riskLevel,
        sentiment: analysis.sentiment,
        recentNews: analysis.newsCount,
      });
      
      return {
        safe: isSafe,
        reason: analysis.reason,
        sentiment: analysis.sentiment,
        riskLevel: analysis.riskLevel,
        confidence: analysis.confidence,
        newsCount: analysis.newsCount,
        recentHighImpact: analysis.highImpactCount,
      };
      
    } catch (error) {
      logger.error('News check error', { symbol, error: error.message });
      
      // On error, be conservative - allow trading but with caution
      // This ensures bot doesn't stop if news API fails
      return {
        safe: true,
        reason: 'News check unavailable, proceeding with caution',
        sentiment: 'UNKNOWN',
        riskLevel: 'LOW',
        confidence: 0.5,
      };
    }
  }

  /**
   * Fetch latest crypto news
   */
  async fetchLatestNews() {
    try {
      const news = [];
      
      // Try CryptoPanic API if key available
      if (this.apiKey) {
        const cryptoPanicNews = await this.fetchCryptoPanicNews();
        news.push(...cryptoPanicNews);
      }
      
      // Fallback: Use RSS feeds or other free sources
      if (news.length === 0) {
        logger.debug('No API key or no news fetched, using fallback');
        // For now, return empty - can add RSS parser later
      }
      
      // Cache news by symbol
      this.cacheNews(news);
      
      logger.debug('News fetched', { count: news.length });
      
    } catch (error) {
      logger.error('Fetch news error', { error: error.message });
    }
  }

  /**
   * Fetch news from CryptoPanic API
   */
  async fetchCryptoPanicNews() {
    try {
      const response = await axios.get(this.sources.cryptoPanic, {
        params: {
          auth_token: this.apiKey,
          public: true,
          kind: 'news',
          filter: 'hot',
          currencies: 'BTC,ETH,BNB,SOL', // Top coins
        },
        timeout: 5000,
      });
      
      if (response.data && response.data.results) {
        logger.info('CryptoPanic API success', { count: response.data.results.length });
        
        return response.data.results.map(item => ({
          title: item.title,
          published: item.published_at,
          source: item.source?.title || 'Unknown',
          url: item.url,
          currencies: item.currencies?.map(c => c.code) || [],
          votes: item.votes || {},
        }));
      }
      
      return [];
      
    } catch (error) {
      logger.error('CryptoPanic fetch error', { 
        error: error.message,
        status: error.response?.status,
        plan: this.apiPlan,
      });
      return [];
    }
  }

  /**
   * Cache news by symbol
   */
  cacheNews(newsItems) {
    // Clear old cache
    this.newsCache.clear();
    
    // Group news by currency
    newsItems.forEach(item => {
      if (item.currencies && item.currencies.length > 0) {
        item.currencies.forEach(currency => {
          if (!this.newsCache.has(currency)) {
            this.newsCache.set(currency, []);
          }
          this.newsCache.get(currency).push(item);
        });
      }
      
      // Also cache under 'GENERAL' for market-wide news
      if (!this.newsCache.has('GENERAL')) {
        this.newsCache.set('GENERAL', []);
      }
      this.newsCache.get('GENERAL').push(item);
    });
  }

  /**
   * Analyze news sentiment for a specific symbol
   */
  analyzeNewsForSymbol(baseAsset) {
    const symbolNews = this.newsCache.get(baseAsset) || [];
    const generalNews = this.newsCache.get('GENERAL') || [];
    const allRelevantNews = [...symbolNews, ...generalNews];
    
    if (allRelevantNews.length === 0) {
      return {
        riskLevel: 'LOW',
        sentiment: 'NEUTRAL',
        confidence: 0.7,
        reason: 'No recent news found',
        newsCount: 0,
        highImpactCount: 0,
      };
    }
    
    // Analyze last 24 hours of news
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    const recentNews = allRelevantNews.filter(item => {
      const publishedTime = new Date(item.published).getTime();
      return publishedTime > oneDayAgo;
    });
    
    // Count high and medium impact news
    let highImpactCount = 0;
    let mediumImpactCount = 0;
    let positiveCount = 0;
    let negativeCount = 0;
    
    recentNews.forEach(item => {
      const titleLower = item.title.toLowerCase();
      
      // Check for high-impact keywords
      const hasHighImpact = this.highImpactKeywords.some(keyword => 
        titleLower.includes(keyword)
      );
      
      if (hasHighImpact) {
        highImpactCount++;
        negativeCount++;
      }
      
      // Check for medium-impact keywords
      const hasMediumImpact = this.mediumImpactKeywords.some(keyword => 
        titleLower.includes(keyword)
      );
      
      if (hasMediumImpact) {
        mediumImpactCount++;
        negativeCount++;
      }
      
      // Check votes if available
      if (item.votes) {
        if (item.votes.positive > item.votes.negative) {
          positiveCount++;
        } else if (item.votes.negative > item.votes.positive) {
          negativeCount++;
        }
      }
    });
    
    // Determine risk level
    let riskLevel = 'LOW';
    let sentiment = 'NEUTRAL';
    let reason = 'Normal market conditions';
    
    if (highImpactCount > 0) {
      riskLevel = 'HIGH';
      sentiment = 'VERY_NEGATIVE';
      reason = `${highImpactCount} high-impact negative news in last 24h`;
    } else if (mediumImpactCount >= 3) {
      riskLevel = 'MEDIUM';
      sentiment = 'NEGATIVE';
      reason = `${mediumImpactCount} concerning news items in last 24h`;
    } else if (negativeCount > positiveCount * 2) {
      riskLevel = 'MEDIUM';
      sentiment = 'NEGATIVE';
      reason = 'Predominantly negative sentiment';
    } else if (positiveCount > negativeCount * 2) {
      sentiment = 'POSITIVE';
      reason = 'Predominantly positive sentiment';
    }
    
    // Calculate confidence based on news volume
    const confidence = Math.min(0.9, 0.5 + (recentNews.length * 0.05));
    
    return {
      riskLevel,
      sentiment,
      confidence,
      reason,
      newsCount: recentNews.length,
      highImpactCount,
      mediumImpactCount,
    };
  }

  /**
   * Get cached news for a symbol
   */
  getNewsForSymbol(baseAsset) {
    return this.newsCache.get(baseAsset) || [];
  }

  /**
   * Manual news check (for testing)
   */
  async manualCheck(symbol) {
    await this.fetchLatestNews();
    return this.checkTradingSafety(symbol);
  }

  /**
   * Get all cached news
   */
  getAllNews() {
    const allNews = {};
    this.newsCache.forEach((news, symbol) => {
      allNews[symbol] = news;
    });
    return allNews;
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.newsCache.clear();
    this.lastCheckTime = null;
    logger.info('News cache cleared');
  }
}

module.exports = NewsChecker;
