import logger from '../middleware/logger.js';

// ── Tool Implementations ────────────────────────────────────────────
import {
  lookupOrderById,
  lookupOrderByEmail,
  lookupOrderByPhone,
  getOrderStatuses,
  getPaymentHistory,
  getTransactionData,
  setOrderStatus,
} from '../tools/baselinker/orders.js';

import {
  trackShipment,
  getTrackingHistory,
  getCouriers,
} from '../tools/baselinker/shipping.js';

import {
  checkReturnStatus,
  initiateReturn,
} from '../tools/baselinker/returns.js';

import {
  getProductInfo,
  searchProducts,
  checkStock,
} from '../tools/baselinker/products.js';

import {
  getCustomerProfile,
  searchCustomers,
} from '../tools/baselinker/crm.js';

import {
  searchKnowledgeBase,
  getArticle,
} from '../tools/zendesk/knowledgeBase.js';

import {
  createEscalationTicket,
} from '../tools/zendesk/tickets.js';

/**
 * Tool Registry — declares all available tools for Gemini function calling.
 *
 * This is the single source of truth for:
 *   1. Tool declarations (sent to Gemini so it knows what tools exist)
 *   2. Tool execution mapping (name → function)
 *
 * Gemini uses these declarations to DYNAMICALLY decide which tool to call
 * based on the customer's message. No regex. No intent mapping. Pure AI reasoning.
 */

// ── Tool Execution Map ──────────────────────────────────────────────
const TOOL_EXECUTORS = {
  lookupOrderById,
  lookupOrderByEmail,
  lookupOrderByPhone,
  getOrderStatuses,
  getPaymentHistory,
  getTransactionData,
  setOrderStatus,
  trackShipment,
  getTrackingHistory,
  getCouriers,
  checkReturnStatus,
  initiateReturn,
  getProductInfo,
  searchProducts,
  checkStock,
  getCustomerProfile,
  searchCustomers,
  searchKnowledgeBase,
  getArticle,
  createEscalationTicket,
};

/**
 * Get Gemini-compatible tool declarations.
 *
 * These tell Gemini WHAT tools exist, their parameters, and when to use them.
 * Gemini's AI then decides on its own which tool(s) to call — no static mapping.
 *
 * @returns {Array} Tool declarations in Gemini function calling format.
 */
