const { Pool } = require('pg');
const logger = require('../utils/logger');
const { config } = require('../config');

class Database {
  constructor() {
    this.pool = new Pool({
      host: config.postgres.host,
      port: config.postgres.port,
      database: config.postgres.database,
      user: config.postgres.user,
      password: config.postgres.password,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    this.pool.on('error', (err) => {
      logger.error('Unexpected error on idle client', err);
    });
  }

  async testConnection() {
    try {
      const client = await this.pool.connect();
      const result = await client.query('SELECT NOW()');
      client.release();
      logger.info('Database connected successfully', { timestamp: result.rows[0].now });
      return true;
    } catch (error) {
      logger.error('Database connection failed', { error: error.message });
      throw error;
    }
  }

  async query(text, params) {
    const start = Date.now();
    try {
      const result = await this.pool.query(text, params);
      const duration = Date.now() - start;
      logger.debug('Executed query', { duration, rows: result.rowCount });
      return result;
    } catch (error) {
      logger.error('Query error', { text, error: error.message });
      throw error;
    }
  }

  async getClient() {
    return await this.pool.connect();
  }

  async close() {
    await this.pool.end();
    logger.info('Database connection closed');
  }

  // Trade operations
  async createTrade(tradeData) {
    const query = `
      INSERT INTO trades (
        trade_id, symbol, side, entry_price, quantity, stop_loss,
        take_profit, risk_amount, risk_percent, strategy, indicators, notes
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
    `;
    const values = [
      tradeData.trade_id,
      tradeData.symbol,
      tradeData.side,
      tradeData.entry_price,
      tradeData.quantity,
      tradeData.stop_loss,
      tradeData.take_profit,
      tradeData.risk_amount,
      tradeData.risk_percent,
      tradeData.strategy,
      tradeData.indicators ? JSON.stringify(tradeData.indicators) : null,
      tradeData.notes,
    ];
    return (await this.query(query, values)).rows[0];
  }

  async updateTrade(tradeId, updates) {
    const fields = Object.keys(updates);
    const values = Object.values(updates);
    const setClause = fields.map((field, index) => `${field} = $${index + 1}`).join(', ');
    const query = `
      UPDATE trades
      SET ${setClause}, updated_at = NOW()
      WHERE trade_id = $${fields.length + 1}
      RETURNING *
    `;
    return (await this.query(query, [...values, tradeId])).rows[0];
  }

  async getTrade(tradeId) {
    const query = 'SELECT * FROM trades WHERE trade_id = $1';
    return (await this.query(query, [tradeId])).rows[0];
  }

  async getOpenTrades() {
    const query = 'SELECT * FROM trades WHERE status = $1 ORDER BY entry_time DESC';
    return (await this.query(query, ['OPEN'])).rows;
  }

  async getPendingTrades() {
    const query = 'SELECT * FROM trades WHERE status = $1 ORDER BY entry_time DESC';
    return (await this.query(query, ['PENDING'])).rows;
  }

  async getFailedTrades(limit = 100) {
    const query = 'SELECT * FROM trades WHERE status = $1 ORDER BY entry_time DESC LIMIT $2';
    return (await this.query(query, ['FAILED', limit])).rows;
  }

  async getClosedTrades(limit = 100) {
    const query = 'SELECT * FROM trades WHERE status = $1 ORDER BY entry_time DESC LIMIT $2';
    return (await this.query(query, ['CLOSED', limit])).rows;
  }

  // Order operations
  async createOrder(orderData) {
    const query = `
      INSERT INTO orders (
        order_id, trade_id, exchange_order_id, symbol, side, order_type,
        price, quantity, status, order_type_value
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `;
    const values = [
      orderData.order_id,
      orderData.trade_id,
      orderData.exchange_order_id,
      orderData.symbol,
      orderData.side,
      orderData.order_type,
      orderData.price,
      orderData.quantity,
      orderData.status,
      orderData.order_type_value,
    ];
    return (await this.query(query, values)).rows[0];
  }

  async updateOrder(orderId, updates) {
    const fields = Object.keys(updates);
    const values = Object.values(updates);
    const setClause = fields.map((field, index) => `${field} = $${index + 1}`).join(', ');
    const query = `
      UPDATE orders
      SET ${setClause}, updated_at = NOW()
      WHERE order_id = $${fields.length + 1}
      RETURNING *
    `;
    return (await this.query(query, [...values, orderId])).rows[0];
  }

  async getOrdersByTrade(tradeId) {
    const query = 'SELECT * FROM orders WHERE trade_id = $1 ORDER BY created_at DESC';
    return (await this.query(query, [tradeId])).rows;
  }

  // Account snapshot operations
  async createSnapshot(snapshotData) {
    const query = `
      INSERT INTO account_snapshots (
        balance, equity, unrealized_pnl, open_positions_count, total_risk_exposure
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;
    const values = [
      snapshotData.balance,
      snapshotData.equity,
      snapshotData.unrealized_pnl,
      snapshotData.open_positions_count,
      snapshotData.total_risk_exposure,
    ];
    return (await this.query(query, values)).rows[0];
  }

  async getLatestSnapshot() {
    const query = 'SELECT * FROM account_snapshots ORDER BY recorded_at DESC LIMIT 1';
    return (await this.query(query)).rows[0];
  }

  // System events operations
  async logEvent(eventData) {
    const query = `
      INSERT INTO system_events (event_type, severity, message, data)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `;
    const values = [
      eventData.event_type,
      eventData.severity,
      eventData.message,
      eventData.data ? JSON.stringify(eventData.data) : null,
    ];
    return (await this.query(query, values)).rows[0];
  }

  async getEvents(severity = null, limit = 100) {
    let query = 'SELECT * FROM system_events';
    const params = [];

    if (severity) {
      query += ' WHERE severity = $1';
      params.push(severity);
    }

    query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
    params.push(limit);

    return (await this.query(query, params)).rows;
  }

  // Kill switch operations
  async getKillSwitch() {
    const query = 'SELECT * FROM kill_switch WHERE id = 1';
    return (await this.query(query)).rows[0];
  }

  async activateKillSwitch(reason, activatedBy = 'system') {
    const query = `
      UPDATE kill_switch
      SET activated = true, reason = $1, activated_at = NOW(), activated_by = $2, updated_at = NOW()
      WHERE id = 1
      RETURNING *
    `;
    return (await this.query(query, [reason, activatedBy])).rows[0];
  }

  async deactivateKillSwitch(activatedBy = 'system') {
    const query = `
      UPDATE kill_switch
      SET activated = false, deactivated_at = NOW(), activated_by = $2, updated_at = NOW()
      WHERE id = 1
      RETURNING *
    `;
    return (await this.query(query, [null, activatedBy])).rows[0];
  }
}

// Singleton instance
let dbInstance = null;

function getDatabase() {
  if (!dbInstance) {
    dbInstance = new Database();
  }
  return dbInstance;
}

module.exports = { Database, getDatabase };
