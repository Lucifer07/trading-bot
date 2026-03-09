const logger = require('../utils/logger');
const { config } = require('../config');

class RiskCalculator {
  constructor() {
    this.maxPositionSizePercent = config.risk.maxPositionSizePercent;
    this.maxTotalOpenRiskPercent = config.risk.maxTotalOpenRiskPercent;
    this.maxDailyLossPercent = config.risk.maxDailyLossPercent;
    this.stopLossBufferATR = config.risk.stopLossBufferATR;
  }

  /**
   * Calculate position size based on risk percentage and stop loss
   * Formula: Position Size = (Account Balance × Risk %) / (Entry Price - Stop Loss)
   *
   * @param {number} accountBalance - Total account balance
   * @param {number} riskPercent - Risk percentage (1-2% recommended)
   * @param {number} entryPrice - Entry price
   * @param {number} stopLoss - Stop loss price
   * @param {number} tickSize - Minimum price increment (for precision)
   * @returns {Object} Position size calculation result
   */
  calculatePositionSize(accountBalance, riskPercent, entryPrice, stopLoss, tickSize = 0.01) {
    if (riskPercent > this.maxPositionSizePercent) {
      logger.warn(`Risk percent ${riskPercent}% exceeds max ${this.maxPositionSizePercent}%, capping`);
      riskPercent = this.maxPositionSizePercent;
    }

    const riskAmount = accountBalance * (riskPercent / 100);
    const priceDifference = Math.abs(entryPrice - stopLoss);

    if (priceDifference === 0) {
      throw new Error('Entry price and stop loss cannot be the same');
    }

    let positionSize = riskAmount / priceDifference;

    // Round to tick size precision
    positionSize = this.roundToPrecision(positionSize, tickSize);

    // Calculate actual risk amount
    const actualRisk = positionSize * priceDifference;
    const actualRiskPercent = (actualRisk / accountBalance) * 100;

    logger.info('Position size calculated', {
      accountBalance,
      riskPercent,
      entryPrice,
      stopLoss,
      positionSize,
      riskAmount: actualRisk.toFixed(2),
      actualRiskPercent: actualRiskPercent.toFixed(2),
    });

    return {
      positionSize,
      riskAmount: actualRisk,
      riskPercent: actualRiskPercent,
      priceDifference,
      valid: actualRiskPercent <= this.maxPositionSizePercent,
    };
  }

  /**
   * Calculate stop loss level based on ATR or support level
   *
   * @param {number} entryPrice - Entry price
   * @param {number} atr - Average True Range
   * @param {number} side - 'LONG' or 'SHORT'
   * @param {number} supportLevel - Support level (optional)
   * @param {number} tickSize - Minimum price increment
   * @returns {number} Stop loss price
   */
  calculateStopLoss(entryPrice, atr, side = 'LONG', supportLevel = null, tickSize = 0.01) {
    const buffer = atr * this.stopLossBufferATR;

    let stopLoss;

    if (side === 'LONG') {
      if (supportLevel) {
        stopLoss = supportLevel;
      } else {
        stopLoss = entryPrice - buffer;
      }
    } else {
      // SHORT position
      if (supportLevel) {
        stopLoss = supportLevel;
      } else {
        stopLoss = entryPrice + buffer;
      }
    }

    return this.roundToPrecision(stopLoss, tickSize);
  }

  /**
   * Calculate take profit level based on risk-reward ratio
   *
   * @param {number} entryPrice - Entry price
   * @param {number} stopLoss - Stop loss price
   * @param {number} riskRewardRatio - Risk-reward ratio (default 2)
   * @param {string} side - 'LONG' or 'SHORT'
   * @param {number} tickSize - Minimum price increment
   * @returns {number} Take profit price
   */
  calculateTakeProfit(entryPrice, stopLoss, riskRewardRatio = 2, side = 'LONG', tickSize = 0.01) {
    const riskAmount = Math.abs(entryPrice - stopLoss);
    const rewardAmount = riskAmount * riskRewardRatio;

    let takeProfit;

    if (side === 'LONG') {
      takeProfit = entryPrice + rewardAmount;
    } else {
      // SHORT position
      takeProfit = entryPrice - rewardAmount;
    }

    return this.roundToPrecision(takeProfit, tickSize);
  }

