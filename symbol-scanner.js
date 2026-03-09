require('dotenv').config();
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const logger = require('./src/utils/logger');

// Load config
const BASE_URL = process.env.BINANCE_FUTURES_BASE_URL || 'https://testnet.binancefuture.com';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

console.log('='.repeat(60));
console.log('🔍 Symbol Scanner & Opportunity Analyzer');
console.log('='.repeat(60));
console.log(`\n📊 Environment: ${BASE_URL.includes('testnet') ? 'TESTNET (Demo)' : 'MAINNET (Live)'}`);

async function getExchangeInfo() {
  try {
    logger.info('Fetching exchange info...');
    const response = await axios.get(`${BASE_URL}/fapi/v1/exchangeInfo`);
    return response.data;
  } catch (error) {
    logger.error('Failed to fetch exchange info', { error: error.message });
    throw error;
  }
}

async function get24hrTicker(symbol) {
  try {
    const response = await axios.get(`${BASE_URL}/fapi/v1/ticker/24hr`, {
      params: { symbol }
    });
    return response.data;
  } catch (error) {
    logger.debug('Failed to fetch 24h ticker', { symbol, error: error.message });
    return null;
  }
}

async function getKlines(symbol, interval = '1h', limit = 100) {
  try {
    const response = await axios.get(`${BASE_URL}/fapi/v1/klines`, {
      params: { symbol, interval, limit }
    });
    return response.data;
  } catch (error) {
    logger.debug('Failed to fetch klines', { symbol, error: error.message });
    return null;
  }
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

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );

    trueRanges.push(tr);
  }

  return trueRanges.slice(-period).reduce((sum, tr) => sum + tr, 0) / period;
}

function calculateRSI(klines, period = 14) {
  if (!klines || klines.length < period + 1) return 50;

  const closes = klines.map(k => parseFloat(k[4]));

  let gains = 0;
  let losses = 0;

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

function calculateEMA(prices, period) {
  if (!prices || prices.length < period) return prices[prices.length - 1];

  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((sum, price) => sum + price, 0) / period;

  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }

  return ema;
}

function calculateTrend(klines) {
  if (!klines || klines.length < 50) return 'NEUTRAL';

  const closes = klines.map(k => parseFloat(k[4]));
  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  const ema50 = calculateEMA(closes, 50);
  const currentPrice = closes[closes.length - 1];

  const isUpTrend = ema9 > ema21 && ema21 > ema50 && currentPrice > ema50;
  const isDownTrend = ema9 < ema21 && ema21 < ema50 && currentPrice < ema50;

  if (isUpTrend) return 'UP';
  if (isDownTrend) return 'DOWN';
  return 'NEUTRAL';
}

function calculateProfitPotential(ticker, klines, atr) {
  if (!ticker || !klines || klines.length === 0) return 0;

  const currentPrice = parseFloat(ticker.lastPrice);
  const volatility = atr / currentPrice;
  const volume = parseFloat(ticker.quoteVolume);
  const priceChangePercent = parseFloat(ticker.priceChangePercent);

  // Score components
  let score = 0;

  // Volatility score (0-30)
  if (volatility > 0.05) score += 30;
  else if (volatility > 0.03) score += 25;
  else if (volatility > 0.02) score += 20;
  else if (volatility > 0.01) score += 15;
  else score += 5;

  // Volume score (0-25)
  if (volume > 100000000) score += 25;
  else if (volume > 50000000) score += 20;
  else if (volume > 10000000) score += 15;
  else if (volume > 5000000) score += 10;
  else score += 5;

  // Trend score (0-25)
  const trend = calculateTrend(klines);
  if (trend === 'UP' || trend === 'DOWN') score += 25;
  else if (trend === 'NEUTRAL') score += 10;

  // Price change score (0-20)
  const absChange = Math.abs(priceChangePercent);
  if (absChange > 3) score += 20;
  else if (absChange > 2) score += 15;
  else if (absChange > 1) score += 10;
  else score += 5;

  return score;
}

