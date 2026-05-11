import { baselinkerRequest } from './client.js';
import { CACHE_TTL } from '../../config/constants.js';
import logger from '../../middleware/logger.js';

/**
 * BaseLinker Order Tools
 *
 * All order-related functions that the AI agent can call.
 * Each function is designed as a "tool" — takes structured input, returns structured output.
 */

// ── Status Name Cache ───────────────────────────────────────────────
let statusNameMap = null;
let statusMapTimestamp = 0;
const STATUS_MAP_TTL = 15 * 60 * 1000; // 15 min

async function resolveStatusName(statusId) {
  try {
    if (!statusNameMap || Date.now() - statusMapTimestamp > STATUS_MAP_TTL) {
      const data = await baselinkerRequest('getOrderStatusList', {}, {
        useCache: true,
        cacheTtl: CACHE_TTL.ORDER_STATUS_LIST,
      });
      statusNameMap = {};
      for (const s of (data.statuses || [])) {
        statusNameMap[s.id] = s.name;
      }
      statusMapTimestamp = Date.now();
    }
    return statusNameMap[statusId] || `Unknown (status ID: ${statusId})`;
  } catch {
    return `Status ID: ${statusId}`;
  }
}

/**
 * Look up an order by order ID.
 * @param {object} params - { order_id: string }
 * @returns {object} Order summary for the AI to narrate.
 */
export async function lookupOrderById({ order_id }) {
  logger.info(`Looking up order by ID: ${order_id}`);

  try {
    const data = await baselinkerRequest('getOrders', {
      order_id: parseInt(order_id, 10),
    });

    if (!data.orders || data.orders.length === 0) {
      return { found: false, message: `No order found with ID #${order_id}.` };
    }

    const order = data.orders[0];
    return await formatOrderSummary(order);
  } catch (error) {
    logger.error(`Order lookup failed: ${error.message}`);
    return {
      found: false,
      message: `Unable to look up order #${order_id}. Error: ${error.message}`,
    };
  }
}

/**
 * Look up orders by customer email address.
 * Uses getOrdersByEmail first, falls back to getOrders with filter.
 * @param {object} params - { email: string }
 * @returns {object} List of order summaries.
 */
export async function lookupOrderByEmail({ email }) {
  logger.info(`Looking up orders by email: ${email}`);
  const cleanEmail = email.toLowerCase().trim();

  try {
    let orders = [];

    // Try getOrdersByEmail first
    try {
      const data = await baselinkerRequest('getOrdersByEmail', {
        email: cleanEmail,
      });
      orders = data.orders || [];
    } catch (emailError) {
      logger.warn(`getOrdersByEmail failed: ${emailError.message}, trying getOrders filter`);
      // Fallback: use getOrders — fetch recent orders and filter
      const data = await baselinkerRequest('getOrders', {
        date_from: Math.floor(Date.now() / 1000) - (365 * 24 * 60 * 60), // last year
        get_unconfirmed_orders: false,
      });
      orders = (data.orders || []).filter(o =>
        o.email && o.email.toLowerCase() === cleanEmail
      );
    }

    if (orders.length === 0) {
      return { found: false, message: `No orders found for email ${email}.` };
    }

    // Return the most recent 5 orders
    const sorted = orders
      .sort((a, b) => (b.date_add || 0) - (a.date_add || 0))
      .slice(0, 5);

    const summaries = [];
    for (const o of sorted) {
      summaries.push(await formatOrderSummary(o));
    }

    return {
      found: true,
      count: orders.length,
      orders: summaries,
      message: `Found ${orders.length} order(s) for ${email}. Showing the ${summaries.length} most recent.`,
    };
  } catch (error) {
    logger.error(`Order lookup by email failed: ${error.message}`);
    return {
      found: false,
      message: `Unable to look up orders for ${email}. Error: ${error.message}`,
    };
  }
}

/**
 * Look up orders by customer phone number.
 * @param {object} params - { phone: string }
 * @returns {object} List of order summaries.
 */