  /**
   * Validate if a trade meets risk-reward ratio minimum
   *
   * @param {number} entryPrice - Entry price
   * @param {number} stopLoss - Stop loss price
   * @param {number} takeProfit - Take profit price
   * @param {number} minRatio - Minimum risk-reward ratio
   * @returns {Object} Validation result
   */
  validateRiskReward(entryPrice, stopLoss, takeProfit, minRatio = config.trading.minRiskRewardRatio) {
    const riskAmount = Math.abs(entryPrice - stopLoss);
    const rewardAmount = Math.abs(takeProfit - entryPrice);
    const actualRatio = rewardAmount / riskAmount;

    const isValid = actualRatio >= minRatio;

    logger.info('Risk-reward validation', {
      riskAmount,
      rewardAmount,
      actualRatio: actualRatio.toFixed(2),
      minRatio,
      isValid,
    });

    return {
      valid: isValid,
      actualRatio,
      riskAmount,
      rewardAmount,
    };
  }

  /**
   * Calculate total open risk across all positions
   *
   * @param {Array} positions - Array of open positions
   * @param {number} accountBalance - Account balance
   * @returns {Object} Total risk calculation
   */
  calculateTotalOpenRisk(positions, accountBalance) {
    let totalRisk = 0;
    let totalUnrealizedPnL = 0;

    positions.forEach((position) => {
      const riskAmount = parseFloat(position.risk_amount) || 0;
      const unrealizedPnL = parseFloat(position.unrealized_pnl) || 0;

      totalRisk += riskAmount;
      totalUnrealizedPnL += unrealizedPnL;
    });

    const riskPercent = (totalRisk / accountBalance) * 100;

    const canOpenNewPosition = riskPercent < this.maxTotalOpenRiskPercent;

    logger.info('Total open risk calculated', {
      totalRisk,
      riskPercent: riskPercent.toFixed(2),
      maxRiskPercent: this.maxTotalOpenRiskPercent,
      canOpenNewPosition,
      totalUnrealizedPnL,
    });

    return {
      totalRisk,
      riskPercent,
      maxRiskPercent: this.maxTotalOpenRiskPercent,
      canOpenNewPosition,
      totalUnrealizedPnL,
    };
  }

  /**
   * Check if daily loss limit has been exceeded
   *
   * @param {number} realizedPnL - Today's realized P/L
   * @param {number} accountBalance - Account balance
   * @returns {Object} Daily loss check result
   */
  checkDailyLossLimit(realizedPnL, accountBalance) {
    const dailyLossPercent = (Math.abs(realizedPnL) / accountBalance) * 100;

    const isExceeded = realizedPnL < 0 && dailyLossPercent >= this.maxDailyLossPercent;

    logger.info('Daily loss check', {
      realizedPnL,
      dailyLossPercent: dailyLossPercent.toFixed(2),
      maxLossPercent: this.maxDailyLossPercent,
      isExceeded,
    });

    return {
      realizedPnL,
      dailyLossPercent,
      maxLossPercent: this.maxDailyLossPercent,
      isExceeded,
      shouldStopTrading: isExceeded,
    };
  }

  /**
   * Check position correlation
   *
   * @param {Array} openPositions - Currently open positions
   * @param {string} newSymbol - New symbol to trade
   * @param {number} maxCorrelated - Maximum allowed correlated positions
   * @returns {boolean} True if position is allowed
   */
  checkPositionCorrelation(openPositions, newSymbol, maxCorrelated = config.trading.maxCorrelatedPositions) {
    // Simple correlation check based on base asset
    const baseAsset = newSymbol.substring(0, newSymbol.indexOf('USDT'));
    const correlatedCount = openPositions.filter((pos) => {
      const posBaseAsset = pos.symbol.substring(0, pos.symbol.indexOf('USDT'));
      return posBaseAsset === baseAsset;
    }).length;

    const isAllowed = correlatedCount < maxCorrelated;

    logger.info('Position correlation check', {
      newSymbol,
      baseAsset,
      correlatedCount,
      maxCorrelated,
      isAllowed,
    });

    return {
      allowed: isAllowed,
      correlatedCount,
      maxCorrelated,
    };
  }

  /**
   * Round number to specific precision
   *
   * @param {number} value - Value to round
   * @param {number} precision - Precision (tick size)
   * @returns {number} Rounded value
   */
  roundToPrecision(value, precision) {
    const decimalPlaces = this.countDecimalPlaces(precision);
    const multiplier = Math.pow(10, decimalPlaces);
    return Math.floor(value * multiplier) / multiplier;
  }

  /**
   * Count decimal places in a number
   *
   * @param {number} value - Value to count decimals for
   * @returns {number} Number of decimal places
   */
  countDecimalPlaces(value) {
    if (value === 0) return 0;
    const str = value.toString();
    if (str.indexOf('.') === -1) return 0;
    return str.split('.')[1].length;
  }

  /**
   * Calculate maximum position size based on leverage
   *
   * @param {number} accountBalance - Account balance
   * @param {number} leverage - Leverage multiplier
   * @returns {number} Maximum position value
   */
  calculateMaxPositionValue(accountBalance, leverage) {
    return accountBalance * leverage;
  }

