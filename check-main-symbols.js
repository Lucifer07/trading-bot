require('dotenv').config();
const Redis = require('ioredis');
const axios = require('axios');

const BASE_URL = process.env.BINANCE_FUTURES_BASE_URL || 'https://testnet.binancefuture.com';
const MIN_CONFIDENCE = 0.75;
const MIN_RISK_REWARD = 2.5;

const mainSymbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'DOGEUSDT'];

console.log('='.repeat(60));
console.log('🔍 Analyzing Main Trading Symbols');
console.log('='.repeat(60));

// Technical Analysis
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
    const [klines, ticker] = await Promise.all([
      axios.get(`${BASE_URL}/fapi/v1/klines`, { params: { symbol, interval: '1h', limit: 200 } }),
      axios.get(`${BASE_URL}/fapi/v1/ticker/price`, { params: { symbol } })
    ]);

    const klinesData = klines.data;
    const currentPrice = parseFloat(ticker.data.price);
    const closes = klinesData.map(k => parseFloat(k[4]));

    const ema9 = calculateEMA(closes, 9);
    const ema21 = calculateEMA(closes, 21);
    const ema50 = calculateEMA(closes, 50);
    const prevEma9 = calculateEMA(closes.slice(0, -1), 9);
    const prevEma21 = calculateEMA(closes.slice(0, -1), 21);
    const rsi = calculateRSI(klinesData, 14);
    const atr = calculateATR(klinesData, 14);

    const bullishCrossover = prevEma9 <= prevEma21 && ema9 > ema21;
    const bearishCrossover = prevEma9 >= prevEma21 && ema9 < ema21;
    const isOversold = rsi < 30;
    const isOverbought = rsi > 70;
    const isUpTrend = ema9 > ema21 && ema21 > ema50 && currentPrice > ema50;
    const isDownTrend = ema9 < ema21 && ema21 < ema50 && currentPrice < ema50;

    let emaSignal = 'NEUTRAL';
    let emaConfidence = 0;
    if (bullishCrossover) {
      emaSignal = 'LONG';
      emaConfidence = isUpTrend ? 0.9 : 0.7;
    } else if (bearishCrossover) {
      emaSignal = 'SHORT';
      emaConfidence = isDownTrend ? 0.9 : 0.7;
    }

    let rsiSignal = 'NEUTRAL';
    let rsiConfidence = 0;
    if (isOversold && isUpTrend) {
      rsiSignal = 'LONG';
      rsiConfidence = 0.8;
    } else if (isOverbought && isDownTrend) {
      rsiSignal = 'SHORT';
      rsiConfidence = 0.8;
    }

    let overallSignal = 'NEUTRAL';
    let confidence = 0;

    if (emaSignal === rsiSignal && emaSignal !== 'NEUTRAL') {
      overallSignal = emaSignal;
      confidence = (emaConfidence + rsiConfidence) / 2;
    }

    let stopLoss, takeProfit, riskRewardRatio;
    if (overallSignal !== 'NEUTRAL') {
      const stopLossDist = atr * 2;
      stopLoss = overallSignal === 'LONG' ? currentPrice - stopLossDist : currentPrice + stopLossDist;
      takeProfit = overallSignal === 'LONG' ? currentPrice + (stopLossDist * MIN_RISK_REWARD) : currentPrice - (stopLossDist * MIN_RISK_REWARD);
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
    console.error(`Error analyzing ${symbol}:`, error.message);
    return null;
  }
}

async function main() {
  console.log(`\n📊 Analyzing main symbols...\n`);
  
  const validSignals = [];
  
  for (const symbol of mainSymbols) {
    console.log(`🔍 Analyzing ${symbol}...`);
    const analysis = await analyzeSymbol(symbol);
    
    if (analysis && analysis.overallSignal !== 'NEUTRAL') {
      const meetsCriteria = analysis.confidence >= MIN_CONFIDENCE &&
                           analysis.riskRewardRatio >= MIN_RISK_REWARD;
      
      const statusEmoji = meetsCriteria ? '🟢' : '🟡';
      
      console.log(`${statusEmoji} ${analysis.symbol}`);
      console.log(`   Signal: ${analysis.overallSignal} | Confidence: ${(analysis.confidence * 100).toFixed(1)}% | R:R: 1:${analysis.riskRewardRatio.toFixed(1)}`);
      console.log(`   Price: $${analysis.currentPrice.toFixed(2)} | Trend: ${analysis.trend}`);
      console.log(`   EMA: ${analysis.ema9.toFixed(2)} / ${analysis.ema21.toFixed(2)} / ${analysis.ema50.toFixed(2)}`);
      console.log(`   RSI: ${analysis.rsi.toFixed(1)} | ATR: ${analysis.atr.toFixed(2)}`);
      console.log(`   SL: $${analysis.stopLoss.toFixed(2)} | TP: $${analysis.takeProfit.toFixed(2)}`);
      
      if (meetsCriteria) {
        console.log(`   ✅ MEETS ALL CRITERIA (≥75% confidence + R:R ≥ 2.5)`);
        validSignals.push(analysis);
      } else if (analysis.confidence >= MIN_CONFIDENCE) {
        console.log(`   ⚠️ Good confidence but R:R is fixed at 2.5`);
      } else if (analysis.riskRewardRatio >= MIN_RISK_REWARD) {
        console.log(`   ⚠️ Good R:R but low confidence`);
      } else {
        console.log(`   ❌ Doesn't meet criteria`);
      }
      console.log('');
    } else {
      console.log(`⚪ ${symbol}: No valid signal`);
      console.log(`   EMA: ${analysis?.ema9.toFixed(2)} / ${analysis?.ema21.toFixed(2)} / ${analysis?.ema50.toFixed(2)}`);
      console.log(`   RSI: ${analysis?.rsi.toFixed(1)} | Trend: ${analysis?.trend}`);
      console.log('');
    }
  }
  
  console.log('='.repeat(60));
  console.log('📊 SUMMARY');
  console.log('='.repeat(60));
  console.log(`\n✅ Valid signals (≥75% confidence + R:R ≥ 2.5): ${validSignals.length}`);
  
  if (validSignals.length > 0) {
    console.log(`\n🎯 Signals Ready to Trade:\n`);
    validSignals.forEach((s, i) => {
      console.log(`${i + 1}. ${s.symbol}`);
      console.log(`   Signal: ${s.overallSignal} (${(s.confidence * 100).toFixed(1)}% confidence)`);
      console.log(`   Entry: $${s.currentPrice.toFixed(2)}`);
      console.log(`   SL: $${s.stopLoss.toFixed(2)} | TP: $${s.takeProfit.toFixed(2)}`);
      console.log(`   R:R: 1:${s.riskRewardRatio.toFixed(1)} | Trend: ${s.trend}`);
      console.log('');
    });
  } else {
    console.log(`\n⚠️ No signals meet the criteria at this time.`);
    console.log(`   - Min Confidence: 75%`);
    console.log(`   - Min Risk-Reward: 2.5`);
    console.log(`   - Required: Both EMA and RSI strategies must agree (100% confluence)`);
  }
  
  console.log('\n' + '='.repeat(60));
  
  process.exit(0);
}

main();
