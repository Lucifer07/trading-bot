require('dotenv').config();
const Redis = require('ioredis');
const axios = require('axios');

// Configuration
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || '';
const BASE_URL = process.env.BINANCE_FUTURES_BASE_URL || 'https://testnet.binancefuture.com';

// Trading criteria
const MIN_CONFIDENCE = 0.75;  // 75%
const MIN_RISK_REWARD = 2.5;   // 2.5:1

console.log('='.repeat(60));
console.log('🔍 Checking Redis for Trading Signals');
console.log('='.repeat(60));
console.log(`\n📊 Environment: ${BASE_URL.includes('testnet') ? 'TESTNET' : 'MAINNET'}`);
console.log(`🎯 Min Confidence: ${MIN_CONFIDENCE * 100}%`);
console.log(`📊 Min Risk-Reward: 1:${MIN_RISK_REWARD}`);
console.log('');

// Redis client
let redis = null;

async function connectRedis() {
  try {
    if (REDIS_PASSWORD) {
      redis = new Redis(`redis://:${REDIS_PASSWORD}@${REDIS_HOST}:${REDIS_PORT}`);
    } else {
      redis = new Redis(`redis://${REDIS_HOST}:${REDIS_PORT}`);
    }
    await redis.ping();
    console.log('✅ Connected to Redis\n');
    return true;
  } catch (error) {
    console.error('❌ Failed to connect to Redis:', error.message);
    return false;
  }
}

async function getAllRedisKeys() {
  try {
    const keys = await redis.keys('*');
    console.log(`📂 Found ${keys.length} keys in Redis:\n`);
    keys.forEach(key => {
      console.log(`   - ${key}`);
    });
    console.log('');
    return keys;
  } catch (error) {
    console.error('❌ Failed to get keys:', error.message);
    return [];
  }
}

async function getRedisValue(key) {
  try {
    const type = await redis.type(key);
    let value;

    switch(type) {
      case 'string':
        value = await redis.get(key);
        try {
          value = JSON.parse(value);
        } catch(e) {}
        break;
      case 'hash':
        value = await redis.hgetall(key);
        break;
      case 'list':
        value = await redis.lrange(key, 0, -1);
        break;
      case 'set':
        value = await redis.smembers(key);
        break;
      case 'zset':
        value = await redis.zrange(key, 0, -1, 'WITHSCORES');
        break;
    }

    return { type, value };
  } catch (error) {
    console.error(`❌ Failed to get value for ${key}:`, error.message);
    return null;
  }
}

