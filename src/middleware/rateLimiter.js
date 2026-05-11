import env from '../config/env.js';
import logger from './logger.js';

/**
 * Simple in-memory rate limiter per client IP / session.
 * Tracks request counts in sliding windows.
 */
const windows = new Map();

const WINDOW_MS = 60_000; // 1-minute windows
const MAX_REQUESTS = 30;  // per window per client

/**
 * Clean up expired windows periodically.
 */
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of windows) {
    if (now - entry.windowStart > WINDOW_MS * 2) {
      windows.delete(key);
    }
  }
}, WINDOW_MS * 5);

/**
 * Express middleware — rate limits requests per client.
 */
export function rateLimiter(req, res, next) {
  const clientId = req.headers['x-session-id'] || req.ip || 'unknown';
  const now = Date.now();

  let entry = windows.get(clientId);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    entry = { windowStart: now, count: 0 };
    windows.set(clientId, entry);
  }

  entry.count++;

  if (entry.count > MAX_REQUESTS) {
    logger.warn(`Rate limit exceeded for client ${clientId}`);
    return res.status(429).json({
      error: 'Too many requests. Please slow down.',
      retryAfter: Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000),
    });
  }

  // Set rate limit headers
  res.set('X-RateLimit-Limit', String(MAX_REQUESTS));
  res.set('X-RateLimit-Remaining', String(MAX_REQUESTS - entry.count));
  res.set('X-RateLimit-Reset', String(Math.ceil((entry.windowStart + WINDOW_MS) / 1000)));

  next();
}

export default rateLimiter;
