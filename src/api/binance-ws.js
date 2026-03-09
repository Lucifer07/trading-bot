const WebSocket = require('ws');
const logger = require('../utils/logger');
const { config } = require('../config');
const { getDatabase } = require('../storage/db');

class BinanceWebSocketClient {
  constructor() {
    this.baseUrl = config.binance.wsUrl;
    this.connections = new Map();
    this.reconnectAttempts = new Map();
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 1000;
    this.db = getDatabase();
  }

  connect(stream, callback, reconnect = true) {
    const wsUrl = `${this.baseUrl}/${stream}`;
    const ws = new WebSocket(wsUrl);

    logger.info(`Connecting to WebSocket: ${stream}`);

    ws.on('open', () => {
      logger.info(`WebSocket connected: ${stream}`);
      this.reconnectAttempts.set(stream, 0);
    });

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        callback(message);
      } catch (error) {
        logger.error('WebSocket message parse error', { stream, error: error.message });
      }
    });

    ws.on('error', (error) => {
      logger.error('WebSocket error', { stream, error: error.message });
    });

    ws.on('close', (code, reason) => {
      logger.warn('WebSocket closed', { stream, code, reason });

      this.connections.delete(stream);

      if (reconnect && code !== 1000) {
        this.reconnect(stream, callback);
      }
    });

    this.connections.set(stream, ws);
    return ws;
  }

  reconnect(stream, callback) {
    const attempts = this.reconnectAttempts.get(stream) || 0;

    if (attempts >= this.maxReconnectAttempts) {
      logger.error('Max reconnect attempts reached', { stream, attempts });
      return;
    }

    const delay = this.reconnectDelay * Math.pow(2, attempts);
    logger.info(`Reconnecting to WebSocket in ${delay}ms`, { stream, attempt: attempts + 1 });

    setTimeout(() => {
      this.reconnectAttempts.set(stream, attempts + 1);
      this.connect(stream, callback, true);
    }, delay);
  }

  disconnect(stream) {
    const ws = this.connections.get(stream);
    if (ws) {
      ws.close(1000, 'User initiated disconnect');
      this.connections.delete(stream);
      logger.info('WebSocket disconnected', { stream });
    }
  }

  disconnectAll() {
    this.connections.forEach((ws, stream) => {
      ws.close(1000, 'User initiated disconnect');
    });
    this.connections.clear();
    logger.info('All WebSocket connections closed');
  }

  // Public streams
  subscribeKlines(symbols, interval = '1h', callback) {
    const streams = symbols.map((s) => `${s.toLowerCase()}@kline_${interval}`).join('/');
    return this.connect(streams, callback);
  }

  subscribeMiniTicker(symbols, callback) {
    const streams = symbols.map((s) => `${s.toLowerCase()}@miniTicker`).join('/');
    return this.connect(streams, callback);
  }

  subscribeTicker(symbols, callback) {
    const streams = symbols.map((s) => `${s.toLowerCase()}@ticker`).join('/');
    return this.connect(streams, callback);
  }

  subscribeBookTicker(symbols, callback) {
    const streams = symbols.map((s) => `${s.toLowerCase()}@bookTicker`).join('/');
    return this.connect(streams, callback);
  }

  subscribeDepth(symbols, levels = 5, updateSpeed = '1000ms', callback) {
    const streams = symbols.map((s) => `${s.toLowerCase()}@depth${levels}@${updateSpeed}`).join('/');
    return this.connect(streams, callback);
  }

  subscribeAggTrade(symbols, callback) {
    const streams = symbols.map((s) => `${s.toLowerCase()}@aggTrade`).join('/');
    return this.connect(streams, callback);
  }

  // Private streams (user data)
  async connectUserData(listenKey, callback, api = null) {
    if (!api) {
      throw new Error('Binance API instance required for user data stream');
    }

    const wsUrl = `${this.baseUrl}/${listenKey}`;
    const ws = new WebSocket(wsUrl);

    logger.info('Connecting to user data stream');

    ws.on('open', () => {
      logger.info('User data stream connected');
    });

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());

        // Keepalive ping
        if (message.result === null && message.e === 'listenKeyExpired') {
          logger.warn('Listen key expired, renewing...');
          await this.renewUserDataStream(listenKey, api);
          return;
        }

        // Handle user data events
        await this.handleUserDataEvent(message, callback);
      } catch (error) {
        logger.error('User data message parse error', { error: error.message });
      }
    });

    ws.on('error', (error) => {
      logger.error('User data stream error', { error: error.message });
    });

    ws.on('close', async (code, reason) => {
      logger.warn('User data stream closed', { code, reason });

      if (code !== 1000) {
        await this.reconnectUserData(listenKey, callback, api);
      }
    });

    this.connections.set('user_data', ws);
    return ws;
  }

  async handleUserDataEvent(message, callback) {
    const { e: eventType } = message;

    switch (eventType) {
      case 'ORDER_TRADE_UPDATE':
        logger.debug('Order trade update', message);
        await this.db.logEvent({
          event_type: 'order_update',
          severity: 'INFO',
          message: 'Order trade update received',
          data: message,
        });
        break;

      case 'ACCOUNT_UPDATE':
        logger.debug('Account update', message);
        await this.db.logEvent({
          event_type: 'account_update',
          severity: 'INFO',
          message: 'Account update received',
          data: message,
        });
        break;

      case 'MARGIN_CALL':
        logger.warn('Margin call warning', message);
        await this.db.logEvent({
          event_type: 'margin_call',
          severity: 'WARNING',
          message: 'Margin call warning',
          data: message,
        });
        break;

      default:
        logger.debug('Unknown user data event', { eventType, message });
    }

    if (callback) callback(message);
  }

  async reconnectUserData(listenKey, callback, api) {
    const attempts = this.reconnectAttempts.get('user_data') || 0;

    if (attempts >= this.maxReconnectAttempts) {
      logger.error('Max reconnect attempts reached for user data');
      return;
    }

    const delay = this.reconnectDelay * Math.pow(2, attempts);
    logger.info(`Reconnecting to user data stream in ${delay}ms`, { attempt: attempts + 1 });

    setTimeout(async () => {
      this.reconnectAttempts.set('user_data', attempts + 1);
      await this.connectUserData(listenKey, callback, api);
    }, delay);
  }

  async renewUserDataStream(listenKey, api) {
    try {
      await api.keepAliveUserDataStream(listenKey);
      logger.info('User data stream renewed');
    } catch (error) {
      logger.error('Failed to renew user data stream', { error: error.message });
    }
  }
}

module.exports = BinanceWebSocketClient;
