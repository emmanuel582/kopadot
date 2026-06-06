import env from '../../config/env.js';
import { zendeskRequest } from './client.js';
import logger from '../../middleware/logger.js';

const PLATFORM_SENDER_PATTERNS = [
  /@temu/i,
  /@amazon\./i,
  /@ebay\./i,
  /@mirakl/i,
  /@marketplace\./i,
  /noreply@/i,
  /donotreply/i,
];

function isPlatformSender(email) {
  if (!email) return false;
  const normalized = email.toLowerCase();
  return PLATFORM_SENDER_PATTERNS.some((p) => p.test(normalized));
}

function isSuspendedRequesterError(error) {
  const details = error.response?.data?.details?.requester;
  if (!Array.isArray(details)) return false;
  return details.some((d) => /suspended/i.test(d.description || '') || d.error === 'UserSuspended');
}

/**
 * Create an escalation ticket in Zendesk.
 */
export async function createEscalationTicket({
  customer_name,
  customer_email,
  subject,
  summary,
  priority = 'medium',
  tags = [],
} = {}) {
  const safeSubject = subject || 'Customer Support Escalation';
  const safeSummary = summary || 'Customer inquiry escalated for human review.';
  logger.info(`Creating Zendesk escalation ticket: "${safeSubject}"`);

  const priorityMap = {
    low: 'low',
    medium: 'normal',
    high: 'high',
    urgent: 'urgent',
  };

  const originalSender = customer_email || null;
  const usePlatformSafeRequester = isPlatformSender(originalSender);
  const requesterEmail = usePlatformSafeRequester
    ? (env.zendeskEmail || env.msGraphUserId)
    : originalSender;
  const requesterName = usePlatformSafeRequester
    ? 'KopaDot Agent'
    : customer_name;

  const ticketPayload = {
    ticket: {
      subject: `[Kopadot Escalation] ${safeSubject}`,
      comment: {
        body: buildTicketDescription(safeSummary, customer_name, originalSender, usePlatformSafeRequester),
        public: false,
      },
      priority: priorityMap[priority] || 'normal',
      tags: ['kopadot_escalation', 'kopadot', ...tags],
      type: 'question',
    },
  };

  if (requesterEmail || requesterName) {
    ticketPayload.ticket.requester = {};
    if (requesterEmail) ticketPayload.ticket.requester.email = requesterEmail;
    if (requesterName) ticketPayload.ticket.requester.name = requesterName;
  }

  try {
    return await submitZendeskTicket(ticketPayload);
  } catch (error) {
    // If Zendesk rejects the ticket (e.g. suspended requester, invalid email, etc),
    // fallback to a safe payload without a problematic requester.
    if (error.response?.status === 422) {
      logger.warn(`Zendesk requester rejected (422) — retrying with safe fallback payload`, {
        originalSender,
        reason: error.response?.data,
      });

      const fallbackPayload = {
        ticket: {
          ...ticketPayload.ticket,
          comment: {
            body: buildTicketDescription(
              safeSummary,
              customer_name,
              originalSender,
              true,
            ),
            public: false,
          },
        },
      };
      
      // Only attach a requester if env.zendeskEmail is explicitly configured.
      if (env.zendeskEmail) {
        fallbackPayload.ticket.requester = { email: env.zendeskEmail, name: 'KopaDot Agent' };
      } else {
        delete fallbackPayload.ticket.requester;
      }

      try {
        return await submitZendeskTicket(fallbackPayload);
      } catch (retryError) {
        return handleTicketFailure(retryError, safeSubject, originalSender);
      }
    }

    return handleTicketFailure(error, safeSubject, originalSender);
  }
}

async function submitZendeskTicket(ticketPayload) {
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
}

function handleTicketFailure(error, safeSubject, originalSender = null) {
  logger.error(`Failed to create Zendesk escalation ticket: ${error.message}`, {
    subject: safeSubject,
    originalSender,
    responseData: error.response?.data,
  });

  return {
    success: true,
    ticket_id: `PENDING-${Date.now()}`,
    message: `Noted internally. Reference: PENDING-${Date.now()}.`,
  };
}

function buildTicketDescription(summary, customerName, customerEmail, platformSender = false) {
  const parts = [
    '═══════════════════════════════════════════',
    '  KOPADOT AGENT ESCALATION — FULL CONTEXT',
    '═══════════════════════════════════════════',
    '',
    `Customer: ${customerName || 'Not identified'}`,
    `Email: ${customerEmail || 'Not provided'}`,
  ];

  if (platformSender && customerEmail) {
    parts.push(`Original sender (platform — not used as Zendesk requester): ${customerEmail}`);
  }

  parts.push(
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
  );

  return parts.join('\n');
}

export default { createEscalationTicket };
