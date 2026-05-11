import { baselinkerRequest } from './client.js';
import { lookupOrderById, getOrderStatuses, setOrderStatus } from './orders.js';
import logger from '../../middleware/logger.js';

/**
 * BaseLinker Returns & Refunds Tools
 *
 * IMPORTANT: BaseLinker does NOT have a dedicated returns management API.
 * Returns are handled through:
 *   1. Order status changes (moving to a "return" status)
 *   2. Admin comments (storing return reason/notes)
 *   3. Escalation to human agents for actual refund processing
 *
 * This module provides AI-friendly abstractions over these mechanisms.
 */

/**
 * Check return/refund status for an order.
 * Looks up the order and interprets its status to determine if a return is in progress.
 *
 * @param {object} params - { order_id?: string, return_id?: string }
 */
export async function checkReturnStatus({ order_id, return_id }) {
  const lookupId = order_id || return_id;
  if (!lookupId) {
    return {
      found: false,
      message: 'Please provide an order ID to check return status.',
    };
  }

  logger.info(`Checking return status for order: ${lookupId}`);

  try {
    // Look up the order to get its current status
    const orderResult = await lookupOrderById({ order_id: lookupId });

    if (!orderResult.found) {
      return {
        found: false,
        message: `No order found with ID #${lookupId}. Cannot check return status.`,
      };
    }

    // Get all statuses to identify return-related ones
    const allStatuses = await getOrderStatuses();
    const returnStatuses = allStatuses.filter(s =>
      /return|refund|rma|sent back|returned/i.test(s.name)
    );
    const returnStatusIds = new Set(returnStatuses.map(s => s.id));

    const currentStatusId = orderResult.status_id;
    const isReturnStatus = returnStatusIds.has(currentStatusId);
    const hasReturnNotes = !!(orderResult.admin_comments &&
      /return|refund|rma/i.test(orderResult.admin_comments));

    return {
      found: true,
      order_id: lookupId,
      current_status: orderResult.status,
      status_id: currentStatusId,
      is_return_in_progress: isReturnStatus || hasReturnNotes,
      return_notes: hasReturnNotes ? orderResult.admin_comments : null,
      order_details: {
        date_placed: orderResult.date_placed,
        items: orderResult.items,
        total_price: orderResult.total_price,
        currency: orderResult.currency,
      },
      available_return_statuses: returnStatuses.map(s => ({
        id: s.id,
        name: s.name,
      })),
      message: isReturnStatus
        ? `Order #${lookupId} has a return in progress. Current status: ${orderResult.status}.`
        : hasReturnNotes
          ? `Order #${lookupId} has return notes but status is: ${orderResult.status}.`
          : `Order #${lookupId} does not currently have a return in progress. Status: ${orderResult.status}.`,
    };
  } catch (error) {
    logger.error(`Return status check failed: ${error.message}`);
    return {
      found: false,
      message: `Unable to check return status for order #${lookupId}. Error: ${error.message}`,
    };
  }
}

/**
 * Initiate a return for an order.
 * ⚠️ WRITE operation — the AI MUST confirm with the customer first.
 *
 * Sets the order status to a return-related status and adds return reason
 * to admin comments. For actual refund processing, an escalation ticket
 * should be created separately.
 *
 * @param {object} params - { order_id: string, reason: string }
 */
export async function initiateReturn({ order_id, reason }) {
  logger.info(`Initiating return for order: ${order_id}, reason: ${reason}`);

  try {
    // Verify the order exists
    const orderResult = await lookupOrderById({ order_id });
    if (!orderResult.found) {
      return {
        success: false,
        message: `Cannot initiate return — order #${order_id} was not found.`,
      };
    }

    // Find a return-related status
    const allStatuses = await getOrderStatuses();
    const returnStatus = allStatuses.find(s =>
      /return|rma|sent back/i.test(s.name)
    );

    if (returnStatus) {
      // Update the order status
      try {
        await baselinkerRequest('setOrderStatus', {
          order_id: parseInt(order_id, 10),
          status_id: returnStatus.id,
        });
      } catch (statusError) {
        logger.warn(`Failed to set return status: ${statusError.message}`);
      }
    }

    // Add return reason to admin comments
    const timestamp = new Date().toISOString();
    const returnNote = `[RETURN REQUESTED - ${timestamp}] Reason: ${reason || 'Customer requested return'}. Previous status: ${orderResult.status}.`;

    try {
      await baselinkerRequest('setOrderFields', {
        order_id: parseInt(order_id, 10),
        admin_comments: [orderResult.admin_comments, returnNote].filter(Boolean).join('\n'),
      });
    } catch (fieldError) {
      logger.warn(`Failed to update admin comments: ${fieldError.message}`);
    }

    return {
      success: true,
      order_id,
      new_status: returnStatus ? returnStatus.name : orderResult.status,
      message: `Return request for order #${order_id} has been recorded. Reason: ${reason}. ${returnStatus ? `Status updated to: ${returnStatus.name}.` : ''} Our team will review and process the refund. You will receive a confirmation email.`,
    };
  } catch (error) {
    logger.error(`Return initiation failed: ${error.message}`);
    return {
      success: false,
      message: `Unable to initiate return for order #${order_id}. Error: ${error.message}. Please contact our support team directly.`,
    };
  }
}

export default {
  checkReturnStatus,
  initiateReturn,
};
