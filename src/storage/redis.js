const Redis = require('ioredis');
const logger = require('../utils/logger');
const { config } = require('../config');

class RedisClient {
  constructor(config = {}) {
    this.config = config;
    this.client = null;
    this.isConnected = false;
    this.isOptional = config.isOptional || false; // Redis optional for trading
    this.maxRetries = config.maxRetries || 10; // Increased from 3 to 10
    this.retryDelay = config.retryDelay || 3000;
    this.retries = 0;
    this.lastError = null;
    this.connectTimeout = config.connectTimeout || 10000; // 10 seconds connect timeout
  }

  async getClient() {
    // If already connected and healthy, return existing client
    if (this.client && this.isConnected) {
      return this.client;
    }

    try {
      const redisConfigData = this.config.redis || config.redis;

      logger.info('Attempting Redis connection', {
        host: redisConfigData.host,
        port: redisConfigData.port,
        isOptional: this.isOptional,
        timeout: this.connectTimeout,
        maxRetries: this.maxRetries,
      });

      const redisConfig = {
        socket: {
          host: redisConfigData.host,
          port: redisConfigData.port,
          connectTimeout: this.connectTimeout,
          reconnectStrategy: 'exponential',
          retryStrategy: 'reconnect',
          retryMaxRetries: this.maxRetries,
          retryMaxDelay: this.retryDelay,
        },
        password: redisConfigData.password || undefined,
      };

      this.client = Redis.createClient(redisConfig);

      this.client.on('connect', () => {
        logger.info('✅ Redis connected');
        this.isConnected = true;
        this.retries = 0;
        this.lastError = null;
      });

      this.client.on('ready', () => {
        logger.info('✅ Redis ready for operations');
        this.isConnected = true;
      });

      this.client.on('error', (err) => {
        const redisConfigData = this.config.redis || config.redis;
        logger.error('❌ Redis client error', {
          error: err.message,
          code: err.code,
          stack: err.stack,
          host: redisConfigData.host,
          port: redisConfigData.port,
        });
        this.lastError = err;
        this.isConnected = false;
      });

      this.client.on('close', () => {
        logger.warn('⚠️  Redis connection closed');
        this.isConnected = false;
      });

      this.client.on('end', () => {
        logger.warn('🔚  Redis connection ended');
        this.isConnected = false;
      });

      this.client.on('reconnecting', () => {
        logger.warn('🔄 Redis reconnecting...');
        this.isConnected = false;
      });

      this.client.on('warning', (msg) => {
        logger.warn('⚠️ Redis warning', { msg });
      });

      return this.client;
    } catch (error) {
      const redisConfigData = this.config.redis || config.redis;
      logger.error('❌ Failed to create Redis client', {
        error: error.message,
        stack: error.stack,
        host: redisConfigData.host,
        port: redisConfigData.port,
        isOptional: this.isOptional,
      });

      this.client = null;
      this.isConnected = false;

      // If Redis is optional, don't crash - just log error
      if (this.isOptional) {
        logger.warn('⚠️ Redis is optional, bot will continue without caching');
      } else {
        throw error;
      }
    }
  }

  async testConnection() {
    try {
      // Ensure client is created
      if (!this.client) {
        await this.getClient();
      }
      const result = await this.client.ping();
      const redisConfigData = this.config.redis || config.redis;
      logger.info('✅ Redis connection test successful', { result, host: redisConfigData.host, port: redisConfigData.port });
      return result === 'PONG';
    } catch (error) {
      const redisConfigData = this.config.redis || config.redis;
      logger.error('❌ Redis connection test failed', {
        error: error.message,
        code: error.code,
        stack: error.stack,
        host: redisConfigData.host,
        port: redisConfigData.port,
        isOptional: this.isOptional
      });

      if (this.isOptional) {
        logger.warn('⚠️ Redis is optional - bot will continue without caching features');
        return false;
      }

      throw error;
    }
  }

  async set(key, value, ttl = null) {
    try {
      const strValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
      if (ttl) {
        await this.client.setex(key, ttl, strValue);
      } else {
        await this.client.set(key, strValue);
      }
      return true;
    } catch (error) {
      logger.error('Redis set error', { key, error: error.message });
      throw error;
    }
  }

