import { baselinkerRequest } from './client.js';
import logger from '../../middleware/logger.js';

/**
 * BaseLinker CRM Tools
 *
 * IMPORTANT: BaseLinker does NOT have a dedicated CRM API.
 * Customer data is derived from order data. We use getOrdersByEmail,
 * getOrdersByPhone, or getOrders with filters to find customer info.
 */

/**
 * Get a customer profile by email or phone.
 * Derives customer data from their order history.
 *
 * @param {object} params - { email?: string, phone?: string }
 * @returns {object} Customer profile summary.
 */
export async function getCustomerProfile({ email, phone }) {
  logger.info(`Getting customer profile — email: ${email || 'N/A'}, phone: ${phone || 'N/A'}`);

  if (!email && !phone) {
    return {
      found: false,
      message: 'Please provide an email address or phone number to look up the customer profile.',
    };
  }

  try {
    let orders = [];

    // Try to find orders by email
    if (email) {
      const cleanEmail = email.toLowerCase().trim();
      try {
        const data = await baselinkerRequest('getOrdersByEmail', {
          email: cleanEmail,
        });
        orders = data.orders || [];
      } catch {
        // Fallback: search recent orders
        try {
          const data = await baselinkerRequest('getOrders', {
            date_from: Math.floor(Date.now() / 1000) - (365 * 24 * 60 * 60),
            get_unconfirmed_orders: false,
          });
          orders = (data.orders || []).filter(o =>
            o.email && o.email.toLowerCase() === cleanEmail
          );
        } catch (fallbackError) {
          logger.warn(`Order fallback search failed: ${fallbackError.message}`);
        }
      }
    }

    // If no results by email, try phone
    if (orders.length === 0 && phone) {
      const cleanPhone = phone.replace(/[\s\-()]/g, '');
      try {
        const data = await baselinkerRequest('getOrdersByPhone', {
          phone: cleanPhone,
        });
        orders = data.orders || [];
      } catch {
        try {
          const data = await baselinkerRequest('getOrders', {
            date_from: Math.floor(Date.now() / 1000) - (365 * 24 * 60 * 60),
            get_unconfirmed_orders: false,
          });
          orders = (data.orders || []).filter(o =>
            o.phone && o.phone.replace(/[\s\-()]/g, '').includes(cleanPhone)
          );
        } catch (fallbackError) {
          logger.warn(`Phone fallback search failed: ${fallbackError.message}`);
        }
      }
    }

    if (orders.length === 0) {
      return {
        found: false,
        message: `No customer profile found for ${email || phone}. No orders on record.`,
      };
    }

    // Sort by date, most recent first
    orders.sort((a, b) => (b.date_add || 0) - (a.date_add || 0));

    // Build profile from the most recent order
    const latestOrder = orders[0];
    const totalSpent = orders.reduce((sum, o) => sum + (parseFloat(o.payment_done) || 0), 0);

    return {
      found: true,
      name: latestOrder.delivery_fullname || [latestOrder.delivery_firstname, latestOrder.delivery_lastname].filter(Boolean).join(' ') || 'N/A',
      email: latestOrder.email || 'N/A',
      phone: latestOrder.phone || 'N/A',
      address: [
        latestOrder.delivery_address,
        latestOrder.delivery_city,
        latestOrder.delivery_postcode,
        latestOrder.delivery_country,
      ].filter(Boolean).join(', ') || 'N/A',
      company: latestOrder.delivery_company || null,
      orders_count: orders.length,
      total_spent: totalSpent,
      currency: latestOrder.currency || 'EUR',
      first_order_date: orders[orders.length - 1].date_add
        ? new Date(orders[orders.length - 1].date_add * 1000).toLocaleDateString()
        : 'Unknown',
      last_order_date: latestOrder.date_add
        ? new Date(latestOrder.date_add * 1000).toLocaleDateString()
        : 'Unknown',
      recent_order_ids: orders.slice(0, 5).map(o => o.order_id),
      message: `Customer profile for ${latestOrder.delivery_fullname || email || phone}: ${orders.length} order(s), total spent: ${totalSpent.toFixed(2)} ${latestOrder.currency || 'EUR'}.`,
    };
  } catch (error) {
    logger.error(`Customer profile lookup failed: ${error.message}`);
    return {
      found: false,
      message: `Unable to retrieve customer profile at this time. Error: ${error.message}`,
    };
  }
}

/**
 * Search for customers by name, email, or phone.
 * Searches through order records since BaseLinker has no CRM API.
 *
 * @param {object} params - { query: string }
 * @returns {object} Matching customer records.
 */
export async function searchCustomers({ query }) {
  logger.info(`Searching customers: "${query}"`);

  try {
    // Determine if query looks like email, phone, or name
    const isEmail = query.includes('@');
    const isPhone = /^\+?\d[\d\s\-()]{6,}$/.test(query.trim());

    if (isEmail) {
      return await getCustomerProfile({ email: query });
    }

    if (isPhone) {
      return await getCustomerProfile({ phone: query });
    }

    // Name search: fetch recent orders and filter by name
    const data = await baselinkerRequest('getOrders', {
      date_from: Math.floor(Date.now() / 1000) - (365 * 24 * 60 * 60),
      get_unconfirmed_orders: false,
    });

    const queryLower = query.toLowerCase();
    const matchingOrders = (data.orders || []).filter(o => {
      const name = (o.delivery_fullname || '').toLowerCase();
      return name.includes(queryLower);
    });

    if (matchingOrders.length === 0) {
      return {
        found: false,
        count: 0,
        message: `No customers found matching "${query}".`,
      };
    }

    // Deduplicate by email
    const seen = new Set();
    const uniqueCustomers = [];
    for (const o of matchingOrders) {
      const key = o.email || o.phone || o.delivery_fullname;
      if (key && !seen.has(key)) {
        seen.add(key);
        uniqueCustomers.push({
          name: o.delivery_fullname || 'N/A',
          email: o.email || 'N/A',
          phone: o.phone || 'N/A',
          last_order_id: o.order_id,
        });
      }
    }

    return {
      found: true,
      count: uniqueCustomers.length,
      customers: uniqueCustomers.slice(0, 10),
      message: `Found ${uniqueCustomers.length} customer(s) matching "${query}".`,
    };
  } catch (error) {
    logger.error(`Customer search failed: ${error.message}`);
    return {
      found: false,
      message: `Unable to search customers at this time. Error: ${error.message}`,
    };
  }
}

export default { getCustomerProfile, searchCustomers };