export function getToolDeclarations() {
  return [{
    functionDeclarations: [
      // ── Order Tools ─────────────────────────────────────────────
      {
        name: 'lookupOrderById',
        description: 'Look up a specific order by its order ID number. Returns full order details including status, items, customer info, shipping, and payment details. Use when customer provides an order number.',
        parameters: {
          type: 'OBJECT',
          properties: {
            order_id: {
              type: 'STRING',
              description: 'The order ID or shop order number (e.g. "29828903" or "DUX055103894")',
            },
          },
          required: ['order_id'],
        },
      },
      {
        name: 'lookupOrderByEmail',
        description: 'Look up all orders associated with a customer email address. Returns the most recent orders. Use when the customer provides their email to find their orders.',
        parameters: {
          type: 'OBJECT',
          properties: {
            email: {
              type: 'STRING',
              description: 'The customer email address',
            },
          },
          required: ['email'],
        },
      },
      {
        name: 'lookupOrderByPhone',
        description: 'Look up all orders associated with a phone number. Use when the customer provides their phone number to find their orders.',
        parameters: {
          type: 'OBJECT',
          properties: {
            phone: {
              type: 'STRING',
              description: 'The customer phone number',
            },
          },
          required: ['phone'],
        },
      },
      {
        name: 'getPaymentHistory',
        description: 'Get the payment history and payment status for a specific order. Use when a customer asks about payment issues, double charges, refund payments, or wants to know if their payment went through.',
        parameters: {
          type: 'OBJECT',
          properties: {
            order_id: {
              type: 'STRING',
              description: 'The order ID to check payment history for',
            },
          },
          required: ['order_id'],
        },
      },
      {
        name: 'getTransactionData',
        description: 'Get detailed transaction/payment gateway data for an order. Use for investigating payment failures, chargebacks, or complex payment inquiries.',
        parameters: {
          type: 'OBJECT',
          properties: {
            order_id: {
              type: 'STRING',
              description: 'The order ID',
            },
          },
          required: ['order_id'],
        },
      },
      {
        name: 'setOrderStatus',
        description: 'Change the status of an order. Use for cancelling orders (set to cancel status) or other status changes. WARNING: This is a WRITE operation — ALWAYS confirm with the customer before calling this. First call getOrderStatuses to find the correct status ID.',
        parameters: {
          type: 'OBJECT',
          properties: {
            order_id: {
              type: 'STRING',
              description: 'The order ID to update',
            },
            status_id: {
              type: 'STRING',
              description: 'The new status ID to set (get from getOrderStatuses)',
            },
          },
          required: ['order_id', 'status_id'],
        },
      },
      {
        name: 'getOrderStatuses',
        description: 'Get the list of all available order statuses with their IDs and names. Use this to find the correct status ID before changing an order status (e.g. to find the "cancelled" status ID).',
        parameters: {
          type: 'OBJECT',
          properties: {},
        },
      },

      // ── Shipping & Tracking Tools ───────────────────────────────
      {
        name: 'trackShipment',
        description: 'Get tracking and shipment information for an order. Returns courier name, tracking number, tracking URL, and delivery status. Use when customer asks "where is my order", "track my package", or about delivery status.',
        parameters: {
          type: 'OBJECT',
          properties: {
            order_id: {
              type: 'STRING',
              description: 'The order ID or shop order number to track (e.g. "29828903" or "DUX055103894")',
            },
          },
          required: ['order_id'],
        },
      },
      {
        name: 'getTrackingHistory',
        description: 'Get detailed tracking event history for specific package(s). Shows all status updates with timestamps. Use when customer wants detailed tracking events or delivery timeline. Requires package IDs from trackShipment.',
        parameters: {
          type: 'OBJECT',
          properties: {
            package_ids: {
              type: 'ARRAY',
              items: { type: 'NUMBER' },
              description: 'Array of package IDs to get history for (get these from trackShipment first)',
            },
          },
          required: ['package_ids'],
        },
      },

      // ── Returns & Refunds Tools ─────────────────────────────────
      {
        name: 'checkReturnStatus',
        description: 'Check the return/refund status for an order. Checks the order status and admin notes to determine if a return is in progress. Use when customer asks about return status or refund progress.',
        parameters: {
          type: 'OBJECT',
          properties: {
            order_id: {
              type: 'STRING',
              description: 'The order ID to check returns for',
            },
          },
          required: ['order_id'],
        },
      },
      {
        name: 'initiateReturn',
        description: 'Create a return request for an order. Updates the order status and records the return reason. WARNING: This is a WRITE operation — ALWAYS confirm with the customer before calling this. Ask them to confirm the order ID and reason.',
        parameters: {
          type: 'OBJECT',
          properties: {
            order_id: {
              type: 'STRING',
              description: 'The order ID to create a return for',
            },
            reason: {
              type: 'STRING',
              description: 'The reason for the return as described by the customer',
            },
          },
          required: ['order_id', 'reason'],
        },
      },

      // ── Product Tools ───────────────────────────────────────────
      {
        name: 'getProductInfo',
        description: 'Get detailed information about a specific product by its product ID. Returns name, description, price, images, variants, and stock availability. Use when customer asks about a specific product by ID.',
        parameters: {
          type: 'OBJECT',
          properties: {
            product_id: {
              type: 'STRING',
              description: 'The product ID number',
            },
          },
          required: ['product_id'],
        },
      },
      {
        name: 'searchProducts',
        description: 'Search the product catalog. Use a broad, single-word query (like "Samsung" or "iPhone") and use the required_features array for specific details (like "5G", "Pink", "Dual SIM"). Returns matching products with basic info and stock.',
        parameters: {
          type: 'OBJECT',
          properties: {
            query: {
              type: 'STRING',
              description: 'Broad search query — e.g. brand or main category (e.g., "Samsung"). Avoid long specific phrases here.',
            },
            required_features: {
              type: 'ARRAY',
              items: { type: 'STRING' },
              description: 'Optional: Array of specific features the product MUST have (e.g., ["5G", "Dual SIM", "Pink"]).',
            },
            max_price: {
              type: 'NUMBER',
              description: 'Optional: Maximum price budget.',
            },
            in_stock_only: {
              type: 'BOOLEAN',
              description: 'Optional: Set to true to only return products currently in stock.',
            },
            category_id: {
              type: 'STRING',
              description: 'Optional: filter by category ID',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'checkStock',
        description: 'Check real-time stock availability for a specific product by its product ID. Use when customer asks "is this in stock?", "do you have X available?", or about product availability.',
        parameters: {
          type: 'OBJECT',
          properties: {
            product_id: {
              type: 'STRING',
              description: 'The product ID to check stock for',
            },
          },
          required: ['product_id'],
        },
      },

      // ── Customer / CRM Tools ────────────────────────────────────
      {
        name: 'getCustomerProfile',
        description: 'Get a customer profile with order history and account details. Derived from order records. Use when you need to look up customer information or verify identity. Requires email or phone.',
        parameters: {
          type: 'OBJECT',
          properties: {
            email: {
              type: 'STRING',
              description: 'Customer email address',
            },
            phone: {
              type: 'STRING',
              description: 'Customer phone number',
            },
          },
        },
      },
      {
        name: 'searchCustomers',
        description: 'Search for customer records by name, email, or phone. Use to find a customer account when limited info is available.',
        parameters: {
          type: 'OBJECT',
          properties: {
            query: {
              type: 'STRING',
              description: 'Search query — name, email, or phone',
            },
          },
          required: ['query'],
        },
      },

      // ── Knowledge Base Tools ────────────────────────────────────
      {
        name: 'searchKnowledgeBase',
        description: 'Search the support knowledge base for articles about policies, procedures, FAQs, shipping info, size guides, care instructions, warranty, and general store information. Use when customer asks about policies, "how does...", "what is your...", or any general question not related to a specific order.',
        parameters: {
          type: 'OBJECT',
          properties: {
            query: {
              type: 'STRING',
              description: 'The search query — what the customer is asking about',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'getArticle',
        description: 'Get the full content of a specific knowledge base article by its ID. Use when you found a relevant article via search and need the complete text to answer the customer thoroughly.',
        parameters: {
          type: 'OBJECT',
          properties: {
            article_id: {
              type: 'STRING',
              description: 'The article ID to retrieve',
            },
          },
          required: ['article_id'],
        },
      },

      // ── Escalation Tools ────────────────────────────────────────
      {
        name: 'createEscalationTicket',
        description: 'Escalate the conversation to a human support agent by creating a Zendesk ticket. Use when: the customer explicitly asks to speak to a human, the issue is too complex to resolve, the customer is very upset, or you cannot help after multiple attempts. Include a detailed summary.',
        parameters: {
          type: 'OBJECT',
          properties: {
            customer_name: {
              type: 'STRING',
              description: 'The customer name if known',
            },
            customer_email: {
              type: 'STRING',
              description: 'The customer email if known',
            },
            subject: {
              type: 'STRING',
              description: 'A brief subject line summarising the issue',
            },
            summary: {
              type: 'STRING',
              description: 'Detailed summary of the conversation and what was attempted. Helps the human agent pick up where you left off.',
            },
            priority: {
              type: 'STRING',
              description: 'Priority level: low, medium, high, or urgent',
            },
            tags: {
              type: 'ARRAY',
              items: { type: 'STRING' },
              description: 'Intelligent tags to categorize the ticket based on context (e.g. refund, shipping, policy, complaint, miscellaneous)',
            },
          },
          required: ['subject', 'summary'],
        },
      },
    ],
  }];
}

/**
 * Execute a tool call by name with the given arguments.
 * This is called by the Gemini engine when the AI decides to use a tool.
 *
 * @param {string} toolName - The name of the tool to execute.
 * @param {object} args - The arguments passed by Gemini.
 * @returns {Promise<object>} The tool's result.
 */
export async function executeToolCall(toolName, args) {
  const executor = TOOL_EXECUTORS[toolName];

  if (!executor) {
    logger.error(`Unknown tool requested: ${toolName}`);
    return {
      error: true,
      message: `Tool "${toolName}" is not available. Available tools: ${Object.keys(TOOL_EXECUTORS).join(', ')}`,
    };
  }

  logger.info(`Executing tool: ${toolName}`, { args });

  try {
    const result = await executor(args);
    return result;
  } catch (error) {
    logger.error(`Tool execution failed: ${toolName}`, {
      error: error.message,
      args,
    });
    // Return error result instead of throwing — let Gemini handle it gracefully
    return {
      error: true,
      message: `The ${toolName} tool encountered an error: ${error.message}. Please inform the customer and suggest alternatives.`,
    };
  }
}

export default { getToolDeclarations, executeToolCall };
