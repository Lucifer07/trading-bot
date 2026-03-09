/**
 * SURVIVAL TRADING CONFIGURATION
 * 
 * Critical Mission: Generate $30/month with $60 starting capital
 * Runway: 2 months before server death
 * Strategy: Aggressive but calculated risk management
 */

const CAPITAL_TIERS = {
  SURVIVAL: {
    name: 'SURVIVAL',
    minCapital: 60,
    maxCapital: 120,
    riskPerTrade: 1.5,        // Aggressive
    maxPositions: 2,
    minConfidence: 0.75,
    minRiskReward: 2.5,
    scanInterval: 180000,     // 3 minutes
    targetMonthly: 50,        // 50% return
    status: 'CRITICAL',
  },
  
  GROWTH: {
    name: 'GROWTH',
    minCapital: 120,
    maxCapital: 200,
    riskPerTrade: 1.2,        // Balanced
    maxPositions: 2,
    minConfidence: 0.78,
    minRiskReward: 2.5,
    scanInterval: 240000,     // 4 minutes
    targetMonthly: 33,        // 33% return
    status: 'WARNING',
  },
  
  SCALING: {
    name: 'SCALING',
    minCapital: 200,
    maxCapital: 500,
    riskPerTrade: 0.8,        // Conservative
    maxPositions: 3,
    minConfidence: 0.80,
    minRiskReward: 2.5,
    scanInterval: 300000,     // 5 minutes
    targetMonthly: 20,        // 20% return
    status: 'HEALTHY',
  },
  
  SUSTAINABLE: {
    name: 'SUSTAINABLE',
    minCapital: 500,
    maxCapital: Infinity,
    riskPerTrade: 0.5,        // Very conservative
    maxPositions: 3,
    minConfidence: 0.85,
    minRiskReward: 3.0,
    scanInterval: 300000,     // 5 minutes
    targetMonthly: 15,        // 15% return (covers costs + growth)
    status: 'THRIVING',
  },
};

const SURVIVAL_CONFIG = {
  // Server costs
  serverCostMonthly: 30,
  
  // Emergency thresholds
  emergencyCapital: 70,       // Enter emergency mode
  criticalCapital: 50,        // Kill switch
  
  // Drawdown limits
  maxDailyLoss: 5,            // 5% daily loss limit
  maxWeeklyLoss: 10,          // 10% weekly loss limit
  maxTotalDrawdown: 15,       // 15% total drawdown = kill switch
  
  // Consecutive loss protection
  maxConsecutiveLosses: 5,    // After 5 losses, emergency mode
  
  // Performance tracking
  trackingInterval: 3600000,  // 1 hour
  reportingInterval: 86400000, // Daily Telegram report
};

/**
 * Get current capital tier based on balance
 */
function getCurrentTier(balance) {
  if (balance >= CAPITAL_TIERS.SUSTAINABLE.minCapital) {
    return CAPITAL_TIERS.SUSTAINABLE;
  } else if (balance >= CAPITAL_TIERS.SCALING.minCapital) {
    return CAPITAL_TIERS.SCALING;
  } else if (balance >= CAPITAL_TIERS.GROWTH.minCapital) {
    return CAPITAL_TIERS.GROWTH;
  } else {
    return CAPITAL_TIERS.SURVIVAL;
  }
}

/**
 * Calculate runway (months until death)
 */
function calculateRunway(balance) {
  return balance / SURVIVAL_CONFIG.serverCostMonthly;
}

/**
 * Calculate monthly target profit
 */
function getMonthlyTarget(balance) {
  const tier = getCurrentTier(balance);
  return (balance * tier.targetMonthly) / 100;
}

/**
 * Check if in emergency mode
 */
function isEmergencyMode(balance, drawdown) {
  return balance < SURVIVAL_CONFIG.emergencyCapital || 
         drawdown > (SURVIVAL_CONFIG.maxTotalDrawdown - 5);
}

/**
 * Check if kill switch should activate
 */
function shouldActivateKillSwitch(balance, drawdown, consecutiveLosses) {
  return balance < SURVIVAL_CONFIG.criticalCapital ||
         drawdown >= SURVIVAL_CONFIG.maxTotalDrawdown ||
         consecutiveLosses >= SURVIVAL_CONFIG.maxConsecutiveLosses;
}

module.exports = {
  CAPITAL_TIERS,
  SURVIVAL_CONFIG,
  getCurrentTier,
  calculateRunway,
  getMonthlyTarget,
  isEmergencyMode,
  shouldActivateKillSwitch,
};
