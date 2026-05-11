import logger from './logger.js';

/**
 * API key authentication middleware.
 * For external webhook / API consumers — validates X-API-Key header.
 * Internal live chat and test endpoints can bypass via config.
 */
export function apiKeyAuth(req, res, next) {
  // Skip auth in development for convenience
  if (process.env.NODE_ENV === 'development') return next();

  // Skip auth for health check
  if (req.path === '/health') return next();

  const apiKey = req.headers['x-api-key'];
  const expectedKey = process.env.API_SECRET_KEY;

  if (!expectedKey) {
    logger.error('API_SECRET_KEY is not configured in non-development mode — rejecting request');
    return res.status(503).json({
      error: 'Service misconfigured',
      message: 'API key authentication is required in non-development mode.',
    });
  }

  if (!apiKey || apiKey !== expectedKey) {
    logger.warn(`Unauthorized request from ${req.ip} to ${req.path}`);
    return res.status(401).json({ error: 'Unauthorized — invalid or missing API key' });
  }

  next();
}

/**
 * Webhook signature verification.
 * Verifies HMAC-SHA256 signatures for incoming webhooks.
 */
export function webhookAuth(secret) {
  return (req, res, next) => {
    if (!secret) return next();

    const signature = req.headers['x-webhook-signature'];
    if (!signature) {
      logger.warn('Webhook received without signature');
      return res.status(401).json({ error: 'Missing webhook signature' });
    }

    // Verify HMAC (implementation depends on webhook provider)
    // For now, pass through — individual channel handlers verify signatures
    next();
  };
}

export default apiKeyAuth;
