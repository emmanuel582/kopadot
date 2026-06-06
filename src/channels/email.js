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
let escalatedFolderId = null;
const processedMessageIds = new Set();
const MAX_PROCESSED_IDS = 5000;

function getOwnMailbox() {
  return env.msGraphUserId?.toLowerCase().trim() || '';
}

function getLookbackSinceIso() {
  const since = Date.now() - env.emailLookbackHours * 60 * 60 * 1000;
  return new Date(since).toISOString();
}

const MESSAGE_SELECT = 'id,subject,bodyPreview,from,body,conversationId,receivedDateTime,isRead';

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

function getGraphConfigStatus() {
  return {
    tenantId: Boolean(env.msGraphTenantId),
    clientId: Boolean(env.msGraphClientId),
    clientSecret: Boolean(env.msGraphClientSecret),
    userId: Boolean(env.msGraphUserId),
    mailbox: env.msGraphUserId || null,
  };
}

/**
 * Verify Graph credentials on startup — logs clearly if Render env vars are missing.
 */
export async function verifyGraphConnection() {
  const config = getGraphConfigStatus();
  const missing = Object.entries(config)
    .filter(([key, value]) => key !== 'mailbox' && !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    logger.error('Microsoft Graph email disabled — missing env vars on Render', {
      missing,
      hint: 'Set MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID, MS_GRAPH_CLIENT_SECRET, MS_GRAPH_USER_ID in Render dashboard',
    });
    return { ok: false, reason: 'missing_credentials', missing };
  }

  logger.info('Microsoft Graph config loaded', {
    mailbox: config.mailbox,
    pollIntervalMinutes: env.emailPollIntervalMs / 60000,
    lookbackHours: env.emailLookbackHours,
  });

  const client = getGraphClient();
  if (!client) {
    return { ok: false, reason: 'client_init_failed' };
  }

  try {
    // Use mail endpoints only (Mail.Read) — avoids User.Read.All which Render tenants may not grant.
    await client
      .api(`/users/${env.msGraphUserId}/mailFolders/inbox/messages`)
      .top(1)
      .select('id,subject')
      .get();
    logger.info('Microsoft Graph mailbox read verified', { mailbox: config.mailbox });

    const folder = await ensureEscalatedFolder(client);
    if (!folder?.id) {
      logger.error('Escalated mail folder could not be created or found', {
        folderName: env.emailEscalatedFolderName,
        hint: 'Grant Mail.ReadWrite application permission in Azure AD and re-consent',
      });
      return { ok: false, reason: 'escalated_folder_unavailable' };
    }

    logger.info('Escalated folder ready', {
      folderName: env.emailEscalatedFolderName,
      folderId: folder.id,
    });
    return { ok: true, mailbox: config.mailbox, escalatedFolderId: folder.id };
  } catch (error) {
    logger.error(`Microsoft Graph connection failed: ${error.message}`, {
      mailbox: config.mailbox,
      hint: 'Check Azure app permissions (Mail.Read, Mail.Send, Mail.ReadWrite application permissions) and admin consent. User.Read.All is not required.',
    });
    return { ok: false, reason: error.message };
  }
}

/**
 * Find or create the human-review folder in the mailbox root.
 */
async function ensureEscalatedFolder(client) {
  if (escalatedFolderId) {
    return { id: escalatedFolderId, displayName: env.emailEscalatedFolderName };
  }

  const folderName = env.emailEscalatedFolderName;
  const foldersPath = `/users/${env.msGraphUserId}/mailFolders`;

  const response = await client.api(foldersPath).select('id,displayName').top(200).get();
  const existing = (response.value || []).find(
    (f) => f.displayName?.toLowerCase() === folderName.toLowerCase(),
  );

  if (existing?.id) {
    escalatedFolderId = existing.id;
    return existing;
  }

  const created = await client.api(foldersPath).post({ displayName: folderName });
  escalatedFolderId = created.id;
  return created;
}

async function moveEmailToEscalated(client, messageId, folderId) {
  const moved = await client
    .api(`/users/${env.msGraphUserId}/messages/${messageId}/move`)
    .post({ destinationId: folderId });
  return moved;
}

async function markEmailUnread(client, messageId) {
  try {
    await client
      .api(`/users/${env.msGraphUserId}/messages/${messageId}`)
      .patch({ isRead: false });
  } catch (error) {
    logger.warn(`Could not mark email as unread: ${error.message}`, { messageId });
  }
}

/**
 * Move an unresolved email to the Escalated folder and leave it unread for humans.
 */
