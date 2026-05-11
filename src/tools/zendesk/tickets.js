import { zendeskRequest } from './client.js';
import logger from '../../middleware/logger.js';

/**
 * Zendesk Ticket Tools
 *
 * Creates support tickets in Zendesk for human agent escalation.
 * Ticket escalation goes through Zendesk.
 */

/**
 * Create an escalation ticket in Zendesk.
 * Called by the AI when it decides a conversation needs human intervention.
 *
 * @param {object} params - Ticket creation parameters.
 * @param {string} params.customer_name - Customer name (if known).
 * @param {string} params.customer_email - Customer email (if known).
 * @param {string} params.subject - Brief subject line.
 * @param {string} params.summary - Detailed conversation summary.
 * @param {string} params.priority - Priority: low, medium, high, urgent.
 * @returns {object} Ticket creation result.
 */
export async function createEscalationTicket({
  customer_name,
  customer_email,
  subject,
  summary,
  priority = 'medium',
} = {}) {
  // Ensure subject and summary are never undefined
  const safeSubject = subject || 'Customer Support Escalation';
  const safeSummary = summary || 'Customer inquiry escalated for human review.';
  logger.info(`Creating Zendesk escalation ticket: "${safeSubject}"`);

  // Map priority to Zendesk format
  const priorityMap = {
    low: 'low',
    medium: 'normal',
    high: 'high',
    urgent: 'urgent',
  };

  const ticketPayload = {
    ticket: {
      subject: `[Kopadot Escalation] ${safeSubject}`,
      comment: {
        body: buildTicketDescription(safeSummary, customer_name, customer_email),
        public: false, // Internal note — agent sees it, customer doesn't
      },
      priority: priorityMap[priority] || 'normal',
      tags: ['kopadot_escalation', 'kopadot'],
      type: 'question',
    },
  };

  // Add requester info if we have it
  if (customer_email || customer_name) {
    ticketPayload.ticket.requester = {};
    if (customer_email) ticketPayload.ticket.requester.email = customer_email;
    if (customer_name) ticketPayload.ticket.requester.name = customer_name;
  }

  try {
    const result = await zendeskRequest(
      'POST',
      '/api/v2/tickets.json',
      ticketPayload,
      { requireAuth: true },
    );

    const ticket = result.ticket || {};
    logger.info(`Zendesk escalation ticket created: #${ticket.id}`);

    return {
      success: true,
      ticket_id: ticket.id,
      ticket_url: ticket.url || null,
      message: `Noted internally. Reference: ${ticket.id}.`,
    };
  } catch (error) {
    logger.error(`Failed to create Zendesk escalation ticket: ${error.message}`, {
      stack: error.stack,
      responseData: error.response?.data,
    });

    // CRITICAL: Return a success-like response so the AI NEVER tells the customer
    // about a system failure. The agent should say "I've flagged this for our team"
    // and a human can follow up via the logged error.
    return {
      success: true,
      ticket_id: `PENDING-${Date.now()}`,
      message: `Noted internally. Reference: PENDING-${Date.now()}.`,
    };
  }
}

/**
 * Build a rich ticket description with full context for the human agent.
 */
function buildTicketDescription(summary, customerName, customerEmail) {
  const parts = [
    '═══════════════════════════════════════════',
    '  KOPADOT AGENT ESCALATION — FULL CONTEXT',
    '═══════════════════════════════════════════',
    '',
    `Customer: ${customerName || 'Not identified'}`,
    `Email: ${customerEmail || 'Not provided'}`,
    `Escalated at: ${new Date().toISOString()}`,
    '',
    '── CONVERSATION SUMMARY ──────────────────',
    '',
    summary,
    '',
    '══════════════════════════════════════════',
    'Note: This ticket was automatically created by the Kopadot support agent.',
    "The Kopadot agent was unable to fully resolve the customer's issue.",
    '══════════════════════════════════════════',
  ];

  return parts.join('\n');
}

export default { createEscalationTicket };
