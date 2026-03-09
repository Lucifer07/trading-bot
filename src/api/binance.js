const axios = require('axios');
const logger = require('../utils/logger');
const { signParams } = require('../utils/crypto');
const { config } = require('../config');
const { getDatabase } = require('../storage/db');

class BinanceFuturesAPI {
  constructor() {
    this.baseUrl = config.binance.baseUrl;
    this.apiKey = config.binance.apiKey;
    this.secretKey = config.binance.secretKey;
    this.testnet = config.binance.testnet;
    this.db = getDatabase();

    // Rate limiting
    this.requestWeights = {
      '/fapi/v1/exchangeInfo': 10,
      '/fapi/v1/depth': 1,
      '/fapi/v1/klines': 1,
      '/fapi/v1/ticker/price': 1,
      '/fapi/v1/ticker/bookTicker': 1,
      '/fapi/v1/account': 5,
      '/fapi/v1/order': 1,
      '/fapi/v1/positionRisk': 5,
      '/fapi/v1/leverage': 1,
    };
  }

  async request(endpoint, method = 'GET', params = {}, signed = false) {
    try {
      let url = `${this.baseUrl}${endpoint}`;

      // Add signature for signed requests
      if (signed && this.apiKey && this.secretKey) {
        params = signParams(params, this.secretKey);
      }

      // Build query string
      const queryString = Object.keys(params)
        .map((key) => `${key}=${encodeURIComponent(params[key])}`)
        .join('&');

      if (method === 'GET' && queryString) {
        url += `?${queryString}`;
      }

      const headers = {
        'Content-Type': 'application/json',
      };

      if (this.apiKey) {
        headers['X-MBX-APIKEY'] = this.apiKey;
      }

      const response = await axios({
        method,
        url,
        headers,
        data: method !== 'GET' ? queryString : undefined,
        timeout: 10000,
      });

      // Log API request
      // await this.db.logEvent({
      //   event_type: 'api_request',
      //   severity: 'INFO',
      //   message: `${method} ${endpoint}`,
      //   data: { params: { ...params, signature: '***' }, status: response.status },
      // });

      return response.data;
    } catch (error) {
      const errorMessage = error.response?.data?.msg || error.message;
      logger.error('Binance API error', { endpoint, error: errorMessage });

      // await this.db.logEvent({
      //   event_type: 'api_error',
      //   severity: 'ERROR',
      //   message: `${method} ${endpoint} failed`,
      //   data: { params: { ...params, signature: '***' }, error: errorMessage },
      // });

      throw new Error(`Binance API Error: ${errorMessage}`);
    }
  }

  // Public endpoints
  async getExchangeInfo(symbol = null) {
    const params = symbol ? { symbol } : {};
    return await this.request('/fapi/v1/exchangeInfo', 'GET', params, false);
  }

  async getDepth(symbol, limit = 100) {
    return await this.request('/fapi/v1/depth', 'GET', { symbol, limit }, false);
  }

  async getKlines(symbol, interval = '1h', limit = 500) {
    return await this.request('/fapi/v1/klines', 'GET', { symbol, interval, limit }, false);
  }

  async getTickerPrice(symbol = null) {
    const params = symbol ? { symbol } : {};
    return await this.request('/fapi/v1/ticker/price', 'GET', params, false);
  }

  async get24hrTicker(symbol = null) {
    const params = symbol ? { symbol } : {};
    return await this.request('/fapi/v1/ticker/24hr', 'GET', params, false);
  }

  async getBookTicker(symbol = null) {
    const params = symbol ? { symbol } : {};
    return await this.request('/fapi/v1/ticker/bookTicker', 'GET', params, false);
  }

  async getOpenInterest(symbol = null) {
    const params = symbol ? { symbol } : {};
    return await this.request('/fapi/v1/openInterest', 'GET', params, false);
  }

  // Derivatives data endpoints
  async getFundingRate(symbol) {
    return await this.request('/fapi/v1/premiumIndex', 'GET', { symbol }, false);
  }

  async getOpenInterestStats(symbol) {
    return await this.request('/fapi/v1/openInterest', 'GET', { symbol }, false);
  }

  async getOpenInterestHistory(symbol, period = '1h', limit = 30) {
    return await this.request('/futures/data/openInterestHist', 'GET', { symbol, period, limit }, false);
  }

  async getLongShortRatio(symbol, period = '1h', limit = 30) {
    return await this.request('/futures/data/globalLongShortAccountRatio', 'GET', { symbol, period, limit }, false);
  }

  async getRecentTrades(symbol, limit = 500) {
    return await this.request('/fapi/v1/trades', 'GET', { symbol, limit }, false);
  }


