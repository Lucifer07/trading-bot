const crypto = require('crypto');

/**
 * Generate HMAC SHA256 signature for Binance API requests
 * @param {string} queryString - Query string to sign
 * @param {string} secret - API secret key
 * @returns {string} Hex signature
 */
function generateSignature(queryString, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(queryString)
    .digest('hex');
}

/**
 * Generate timestamp for Binance API
 * @returns {number} Current timestamp in milliseconds
 */
function getTimestamp() {
  return Date.now();
}

/**
 * Create signed query parameters
 * @param {Object} params - Query parameters
 * @param {string} secret - API secret key
 * @returns {Object} Parameters with signature
 */
function signParams(params, secret) {
  const timestamp = getTimestamp();
  const signedParams = {
    ...params,
    timestamp,
  };

  const queryString = Object.keys(signedParams)
    .sort()
    .map((key) => `${key}=${encodeURIComponent(signedParams[key])}`)
    .join('&');

  signedParams.signature = generateSignature(queryString, secret);

  return signedParams;
}

/**
 * Create request body with signature
 * @param {Object} body - Request body
 * @param {string} secret - API secret key
 * @returns {Object} Body with signature
 */
function signBody(body, secret) {
  const timestamp = getTimestamp();
  const signedBody = {
    ...body,
    timestamp,
  };

  const queryString = Object.keys(signedBody)
    .sort()
    .map((key) => `${key}=${encodeURIComponent(signedBody[key])}`)
    .join('&');

  signedBody.signature = generateSignature(queryString, secret);

  return signedBody;
}

/**
 * Validate API response signature (if applicable)
 * @param {string} payload - Response payload
 * @param {string} signature - Signature from header
 * @param {string} secret - API secret key
 * @returns {boolean} True if valid
 */
function validateSignature(payload, signature, secret) {
  const computedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  return computedSignature === signature;
}

module.exports = {
  generateSignature,
  getTimestamp,
  signParams,
  signBody,
  validateSignature,
};
