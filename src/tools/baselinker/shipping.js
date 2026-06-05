import { baselinkerRequest } from './client.js';
import { resolveOrderReference } from './orders.js';
import { CACHE_TTL, TRACKING_STATUS } from '../../config/constants.js';
import logger from '../../middleware/logger.js';

/**
 * BaseLinker Shipping & Tracking Tools
 */

/**
 * Get shipment tracking information for an order.
 * Uses the order data to extract package/tracking info.
 * @param {object} params - { order_id: string }
 * @returns {object} Tracking summary.
 */
export async function trackShipment({ order_id }) {
  logger.info(`Tracking shipment for order: ${order_id}`);

  try {
    const resolved = await resolveOrderReference(order_id);
    if (!resolved) {
      return {
        found: false,
        message: `No order found with ID #${order_id}.`,
      };
    }

    const internalOrderId = resolved.internalOrderId;

    // First try getOrderPackages (dedicated package method)
    let packages = [];
    try {
      const data = await baselinkerRequest('getOrderPackages', {
        order_id: internalOrderId,
      });
      packages = data.packages || [];
    } catch (pkgError) {
      logger.warn(`getOrderPackages failed: ${pkgError.message}, trying order data`);
    }

    // If no packages from dedicated endpoint, extract from order data
    if (packages.length === 0) {
      const orderData = resolved.order
        ? { orders: [resolved.order] }
        : await baselinkerRequest('getOrders', {
          order_id: internalOrderId,
        });

      if (!orderData.orders || orderData.orders.length === 0) {
        return {
          found: false,
          message: `No order found with ID #${order_id}.`,
        };
      }

      const order = orderData.orders[0];

      // Extract tracking info from order fields
      if (order.delivery_package_nr || order.delivery_package_module) {
        return {
          found: true,
          order_id,
          packages: [{
            courier: order.delivery_package_module || order.delivery_method || 'Unknown',
            tracking_number: order.delivery_package_nr || 'N/A',
            tracking_url: null,
            status: 'See order status',
            is_delivered: false,
            is_in_transit: !!order.delivery_package_nr,
          }],
          order_status: order.order_status_id,
          summary: order.delivery_package_nr
            ? `Order #${order_id} has tracking number: ${order.delivery_package_nr} via ${order.delivery_package_module || order.delivery_method || 'courier'}.`
            : `Order #${order_id} shipping information is being prepared.`,
        };
      }

      return {
        found: false,
        order_exists: true,
        message: `No shipment information found for order #${order_id}. The order may not have been shipped yet.`,
      };
    }

    // Format packages from getOrderPackages
    const formattedPackages = packages.map(pkg => ({
      package_id: pkg.package_id,
      courier: pkg.courier_code || pkg.courier_name || 'Unknown',
      tracking_number: pkg.courier_package_nr || 'N/A',
      tracking_url: pkg.tracking_url || null,
      status: TRACKING_STATUS[pkg.tracking_status] || `Status code: ${pkg.tracking_status}`,
      status_code: pkg.tracking_status,
      is_delivered: pkg.tracking_status === 5,
      is_in_transit: [2, 3, 4].includes(pkg.tracking_status),
    }));

    const allDelivered = formattedPackages.every(p => p.is_delivered);
    const anyInTransit = formattedPackages.some(p => p.is_in_transit);

    return {
      found: true,
      order_id,
      packages: formattedPackages,
      summary: allDelivered
        ? `All ${formattedPackages.length} package(s) for order #${order_id} have been delivered.`
        : anyInTransit
          ? `Order #${order_id} has ${formattedPackages.length} package(s) — currently in transit.`
          : `Order #${order_id} has ${formattedPackages.length} package(s).`,
    };
  } catch (error) {
    logger.error(`Shipment tracking failed: ${error.message}`);
    return {
      found: false,
      message: `Unable to track shipment for order #${order_id}. Error: ${error.message}`,
    };
  }
}

/**
 * Get detailed tracking history for specific package(s).
 * @param {object} params - { package_ids: number[] }
 */
export async function getTrackingHistory({ package_ids }) {
  const ids = Array.isArray(package_ids) ? package_ids : [package_ids];
  logger.info(`Getting tracking history for packages: ${ids.join(', ')}`);

  try {
    const data = await baselinkerRequest('getCourierPackagesStatusHistory', {
      package_ids: ids.map(id => parseInt(id, 10)),
    });
    return { found: true, ...data };
  } catch (error) {
    logger.error(`Tracking history failed: ${error.message}`);
    return {
      found: false,
      message: `Unable to retrieve tracking history. Error: ${error.message}`,
    };
  }
}

/**
 * Get the list of available couriers (cached).
 */
export async function getCouriers() {
  try {
    const data = await baselinkerRequest('getCouriersList', {}, {
      useCache: true,
      cacheTtl: CACHE_TTL.COURIER_LIST,
    });

    return (data.couriers || []).map(c => ({
      id: c.courier_id,
      name: c.courier_name,
      code: c.courier_code,
    }));
  } catch (error) {
    logger.error(`Failed to get couriers: ${error.message}`);
    return [];
  }
}

export default {
  trackShipment,
  getTrackingHistory,
  getCouriers,
};
