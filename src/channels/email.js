import { ConfidentialClientApplication } from '@azure/msal-node';
import { Client } from '@microsoft/microsoft-graph-client';
import 'isomorphic-fetch';
import OpenAI from 'openai';
import env from '../config/env.js';
import { CHANNELS } from '../config/constants.js';
import logger from '../middleware/logger.js';
import { processMessage } from '../agent/chatgptEngine.js';
import {
  getSession,
  addToHistory,
  getHistory,
  recordToolUsage,
  updateCustomerIdentity,
} from '../agent/conversationMgr.js';
import { shouldAutoEscalate } from '../agent/escalation.js';
import { formatResponse } from '../utils/responseFormatter.js';

const openai = new OpenAI({ apiKey: env.openaiApiKey });

let graphClient = null;
let isPolling = false;
const processedMessageIds = new Set();
const MAX_PROCESSED_IDS = 2000;

function getGraphClient() {
  if (graphClient) return graphClient;

  if (!env.msGraphTenantId || !env.msGraphClientId || !env.msGraphClientSecret || !env.msGraphUserId) {
    logger.error('Microsoft Graph credentials are not fully configured in environment variables.');
    return null;
  }

  const msalConfig = {
    auth: {
      clientId: env.msGraphClientId,
      authority: `https://login.microsoftonline.com/${env.msGraphTenantId}`,
      clientSecret: env.msGraphClientSecret,
    },
  };

  const cca = new ConfidentialClientApplication(msalConfig);

  const authProvider = async (done) => {
    try {
      const authResponse = await cca.acquireTokenByClientCredential({
        scopes: ['https://graph.microsoft.com/.default'],
      });
      done(null, authResponse.accessToken);
    } catch (error) {
      logger.error(`Error acquiring token: ${error.message}`);
      done(error, null);
    }
  };

  graphClient = Client.init({ authProvider });
  return graphClient;
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function trackProcessedMessage(messageId) {
  processedMessageIds.add(messageId);
  if (processedMessageIds.size > MAX_PROCESSED_IDS) {
    const oldest = processedMessageIds.values().next().value;
    processedMessageIds.delete(oldest);
  }
}

/**
 * Classify whether an inbound email needs a personalized support reply.
 */
async function shouldRespondToEmail(subject, bodyPreview, senderEmail) {
  try {
    const response = await openai.chat.completions.create({
      model: env.openaiModel,
      messages: [
        {
          role: 'system',
          content: `You classify inbound emails for an e-commerce support inbox (${env.storeName}).

Respond YES (needs_response: true) when a real customer is asking for help, such as:
- Order status, tracking, delivery issues
- Returns, refunds, cancellations
- Product questions or complaints
- Payment or account issues
- General support questions directed at the store

Respond NO (needs_response: false) for:
- Marketing newsletters, promotions, spam
- Automated notifications (shipping alerts, seller central, system alerts)
- Government/regulatory correspondence not asking the store for help
- Out-of-office or auto-replies
- Internal/team emails not requesting customer support

Respond ONLY with JSON: {"needs_response": true/false, "reason": "brief reason"}`,
        },
        {
          role: 'user',
          content: `From: ${senderEmail || 'unknown'}\nSubject: ${subject}\n\nPreview:\n${bodyPreview}`,
        },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    });

    const result = JSON.parse(response.choices[0].message.content);
    return { shouldRespond: Boolean(result.needs_response), reason: result.reason || '' };
  } catch (error) {
    logger.warn(`Failed to classify email: ${error.message}`);
    return { shouldRespond: false, reason: 'classification_failed' };
  }
}

async function fetchUnreadMessages(client) {
  const messages = [];
  let request = client
    .api(`/users/${env.msGraphUserId}/messages`)
    .filter('isRead eq false')
    .select('id,subject,bodyPreview,from,body,conversationId')
    .top(10);

  let response = await request.get();
  messages.push(...(response.value || []));

  let nextLink = response['@odata.nextLink'];
  while (nextLink && messages.length < 30) {
    response = await client.api(nextLink).get();
    messages.push(...(response.value || []));
    nextLink = response['@odata.nextLink'];
  }

  return messages;
}

async function markEmailAsRead(client, messageId) {
  await client
    .api(`/users/${env.msGraphUserId}/messages/${messageId}`)
    .patch({ isRead: true });
}

async function sendEmailReply(client, messageId, htmlContent) {
  await client
    .api(`/users/${env.msGraphUserId}/messages/${messageId}/reply`)
    .post({
      message: {
        body: {
          contentType: 'HTML',
          content: htmlContent,
        },
      },
    });
}

/**
 * Process a single inbound email through the AI agent and reply if appropriate.
 */
async function processInboundEmail(client, msg) {
  if (processedMessageIds.has(msg.id)) {
    logger.debug(`Skipping already-processed email: ${msg.id}`);
    return;
  }

  const senderEmail = msg.from?.emailAddress?.address || null;
  const senderName = msg.from?.emailAddress?.name || null;
  const subject = msg.subject || '(no subject)';
  const bodyPreview = msg.bodyPreview || '';
  const plainBody = stripHtml(msg.body?.content) || bodyPreview;

  const { shouldRespond, reason } = await shouldRespondToEmail(subject, plainBody.slice(0, 1500), senderEmail);

  if (!shouldRespond) {
    logger.debug(`Email skipped (no reply needed): "${subject}" — ${reason}`);
    await markEmailAsRead(client, msg.id);
    trackProcessedMessage(msg.id);
    return;
  }

  logger.info(`Email needs support reply: "${subject}" from ${senderEmail || 'unknown'}`);

  const sessionId = `email-${msg.conversationId || senderEmail || msg.id}`;
  getSession(sessionId, { channel: CHANNELS.EMAIL });

  if (senderName || senderEmail) {
    updateCustomerIdentity(sessionId, {
      name: senderName,
      email: senderEmail,
      source: 'email',
    });
  }

  const escalationCheck = shouldAutoEscalate(sessionId);
  if (escalationCheck.shouldEscalate) {
    const fallback = formatResponse(
      'Thank you for your patience. I have passed your enquiry to a member of our support team who will review the full conversation and get back to you by email within 24 hours.',
      CHANNELS.EMAIL,
      {
        subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`,
        customerName: senderName,
        storeName: env.storeName,
      },
    );
    await sendEmailReply(client, msg.id, fallback.html);
    await markEmailAsRead(client, msg.id);
    trackProcessedMessage(msg.id);
    return;
  }

  const history = getHistory(sessionId);
  const customerIdentity = { name: senderName, email: senderEmail };
  const emailContent = [
    'The customer sent the following email. Reply as a professional support email.',
    'Use a warm greeting with their name if known, answer their question fully using tools when needed,',
    'and close with a polite sign-off. Do not use markdown.',
    '',
    `Subject: ${subject}`,
    '',
    plainBody,
  ].join('\n');

  const agentResult = await processMessage(emailContent, history, {
    sessionId,
    channel: CHANNELS.EMAIL,
    customerIdentity,
  });

  if (!agentResult.response) {
    throw new Error('AI agent returned an empty response');
  }

  addToHistory(sessionId, agentResult.conversationUpdate);
  recordToolUsage(sessionId, agentResult.toolsUsed?.length || 0);

  const formatted = formatResponse(agentResult.response, CHANNELS.EMAIL, {
    subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`,
    customerName: senderName,
    storeName: env.storeName,
  });

  await sendEmailReply(client, msg.id, formatted.html);

  logger.info(`Email reply sent for "${subject}"`, {
    sessionId,
    toolsUsed: (agentResult.toolsUsed || []).map((t) => t.name),
    processingTimeMs: agentResult.metadata?.processingTimeMs,
  });

  await markEmailAsRead(client, msg.id);
  trackProcessedMessage(msg.id);
}

/**
 * Poll the inbox for unread customer emails and respond via the AI agent.
 */
export async function pollEmails() {
  if (isPolling) {
    logger.debug('Email poll already in progress — skipping overlapping run');
    return;
  }

  const client = getGraphClient();
  if (!client) return;

  isPolling = true;

  try {
    logger.debug('Polling Microsoft 365 for new emails...');
    const messages = await fetchUnreadMessages(client);

    if (messages.length === 0) {
      return;
    }

    logger.info(`Found ${messages.length} unread email(s). Processing...`);

    for (const msg of messages) {
      try {
        await processInboundEmail(client, msg);
      } catch (error) {
        logger.error(`Failed to process email "${msg.subject}": ${error.message}`, {
          messageId: msg.id,
          stack: error.stack,
        });
      }
    }
  } catch (error) {
    logger.error(`Error polling Microsoft 365 emails: ${error.message}`, { stack: error.stack });
  } finally {
    isPolling = false;
  }
}

/**
 * Starts the polling loop.
 * @param {number} intervalMs - Polling interval in milliseconds. Default: 10 mins.
 */
export function startEmailPolling(intervalMs = 10 * 60 * 1000) {
  logger.info(`Starting Microsoft 365 Email Polling every ${intervalMs / 60000} minutes...`);

  const runPoll = () => {
    pollEmails().catch((error) => {
      logger.error(`Unhandled email poll error: ${error.message}`, { stack: error.stack });
    });
  };

  runPoll();
  setInterval(runPoll, intervalMs);
}

export default { startEmailPolling, pollEmails, processInboundEmail };
