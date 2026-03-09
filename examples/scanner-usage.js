require('dotenv').config();
const { TradingBot } = require('../src/index');

/**
 * Contoh Penggunaan Symbol Scanner
 * 
 * File ini menunjukkan berbagai cara menggunakan symbol scanner
 * untuk mendapatkan trading opportunities
 */

async function main() {
  const bot = new TradingBot();

  try {
    // Initialize bot
    console.log('Initializing bot...\n');
    await bot.db.testConnection();
    await bot.redis.testConnection();

    // Example 1: Get Latest Scan Results
    console.log('='.repeat(60));
    console.log('Example 1: Get Latest Scan Results');
    console.log('='.repeat(60));

    // Run a scan first
    console.log('Running scan...');
    await bot.symbolScanner.scanSymbols();

    const latestScan = await bot.getLatestScan();
    console.log(`Total symbols scanned: ${latestScan.count}`);
    console.log(`Scanned at: ${latestScan.scannedAt}`);
    console.log(`Top symbol: ${latestScan.results[0].symbol} (Score: ${latestScan.results[0].profitPotential})`);

    // Example 2: Get Top 20 Symbols
    console.log('\n' + '='.repeat(60));
    console.log('Example 2: Get Top 20 Symbols');
    console.log('='.repeat(60));

    const top20 = await bot.getTop20Symbols();
    console.log('\nTop 5 Symbols:');
    top20.slice(0, 5).forEach((s, i) => {
      console.log(`${i + 1}. ${s.symbol.padEnd(12)} Score: ${s.profitPotential.toFixed(0).padStart(3)} | Trend: ${s.trend.padEnd(7)} | RSI: ${s.rsi.toFixed(1)}`);
    });

    // Example 3: Filter Bullish Opportunities
    console.log('\n' + '='.repeat(60));
    console.log('Example 3: Filter Bullish Opportunities');
    console.log('='.repeat(60));

    const bullish = top20.filter(s => 
      s.trend === 'UP' && 
      s.rsi < 70 && 
      s.profitPotential > 70
    );

    console.log(`\nFound ${bullish.length} bullish opportunities:`);
    bullish.forEach((s, i) => {
      console.log(`${i + 1}. ${s.symbol.padEnd(12)} Score: ${s.profitPotential.toFixed(0)} | RSI: ${s.rsi.toFixed(1)} | Price: $${s.price}`);
    });

    // Example 4: Filter Bearish Opportunities
    console.log('\n' + '='.repeat(60));
    console.log('Example 4: Filter Bearish Opportunities');
    console.log('='.repeat(60));

    const bearish = top20.filter(s => 
      s.trend === 'DOWN' && 
      s.rsi > 30 && 
      s.profitPotential > 70
    );

    console.log(`\nFound ${bearish.length} bearish opportunities:`);
    bearish.forEach((s, i) => {
      console.log(`${i + 1}. ${s.symbol.padEnd(12)} Score: ${s.profitPotential.toFixed(0)} | RSI: ${s.rsi.toFixed(1)} | Price: $${s.price}`);
    });

    // Example 5: Get Specific Symbol Data
    console.log('\n' + '='.repeat(60));
    console.log('Example 5: Get Specific Symbol Data');
    console.log('='.repeat(60));

    const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
    console.log('\nSymbol Details:');
    
    for (const symbol of symbols) {
      const data = await bot.getSymbolData(symbol);
      if (data) {
        console.log(`\n${symbol}:`);
        console.log(`  Price: $${data.price}`);
        console.log(`  24h Change: ${data.priceChange >= 0 ? '+' : ''}${data.priceChange.toFixed(2)}%`);
        console.log(`  Volume: $${(data.volume / 1000000).toFixed(2)}M`);
        console.log(`  Volatility: ${(data.volatility * 100).toFixed(2)}%`);
        console.log(`  RSI: ${data.rsi.toFixed(1)}`);
        console.log(`  Trend: ${data.trend}`);
        console.log(`  Score: ${data.profitPotential}/100`);
      }
    }

    // Example 6: High Volatility Symbols
    console.log('\n' + '='.repeat(60));
    console.log('Example 6: High Volatility Symbols (>3%)');
    console.log('='.repeat(60));

    const highVol = top20.filter(s => s.volatility > 0.03);
    console.log(`\nFound ${highVol.length} high volatility symbols:`);
    highVol.forEach((s, i) => {
      console.log(`${i + 1}. ${s.symbol.padEnd(12)} Volatility: ${(s.volatility * 100).toFixed(2)}% | Score: ${s.profitPotential.toFixed(0)}`);
    });

    // Example 7: High Volume Symbols
    console.log('\n' + '='.repeat(60));
    console.log('Example 7: High Volume Symbols (>$100M)');
    console.log('='.repeat(60));

    const highVolume = top20.filter(s => s.volume > 100000000);
    console.log(`\nFound ${highVolume.length} high volume symbols:`);
    highVolume.forEach((s, i) => {
      console.log(`${i + 1}. ${s.symbol.padEnd(12)} Volume: $${(s.volume / 1000000).toFixed(0)}M | Score: ${s.profitPotential.toFixed(0)}`);
    });

    // Example 8: Oversold/Overbought
    console.log('\n' + '='.repeat(60));
    console.log('Example 8: Oversold & Overbought Symbols');
    console.log('='.repeat(60));

    const oversold = latestScan.results.filter(s => s.rsi < 30);
    const overbought = latestScan.results.filter(s => s.rsi > 70);

    console.log(`\nOversold (RSI < 30): ${oversold.length} symbols`);
    oversold.slice(0, 3).forEach((s, i) => {
      console.log(`${i + 1}. ${s.symbol.padEnd(12)} RSI: ${s.rsi.toFixed(1)} | Trend: ${s.trend}`);
    });

    console.log(`\nOverbought (RSI > 70): ${overbought.length} symbols`);
    overbought.slice(0, 3).forEach((s, i) => {
      console.log(`${i + 1}. ${s.symbol.padEnd(12)} RSI: ${s.rsi.toFixed(1)} | Trend: ${s.trend}`);
    });

    // Example 9: Custom Scoring
    console.log('\n' + '='.repeat(60));
    console.log('Example 9: Custom Filtering Strategy');
    console.log('='.repeat(60));

    // Custom filter: Strong uptrend + good volume + not overbought
    const customFilter = top20.filter(s => 
      s.trend === 'UP' &&
      s.rsi >= 40 && s.rsi <= 65 &&
      s.volume > 50000000 &&
      s.volatility > 0.02 &&
      s.profitPotential > 75
    );

    console.log(`\nCustom Strategy Results: ${customFilter.length} symbols`);
    console.log('Criteria: Uptrend + RSI 40-65 + Volume >$50M + Volatility >2% + Score >75');
    customFilter.forEach((s, i) => {
      console.log(`${i + 1}. ${s.symbol.padEnd(12)} Score: ${s.profitPotential.toFixed(0)} | RSI: ${s.rsi.toFixed(1)} | Vol: ${(s.volatility * 100).toFixed(2)}%`);
    });

    // Example 10: Trading Decision Example
    console.log('\n' + '='.repeat(60));
    console.log('Example 10: Trading Decision Example');
    console.log('='.repeat(60));

    if (customFilter.length > 0) {
      const bestSymbol = customFilter[0];
      console.log(`\nBest Trading Opportunity: ${bestSymbol.symbol}`);
      console.log(`Score: ${bestSymbol.profitPotential}/100`);
      console.log(`Current Price: $${bestSymbol.price}`);
      console.log(`Trend: ${bestSymbol.trend}`);
      console.log(`RSI: ${bestSymbol.rsi.toFixed(1)}`);
      console.log(`Volatility: ${(bestSymbol.volatility * 100).toFixed(2)}%`);
      
      // Calculate suggested entry/stop loss
      const entryPrice = bestSymbol.price;
      const stopLoss = entryPrice * 0.98; // 2% stop loss
      const takeProfit = entryPrice * 1.04; // 2:1 risk-reward
      
      console.log(`\nSuggested Trade Setup:`);
      console.log(`  Entry: $${entryPrice.toFixed(2)}`);
      console.log(`  Stop Loss: $${stopLoss.toFixed(2)} (-2%)`);
      console.log(`  Take Profit: $${takeProfit.toFixed(2)} (+4%)`);
      console.log(`  Risk/Reward: 1:2`);
      
      console.log(`\nTo execute this trade:`);
      console.log(`await bot.executeTrade('${bestSymbol.symbol}', 'LONG', ${entryPrice.toFixed(2)}, ${stopLoss.toFixed(2)}, 1, 'Scanner-Based');`);
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ All examples completed!');
    console.log('='.repeat(60));

    // Cleanup
    await bot.db.close();
    await bot.redis.close();

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    
    // Cleanup on error
    try {
      await bot.db.close();
      await bot.redis.close();
    } catch (e) {
      // Ignore
    }
    
    process.exit(1);
  }
}

// Run examples
main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