async function routeEmailToHumanQueue(client, messageId, { subject, reason } = {}) {
  const folder = await ensureEscalatedFolder(client);
  if (!folder?.id) {
    logger.error('Cannot route email to human queue — Escalated folder unavailable', {
      messageId,
      subject,
      reason,
    });
    return null;
  }

  trackProcessedMessage(messageId);

  const moved = await moveEmailToEscalated(client, messageId, folder.id);
  const newMessageId = moved?.id || messageId;

  if (newMessageId !== messageId) {
    trackProcessedMessage(newMessageId);
  }

  await markEmailUnread(client, newMessageId);

  logger.info(`Email routed to "${env.emailEscalatedFolderName}" folder (unread)`, {
    originalMessageId: messageId,
    messageId: newMessageId,
    subject,
    reason,
    folderId: folder.id,
  });

  return newMessageId;
}

function emailNeedsHumanFollowUp(agentResult, escalationCheck) {
  if (escalationCheck?.shouldEscalate) {
    return { needsHuman: true, reason: escalationCheck.reason || 'auto_escalation' };
  }

  if (agentResult?.metadata?.needsHumanFollowUp) {
    return { needsHuman: true, reason: 'agent_escalation' };
  }

  if (agentResult?.metadata?.error) {
    return { needsHuman: true, reason: 'agent_error' };
  }

  const tools = agentResult?.toolsUsed || [];
  if (tools.some((t) => t.name === 'createEscalationTicket')) {
    return { needsHuman: true, reason: 'escalation_ticket' };
  }

  return { needsHuman: false };
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

const AUTOMATED_SENDER_PATTERNS = [
  /no[-_.]?reply/i,
  /donotreply/i,
  /do[-_.]?not[-_.]?reply/i,
  /mailer-daemon/i,
  /postmaster@/i,
  /bounce@/i,
  /notifications?@/i,
  /alerts?@/i,
];

const INTERNAL_NOTIFICATION_PATTERNS = [
  /^\[KopaDot\]/i,
  /ticket\s*\(#\d+\)\s*by/i,
  /has been received\.\s*It is unassigned/i,
];

const MARKETING_SUBJECT_PATTERNS = [
  /ship now/i,
  /you made the sale/i,
  /you have a new order/i,
  /upgrade reminder/i,
  /newsletter/i,
  /\bseo\b/i,
  /partnership opportunity/i,
  /wholesale/i,
  /traffic magnet/i,
  /conversion flow/i,
  /website design/i,
  /refurbished.*screen/i,
  /months pro free/i,
  /could we discuss/i,
  /store structure observation/i,
  /re:\s*\[\[/i,
  /reminder to speed up/i,
  /approaching delivery times/i,
  /order\(s\) about to be late/i,
  /successfully cancelled an order/i,
  /buyer wants to cancel/i,
  /statement summary is ready/i,
  /new device is using your account/i,
  /has shipped your sold item/i,
  /your order has shipped/i,
  /fulfilment order/i,
  /refund initiated/i,
  /feedback notification/i,
  /sent a message about/i,
  /limited-time.*discount/i,
];

const PLATFORM_SENDER_DOMAINS = [
  '@amazon.',
  '@ebay.',
  '@zendesk.com',
  '@parcelpanel',
  '@ingrammicro',
  '@marketplace.',
  '@google.com',
  '@facebookmail.com',
];

const CUSTOMER_SUPPORT_SIGNALS = [
  /\border\s*(#?\d{5,}|number|dux\d+)/i,
  /\bcancel(l)?(ing|ation)?\b/i,
  /\brefund\b/i,
  /\breturn\b/i,
  /\btrack(ing)?\b/i,
  /\bship(ped|ping)?\b/i,
  /where is my/i,
  /haven'?t received/i,
  /not received/i,
  /not dispatched/i,
  /\bdelivery\b/i,
  /\bhelp\b/i,
  /\bissue\b/i,
  /\bproblem\b/i,
  /\bpolicy on\b/i,
  /\?\s*$/,
  /\?/,
];

/**
 * Hard-filter obvious non-customer emails before the AI classifier runs.
 */
function isObviousNonCustomerEmail(senderEmail, subject = '', bodyPreview = '') {
  if (!senderEmail) {
    return { skip: true, reason: 'no_sender_address' };
  }

  const normalized = senderEmail.toLowerCase().trim();
  const ownMailbox = getOwnMailbox();

  if (ownMailbox && normalized === ownMailbox) {
    return { skip: true, reason: 'sent_from_own_mailbox' };
  }

  if (AUTOMATED_SENDER_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { skip: true, reason: 'automated_sender_address' };
  }

  const combined = `${subject}\n${bodyPreview}`;
  if (INTERNAL_NOTIFICATION_PATTERNS.some((pattern) => pattern.test(combined))) {
    return { skip: true, reason: 'internal_system_notification' };
  }

  return { skip: false };
}

function isLikelyCustomerSupport(subject, bodyPreview) {
  const combined = `${subject}\n${bodyPreview}`;
  return CUSTOMER_SUPPORT_SIGNALS.some((pattern) => pattern.test(combined));
}

function shouldSkipWithoutGpt(senderEmail, subject) {
  const normalized = senderEmail?.toLowerCase() || '';
  if (PLATFORM_SENDER_DOMAINS.some((domain) => normalized.includes(domain))) {
    return { skip: true, reason: 'platform_notification_sender' };
  }
  if (MARKETING_SUBJECT_PATTERNS.some((pattern) => pattern.test(subject))) {
    return { skip: true, reason: 'marketing_or_automated_subject' };
  }
  return { skip: false };
}

/**
 * Decide if we should reply — uses GPT only for ambiguous emails.
 */
async function classifyEmailNeed(subject, bodyPreview, senderEmail) {
  const noGptSkip = shouldSkipWithoutGpt(senderEmail, subject);
  if (noGptSkip.skip) {
    return { shouldRespond: false, reason: noGptSkip.reason };
  }

  if (isLikelyCustomerSupport(subject, bodyPreview)) {
    return { shouldRespond: true, reason: 'customer_support_signals' };
  }

  return shouldRespondToEmail(subject, bodyPreview, senderEmail);
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
    logger.warn(`Failed to classify email: ${error.message} — defaulting to reply`);
    return { shouldRespond: true, reason: 'classification_failed_default_reply' };
  }
}

async function fetchMessagePage(client, requestBuilder, maxMessages) {
  const messages = [];
  let response = await requestBuilder.get();
  messages.push(...(response.value || []));

  let nextLink = response['@odata.nextLink'];
  while (nextLink && messages.length < maxMessages) {
    response = await client.api(nextLink).get();
    messages.push(...(response.value || []));
    nextLink = response['@odata.nextLink'];
  }

  return messages.slice(0, maxMessages);
}

/**
 * Fetch inbox candidates: prioritises the last 6 hours (read or unread), then
 * unread mail, then the wider lookback window.
 */
async function fetchCandidateMessages(client) {
  const inbox = `/users/${env.msGraphUserId}/mailFolders/inbox/messages`;
  const cap = env.emailMaxPerPoll;
  const sinceIso = getLookbackSinceIso();

  const [priorityRecent, unread, lookback] = await Promise.all([
    fetchMessagePage(
      client,
      client.api(inbox).select(MESSAGE_SELECT).top(40),
      40,
    ),
    fetchMessagePage(
      client,
      client.api(inbox).filter('isRead eq false').select(MESSAGE_SELECT).top(15),
      15,
    ),
    fetchMessagePage(
      client,
      client.api(inbox).filter(`receivedDateTime ge ${sinceIso}`).select(MESSAGE_SELECT).top(20),
      20,
    ),
  ]);

  const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
  const priorityRecentFiltered = priorityRecent.filter(
    (m) => new Date(m.receivedDateTime).getTime() >= sixHoursAgo,
  );
  const priorityIds = new Set(priorityRecentFiltered.map((m) => m.id));
  const byId = new Map();

  for (const msg of priorityRecentFiltered) byId.set(msg.id, msg);
  for (const msg of unread) if (!byId.has(msg.id)) byId.set(msg.id, msg);
  for (const msg of lookback) if (!byId.has(msg.id)) byId.set(msg.id, msg);

  return [...byId.values()]
    .sort((a, b) => {
      const aPriority = priorityIds.has(a.id) ? 0 : 1;
      const bPriority = priorityIds.has(b.id) ? 0 : 1;
      if (aPriority !== bPriority) return aPriority - bPriority;
      return new Date(a.receivedDateTime) - new Date(b.receivedDateTime);
    })
    .slice(0, cap);
}

/**
 * Load recent outbound mail from Sent Items to detect replies we already sent
 * (survives Render restarts — in-memory dedup alone does not).
 */
async function fetchRecentSentMessages(client) {
  const sinceIso = getLookbackSinceIso();
  try {
    return await fetchMessagePage(
      client,
      client
        .api(`/users/${env.msGraphUserId}/mailFolders/sentitems/messages`)
        .filter(`sentDateTime ge ${sinceIso}`)
        .select('id,conversationId,sentDateTime,from,subject')
        .top(50),
      100,
    );
  } catch (error) {
    logger.warn(`Could not load sent items for dedup: ${error.message}`);
    return [];
  }
}

function isCountableSupportReply(sent) {
  const subject = sent.subject || '';
  if (/^\[KopaDot\]/i.test(subject)) return false;
  if (/ticket\s*\(#\d+\)/i.test(subject)) return false;
  return true;
}

function wasAlreadyRepliedTo(inboundMsg, sentMessages) {
  if (!inboundMsg.conversationId || !inboundMsg.receivedDateTime) return false;

  const ownMailbox = getOwnMailbox();
  const inboundTime = new Date(inboundMsg.receivedDateTime).getTime();

  return sentMessages.some((sent) => {
    if (!isCountableSupportReply(sent)) return false;
    if (sent.conversationId !== inboundMsg.conversationId) return false;
    const from = sent.from?.emailAddress?.address?.toLowerCase().trim();
    if (from !== ownMailbox) return false;
    const sentTime = new Date(sent.sentDateTime).getTime();
    return sentTime > inboundTime;
  });
}

async function markEmailAsRead(client, messageId) {
  try {
    await client
      .api(`/users/${env.msGraphUserId}/messages/${messageId}`)
      .patch({ isRead: true });
  } catch (error) {
    // PATCH requires Mail.ReadWrite; read + reply only need Mail.Read + Mail.Send.
    logger.warn(`Could not mark email as read: ${error.message}`, {
      messageId,
      hint: 'Grant Mail.ReadWrite application permission in Azure AD and re-consent',
    });
  }
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
async function processInboundEmail(client, msg, sentMessages = [], { force = false } = {}) {
  if (processedMessageIds.has(msg.id)) {
    logger.debug(`Skipping already-processed email: ${msg.id}`);
    return { replied: false, reason: 'already_processed' };
  }

  const senderEmail = msg.from?.emailAddress?.address || null;
  const senderName = msg.from?.emailAddress?.name || null;
  const subject = msg.subject || '(no subject)';
  const bodyPreview = msg.bodyPreview || '';
  const plainBody = stripHtml(msg.body?.content) || bodyPreview;

  if (!force && wasAlreadyRepliedTo(msg, sentMessages)) {
    logger.debug(`Skipping email already replied to: "${subject}" from ${senderEmail}`, {
      messageId: msg.id,
      conversationId: msg.conversationId,
    });
    trackProcessedMessage(msg.id);
    return { replied: false, reason: 'already_replied' };
  }

  const hardFilter = isObviousNonCustomerEmail(senderEmail, subject, bodyPreview);
  if (hardFilter.skip) {
    logger.debug(`Email skipped (hard filter): "${subject}" from ${senderEmail} — ${hardFilter.reason}`);
    await markEmailAsRead(client, msg.id);
    trackProcessedMessage(msg.id);
    return { replied: false, reason: hardFilter.reason };
  }

  const { shouldRespond, reason } = await classifyEmailNeed(subject, plainBody.slice(0, 1500), senderEmail);

  if (!shouldRespond) {
    logger.debug(`Email skipped (no reply needed): "${subject}" — ${reason}`);
    await markEmailAsRead(client, msg.id);
    trackProcessedMessage(msg.id);
    return { replied: false, reason };
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
    await routeEmailToHumanQueue(client, msg.id, {
      subject,
      reason: escalationCheck.reason || 'auto_escalation',
    });
    return { replied: false, reason: 'escalated_to_folder', escalated: true };
  }

  const history = getHistory(sessionId);
  const customerIdentity = { name: senderName, email: senderEmail };
  const firstName = senderName?.split(' ')[0] || null;
  const emailContent = [
    `Reply to this customer's email. Write like a real ${env.storeName} support team member — natural, warm, human.`,
    'Never sound like AI or a bot. No markdown. Answer their question directly using tools when needed.',
    firstName ? `Customer name: ${firstName}` : 'Customer name: unknown',
    `Customer email: ${senderEmail}`,
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

  const humanCheck = emailNeedsHumanFollowUp(agentResult, escalationCheck);
  if (humanCheck.needsHuman) {
    await routeEmailToHumanQueue(client, msg.id, {
      subject,
      reason: humanCheck.reason,
    });
    return { replied: false, reason: humanCheck.reason, escalated: true };
  }

  const formatted = formatResponse(agentResult.response, CHANNELS.EMAIL, {
    subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`,
    customerName: senderName,
    storeName: env.storeName,
    agentName: env.emailAgentSignoffName,
  });

  // Graph /reply always goes back to the sender of this specific message — never a random address.
  await sendEmailReply(client, msg.id, formatted.html);

  sentMessages.push({
    conversationId: msg.conversationId,
    sentDateTime: new Date().toISOString(),
    from: { emailAddress: { address: env.msGraphUserId } },
  });

  logger.info(`Email reply sent to ${senderEmail} for "${subject}"`, {
    sessionId,
    replyTo: senderEmail,
    toolsUsed: (agentResult.toolsUsed || []).map((t) => t.name),
    processingTimeMs: agentResult.metadata?.processingTimeMs,
  });

  await markEmailAsRead(client, msg.id);
  trackProcessedMessage(msg.id);
  return { replied: true, reason: 'support_reply' };
}

/**
 * Poll the inbox for customer emails and respond via the AI agent.
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
    logger.debug('Polling Microsoft 365 inbox for customer emails...');
    const [messages, sentMessages] = await Promise.all([
      fetchCandidateMessages(client),
      fetchRecentSentMessages(client),
    ]);

    if (messages.length === 0) {
      return;
    }

    const unreadCount = messages.filter((m) => !m.isRead).length;
    logger.info(`Found ${messages.length} candidate email(s) (${unreadCount} unread, lookback ${env.emailLookbackHours}h). Processing...`);

    for (const msg of messages) {
      try {
        await processInboundEmail(client, msg, sentMessages);
      } catch (error) {
        logger.error(`Failed to process email "${msg.subject}": ${error.message}`, {
          messageId: msg.id,
          stack: error.stack,
        });
        try {
          await routeEmailToHumanQueue(client, msg.id, {
            subject: msg.subject,
            reason: `processing_error: ${error.message}`,
          });
        } catch (routeError) {
          logger.error(`Failed to route email to Escalated folder: ${routeError.message}`, {
            messageId: msg.id,
          });
        }
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
 * @param {number} intervalMs - Polling interval in milliseconds. Default: 3 mins.
 */
export function startEmailPolling(intervalMs = 3 * 60 * 1000) {
  logger.info(`Starting Microsoft 365 Email Polling every ${intervalMs / 60000} minutes...`);

  const runPoll = () => {
    pollEmails().catch((error) => {
      logger.error(`Unhandled email poll error: ${error.message}`, { stack: error.stack });
    });
  };

  runPoll();
  setInterval(runPoll, intervalMs);
}

/**
 * Find a specific inbox message by sender and/or subject (for targeted replies).
 */
export async function findInboxMessage({ fromEmail, subjectContains }) {
  const client = getGraphClient();
  if (!client) return null;

  const inbox = `/users/${env.msGraphUserId}/mailFolders/inbox/messages`;
  const messages = await fetchMessagePage(
    client,
    client.api(inbox).select(MESSAGE_SELECT).top(100),
    150,
  );

  const fromNorm = fromEmail?.toLowerCase().trim();
  const subjectNorm = subjectContains?.toLowerCase().trim();

  const matches = messages.filter((m) => {
    const addr = m.from?.emailAddress?.address?.toLowerCase().trim();
    if (fromNorm && addr !== fromNorm) return false;
    if (subjectNorm && !m.subject?.toLowerCase().includes(subjectNorm)) return false;
    return true;
  });

  return matches.sort((a, b) => new Date(b.receivedDateTime) - new Date(a.receivedDateTime))[0] || null;
}

/**
 * Process one specific email by sender/subject — bypasses the poll queue.
 */
export async function replyToSpecificEmail({ fromEmail, subjectContains, force = false }) {
  const client = getGraphClient();
  if (!client) throw new Error('Graph client not configured');

  const msg = await findInboxMessage({ fromEmail, subjectContains });
  if (!msg) {
    throw new Error(`No inbox message found from ${fromEmail || 'any'} with subject containing "${subjectContains || ''}"`);
  }

  const sentMessages = await fetchRecentSentMessages(client);
  if (!force && wasAlreadyRepliedTo(msg, sentMessages)) {
    logger.info(`Already replied to "${msg.subject}" from ${fromEmail} — skipping`);
    return { replied: false, reason: 'already_replied', messageId: msg.id };
  }

  processedMessageIds.delete(msg.id);

  const result = await processInboundEmail(client, msg, sentMessages, { force });
  return {
    replied: Boolean(result?.replied),
    escalated: Boolean(result?.escalated),
    reason: result?.reason,
    subject: msg.subject,
    messageId: msg.id,
    to: fromEmail,
  };
}

export default {
  startEmailPolling,
  pollEmails,
  processInboundEmail,
  verifyGraphConnection,
  findInboxMessage,
  replyToSpecificEmail,
};
