const WebSocket = require('ws');
const logger = require('../utils/logger');
const { config } = require('../config');

/**
 * WebSocket Scanner - Subscribe to all symbols via !ticker@arr stream
 * This provides 24hr ticker data for ALL symbols in a single connection
 */
class WebSocketScanner {
  constructor() {
    this.baseUrl = config.binance.wsUrl;
    this.tickerCache = new Map(); // symbol -> ticker data
    this.isConnected = false;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 1000;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const wsUrl = `${this.baseUrl}/!ticker@arr`;
      this.ws = new WebSocket(wsUrl);

      logger.info('Connecting to WebSocket !ticker@arr stream...');

      this.ws.on('open', () => {
        logger.info('✅ WebSocket !ticker@arr stream connected');
        this.isConnected = true;
        this.reconnectAttempts = 0;
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const tickers = JSON.parse(data.toString());

          // Update ticker cache
          if (Array.isArray(tickers)) {
            for (const ticker of tickers) {
              this.tickerCache.set(ticker.s, ticker);
            }
          }
        } catch (error) {
          logger.error('WebSocket message parse error', { error: error.message });
        }
      });

      this.ws.on('error', (error) => {
        logger.error('WebSocket error', { error: error.message });
        if (!this.isConnected) {
          reject(error);
        }
      });

      this.ws.on('close', (code, reason) => {
        logger.warn('WebSocket closed', { code, reason });
        this.isConnected = false;

        if (code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnect();
        }
      });
    });
  }

  reconnect() {
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    logger.info(`Reconnecting to WebSocket in ${delay}ms...`, { attempt: this.reconnectAttempts });

    setTimeout(() => {
      this.connect().catch(error => {
        logger.error('Failed to reconnect', { error: error.message });
      });
    }, delay);
  }

  disconnect() {
    if (this.ws) {
      this.ws.close(1000, 'User initiated disconnect');
      this.isConnected = false;
      logger.info('WebSocket !ticker@arr stream disconnected');
    }
  }

  /**
   * Get ticker data for a symbol
   */
  getTicker(symbol) {
    return this.tickerCache.get(symbol);
  }

  /**
   * Get all tickers
   */
  getAllTickers() {
    return Array.from(this.tickerCache.values());
  }

  /**
   * Get top symbols by volume (USDT perpetual futures only)
   * @param {number} limit - Number of symbols to return (default: 100)
   */
  getTopSymbolsByVolume(limit = 533) {
    return this.getAllTickers()
      .filter(t => t.s.endsWith('USDT')) // Only USDT pairs
      .sort((a, b) => parseFloat(b.q) - parseFloat(a.q)) // Sort by quote volume
      .slice(0, limit);
  }

  /**
   * Get symbols that match criteria
   */
  filterSymbols(criteria = {}) {
    const tickers = this.getAllTickers();

    return tickers.filter(t => {
      // Filter by symbol pattern (e.g., only USDT perpetual)
      if (criteria.symbolPattern && !t.s.match(criteria.symbolPattern)) {
        return false;
      }

      // Filter by min volume
      if (criteria.minVolume && parseFloat(t.q) < criteria.minVolume) {
        return false;
      }

      // Filter by min price change percent
      if (criteria.minPriceChangePercent && Math.abs(parseFloat(t.P)) < criteria.minPriceChangePercent) {
        return false;
      }

      return true;
    });
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const tickers = this.getAllTickers();
    const usdtTickers = tickers.filter(t => t.s.endsWith('USDT'));

    return {
      isConnected: this.isConnected,
      totalSymbols: tickers.length,
      usdtSymbols: usdtTickers.length,
      reconnectAttempts: this.reconnectAttempts,
    };
  }
}

module.exports = WebSocketScanner;