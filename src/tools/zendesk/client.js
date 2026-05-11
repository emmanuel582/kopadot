import axios from 'axios';
import Bottleneck from 'bottleneck';
import env from '../../config/env.js';
import { RATE_LIMITS } from '../../config/constants.js';
import logger from '../../middleware/logger.js';

/**
 * Zendesk API Client
 *
 * Rate-limited HTTP client for ALL Zendesk APIs:
 *   - Help Center (knowledge base search, articles)
 *   - Support (ticket creation for escalation)
 *
 * Zendesk is the only external helpdesk integration.
 */

// ── Rate Limiter ────────────────────────────────────────────────────
const limiter = new Bottleneck({
  reservoir: RATE_LIMITS.ZENDESK_RPM,
  reservoirRefreshAmount: RATE_LIMITS.ZENDESK_RPM,
  reservoirRefreshInterval: 60_000,
  maxConcurrent: 3,
  minTime: 300,
});

/**
 * Get the base URL for the Zendesk API.
 */
function getBaseUrl() {
  return `https://${env.zendeskSubdomain}.zendesk.com`;
}

/**
 * Get auth headers for Zendesk API requests.
 * Uses email/token authentication.
 */
function getAuthHeaders() {
  const credentials = `${env.zendeskEmail}/token:${env.zendeskApiToken}`;
  const encoded = Buffer.from(credentials).toString('base64');

  return {
    Authorization: `Basic ${encoded}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Make a rate-limited request to the Zendesk API.
 * Supports GET (for KB search) and POST (for ticket creation).
 *
 * @param {string} methodOrEndpoint - HTTP method (GET/POST) OR endpoint path for backward compat.
 * @param {string|object} endpointOrParams - Endpoint path (if method given) OR query params.
 * @param {object} dataOrOptions - Request body (for POST) OR options.
 * @param {object} options - Request options { retries, requireAuth }.
 * @returns {Promise<object>} API response data.
 */
export async function zendeskRequest(methodOrEndpoint, endpointOrParams = {}, dataOrOptions = {}, options = {}) {
  // Detect calling style:
  // Old style: zendeskRequest('/endpoint', { params }, { options })
  // New style: zendeskRequest('POST', '/endpoint', { body }, { options })
  let method, endpoint, params, body, opts;

  if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(methodOrEndpoint.toUpperCase())) {
    method = methodOrEndpoint.toUpperCase();
    endpoint = endpointOrParams;
    body = method !== 'GET' ? dataOrOptions : null;
    params = method === 'GET' ? dataOrOptions : {};
    opts = options;
  } else {
    // Backward-compatible: first arg is the endpoint
    method = 'GET';
    endpoint = methodOrEndpoint;
    params = endpointOrParams;
    opts = dataOrOptions;
  }

  const { retries = 2, requireAuth = false } = opts;

  const execute = async (attempt = 1) => {
    try {
      const headers = requireAuth ? getAuthHeaders() : { 'Content-Type': 'application/json' };

      const axiosConfig = {
        method,
        url: `${getBaseUrl()}${endpoint}`,
        headers,
        timeout: 15_000,
      };

      if (method === 'GET' && Object.keys(params || {}).length > 0) {
        axiosConfig.params = params;
      }

      if (body && method !== 'GET') {
        axiosConfig.data = body;
      }

      const response = await limiter.schedule(() => axios(axiosConfig));

      logger.debug(`Zendesk OK: ${method} ${endpoint}`, { attempt });
      return response.data;
    } catch (error) {
      const status = error.response?.status;

      if ((status === 429 || (status >= 500 && status < 600)) && attempt < retries) {
        const retryAfter = error.response?.headers?.['retry-after'];
        const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : 1000 * Math.pow(2, attempt);
        logger.warn(`Zendesk ${method} ${endpoint} failed (${status}), retrying in ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return execute(attempt + 1);
      }

      logger.error(`Zendesk ${method} ${endpoint} failed permanently`, {
        error: error.message,
        status,
        responseData: error.response?.data,
      });
      throw error;
    }
  };

  return execute();
}

export default { zendeskRequest };