async function analyzeSymbols() {
  try {
    // Get exchange info
    const exchangeInfo = await getExchangeInfo();

    // Filter USDT futures symbols (exclude expired)
    const symbols = exchangeInfo.symbols
      .filter(s => s.quoteAsset === 'USDT' && s.contractType === 'PERPETUAL' && s.status === 'TRADING')
      .map(s => s.symbol)
      .sort();

    console.log(`\n📊 Found ${symbols.length} USDT perpetual futures symbols`);
    console.log('-'.repeat(60));

    // Analyze each symbol
    const results = [];
    let processed = 0;

    for (const symbol of symbols) {
      try {
        // Get 24h ticker
        const ticker = await get24hrTicker(symbol);

        if (!ticker) {
          processed++;
          continue;
        }

        // Get klines for technical analysis
        const klines = await getKlines(symbol, '1h', 100);

        if (!klines || klines.length < 50) {
          processed++;
          continue;
        }

        // Calculate indicators
        const atr = calculateATR(klines, 14);
        const rsi = calculateRSI(klines, 14);
        const trend = calculateTrend(klines);
        const profitPotential = calculateProfitPotential(ticker, klines, atr);

        const result = {
          symbol,
          price: parseFloat(ticker.lastPrice),
          volume: parseFloat(ticker.quoteVolume),
          priceChange: parseFloat(ticker.priceChangePercent),
          volatility: atr / parseFloat(ticker.lastPrice),
          rsi,
          trend,
          profitPotential,
          atr,
        };

        results.push(result);

        processed++;
        if (processed % 10 === 0) {
          console.log(`   Processed: ${processed}/${symbols.length}`);
        }

      } catch (error) {
        processed++;
        logger.debug('Error analyzing symbol', { symbol, error: error.message });
      }
    }

    // Sort by profit potential
    results.sort((a, b) => b.profitPotential - a.profitPotential);

    // Get top 20
    const top20 = results.slice(0, 20);

    // Display results
    console.log('\n📊 TOP 20 OPPORTUNITIES (Sorted by Profit Potential)');
    console.log('='.repeat(120));
    console.log(sprintf('%-15s %-12s %-15s %-12s %-10s %-10s %-12s %s',
      'Symbol', 'Price', 'Volume ($M)', 'Change %', 'Volatility', 'RSI', 'Trend', 'Score'));
    console.log('='.repeat(120));

    for (const r of top20) {
      const volumeM = (r.volume / 1000000).toFixed(2);
      const trendIcon = r.trend === 'UP' ? '🟢' : r.trend === 'DOWN' ? '🔴' : '⚪';
      const rsiSignal = r.rsi < 30 ? 'Oversold' : r.rsi > 70 ? 'Overbought' : 'Neutral';

      console.log(sprintf('%-15s $%-12.2f %-15.2f %-12.2f %-10.4f %-10.2f %-12s %s',
        r.symbol, r.price, volumeM, r.priceChange, r.volatility, r.rsi, `${trendIcon} ${rsiSignal}`, r.profitPotential));
    }

    console.log('\n' + '='.repeat(120));

    // Analysis summary
    console.log('\n📊 ANALYSIS SUMMARY');
    console.log('-'.repeat(60));
    console.log(`Total Symbols Analyzed: ${results.length}`);

    const top10Avg = top20.slice(0, 10).reduce((sum, r) => sum + r.profitPotential, 0) / 10;
    console.log(`Top 10 Average Score: ${top10Avg.toFixed(1)}`);

    console.log(`High Volatility (>3%): ${results.filter(r => r.volatility > 0.03).length}`);
    console.log(`Strong Trends: ${results.filter(r => r.trend !== 'NEUTRAL').length}`);

    // Count bullish and bearish opportunities
    const bullishCount = results.filter(r => r.trend === 'UP' && r.rsi < 50).length;
    const bearishCount = results.filter(r => r.trend === 'DOWN' && r.rsi > 50).length;
    console.log(`Bullish Opportunities (Uptrend + RSI < 50): ${bullishCount}`);
    console.log(`Bearish Opportunities (Downtrend + RSI > 50): ${bearishCount}`);

    // Send to Telegram
    await sendToTelegram(top20, results);

    return top20;

  } catch (error) {
    logger.error('Failed to analyze symbols', { error: error.message, stack: error.stack });
    throw error;
  }
}

function sprintf(format, ...args) {
  return format.replace(/%(-?\d*)\.?\d*[sdffg]/g, (match) => {
    const value = args.shift();
    const precision = match.match(/\.(\d+)/);
    const width = match.match(/-?(\d+)/);

    let formatted = value;
    if (precision) {
      formatted = parseFloat(value).toFixed(parseInt(precision[1]));
    }

    if (width) {
      const w = parseInt(width[1]);
      const align = match.includes('-') ? 'left' : 'right';
      if (align === 'left') {
        formatted = formatted.toString().padEnd(w);
      } else {
        formatted = formatted.toString().padStart(w);
      }
    }

    return formatted;
  });
}

async function sendToTelegram(top20, allResults) {
  try {
    const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

    // Create message
    let message = `🔍 *Symbol Scanner Results*

📊 *Top 10 Best Opportunities*\n\n`;

    for (let i = 0; i < Math.min(10, top20.length); i++) {
      const r = top20[i];
      const trendIcon = r.trend === 'UP' ? '🟢' : r.trend === 'DOWN' ? '🔴' : '⚪';

      message += `*${i + 1}. ${r.symbol}*
💰 Price: $${r.price.toFixed(2)}
📈 Change: ${r.priceChange >= 0 ? '+' : ''}${r.priceChange.toFixed(2)}%
🌊 Volatility: ${(r.volatility * 100).toFixed(2)}%
📊 RSI: ${r.rsi.toFixed(1)}
${trendIcon} Trend: ${r.trend}
⭐ Score: ${r.profitPotential.toFixed(0)}/100

`;
    }

    message += `*Recommendation:*
Start with ${top20[0].symbol} - Highest profit potential (${top20[0].profitPotential.toFixed(0)}/100)

*Environment:* ${BASE_URL.includes('testnet') ? 'TESTNET (Demo)' : 'MAINNET'}
*Total Analyzed:* ${allResults.length} symbols`;

    await bot.sendMessage(TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' });
    logger.info('Results sent to Telegram');

  } catch (error) {
    logger.error('Failed to send to Telegram', { error: error.message });
  }
}

async function main() {
  console.log('\n🚀 Starting symbol analysis...\n');

  const topOpportunities = await analyzeSymbols();

  console.log('\n✅ Analysis complete!');
  console.log('\n💡 Recommendation:');
  console.log(`   Top symbol: ${topOpportunities[0].symbol}`);
  console.log(`   Profit potential: ${topOpportunities[0].profitPotential.toFixed(0)}/100`);
  console.log(`   Current price: $${topOpportunities[0].price.toFixed(2)}`);
  console.log(`   Trend: ${topOpportunities[0].trend}`);
  console.log(`   RSI: ${topOpportunities[0].rsi.toFixed(1)}`);

  console.log('\n' + '='.repeat(60));
  console.log('📞 Check Telegram for detailed results!');
  console.log('='.repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('\n❌ Fatal error:', error.message);
    logger.error('Fatal error', { error: error.message, stack: error.stack });
    process.exit(1);
  });
