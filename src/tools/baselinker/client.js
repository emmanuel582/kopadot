import axios from 'axios';
import Bottleneck from 'bottleneck';
import env from '../../config/env.js';
import { RATE_LIMITS, CACHE_TTL } from '../../config/constants.js';
import logger from '../../middleware/logger.js';

/**
 * BaseLinker API Client
 *
 * Rate-limited HTTP client for the BaseLinker connector API.
 * - All requests are POST to https://api.baselinker.com/connector.php
 * - Auth via X-BLToken header
 * - Rate limited to 90 req/min (official limit is 100)
 * - Auto-retry with exponential backoff on 429/5xx
 * - In-memory response caching for static lookups
 */

// ── Rate Limiter ────────────────────────────────────────────────────
const limiter = new Bottleneck({
  reservoir: RATE_LIMITS.BASELINKER_RPM,
  reservoirRefreshAmount: RATE_LIMITS.BASELINKER_RPM,
  reservoirRefreshInterval: 60_000, // refill every minute
  maxConcurrent: 5,
  minTime: 200, // minimum 200ms between requests
});

// Log when we're hitting rate limits
limiter.on('depleted', () => {
  logger.warn('BaseLinker rate limiter depleted — requests will be queued');
});

// ── Cache ───────────────────────────────────────────────────────────
const cache = new Map();

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > entry.ttl) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data, ttl) {
  cache.set(key, { data, timestamp: Date.now(), ttl });
}

// ── Core Request Function ───────────────────────────────────────────

/**
 * Make a rate-limited request to the BaseLinker API.
 *
 * @param {string} method - API method name (e.g. 'getOrders').
 * @param {object} parameters - Method parameters.
 * @param {object} options - Optional: { cache: boolean, cacheTtl: number, retries: number }.
 * @returns {Promise<object>} API response data.
 */
export async function baselinkerRequest(method, parameters = {}, options = {}) {
  const { useCache = false, cacheTtl = CACHE_TTL.ORDER_STATUS_LIST, retries = 3 } = options;

  // Check cache first
  if (useCache) {
    const cacheKey = `${method}:${JSON.stringify(parameters)}`;
    const cached = getCached(cacheKey);
    if (cached) {
      logger.debug(`BaseLinker cache hit: ${method}`);
      return cached;
    }
  }

  // Execute rate-limited request
  const execute = async (attempt = 1) => {
    try {
      const response = await limiter.schedule(() =>
        axios.post(
          env.baselinkerEndpoint,
          new URLSearchParams({
            method,
            parameters: JSON.stringify(parameters),
          }),
          {
            headers: {
              'X-BLToken': env.baselinkerToken,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            timeout: 30_000,
          },
        ),
      );

      const data = response.data;

      // BaseLinker returns status in response body
      if (data.status === 'ERROR') {
        const errorMsg = data.error_message || 'Unknown BaseLinker error';
        logger.error(`BaseLinker API error: ${method} — ${errorMsg}`, {
          errorCode: data.error_code,
        });
        throw new Error(`BaseLinker: ${errorMsg} (code: ${data.error_code})`);
      }

      // Cache successful response if requested
      if (useCache) {
        const cacheKey = `${method}:${JSON.stringify(parameters)}`;
        setCache(cacheKey, data, cacheTtl);
      }

      logger.debug(`BaseLinker OK: ${method}`, {
        method,
        attempt,
      });

      return data;

    } catch (error) {
      const status = error.response?.status;

      // Retry on rate limit or server errors
      if ((status === 429 || (status >= 500 && status < 600)) && attempt < retries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 10_000);
        logger.warn(`BaseLinker ${method} failed (${status}), retrying in ${delay}ms (attempt ${attempt}/${retries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return execute(attempt + 1);
      }

      // Network errors — retry
      if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
        if (attempt < retries) {
          const delay = 1000 * attempt;
          logger.warn(`BaseLinker network error on ${method}, retrying in ${delay}ms`);
          await new Promise(resolve => setTimeout(resolve, delay));
          return execute(attempt + 1);
        }
      }

      logger.error(`BaseLinker ${method} failed permanently`, {
        error: error.message,
        status,
        attempt,
      });
      throw error;
    }
  };

  return execute();
}

/**
 * Clear all cached data (useful after mutations).
 */
export function clearCache() {
  cache.clear();
  logger.info('BaseLinker cache cleared');
}

/**
 * Get current rate limiter status for monitoring.
 */
export function getRateLimiterStatus() {
  const counts = limiter.counts();
  return {
    running: counts.RUNNING,
    queued: counts.QUEUED,
    reservoir: counts.RECEIVED,
  };
}

export default { baselinkerRequest, clearCache, getRateLimiterStatus };