  // Private endpoints (require API key)
  async getAccount(recvWindow = 5000) {
    return await this.request('/fapi/v2/account', 'GET', { recvWindow }, true);
  }

  async getPositions(symbol = null, recvWindow = 5000) {
    const params = recvWindow ? { recvWindow } : {};
    if (symbol) {
      params.symbol = symbol;
    }
    return await this.request('/fapi/v2/positionRisk', 'GET', params, true);
  }

  async getPositionRisk(symbol = null, recvWindow = 5000) {
    const params = recvWindow ? { recvWindow } : {};
    if (symbol) {
      params.symbol = symbol;
    }
    return await this.request('/fapi/v2/positionRisk', 'GET', params, true);
  }

  async getOpenOrders(symbol = null, recvWindow = 5000) {
    const params = recvWindow ? { recvWindow } : {};
    if (symbol) {
      params.symbol = symbol;
    }
    return await this.request('/fapi/v1/openOrders', 'GET', params, true);
  }

  async getOrder(symbol, orderId, origClientOrderId = null, recvWindow = 5000) {
    const params = { symbol, recvWindow };
    if (orderId) params.orderId = orderId;
    if (origClientOrderId) params.origClientOrderId = origClientOrderId;
    return await this.request('/fapi/v1/order', 'GET', params, true);
  }

  async getAllOrders(symbol, limit = 500, recvWindow = 5000) {
    return await this.request('/fapi/v1/allOrders', 'GET', { symbol, limit, recvWindow }, true);
  }

  async getUserTrades(symbol, limit = 500, fromId = null, recvWindow = 5000) {
    const params = { symbol, limit, recvWindow };
    if (fromId) params.fromId = fromId;
    return await this.request('/fapi/v1/userTrades', 'GET', params, true);
  }

  // Order management
  async createOrder(symbol, side, type, quantity, price = null, timeInForce = 'GTC', stopPrice = null, recvWindow = 5000) {
    const params = {
      symbol,
      side, // 'BUY' or 'SELL'
      type, // 'MARKET', 'LIMIT', 'STOP', 'STOP_MARKET', 'TAKE_PROFIT', 'TAKE_PROFIT_MARKET'
      quantity,
      timeInForce,
      recvWindow,
    };

    if (price) params.price = price;
    if (stopPrice) params.stopPrice = stopPrice;

    return await this.request('/fapi/v1/order', 'POST', params, true);
  }

  async createMarketOrder(symbol, side, quantity, reduceOnly = false, recvWindow = 5000) {
    return await this.createOrder(symbol, side, 'MARKET', quantity, null, null, null, recvWindow);
  }

  async createLimitOrder(symbol, side, quantity, price, timeInForce = 'GTC', recvWindow = 5000) {
    return await this.createOrder(symbol, side, 'LIMIT', quantity, price, timeInForce, null, recvWindow);
  }

  async createStopLossOrder(symbol, side, quantity, stopPrice, closePosition = false, recvWindow = 5000) {
    return await this.createOrder(symbol, side, 'STOP_MARKET', quantity, null, null, stopPrice, recvWindow);
  }

  async createTakeProfitOrder(symbol, side, quantity, stopPrice, closePosition = false, recvWindow = 5000) {
    return await this.createOrder(symbol, side, 'TAKE_PROFIT_MARKET', quantity, null, null, stopPrice, recvWindow);
  }

  async cancelOrder(symbol, orderId, origClientOrderId = null, recvWindow = 5000) {
    const params = { symbol, recvWindow };
    if (orderId) params.orderId = orderId;
    if (origClientOrderId) params.origClientOrderId = origClientOrderId;
    return await this.request('/fapi/v1/order', 'DELETE', params, true);
  }

  async cancelAllOrders(symbol, recvWindow = 5000) {
    return await this.request('/fapi/v1/allOpenOrders', 'DELETE', { symbol, recvWindow }, true);
  }

  // Position management
  async changeLeverage(symbol, leverage, recvWindow = 5000) {
    return await this.request('/fapi/v1/leverage', 'POST', { symbol, leverage, recvWindow }, true);
  }

  async changeMarginType(symbol, marginType = 'CROSS', recvWindow = 5000) {
    return await this.request('/fapi/v1/marginType', 'POST', { symbol, marginType, recvWindow }, true);
  }

  async changePositionMargin(symbol, amount, type = 1, recvWindow = 5000) {
    return await this.request('/fapi/v1/positionMargin', 'POST', { symbol, amount, type, recvWindow }, true);
  }

  async changePositionMode(dualSidePosition = true, recvWindow = 5000) {
    return await this.request('/fapi/v1/positionSide/dual', 'POST', { dualSidePosition, recvWindow }, true);
  }

