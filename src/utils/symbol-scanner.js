const axios = require('axios');
const logger = require('./logger');
const { config } = require('../config');

class SymbolScanner {
  constructor(redis, telegram) {
    this.redis = redis;
    this.telegram = telegram;
    this.baseUrl = config.binance.baseUrl;
    this.isScanning = false;
  }

  async getExchangeInfo() {
    try {
      const response = await axios.get(`${this.baseUrl}/fapi/v1/exchangeInfo`);
      return response.data;
    } catch (error) {
      logger.error('Failed to fetch exchange info', { error: error.message });
      throw error;
    }
  }

  async get24hrTicker(symbol) {
    try {
      const response = await axios.get(`${this.baseUrl}/fapi/v1/ticker/24hr`, {
        params: { symbol }
      });
      return response.data;
    } catch (error) {
      logger.debug('Failed to fetch 24h ticker', { symbol, error: error.message });
      return null;
    }
  }

  async getKlines(symbol, interval = '1h', limit = 200) {
    try {
      const response = await axios.get(`${this.baseUrl}/fapi/v1/klines`, {
        params: { symbol, interval, limit }
      });
      return response.data;
    } catch (error) {
      logger.debug('Failed to fetch klines', { symbol, error: error.message });
      return null;
    }
  }

  calculateATR(klines, period = 14) {
    if (!klines || klines.length < period + 1) return 0;

    const trueRanges = [];
    for (let i = 1; i < klines.length; i++) {
      const current = klines[i];
      const previous = klines[i - 1];

      const high = parseFloat(current[2]);
      const low = parseFloat(current[3]);
      const prevClose = parseFloat(previous[4]);

      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );

      trueRanges.push(tr);
    }