  /**
   * Validate if position size is within limits
   *
   * @param {number} positionValue - Position value
   * @param {number} maxPositionValue - Maximum allowed position value
   * @returns {boolean} True if valid
   */
  validatePositionSize(positionValue, maxPositionValue) {
    return positionValue <= maxPositionValue;
  }

   /**
    * Calculate trading fees (maker/taker + funding)
    *
    * @param {number} positionValue - Position value (price × quantity)
    * @param {number} leverage - Leverage used
    * @param {number} holdingHours - Expected holding time in hours
    * @returns {Object} Fee breakdown
    */
   calculateTradingFees(positionValue, leverage = 1, holdingHours = 24) {
     // Binance Futures fees
     const takerFeeRate = 0.0004; // 0.04% for taker orders
     const makerFeeRate = 0.0002; // 0.02% for maker orders
     const fundingRate = 0.0001; // ~0.01% per 8 hours (average)

     // Use taker fee for conservative estimate (most orders are taker)
     const entryFee = positionValue * takerFeeRate;
     const exitFee = positionValue * takerFeeRate;

     // Funding fee (charged every 8 hours)
     const fundingPeriods = Math.ceil(holdingHours / 8);
     const fundingFee = positionValue * fundingRate * fundingPeriods;

     const totalFees = entryFee + exitFee + fundingFee;
     const feePercent = (totalFees / (positionValue / leverage)) * 100;

     return {
       entryFee,
       exitFee,
       fundingFee,
       totalFees,
       feePercent,
       breakdown: {
         entry: entryFee.toFixed(4),
         exit: exitFee.toFixed(4),
         funding: fundingFee.toFixed(4),
         total: totalFees.toFixed(4),
       }
     };
   }

   /**
    * Calculate position size with fees included
    * Adjusts risk amount to account for trading fees
    *
    * @param {number} accountBalance - Total account balance
    * @param {number} riskPercent - Risk percentage
    * @param {number} entryPrice - Entry price
    * @param {number} stopLoss - Stop loss price
    * @param {number} tickSize - Minimum price increment
    * @param {number} leverage - Leverage used
    * @param {number} holdingHours - Expected holding time
    * @returns {Object} Position size with fees
    */
   calculatePositionSizeWithFees(accountBalance, riskPercent, entryPrice, stopLoss, tickSize = 0.01, leverage = 5, holdingHours = 24) {
     // First calculate base position size
     const baseResult = this.calculatePositionSize(accountBalance, riskPercent, entryPrice, stopLoss, tickSize);

     // Calculate position value
     const positionValue = baseResult.positionSize * entryPrice;

     // Calculate fees
     const fees = this.calculateTradingFees(positionValue, leverage, holdingHours);

     // Adjust risk amount to include fees
     const adjustedRiskAmount = baseResult.riskAmount + fees.totalFees;
     const adjustedRiskPercent = (adjustedRiskAmount / accountBalance) * 100;

     // If adjusted risk exceeds limit, reduce position size
     let finalPositionSize = baseResult.positionSize;
     let finalRiskAmount = adjustedRiskAmount;
     let finalRiskPercent = adjustedRiskPercent;

     if (adjustedRiskPercent > this.maxPositionSizePercent) {
       // Recalculate with reduced position size
       const maxRiskAmount = accountBalance * (this.maxPositionSizePercent / 100);
       const riskForPosition = maxRiskAmount - fees.totalFees;
       const priceDifference = Math.abs(entryPrice - stopLoss);

       finalPositionSize = this.roundToPrecision(riskForPosition / priceDifference, tickSize);
       finalRiskAmount = (finalPositionSize * priceDifference) + fees.totalFees;
       finalRiskPercent = (finalRiskAmount / accountBalance) * 100;

       logger.warn('Position size reduced due to fees', {
         originalSize: baseResult.positionSize,
         reducedSize: finalPositionSize,
         fees: fees.totalFees.toFixed(4),
       });
     }

     logger.info('Position size calculated with fees', {
       accountBalance,
       riskPercent,
       positionSize: finalPositionSize,
       riskAmount: finalRiskAmount.toFixed(4),
       actualRiskPercent: finalRiskPercent.toFixed(2),
       fees: fees.breakdown,
       feeImpact: fees.feePercent.toFixed(2) + '%',
     });

     return {
       positionSize: finalPositionSize,
       riskAmount: finalRiskAmount,
       riskPercent: finalRiskPercent,
       priceDifference: baseResult.priceDifference,
       fees: fees,
       valid: finalRiskPercent <= this.maxPositionSizePercent,
     };
   }
}

module.exports = RiskCalculator;