  async get(key) {
    try {
      const value = await this.client.get(key);
      if (!value) return null;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    } catch (error) {
      logger.error('Redis get error', { key, error: error.message });
      throw error;
    }
  }

  async del(key) {
    try {
      await this.client.del(key);
      return true;
    } catch (error) {
      logger.error('Redis del error', { key, error: error.message });
      throw error;
    }
  }

  async exists(key) {
    try {
      return await this.client.exists(key) === 1;
    } catch (error) {
      logger.error('Redis exists error', { key, error: error.message });
      throw error;
    }
  }

  async expire(key, ttl) {
    try {
      await this.client.expire(key, ttl);
      return true;
    } catch (error) {
      logger.error('Redis expire error', { key, ttl, error: error.message });
      throw error;
    }
  }

  async incr(key) {
    try {
      return await this.client.incr(key);
    } catch (error) {
      logger.error('Redis incr error', { key, error: error.message });
      throw error;
    }
  }

  async decr(key) {
    try {
      return await this.client.decr(key);
    } catch (error) {
      logger.error('Redis decr error', { key, error: error.message });
      throw error;
    }
  }

  async hset(key, field, value) {
    try {
      const strValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
      await this.client.hset(key, field, strValue);
      return true;
    } catch (error) {
      logger.error('Redis hset error', { key, field, error: error.message });
      throw error;
    }
  }

  async hget(key, field) {
    try {
      const value = await this.client.hget(key, field);
      if (!value) return null;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    } catch (error) {
      logger.error('Redis hget error', { key, field, error: error.message });
      throw error;
    }
  }

  async hgetall(key) {
    try {
      const result = await this.client.hgetall(key);
      const parsed = {};
      for (const [field, value] of Object.entries(result)) {
        try {
          parsed[field] = JSON.parse(value);
        } catch {
          parsed[field] = value;
        }
      }
      return parsed;
    } catch (error) {
      logger.error('Redis hgetall error', { key, error: error.message });
      throw error;
    }
  }

  async hdel(key, field) {
    try {
      await this.client.hdel(key, field);
      return true;
    } catch (error) {
      logger.error('Redis hdel error', { key, field, error: error.message });
      throw error;
    }
  }

  // Lock mechanism for preventing race conditions
  async acquireLock(lockKey, ttl = 10000) {
    try {
      const lockValue = Date.now().toString();
      const acquired = await this.client.set(lockKey, lockValue, 'PX', ttl, 'NX');
      return acquired === 'OK';
    } catch (error) {
      logger.error('Redis acquireLock error', { lockKey, error: error.message });
      return false;
    }
  }

  async releaseLock(lockKey) {
    try {
      await this.client.del(lockKey);
      return true;
    } catch (error) {
      logger.error('Redis releaseLock error', { lockKey, error: error.message });
      return false;
    }
  }

  // Rate limiting
  async checkRateLimit(key, limit, window = 60) {
    try {
      const current = await this.incr(key);
      if (current === 1) {
        await this.expire(key, window);
      }
      return current <= limit;
    } catch (error) {
      logger.error('Redis checkRateLimit error', { key, error: error.message });
      return false;
    }
  }

  // Trading-specific methods
  async setOpenPosition(tradeId, position) {
    return await this.hset('open_positions', tradeId, position);
  }

  async getOpenPosition(tradeId) {
    return await this.hget('open_positions', tradeId);
  }

  async getAllOpenPositions() {
    return await this.hgetall('open_positions');
  }

  async removeOpenPosition(tradeId) {
    return await this.hdel('open_positions', tradeId);
  }

  async setPendingOrder(orderId, order) {
    return await this.hset('pending_orders', orderId, order);
  }

  async getPendingOrder(orderId) {
    return await this.hget('pending_orders', orderId);
  }

  async removePendingOrder(orderId) {
    return await this.hdel('pending_orders', orderId);
  }

  async setSystemStatus(status) {
    return await this.set('system_status', status);
  }

  async getSystemStatus() {
    return await this.get('system_status');
  }

  async close() {
    await this.client.quit();
    logger.info('Redis connection closed');
  }
}

// Singleton instance
let redisInstance = null;

function getRedis() {
  if (!redisInstance) {
    redisInstance = new RedisClient();
  }
  return redisInstance;
}

module.exports = { RedisClient, getRedis };