// Technical Analysis Functions
function calculateEMA(prices, period) {
  if (!prices || prices.length < period) return prices[prices.length - 1];
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((sum, price) => sum + price, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function calculateRSI(klines, period = 14) {
  if (!klines || klines.length < period + 1) return 50;
  const closes = klines.map(k => parseFloat(k[4]));
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateATR(klines, period = 14) {
  if (!klines || klines.length < period + 1) return 0;
  const trueRanges = [];
  for (let i = 1; i < klines.length; i++) {
    const current = klines[i];
    const previous = klines[i - 1];
    const high = parseFloat(current[2]);
    const low = parseFloat(current[3]);
    const prevClose = parseFloat(previous[4]);
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trueRanges.push(tr);
  }
  return trueRanges.slice(-period).reduce((sum, tr) => sum + tr, 0) / period;
}

async function analyzeSymbol(symbol) {
  try {
    // Fetch market data
    const [klines, ticker] = await Promise.all([
      axios.get(`${BASE_URL}/fapi/v1/klines`, {
        params: { symbol, interval: '1h', limit: 200 }
      }),
      axios.get(`${BASE_URL}/fapi/v1/ticker/price`, {
        params: { symbol }
      })
    ]);

    const klinesData = klines.data;
    const currentPrice = parseFloat(ticker.data.price);
    const closes = klinesData.map(k => parseFloat(k[4]));

    // Calculate indicators
    const ema9 = calculateEMA(closes, 9);
    const ema21 = calculateEMA(closes, 21);
    const ema50 = calculateEMA(closes, 50);
    const prevEma9 = calculateEMA(closes.slice(0, -1), 9);
    const prevEma21 = calculateEMA(closes.slice(0, -1), 21);
    const rsi = calculateRSI(klinesData, 14);
    const atr = calculateATR(klinesData, 14);

    // Determine signals
    const bullishCrossover = prevEma9 <= prevEma21 && ema9 > ema21;
    const bearishCrossover = prevEma9 >= prevEma21 && ema9 < ema21;
    const isOversold = rsi < 30;
    const isOverbought = rsi > 70;

    // EMA trend
    const isUpTrend = ema9 > ema21 && ema21 > ema50 && currentPrice > ema50;
    const isDownTrend = ema9 < ema21 && ema21 < ema50 && currentPrice < ema50;

    // EMA Signal
    let emaSignal = 'NEUTRAL';
    let emaConfidence = 0;
    if (bullishCrossover) {
      emaSignal = 'LONG';
      emaConfidence = isUpTrend ? 0.9 : 0.7;
    } else if (bearishCrossover) {
      emaSignal = 'SHORT';
      emaConfidence = isDownTrend ? 0.9 : 0.7;
    }

    // RSI Signal
    let rsiSignal = 'NEUTRAL';
    let rsiConfidence = 0;
    if (isOversold && isUpTrend) {
      rsiSignal = 'LONG';
      rsiConfidence = 0.8;
    } else if (isOverbought && isDownTrend) {
      rsiSignal = 'SHORT';
      rsiConfidence = 0.8;
    }

    // Aggregate signal (both must agree)
    let overallSignal = 'NEUTRAL';
    let confidence = 0;

    if (emaSignal === rsiSignal && emaSignal !== 'NEUTRAL') {
      overallSignal = emaSignal;
      confidence = (emaConfidence + rsiConfidence) / 2;
    }

    // Calculate SL, TP, R:R
    let stopLoss, takeProfit, riskRewardRatio;
    if (overallSignal !== 'NEUTRAL') {
      const stopLossDist = atr * 2;
      stopLoss = overallSignal === 'LONG'
        ? currentPrice - stopLossDist
        : currentPrice + stopLossDist;
      takeProfit = overallSignal === 'LONG'
        ? currentPrice + (stopLossDist * MIN_RISK_REWARD)
        : currentPrice - (stopLossDist * MIN_RISK_REWARD);
      riskRewardRatio = MIN_RISK_REWARD;
    }

    return {
      symbol,
      currentPrice,
      ema9,
      ema21,
      ema50,
      rsi,
      atr,
      emaSignal,
      emaConfidence,
      rsiSignal,
      rsiConfidence,
      overallSignal,
      confidence,
      stopLoss,
      takeProfit,
      riskRewardRatio,
      trend: isUpTrend ? 'UP' : isDownTrend ? 'DOWN' : 'NEUTRAL',
    };
  } catch (error) {
    console.error(`❌ Error analyzing ${symbol}:`, error.message);
    return null;
  }
}

async function main() {
  const connected = await connectRedis();
  if (!connected) {
    process.exit(1);
  }

  // Get all keys
  const keys = await getAllRedisKeys();

  // Look for trading-related data
  console.log('🔍 Analyzing Redis data...\n');

  // Check for symbols in various keys
  let symbolsToCheck = new Set();

  for (const key of keys) {
    const { type, value } = await getRedisValue(key);

    if (key.includes('symbol') || key.includes('top') || key.includes('scan')) {
      console.log(`📦 Key: ${key}`);
      console.log(`   Type: ${type}`);

      if (Array.isArray(value)) {
        console.log(`   Items: ${value.length}`);
        if (value.length > 0 && typeof value[0] === 'string') {
          value.forEach(item => {
            if (typeof item === 'string' && item.includes('USDT')) {
              symbolsToCheck.add(item);
            }
          });
          console.log(`   Symbols found: ${Array.from(symbolsToCheck).join(', ')}`);
        }
      } else if (typeof value === 'object' && value !== null) {
        console.log(`   Keys: ${Object.keys(value).join(', ')}`);
        Object.entries(value).forEach(([k, v]) => {
          if (typeof v === 'string' && v.includes('USDT')) {
            symbolsToCheck.add(v);
          }
        });
      }
      console.log('');
    }
  }

  // Default symbols if none found
  if (symbolsToCheck.size === 0) {
    console.log('⚠️ No symbols found in Redis, using defaults\n');
    ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'DOGEUSDT'].forEach(s => symbolsToCheck.add(s));
  }

  // Analyze all symbols
  console.log('='.repeat(60));
  console.log('📊 Signal Analysis');
  console.log('='.repeat(60));
  console.log('');

  const signals = [];
  const symbols = Array.from(symbolsToCheck);

  for (const symbol of symbols) {
    const analysis = await analyzeSymbol(symbol);
    if (analysis && analysis.overallSignal !== 'NEUTRAL') {
      signals.push(analysis);

      const meetsCriteria = analysis.confidence >= MIN_CONFIDENCE &&
                           analysis.riskRewardRatio >= MIN_RISK_REWARD;

      const statusEmoji = meetsCriteria ? '🟢' : '🟡';

      console.log(`${statusEmoji} ${symbol}`);
      console.log(`   Signal: ${analysis.overallSignal} | Confidence: ${(analysis.confidence * 100).toFixed(1)}% | R:R: 1:${analysis.riskRewardRatio.toFixed(1)}`);
      console.log(`   Price: $${analysis.currentPrice.toFixed(2)} | Trend: ${analysis.trend}`);
      console.log(`   EMA: ${analysis.ema9.toFixed(2)} / ${analysis.ema21.toFixed(2)} / ${analysis.ema50.toFixed(2)}`);
      console.log(`   RSI: ${analysis.rsi.toFixed(1)} | ATR: ${analysis.atr.toFixed(2)}`);
      console.log(`   SL: $${analysis.stopLoss.toFixed(2)} | TP: $${analysis.takeProfit.toFixed(2)}`);

      if (meetsCriteria) {
        console.log(`   ✅ MEETS ALL CRITERIA`);
      } else if (analysis.confidence >= MIN_CONFIDENCE) {
        console.log(`   ⚠️ Good confidence but low R:R`);
      } else if (analysis.riskRewardRatio >= MIN_RISK_REWARD) {
        console.log(`   ⚠️ Good R:R but low confidence`);
      } else {
        console.log(`   ❌ Doesn't meet criteria`);
      }
      console.log('');
    } else if (analysis) {
      console.log(`⚪ ${symbol}`);
      console.log(`   Signal: NEUTRAL | Confidence: ${(analysis.confidence * 100).toFixed(1)}%`);
      console.log(`   Price: $${analysis.currentPrice.toFixed(2)} | Trend: ${analysis.trend}`);
      console.log('');
    }
  }

  // Summary
  console.log('='.repeat(60));
  console.log('📊 SUMMARY');
  console.log('='.repeat(60));

  const validSignals = signals.filter(s =>
    s.confidence >= MIN_CONFIDENCE &&
    s.riskRewardRatio >= MIN_RISK_REWARD
  );

  console.log(`\n✅ Valid signals (≥75% confidence + R:R ≥ 2.5): ${validSignals.length}`);
  console.log(`📊 Total symbols analyzed: ${symbols.length}`);

  if (validSignals.length > 0) {
    console.log(`\n🎯 Signals Ready to Trade:`);
    validSignals.sort((a, b) => b.confidence - a.confidence);
    validSignals.forEach((s, i) => {
      console.log(`\n${i + 1}. ${s.symbol}`);
      console.log(`   Signal: ${s.overallSignal} (${(s.confidence * 100).toFixed(1)}% confidence)`);
      console.log(`   Entry: $${s.currentPrice.toFixed(2)}`);
      console.log(`   SL: $${s.stopLoss.toFixed(2)} | TP: $${s.takeProfit.toFixed(2)}`);
      console.log(`   R:R: 1:${s.riskRewardRatio.toFixed(1)} | Trend: ${s.trend}`);
    });
  } else {
    console.log(`\n⚠️ No signals meet the criteria at this time.`);
    console.log(`   - Min Confidence: 75%`);
    console.log(`   - Min Risk-Reward: 2.5`);
  }

  console.log('\n' + '='.repeat(60));

  await redis.quit();
  process.exit(0);
}

main().catch(error => {
  console.error('❌ Error:', error);
  process.exit(1);
});
