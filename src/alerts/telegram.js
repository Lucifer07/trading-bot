const TelegramBot = require('node-telegram-bot-api');
const logger = require('../utils/logger');
const { config } = require('../config');

class TelegramAlerts {
  constructor() {
    this.botToken = config.telegram.botToken;
    this.chatId = config.telegram.chatId;
    this.enabled = !!(this.botToken && this.chatId);
    this.bot = null;

    if (this.enabled) {
      this.bot = new TelegramBot(this.botToken, { polling: false });
      logger.info('Telegram alerts enabled');
    } else {
      logger.info('Telegram alerts disabled (missing credentials)');
    }
  }

  async sendMessage(message, options = {}) {
    if (!this.enabled || !this.bot) {
      logger.debug('Telegram message skipped (not enabled)');
      return false;
    }

    try {
      await this.bot.sendMessage(this.chatId, message, options);
      logger.debug('Telegram message sent', { messageLength: message.length });
      return true;
    } catch (error) {
      logger.error('Failed to send Telegram message', { error: error.message });
      return false;
    }
  }

  async sendTradeEntry(trade) {
    const message = `🚀 *Trade Entry*

📊 Symbol: ${trade.symbol}
📍 Side: ${trade.side}
💰 Entry: ${trade.entry_price}
🎯 TP: ${trade.take_profit}
🛑 SL: ${trade.stop_loss}
📦 Quantity: ${trade.quantity}
💵 Risk: $${trade.risk_amount.toFixed(2)} (${trade.risk_percent.toFixed(2)}%)
📈 Strategy: ${trade.strategy || 'Manual'}`;

    return await this.sendMessage(message, { parse_mode: 'Markdown' });
  }

  async sendTradeExit(trade, pnl, pnlPercent) {
    const emoji = pnl >= 0 ? '✅' : '❌';
    const message = `${emoji} *Trade Exit*

📊 Symbol: ${trade.symbol}
📍 Side: ${trade.side}
💰 Entry: ${trade.entry_price}
💸 Exit: ${trade.exit_price}
💵 P/L: $${pnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)
📏 Duration: ${this.formatDuration(trade.duration_seconds)}`;

    return await this.sendMessage(message, { parse_mode: 'Markdown' });
  }

  async sendTradeUpdate(trade, message) {
    const alertMessage = `📝 *Trade Update*

📊 Symbol: ${trade.symbol}
📍 Side: ${trade.side}
💰 Current: ${trade.entry_price}
📝 ${message}`;

    return await this.sendMessage(alertMessage, { parse_mode: 'Markdown' });
  }

  async sendAlert(title, message, level = 'INFO') {
    const emoji = {
      INFO: 'ℹ️',
      WARNING: '⚠️',
      ERROR: '🚨',
      CRITICAL: '🔥',
    }[level] || 'ℹ️';

    const alertMessage = `${emoji} *${title}*

${message}`;

    return await this.sendMessage(alertMessage, { parse_mode: 'Markdown' });
  }

  async sendSystemAlert(message) {
    return await this.sendAlert('System Alert', message, 'WARNING');
  }

  async sendErrorAlert(message) {
    return await this.sendAlert('Error Alert', message, 'ERROR');
  }

  async sendCriticalAlert(message) {
    return await this.sendAlert('CRITICAL', message, 'CRITICAL');
  }

  async sendDailySummary(trades, totalPnL, winRate) {
    const message = `📊 *Daily Trading Summary*

📈 Total Trades: ${trades.length}
✅ Winning: ${trades.filter((t) => t.profit_loss > 0).length}
❌ Losing: ${trades.filter((t) => t.profit_loss < 0).length}
💵 Total P/L: $${totalPnL.toFixed(2)}
📊 Win Rate: ${winRate.toFixed(2)}%`;

    return await this.sendMessage(message, { parse_mode: 'Markdown' });
  }

  async sendAccountSnapshot(balance, equity, unrealizedPnL) {
    const message = `💰 *Account Snapshot*

💵 Balance: $${balance.toFixed(2)}
💸 Equity: $${equity.toFixed(2)}
📊 Unrealized P/L: $${unrealizedPnL.toFixed(2)}`;

    return await this.sendMessage(message, { parse_mode: 'Markdown' });
  }

  async sendKillSwitchActivated(reason) {
    const message = `🔥 *KILL SWITCH ACTIVATED*

⚠️ All trading has been stopped!

Reason: ${reason}

To reactivate, use manual intervention or restart system.`;

    return await this.sendMessage(message, { parse_mode: 'Markdown' });
  }

  async sendRiskWarning(message) {
    return await this.sendAlert('⚠️ Risk Warning', message, 'WARNING');
  }

  async sendMarginCallWarning(data) {
    const message = `⚠️ *MARGIN CALL WARNING*

Your account is at risk of liquidation!

Balance: $${data.balance?.toFixed(2)}
Equity: $${data.equity?.toFixed(2)}
Margin Ratio: ${data.marginRatio?.toFixed(2)}%

⚠️ Please check your positions immediately!`;

    return await this.sendMessage(message, { parse_mode: 'Markdown' });
  }

  async sendOrderConfirmation(order) {
    const message = `✅ *Order Confirmed*

📊 Symbol: ${order.symbol}
📍 Side: ${order.side}
📦 Type: ${order.order_type}
💰 Price: ${order.price || 'Market'}
📦 Quantity: ${order.quantity}
📋 Order ID: ${order.order_id}`;

    return await this.sendMessage(message, { parse_mode: 'Markdown' });
  }

  async sendOrderCancellation(orderId, symbol) {
    const message = `❌ *Order Cancelled*

📊 Symbol: ${symbol}
📋 Order ID: ${orderId}`;

    return await this.sendMessage(message, { parse_mode: 'Markdown' });
  }

  async testConnection() {
    if (!this.enabled || !this.bot) {
      return false;
    }

    try {
      await this.sendMessage('🤖 Binance Futures Trader is online!');
      logger.info('Telegram connection test successful');
      return true;
    } catch (error) {
      logger.error('Telegram connection test failed', { error: error.message });
      return false;
    }
  }

  formatDuration(seconds) {
    if (!seconds) return 'N/A';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  }
}

module.exports = TelegramAlerts;
