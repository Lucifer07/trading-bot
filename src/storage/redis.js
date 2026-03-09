const Redis = require('ioredis');
const logger = require('../utils/logger');
const { config } = require('../config');

class RedisClient {
  constructor() {
    this.client = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password || undefined,
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      maxRetriesPerRequest: 3,
    });

    this.client.on('connect', () => {
      logger.info('Redis connected');
    });

    this.client.on('error', (err) => {
      logger.error('Redis error', { error: err.message });
    });

    this.client.on('close', () => {
      logger.warn('Redis connection closed');
    });
  }

  async testConnection() {
    try {
      const result = await this.client.ping();
      logger.info('Redis connection test', { result });
      return result === 'PONG';
    } catch (error) {
      logger.error('Redis connection test failed', { error: error.message });
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
