const logger = require('../utils/logger');

class BaseStrategy {
  constructor(config = {}) {
    this.name = config.name || 'BaseStrategy';
    this.timeframe = config.timeframe || '1h';
    this.riskPercent = config.riskPercent || 1;
    this.minRiskRewardRatio = config.minRiskRewardRatio || 2;
    this.maxPositions = config.maxPositions || 3;
    this.enabled = config.enabled !== false;

    this.signals = [];
    this.lastAnalysisTime = null;
  }

  async analyze(symbol, marketData) {
    throw new Error('analyze method must be implemented by subclass');
  }

  async generateSignal(symbol, marketData) {
    throw new Error('generateSignal method must be implemented by subclass');
  }

  calculatePositionSize(accountBalance, entryPrice, stopLoss, tickSize) {
    const riskAmount = accountBalance * (this.riskPercent / 100);
    const priceDifference = Math.abs(entryPrice - stopLoss);
    let positionSize = riskAmount / priceDifference;

    // Round to tick size
    const decimalPlaces = this.countDecimalPlaces(tickSize);
    const multiplier = Math.pow(10, decimalPlaces);
    positionSize = Math.floor(positionSize * multiplier) / multiplier;

    const actualRisk = positionSize * priceDifference;
    const actualRiskPercent = (actualRisk / accountBalance) * 100;

    return {
      positionSize,
      riskAmount: actualRisk,
      riskPercent: actualRiskPercent,
      valid: actualRiskPercent <= this.riskPercent,
    };
  }

  calculateTakeProfit(entryPrice, stopLoss, riskRewardRatio = this.minRiskRewardRatio, side, tickSize) {
    const riskAmount = Math.abs(entryPrice - stopLoss);
    const rewardAmount = riskAmount * riskRewardRatio;

    let takeProfit;
    if (side === 'LONG') {
      takeProfit = entryPrice + rewardAmount;
    } else {
      takeProfit = entryPrice - rewardAmount;
    }

    // Round to tick size
    const decimalPlaces = this.countDecimalPlaces(tickSize);
    const multiplier = Math.pow(10, decimalPlaces);
    takeProfit = Math.floor(takeProfit * multiplier) / multiplier;

    return takeProfit;
  }

  validateRiskReward(entryPrice, stopLoss, takeProfit) {
    const riskAmount = Math.abs(entryPrice - stopLoss);
    const rewardAmount = Math.abs(takeProfit - entryPrice);
    const actualRatio = rewardAmount / riskAmount;

    return {
      valid: actualRatio >= this.minRiskRewardRatio,
      actualRatio,
      riskAmount,
      rewardAmount,
    };
  }

  countDecimalPlaces(value) {
    if (value === 0) return 0;
    const str = value.toString();
    if (str.indexOf('.') === -1) return 0;
    return str.split('.')[1].length;
  }

  async checkConfluence(indicators, requiredConfluence = 2) {
    const bullishSignals = [];
    const bearishSignals = [];

    for (const [key, value] of Object.entries(indicators)) {
      if (value.signal === 'BULLISH') {
        bullishSignals.push(key);
      } else if (value.signal === 'BEARISH') {
        bearishSignals.push(key);
      }
    }

    const bullishScore = bullishSignals.length;
    const bearishScore = bearishSignals.length;

    let direction = 'NEUTRAL';
    if (bullishScore >= requiredConfluence && bullishScore > bearishScore) {
      direction = 'LONG';
    } else if (bearishScore >= requiredConfluence && bearishScore > bullishScore) {
      direction = 'SHORT';
    }

    return {
      direction,
      bullishScore,
      bearishScore,
      bullishSignals,
      bearishSignals,
      confluenceMet: bullishScore >= requiredConfluence || bearishScore >= requiredConfluence,
    };
  }

  async shouldTrade(symbol, marketData, openPositions) {
    if (!this.enabled) {
      return { shouldTrade: false, reason: 'Strategy disabled' };
    }

    // Check if already have position for this symbol
    const hasPosition = openPositions.some(pos => pos.symbol === symbol);
    if (hasPosition) {
      return { shouldTrade: false, reason: 'Already have position' };
    }

    // Check max positions limit
    if (openPositions.length >= this.maxPositions) {
      return { shouldTrade: false, reason: 'Max positions reached' };
    }

    // Check if recently analyzed (avoid spamming)
    const minInterval = 60000; // 1 minute
    if (this.lastAnalysisTime) {
      const timeSinceLastAnalysis = Date.now() - this.lastAnalysisTime;
      if (timeSinceLastAnalysis < minInterval) {
        return { shouldTrade: false, reason: 'Analyzed recently' };
      }
    }

    return { shouldTrade: true };
  }

  logSignal(signal) {
    logger.info(`Signal generated`, {
      strategy: this.name,
      symbol: signal.symbol,
      side: signal.side,
      entryPrice: signal.entryPrice,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      riskPercent: signal.riskPercent,
      confidence: signal.confidence,
    });
  }
}

module.exports = BaseStrategy;