export async function lookupOrderByPhone({ phone }) {
  logger.info(`Looking up orders by phone: ${phone}`);
  const cleanPhone = phone.replace(/[\s\-()]/g, '');

  try {
    let orders = [];

    try {
      const data = await baselinkerRequest('getOrdersByPhone', {
        phone: cleanPhone,
      });
      orders = data.orders || [];
    } catch (phoneError) {
      logger.warn(`getOrdersByPhone failed: ${phoneError.message}, trying getOrders filter`);
      const data = await baselinkerRequest('getOrders', {
        date_from: Math.floor(Date.now() / 1000) - (365 * 24 * 60 * 60),
        get_unconfirmed_orders: false,
      });
      orders = (data.orders || []).filter(o =>
        o.phone && o.phone.replace(/[\s\-()]/g, '').includes(cleanPhone)
      );
    }

    if (orders.length === 0) {
      return { found: false, message: `No orders found for phone number ${phone}.` };
    }

    const sorted = orders
      .sort((a, b) => (b.date_add || 0) - (a.date_add || 0))
      .slice(0, 5);

    const summaries = [];
    for (const o of sorted) {
      summaries.push(await formatOrderSummary(o));
    }

    return {
      found: true,
      count: orders.length,
      orders: summaries,
      message: `Found ${orders.length} order(s) for phone ${phone}.`,
    };
  } catch (error) {
    logger.error(`Order lookup by phone failed: ${error.message}`);
    return {
      found: false,
      message: `Unable to look up orders for phone ${phone}. Error: ${error.message}`,
    };
  }
}

/**
 * Get the list of all order statuses (cached).
 * Used to translate status_id to human-readable names.
 */
export async function getOrderStatuses() {
  try {
    const data = await baselinkerRequest('getOrderStatusList', {}, {
      useCache: true,
      cacheTtl: CACHE_TTL.ORDER_STATUS_LIST,
    });
    return data.statuses || [];
  } catch (error) {
    logger.error(`Failed to get order statuses: ${error.message}`);
    return [];
  }
}

/**
 * Get payment history for an order.
 * @param {object} params - { order_id: string }
 */
export async function getPaymentHistory({ order_id }) {
  logger.info(`Getting payment history for order: ${order_id}`);

  try {
    const data = await baselinkerRequest('getOrderPaymentsHistory', {
      order_id: parseInt(order_id, 10),
    });

    if (!data.payments || data.payments.length === 0) {
      // Fallback: get order data and extract payment info
      const orderData = await baselinkerRequest('getOrders', {
        order_id: parseInt(order_id, 10),
      });

      if (orderData.orders && orderData.orders.length > 0) {
        const order = orderData.orders[0];
        return {
          found: true,
          order_id,
          payments: [{
            date: order.date_add ? new Date(order.date_add * 1000).toLocaleDateString() : 'Unknown',
            amount: order.payment_done || order.order_total_price || 0,
            comment: order.payment_method || 'N/A',
            status: order.payment_done > 0 ? 'Paid' : 'Pending',
            isExternalPayment: !!order.external_payment_id,
          }],
          total_paid: order.payment_done || 0,
          order_total: order.order_total_price || 0,
          payment_method: order.payment_method || 'N/A',
          message: `Payment information for order #${order_id}.`,
        };
      }

      return { found: false, message: `No payment records found for order #${order_id}.` };
    }

    const payments = data.payments.map(p => ({
      date: p.date ? new Date(p.date * 1000).toLocaleDateString() : 'Unknown',
      amount: p.payment_done || p.amount || 0,
      comment: p.payment_comment || 'N/A',
      isExternalPayment: !!p.external_payment_id,
      external_id: p.external_payment_id || null,
    }));

    return {
      found: true,
      order_id,
      payments,
      total_paid: payments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0),
      message: `Found ${payments.length} payment record(s) for order #${order_id}.`,
    };
  } catch (error) {
    logger.error(`Payment history lookup failed: ${error.message}`);
    // Try to get basic payment info from the order itself
    try {
      const orderData = await baselinkerRequest('getOrders', {
        order_id: parseInt(order_id, 10),
      });
      if (orderData.orders && orderData.orders.length > 0) {
        const order = orderData.orders[0];
        return {
          found: true,
          order_id,
          payments: [{
            date: order.date_add ? new Date(order.date_add * 1000).toLocaleDateString() : 'Unknown',
            amount: order.payment_done || order.order_total_price || 0,
            comment: order.payment_method || 'N/A',
            status: order.payment_done > 0 ? 'Paid' : 'Pending',
          }],
          message: `Basic payment info for order #${order_id} (detailed history unavailable).`,
        };
      }
    } catch {
      // ignore fallback failure
    }
    return {
      found: false,
      message: `Unable to retrieve payment history for order #${order_id}. Error: ${error.message}`,
    };
  }
}