  // Futures account balance
  async getBalance(recvWindow = 5000) {
    const account = await this.getAccount(recvWindow);
    return account.assets.filter((asset) => parseFloat(asset.walletBalance) > 0);
  }

  async getTotalWalletBalance(recvWindow = 5000) {
    const account = await this.getAccount(recvWindow);
    return parseFloat(account.totalWalletBalance);
  }

  async getAvailableBalance(recvWindow = 5000) {
    const account = await this.getAccount(recvWindow);
    return parseFloat(account.availableBalance);
  }

  async getUnrealizedPnL(recvWindow = 5000) {
    const account = await this.getAccount(recvWindow);
    return parseFloat(account.totalUnrealizedProfit);
  }

  // Test new order
  async testOrder(symbol, side, type, quantity, price = null, timeInForce = 'GTC', recvWindow = 5000) {
    const params = {
      symbol,
      side,
      type,
      quantity,
      timeInForce,
      recvWindow,
    };

    if (price) params.price = price;

    return await this.request('/fapi/v1/order/test', 'POST', params, true);
  }

  // Start user data stream
  async startUserDataStream() {
    return await this.request('/fapi/v1/listenKey', 'POST', {}, false);
  }

  // Keepalive user data stream
  async keepAliveUserDataStream(listenKey) {
    return await this.request('/fapi/v1/listenKey', 'PUT', { listenKey }, false);
  }

  // Close user data stream
  async closeUserDataStream(listenKey) {
    return await this.request('/fapi/v1/listenKey', 'DELETE', { listenKey }, false);
  }

  // Test connection
  async testConnection() {
    try {
      // Test public endpoint (no auth required)
      await this.request('/fapi/v1/ping', 'GET', {}, false);
      logger.info('Binance API connection test (public) successful');
      
      // Test private endpoint (requires auth) if API keys are configured
      if (this.apiKey && this.secretKey) {
        try {
          const account = await this.getAccount();
          logger.info('Binance API connection test (authenticated) successful', {
            totalWalletBalance: account.totalWalletBalance,
            availableBalance: account.availableBalance,
            canTrade: account.canTrade,
            canDeposit: account.canDeposit,
            canWithdraw: account.canWithdraw,
          });
          return {
            connected: true,
            authenticated: true,
            testnet: this.testnet,
            canTrade: account.canTrade,
            totalWalletBalance: parseFloat(account.totalWalletBalance),
            availableBalance: parseFloat(account.availableBalance),
          };
        } catch (authError) {
          logger.error('Binance API authentication failed', { error: authError.message });
          return {
            connected: true,
            authenticated: false,
            testnet: this.testnet,
            error: authError.message,
          };
        }
      } else {
        logger.warn('Binance API keys not configured - only public endpoints available');
        return {
          connected: true,
          authenticated: false,
          testnet: this.testnet,
          message: 'API keys not configured',
        };
      }
    } catch (error) {
      logger.error('Binance API connection test failed', { error: error.message });
      throw new Error(`Binance API connection failed: ${error.message}`);
    }
  }

  // Get account info summary
  async getAccountInfo() {
    try {
      const account = await this.getAccount();
      const positions = await this.getPositions();
      
      const openPositions = positions.filter(p => parseFloat(p.positionAmt) !== 0);
      
      return {
        totalWalletBalance: parseFloat(account.totalWalletBalance),
        availableBalance: parseFloat(account.availableBalance),
        totalUnrealizedProfit: parseFloat(account.totalUnrealizedProfit),
        totalMarginBalance: parseFloat(account.totalMarginBalance),
        totalPositionInitialMargin: parseFloat(account.totalPositionInitialMargin),
        totalOpenOrderInitialMargin: parseFloat(account.totalOpenOrderInitialMargin),
        maxWithdrawAmount: parseFloat(account.maxWithdrawAmount),
        canTrade: account.canTrade,
        canDeposit: account.canDeposit,
        canWithdraw: account.canWithdraw,
        openPositionsCount: openPositions.length,
        openPositions: openPositions.map(p => ({
          symbol: p.symbol,
          positionAmt: parseFloat(p.positionAmt),
          entryPrice: parseFloat(p.entryPrice),
          markPrice: parseFloat(p.markPrice),
          unRealizedProfit: parseFloat(p.unRealizedProfit),
          leverage: parseFloat(p.leverage),
          positionSide: p.positionSide,
        })),
      };
    } catch (error) {
      logger.error('Failed to get account info', { error: error.message });
      throw error;
    }
  }
}

module.exports = BinanceFuturesAPI;
