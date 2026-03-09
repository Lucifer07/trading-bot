require('dotenv').config();
const { getDatabase } = require('./src/storage/db');
const { getRedis } = require('./src/storage/redis');
const BinanceFuturesAPI = require('./src/api/binance');
const logger = require('./src/utils/logger');

async function closePosition() {
  try {
    console.log('='.repeat(60));
    console.log('🔒 Closing BTCUSDT LONG Position');
    console.log('='.repeat(60));

    const db = getDatabase();
    const redis = getRedis();
    const api = new BinanceFuturesAPI();

    // Get current price
    const ticker = await api.getTickerPrice('BTCUSDT');
    const currentPrice = parseFloat(ticker.price);
    console.log('\n💰 Current Price: $' + currentPrice.toFixed(2));

    // Get open trades from database
    const openTrades = await db.getOpenTrades();
    const btcTrade = openTrades.find(t => 
      t.symbol === 'BTCUSDT' && 
      t.side === 'LONG' && 
      t.status === 'OPEN'
    );

    if (!btcTrade) {
      console.log('\n⚠️ No open BTCUSDT LONG position found in database');
      console.log('\n📊 Open trades found: ' + openTrades.length);
      openTrades.forEach(t => {
        console.log('   - ' + t.symbol + ' ' + t.side + ' | Status: ' + t.status);
      });
      return;
    }

    console.log('\n📊 Trade Details:');
    console.log('   Trade ID: ' + btcTrade.trade_id);
    console.log('   Symbol: ' + btcTrade.symbol);
    console.log('   Side: ' + btcTrade.side);
    console.log('   Entry: $' + btcTrade.entry_price.toFixed(2));
    console.log('   Entry Time: ' + btcTrade.entry_time);
    console.log('   Stop Loss: $' + btcTrade.stop_loss.toFixed(2));
    console.log('   Take Profit: $' + btcTrade.take_profit.toFixed(2));
    console.log('   Quantity: ' + btcTrade.quantity.toFixed(4));

    // Calculate P/L
    const pnl = btcTrade.side === 'LONG' 
      ? (currentPrice - btcTrade.entry_price) * btcTrade.quantity
      : (btcTrade.entry_price - currentPrice) * btcTrade.quantity;

    const pnlPercent = (pnl / (btcTrade.entry_price * btcTrade.quantity)) * 100;

    console.log('\n💵 P/L Calculation:');
    console.log('   Current Price: $' + currentPrice.toFixed(2));
    console.log('   Entry Price: $' + btcTrade.entry_price.toFixed(2));
    console.log('   Quantity: ' + btcTrade.quantity.toFixed(4));
    console.log('   Profit/Loss: $' + pnl.toFixed(2) + ' (' + pnlPercent.toFixed(2) + '%)');

    const duration = Math.floor((new Date() - new Date(btcTrade.entry_time)) / 1000 / 60);
    const durationHours = Math.floor(duration / 60);
    const durationMinutes = duration % 60;
    console.log('   Hold Time: ' + durationHours + 'h ' + durationMinutes + 'm');

    // Close in Binance (if not paper trading)
    const isPaperTrading = process.env.PAPER_TRADING === 'true';
    
    if (!isPaperTrading) {
      console.log('\n🔔 Closing position on Binance...');
      
      try {
        const closeOrder = await api.createMarketOrder(
          'BTCUSDT', 
          btcTrade.side === 'LONG' ? 'SELL' : 'BUY', 
          btcTrade.quantity
        );
        console.log('   ✅ Market Order placed: ' + closeOrder.orderId);
      } catch (error) {
        console.log('   ⚠️ Error closing on Binance: ' + error.message);
        console.log('   📝 Proceeding with database update anyway...');
      }
    } else {
      console.log('\n📝 Paper trading mode - simulating close');
    }

    // Update database
    console.log('\n💾 Updating database...');
    await db.updateTrade(btcTrade.trade_id, {
      status: 'CLOSED',
      exit_price: currentPrice,
      profit_loss: pnl,
      profit_loss_percent: pnlPercent,
      exit_time: new Date(),
      duration_seconds: duration * 60,
      notes: 'Manual close by Sebas - Reason: Taking profit +$' + pnl.toFixed(2)
    });
    console.log('   ✅ Trade status updated to CLOSED');

    // Update Redis
    console.log('\n💾 Updating Redis...');
    const redisKey = 'trading:positions';
    const positionsData = await redis.get(redisKey);
    
    if (positionsData) {
      const posData = JSON.parse(positionsData);
      const filtered = posData.filter(p => p.symbol !== 'BTCUSDT' || p.trade_id !== btcTrade.trade_id);
      await redis.set(redisKey, JSON.stringify(filtered));
      console.log('   ✅ BTCUSDT removed from Redis');
      console.log('   📊 Remaining positions: ' + filtered.length);
    } else {
      console.log('   ⚠️ No positions found in Redis');
    }

    console.log('\n✅ Position closed successfully!');
    console.log('\n💰 Final Result:');
    console.log('   Symbol: ' + btcTrade.symbol + ' ' + btcTrade.side);
    console.log('   Entry: $' + btcTrade.entry_price.toFixed(2));
    console.log('   Exit: $' + currentPrice.toFixed(2));
    console.log('   Profit: $' + pnl.toFixed(2) + ' (' + pnlPercent.toFixed(2) + '%)');
    console.log('   Hold Time: ' + durationHours + 'h ' + durationMinutes + 'm');
    console.log('   Reason: Manual close - Taking profit');

    // Send Telegram alert
    const TelegramAlerts = require('./src/alerts/telegram');
    const telegram = new TelegramAlerts();
    
    if (telegram.enabled) {
      try {
        const message = '✅ *Position Closed*\n\n📊 *Symbol:* ' + btcTrade.symbol +
          '\n' + (btcTrade.side === 'LONG' ? '🟢' : '🔴') + ' *Direction:* ' + btcTrade.side +
          '\n💰 *Entry:* $' + btcTrade.entry_price.toFixed(2) +
          '\n💰 *Exit:* $' + currentPrice.toFixed(2) +
          '\n' + (pnl >= 0 ? '🟢' : '🔴') + ' *P/L:* $' + pnl.toFixed(2) + ' (' + pnlPercent.toFixed(2) + '%)\n\n📝 *Details:*\n• Hold Time: ' + durationHours + 'h ' + durationMinutes + 'm' +
          '\n• Reason: Manual close by Sebas' +
          '\n• Type: Taking profit +$' + pnl.toFixed(2) +
          '\n\n*Environment:* ' + (isPaperTrading ? 'PAPER TRADING' : 'LIVE') +
          '\n*Closed:* ' + new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }));

        await telegram.sendAlert('Position Closed', message, 'INFO');
        console.log('\n📱 Telegram notification sent');
      } catch (error) {
        console.log('\n⚠️ Failed to send Telegram: ' + error.message);
      }
    }

    await db.close();
    await redis.close();

    console.log('\n' + '='.repeat(60));
    process.exit(0);

  } catch (error) {
    console.error('\n❌ Error closing position:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

closePosition();