/**
 * Get transaction / payment gateway data for an order.
 * Falls back to order data if the dedicated method doesn't exist.
 * @param {object} params - { order_id: string }
 */
export async function getTransactionData({ order_id }) {
  logger.info(`Getting transaction data for order: ${order_id}`);

  try {
    const data = await baselinkerRequest('getOrderTransactionData', {
      order_id: parseInt(order_id, 10),
    });
    return { found: true, order_id, ...data };
  } catch (error) {
    logger.warn(`getOrderTransactionData failed: ${error.message}, falling back to order data`);
    // Fallback: extract transaction info from the order itself
    try {
      const orderData = await baselinkerRequest('getOrders', {
        order_id: parseInt(order_id, 10),
      });
      if (orderData.orders && orderData.orders.length > 0) {
        const order = orderData.orders[0];
        return {
          found: true,
          order_id,
          payment_method: order.payment_method || 'N/A',
          payment_done: order.payment_done || 0,
          order_total: order.order_total_price || 0,
          external_payment_id: order.external_payment_id || null,
          currency: order.currency || 'EUR',
          message: `Transaction data for order #${order_id}.`,
        };
      }
    } catch {
      // ignore
    }
    return {
      found: false,
      message: `Unable to retrieve transaction data for order #${order_id}.`,
    };
  }
}

/**
 * Set order status (used for cancellation, return initiation, etc.)
 * ⚠️ WRITE operation — AI must confirm with customer first.
 * @param {object} params - { order_id: string, status_id: number }
 */
export async function setOrderStatus({ order_id, status_id }) {
  logger.info(`Setting order ${order_id} status to ${status_id}`);

  try {
    const data = await baselinkerRequest('setOrderStatus', {
      order_id: parseInt(order_id, 10),
      status_id: parseInt(status_id, 10),
    });

    const statusName = await resolveStatusName(status_id);
    return {
      success: true,
      order_id,
      new_status: statusName,
      message: `Order #${order_id} status updated to: ${statusName}.`,
    };
  } catch (error) {
    logger.error(`Failed to set order status: ${error.message}`);
    return {
      success: false,
      message: `Unable to update order status. Error: ${error.message}`,
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Format a raw BaseLinker order into a clean summary for the AI.
 */
async function formatOrderSummary(order) {
  const items = (order.products || []).map(p => ({
    name: p.name,
    sku: p.sku || 'N/A',
    quantity: p.quantity,
    price: p.price_brutto,
  }));

  const totalItems = items.reduce((sum, i) => sum + (i.quantity || 0), 0);
  const statusName = await resolveStatusName(order.order_status_id);

  return {
    found: true,
    order_id: order.order_id,
    status: statusName,
    status_id: order.order_status_id,
    date_placed: order.date_add ? new Date(order.date_add * 1000).toLocaleDateString() : 'Unknown',
    date_confirmed: order.date_confirmed ? new Date(order.date_confirmed * 1000).toLocaleDateString() : null,
    customer: {
      name: `${order.delivery_fullname || ''}`.trim() || 'N/A',
      email: order.email || 'N/A',
      phone: order.phone || 'N/A',
    },
    delivery_address: [
      order.delivery_address,
      order.delivery_city,
      order.delivery_postcode,
      order.delivery_country,
    ].filter(Boolean).join(', ') || 'N/A',
    items,
    total_items: totalItems,
    total_price: order.payment_done || order.order_total_price || 0,
    currency: order.currency || 'EUR',
    payment_method: order.payment_method || 'N/A',
    payment_status: (order.payment_done || 0) > 0 ? 'Paid' : 'Pending',
    delivery_method: order.delivery_method || 'N/A',
    admin_comments: order.admin_comments || '',
    user_comments: order.user_comments || '',
    has_packages: !!(order.delivery_package_nr),
    tracking_number: order.delivery_package_nr || null,
  };
}

export default {
  lookupOrderById,
  lookupOrderByEmail,
  lookupOrderByPhone,
  getOrderStatuses,
  getPaymentHistory,
  getTransactionData,
  setOrderStatus,
};