    return trueRanges.slice(-period).reduce((sum, tr) => sum + tr, 0) / period;
  }

  calculateRSI(klines, period = 14) {
    if (!klines || klines.length < period + 1) return 50;

    const closes = klines.map(k => parseFloat(k[4]));

    let gains = 0;
    let losses = 0;

    // Calculate initial average gain/loss
    for (let i = 1; i <= period; i++) {
      const change = closes[i] - closes[i - 1];
      if (change > 0) {
        gains += change;
      } else {
        losses += Math.abs(change);
      }
    }

    const avgGain = gains / period;
    const avgLoss = losses / period;

    // Calculate RSI using smoothed averages
    const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));
    
    return rsi;
  }

  calculateEMA(prices, period) {
    if (!prices || prices.length < period) return prices[prices.length - 1];

    const k = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((sum, price) => sum + price, 0) / period;

    for (let i = period; i < prices.length; i++) {
      ema = prices[i] * k + ema * (1 - k);
    }

    return ema;
  }

  calculateTrend(klines) {
    if (!klines || klines.length < 50) return 'NEUTRAL';

    const closes = klines.map(k => parseFloat(k[4]));
    const ema9 = this.calculateEMA(closes, 9);
    const ema21 = this.calculateEMA(closes, 21);
    const ema50 = this.calculateEMA(closes, 50);
    const currentPrice = closes[closes.length - 1];

    const isUpTrend = ema9 > ema21 && ema21 > ema50 && currentPrice > ema50;
    const isDownTrend = ema9 < ema21 && ema21 < ema50 && currentPrice < ema50;

    if (isUpTrend) return 'UP';
    if (isDownTrend) return 'DOWN';
    return 'NEUTRAL';
  }

  calculateProfitPotential(ticker, klines, atr) {
    if (!ticker || !klines || klines.length === 0) return 0;

    const currentPrice = parseFloat(ticker.lastPrice);
    const volatility = atr / currentPrice;
    const volume = parseFloat(ticker.quoteVolume);
    const priceChangePercent = parseFloat(ticker.priceChangePercent);

    let score = 0;

    // Volatility score (0-30)
    if (volatility > 0.05) score += 30;
    else if (volatility > 0.03) score += 25;
    else if (volatility > 0.02) score += 20;
    else if (volatility > 0.01) score += 15;
    else score += 5;

    // Volume score (0-25)
    if (volume > 100000000) score += 25;
    else if (volume > 50000000) score += 20;
    else if (volume > 10000000) score += 15;
    else if (volume > 5000000) score += 10;
    else score += 5;

    // Trend score (0-25)
    const trend = this.calculateTrend(klines);
    if (trend === 'UP' || trend === 'DOWN') score += 25;
    else if (trend === 'NEUTRAL') score += 10;

    // Price change score (0-20)
    const absChange = Math.abs(priceChangePercent);
    if (absChange > 3) score += 20;
    else if (absChange > 2) score += 15;
    else if (absChange > 1) score += 10;
    else score += 5;

    return score;
  }

  async scanSymbols() {
      if (this.isScanning) {
        logger.warn('Symbol scan already in progress, skipping...');
        return null;
      }

      this.isScanning = true;
      const scanStartTime = Date.now();

      try {
        logger.info('Starting symbol scan...');

        // Get exchange info
        const exchangeInfo = await this.getExchangeInfo();

        // Filter USDT perpetual futures
        const symbols = exchangeInfo.symbols
          .filter(s => s.quoteAsset === 'USDT' && s.contractType === 'PERPETUAL' && s.status === 'TRADING')
          .map(s => s.symbol)
          .sort();

        logger.info(`Found ${symbols.length} USDT perpetual futures symbols`);

        // Parallel processing with batching to avoid rate limits
        const BATCH_SIZE = 50; // Process 50 symbols at a time
        const results = [];
        let processed = 0;

        // Split symbols into batches
        for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
          const batch = symbols.slice(i, i + BATCH_SIZE);

          // Process batch in parallel
          const batchPromises = batch.map(async (symbol) => {
            try {
              const ticker = await this.get24hrTicker(symbol);
              if (!ticker) return null;

              const klines = await this.getKlines(symbol, '1h', 200);
              if (!klines || klines.length < 50) return null;

              const atr = this.calculateATR(klines, 14);
              const rsi = this.calculateRSI(klines, 14);
              const trend = this.calculateTrend(klines);
              const profitPotential = this.calculateProfitPotential(ticker, klines, atr);

              // Log RSI calculation for debugging
              if (symbol === 'ARIAUSDT' || symbol === 'DEGOUSDT' || symbol === 'BOBUSDT') {
                logger.info(`[SymbolScanner] ${symbol}: RSI=${rsi.toFixed(2)} (from ${klines.length} candles), Price=${parseFloat(ticker.lastPrice).toFixed(6)}`);
              }

              return {
                symbol,
                price: parseFloat(ticker.lastPrice),
                volume: parseFloat(ticker.quoteVolume),
                priceChange: parseFloat(ticker.priceChangePercent),
                volatility: atr / parseFloat(ticker.lastPrice),
                rsi,
                trend,
                profitPotential,
                atr,
                // Store full data for strategies to use
                klines,
                trades: [], // Will be fetched by strategies if needed
                ticker,
                scannedAt: new Date().toISOString(),
              };
            } catch (error) {
              logger.debug('Error analyzing symbol', { symbol, error: error.message });
              return null;
            }
          });

          // Wait for batch to complete
          const batchResults = await Promise.all(batchPromises);

          // Filter out null results and add to main results
          results.push(...batchResults.filter(r => r !== null));

          processed += batch.length;
          logger.info(`Scan progress: ${processed}/${symbols.length}`);
        }

        // Sort by profit potential
        results.sort((a, b) => b.profitPotential - a.profitPotential);

        const scanDuration = ((Date.now() - scanStartTime) / 1000).toFixed(2);
        logger.info(`Symbol scan completed in ${scanDuration}s`, {
          totalSymbols: results.length,
          topScore: results[0]?.profitPotential || 0,
        });

        // Save to Redis for backup/reference
        await this.saveToRedis(results);

        this.isScanning = false;
        
        // Return results for immediate use by AutoTrader
        return results;

      } catch (error) {
        this.isScanning = false;
        logger.error('Symbol scan failed', { error: error.message, stack: error.stack });
        throw error;
      }
    }

  async saveToRedis(results) {
    try {
      const timestamp = new Date().toISOString();
      
      // Save all results
      await this.redis.set('symbol_scan:latest', {
        results,
        scannedAt: timestamp,
        count: results.length,
      }, 600); // TTL 10 minutes

      // Save top 20 separately for quick access
      const top20 = results.slice(0, 20);
      await this.redis.set('symbol_scan:top20', top20, 600);

      // Save individual symbol data
      for (const result of results) {
        await this.redis.hset('symbol_scan:symbols', result.symbol, result);
      }

      // Set expiry for hash
      await this.redis.expire('symbol_scan:symbols', 600);

      logger.info('Scan results saved to Redis', { 
        count: results.length,
        timestamp,
        top5RSI: results.slice(0, 5).map(r => `${r.symbol}:${r.rsi.toFixed(2)}`).join(', ')
      });
    } catch (error) {
      logger.error('Failed to save scan results to Redis', { error: error.message });
    }
  }

  async notifyTopOpportunities(topResults) {
    try {
      if (!this.telegram || !this.telegram.enabled || topResults.length === 0) {
        return;
      }

      // Log what we're about to send
      logger.info('Preparing Telegram notification', {
        count: topResults.length,
        top5RSI: topResults.slice(0, 5).map(r => `${r.symbol}:${r.rsi.toFixed(2)}`).join(', ')
      });

      let message = `🔍 *Symbol Scanner - Top Opportunities*\n\n`;

      for (let i = 0; i < Math.min(5, topResults.length); i++) {
        const r = topResults[i];
        const trendIcon = r.trend === 'UP' ? '🟢' : r.trend === 'DOWN' ? '🔴' : '⚪';

        message += `*${i + 1}. ${r.symbol}*\n`;
        message += `💰 Price: $${r.price.toFixed(2)}\n`;
        message += `📈 Change: ${r.priceChange >= 0 ? '+' : ''}${r.priceChange.toFixed(2)}%\n`;
        message += `🌊 Volatility: ${(r.volatility * 100).toFixed(2)}%\n`;
        message += `📊 RSI: ${r.rsi.toFixed(2)}\n`;
        message += `${trendIcon} Trend: ${r.trend}\n`;
        message += `⭐ Score: ${r.profitPotential.toFixed(0)}/100\n\n`;
      }

      message += `_Scan completed at ${new Date().toLocaleTimeString()}_`;

      await this.telegram.sendAlert('Symbol Scanner', message, 'INFO');
      logger.info('Top opportunities sent to Telegram');

    } catch (error) {
      logger.error('Failed to send notification', { error: error.message });
    }
  }

  async getLatestScan() {
    try {
      return await this.redis.get('symbol_scan:latest');
    } catch (error) {
      logger.error('Failed to get latest scan from Redis', { error: error.message });
      return null;
    }
  }

  async getTop20() {
    try {
      return await this.redis.get('symbol_scan:top20');
    } catch (error) {
      logger.error('Failed to get top 20 from Redis', { error: error.message });
      return null;
    }
  }

  async getSymbolData(symbol) {
    try {
      return await this.redis.hget('symbol_scan:symbols', symbol);
    } catch (error) {
      logger.error('Failed to get symbol data from Redis', { error: error.message });
      return null;
    }
  }

  /**
   * Start scanner - NOT USED ANYMORE
   * Scanner is now called directly by AutoTrader
   */
  start() {
    logger.warn('SymbolScanner.start() is deprecated - scanner is now called directly by AutoTrader');
    return false;
  }

  stop() {
    logger.info('Symbol scanner stop() called - no-op since scanner is called directly');
    return true;
  }

  isRunning() {
    return this.isScanning;
  }
}

/**
 * Helper function to get top symbols from Redis
 * @param {number} limit - Number of top symbols to return
 * @returns {Promise<string[]>} Array of symbol names
 */
async function getTopSymbols(limit = 10) {
  try {
    const { getRedis } = require('../storage/redis');
    const redis = getRedis();
    
    const top20Data = await redis.get('symbol_scan:top20');
    
    if (!top20Data) {
      logger.warn('No top symbols found in Redis, using defaults');
      return ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT'];
    }
    
    // top20Data is already an array of objects
    const topSymbols = top20Data.slice(0, limit).map(item => item.symbol);
    
    logger.info('Top symbols retrieved from Redis', {
      count: topSymbols.length,
      symbols: topSymbols.join(', ')
    });
    
    return topSymbols;
    
  } catch (error) {
    logger.error('Failed to get top symbols', { error: error.message });
    return ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT'];
  }
}

module.exports = SymbolScanner;
module.exports.getTopSymbols = getTopSymbols;
