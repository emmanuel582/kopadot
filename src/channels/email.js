import { ConfidentialClientApplication } from '@azure/msal-node';
import { Client } from '@microsoft/microsoft-graph-client';
import 'isomorphic-fetch';
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
import { triageInboundEmail, triageInboundEmailFast } from './emailTriage.js';

let graphClient = null;
let isPolling = false;
let escalatedFolderId = null;
let backlogDrainComplete = false;
const processedMessageIds = new Set();
const processingMessageIds = new Set();
const MAX_PROCESSED_IDS = 5000;

function getOwnMailbox() {
  return env.msGraphUserId?.toLowerCase().trim() || '';
}

function getLookbackSinceIso() {
  const since = Date.now() - env.emailLookbackHours * 60 * 60 * 1000;
  return new Date(since).toISOString();
}

function getPrioritySinceIso() {
  const since = Date.now() - env.emailPriorityHours * 60 * 60 * 1000;
  return new Date(since).toISOString();
}

const MESSAGE_SELECT = 'id,subject,bodyPreview,from,body,conversationId,receivedDateTime,isRead,internetMessageHeaders';

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
    priorityHours: env.emailPriorityHours,
    lookbackHours: env.emailLookbackHours,
    backlogDrainPerPoll: env.emailBacklogDrainPerPoll,
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
    return { needsHuman: true, reason: escalationCheck.reason || 'auto_escalation', stillSendReply: false };
  }

  if (agentResult?.metadata?.inadequateReply) {
    return { needsHuman: true, reason: 'inadequate_ai_reply', stillSendReply: true };
  }

  if (agentResult?.metadata?.needsHumanFollowUp) {
    return { needsHuman: true, reason: 'agent_escalation', stillSendReply: true };
  }

  if (agentResult?.metadata?.error) {
    return { needsHuman: true, reason: 'agent_error', stillSendReply: true };
  }

  const tools = agentResult?.toolsUsed || [];
  if (tools.some((t) => t.name === 'createEscalationTicket')) {
    return { needsHuman: true, reason: 'escalation_ticket', stillSendReply: true };
  }

  return { needsHuman: false, stillSendReply: false };
}

function stripHtml(html) {
  if (!html) return '';
  let text = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
    
  // Strip quoted replies (standard email quoting)
  const lines = text.split('\n');
  const cleanLines = [];
  for (const line of lines) {
    if (line.trim().startsWith('>')) continue;
    if (line.match(/^On .* wrote:/i)) break;
    if (line.match(/^_{10,}/)) break; // Outlook separator
    if (line.match(/^-{10,}/)) break; // Outlook separator
    if (line.match(/^From: /i)) break;
    cleanLines.push(line);
  }
  return cleanLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function trackProcessedMessage(messageId) {
  processedMessageIds.add(messageId);
  if (processedMessageIds.size > MAX_PROCESSED_IDS) {
    const oldest = processedMessageIds.values().next().value;
    processedMessageIds.delete(oldest);
  }
}

function normalizeEmailSubject(subject = '') {
  return subject.replace(/^(re|fw|fwd):\s*/gi, '').trim().toLowerCase();
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
 * Recent unread customer candidates — newest first within the priority window.
 */
async function fetchRecentCustomerMessages(client) {
  const inbox = `/users/${env.msGraphUserId}/mailFolders/inbox/messages`;
  const sinceIso = getPrioritySinceIso();

  const messages = await fetchMessagePage(
    client,
    client
      .api(inbox)
      .filter(`isRead eq false and receivedDateTime ge ${sinceIso}`)
      .select(MESSAGE_SELECT)
      .orderby('receivedDateTime desc')
      .top(env.emailMaxPerPoll),
    env.emailMaxPerPoll,
  );

  return messages;
}

/**
 * Old unread backlog — received before the priority window, oldest first for drain.
 */
async function fetchBacklogUnread(client, limit) {
  const inbox = `/users/${env.msGraphUserId}/mailFolders/inbox/messages`;
  const priorityCutoff = getPrioritySinceIso();

  const messages = await fetchMessagePage(
    client,
    client
      .api(inbox)
      .filter(`isRead eq false and receivedDateTime lt ${priorityCutoff}`)
      .select(MESSAGE_SELECT)
      .orderby('receivedDateTime asc')
      .top(limit),
    limit,
  );

  return messages;
}

function buildTriageInput(msg) {
  return {
    senderEmail: msg.from?.emailAddress?.address || null,
    senderName: msg.from?.emailAddress?.name || null,
    subject: msg.subject || '(no subject)',
    bodyPreview: msg.bodyPreview || '',
    plainBody: stripHtml(msg.body?.content) || msg.bodyPreview || '',
    internetMessageHeaders: msg.internetMessageHeaders,
  };
}

/**
 * Mark-read old noise without GPT. Strong customer signals in backlog are kept for processing.
 */
async function drainInboxBacklog(client, { aggressive = false } = {}) {
  const limit = aggressive ? 200 : env.emailBacklogDrainPerPoll;
  const batch = await fetchBacklogUnread(client, limit);
  if (batch.length === 0) {
    backlogDrainComplete = true;
    return { drained: 0, kept: 0, remaining: false };
  }

  let drained = 0;
  let kept = 0;

  for (const msg of batch) {
    const triage = triageInboundEmailFast(buildTriageInput(msg), { ownMailbox: getOwnMailbox() });

    if (triage.shouldRespond) {
      kept += 1;
      logger.info(`Backlog kept for processing (customer signals): "${msg.subject}"`, {
        messageId: msg.id,
        reason: triage.reason,
        customerScore: triage.customerScore,
      });
      continue;
    }

    // Only drain if Layer 1 hard-denied (automated sender, platform notification, etc.)
    // Layer 2 ambiguous skips are left unread — the priority loop will give them full GPT triage.
    if (triage.layer === 1) {
      const readOk = await markEmailAsRead(client, msg.id);
      trackProcessedMessage(msg.id);
      drained += 1;
      logger.debug(`Backlog drained (mark read): "${msg.subject}" — ${triage.reason}`, {
        messageId: msg.id,
        markReadOk: readOk,
      });
    } else {
      // Layer 2 skip with low confidence — leave unread for full triage
      kept += 1;
      logger.debug(`Backlog kept for full triage: "${msg.subject}" — ${triage.reason}`, {
        messageId: msg.id,
        customerScore: triage.customerScore,
        marketingScore: triage.marketingScore,
      });
    }
  }

  const remaining = batch.length >= limit;
  if (!remaining) backlogDrainComplete = true;

  logger.info(`Inbox backlog drain: ${drained} marked read, ${kept} kept, batch=${batch.length}`, {
    aggressive,
    backlogDrainComplete,
  });

  return { drained, kept, remaining };
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
  if (!inboundMsg.receivedDateTime) return false;

  const ownMailbox = getOwnMailbox();
  const inboundTime = new Date(inboundMsg.receivedDateTime).getTime();
  const inboundSubject = normalizeEmailSubject(inboundMsg.subject);

  return sentMessages.some((sent) => {
    if (!isCountableSupportReply(sent)) return false;
    const from = sent.from?.emailAddress?.address?.toLowerCase().trim();
    if (from !== ownMailbox) return false;
    const sentTime = new Date(sent.sentDateTime).getTime();
    if (sentTime <= inboundTime) return false;

    if (inboundMsg.conversationId && sent.conversationId === inboundMsg.conversationId) {
      return true;
    }

    const sentSubject = normalizeEmailSubject(sent.subject);
    if (inboundSubject && sentSubject && (
      sentSubject === inboundSubject
      || sentSubject.includes(inboundSubject)
      || inboundSubject.includes(sentSubject)
    )) {
      return true;
    }

    return false;
  });
}

/**
 * Check the Graph conversation thread for an outbound reply from our mailbox.
 * Survives multi-instance deploys and Sent Items sync delay.
 */
async function hasReplyInConversation(client, inboundMsg) {
  if (!inboundMsg.conversationId || !inboundMsg.receivedDateTime) return false;

  const ownMailbox = getOwnMailbox();
  const inboundTime = new Date(inboundMsg.receivedDateTime).getTime();

  try {
    const response = await client
      .api(`/users/${env.msGraphUserId}/messages`)
      .filter(`conversationId eq '${inboundMsg.conversationId}'`)
      .select('id,from,receivedDateTime,sentDateTime')
      .top(25)
      .get();

    return (response.value || []).some((message) => {
      const from = message.from?.emailAddress?.address?.toLowerCase().trim();
      if (from !== ownMailbox) return false;
      const messageTime = new Date(message.sentDateTime || message.receivedDateTime).getTime();
      return messageTime > inboundTime;
    });
  } catch (error) {
    logger.warn(`Could not check conversation for existing reply: ${error.message}`, {
      conversationId: inboundMsg.conversationId,
    });
    return false;
  }
}

async function skipHandledEmail(client, msg, reason) {
  trackProcessedMessage(msg.id);
  await markEmailAsRead(client, msg.id);
  if (msg.conversationId) {
    await markConversationAsRead(client, msg.conversationId);
  }
  return { replied: false, reason };
}

async function markEmailAsRead(client, messageId) {
  try {
    await client
      .api(`/users/${env.msGraphUserId}/messages/${messageId}`)
      .patch({ isRead: true });
    return true;
  } catch (error) {
    logger.warn(`Could not mark email as read: ${error.message}`, {
      messageId,
      hint: 'Grant Mail.ReadWrite application permission in Azure AD and re-consent',
    });
    return false;
  }
}

/**
 * Mark every unread message in a conversation read (handles multi-message threads).
 */
async function markConversationAsRead(client, conversationId) {
  if (!conversationId) return 0;

  try {
    const response = await client
      .api(`/users/${env.msGraphUserId}/messages`)
      .filter(`conversationId eq '${conversationId}' and isRead eq false`)
      .select('id')
      .top(25)
      .get();

    const unread = response.value || [];
    let marked = 0;
    for (const message of unread) {
      if (await markEmailAsRead(client, message.id)) {
        trackProcessedMessage(message.id);
        marked += 1;
      }
    }
    return marked;
  } catch (error) {
    logger.warn(`Could not mark conversation as read: ${error.message}`, { conversationId });
    return 0;
  }
}

async function sendEmailReply(client, messageId, htmlContent) {
  await client
    .api(`/users/${env.msGraphUserId}/messages/${messageId}/replyAll`)
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
  const senderEmail = msg.from?.emailAddress?.address || null;
  const lockKey = msg.conversationId || senderEmail || msg.id;

  if (processingMessageIds.has(lockKey) || processedMessageIds.has(msg.id)) {
    logger.debug(`Skipping already-processing/processed email: ${msg.id}`);
    return skipHandledEmail(client, msg, 'already_processed');
  }

  const senderName = msg.from?.emailAddress?.name || null;
  const subject = msg.subject || '(no subject)';
  const bodyPreview = msg.bodyPreview || '';
  const plainBody = stripHtml(msg.body?.content) || bodyPreview;

  if (!force && wasAlreadyRepliedTo(msg, sentMessages)) {
    logger.debug(`Skipping email already replied to: "${subject}" from ${senderEmail}`, {
      messageId: msg.id,
      conversationId: msg.conversationId,
    });
    return skipHandledEmail(client, msg, 'already_replied');
  }

  if (!force && await hasReplyInConversation(client, msg)) {
    logger.debug(`Skipping email — conversation already has our reply: "${subject}"`, {
      messageId: msg.id,
      conversationId: msg.conversationId,
    });
    return skipHandledEmail(client, msg, 'conversation_already_replied');
  }

  const triage = await triageInboundEmail({
    senderEmail,
    senderName,
    subject,
    bodyPreview,
    plainBody,
    internetMessageHeaders: msg.internetMessageHeaders,
  }, { ownMailbox: getOwnMailbox() });

  if (!triage.shouldRespond) {
    logger.debug(`Email skipped (triage L${triage.layer}): "${subject}" — ${triage.reason}`, {
      confidence: triage.confidence,
      gptUsed: triage.gptUsed,
      customerScore: triage.customerScore,
      marketingScore: triage.marketingScore,
    });
    await markEmailAsRead(client, msg.id);
    trackProcessedMessage(msg.id);
    await markConversationAsRead(client, msg.conversationId);
    return { replied: false, reason: triage.reason, triage };
  }

  logger.info(`Email passed triage (L${triage.layer}): "${subject}" — ${triage.reason}`, {
    confidence: triage.confidence,
    gptUsed: triage.gptUsed,
    customerScore: triage.customerScore,
    marketingScore: triage.marketingScore,
  });

  logger.info(`Email needs support reply: "${subject}" from ${senderEmail || 'unknown'}`);

  // In-flight lock before expensive AI work — prevents duplicate agent runs in overlapping polls.
  processingMessageIds.add(lockKey);
  try {
    return await processSupportEmail(client, msg, sentMessages, {
      senderEmail,
      senderName,
      subject,
      plainBody,
      force,
    });
  } finally {
    processingMessageIds.delete(lockKey);
  }
}

async function processSupportEmail(client, msg, sentMessages, {
  senderEmail,
  senderName,
  subject,
  plainBody,
  force,
}) {
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
  if (humanCheck.needsHuman && !humanCheck.stillSendReply) {
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

  if (!force && await hasReplyInConversation(client, msg)) {
    logger.warn(`Duplicate reply prevented at send time for "${subject}"`, {
      messageId: msg.id,
      conversationId: msg.conversationId,
    });
    await markEmailAsRead(client, msg.id);
    trackProcessedMessage(msg.id);
    return { replied: false, reason: 'duplicate_reply_prevented' };
  }

  // Graph /reply always goes back to the sender of this specific message — never a random address.
  await sendEmailReply(client, msg.id, formatted.html);

  // Mark entire conversation read so the next poll never re-fetches thread messages.
  await markEmailAsRead(client, msg.id);
  trackProcessedMessage(msg.id);
  const threadMarked = await markConversationAsRead(client, msg.conversationId);
  if (threadMarked > 1) {
    logger.debug(`Marked ${threadMarked} unread messages read in conversation`, {
      conversationId: msg.conversationId,
      subject,
    });
  }

  if (humanCheck.needsHuman && humanCheck.stillSendReply) {
    await routeEmailToHumanQueue(client, msg.id, {
      subject,
      reason: humanCheck.reason,
    });
    logger.warn('Safe fallback reply sent — email also routed for human review', {
      subject,
      reason: humanCheck.reason,
    });
  }

  sentMessages.push({
    conversationId: msg.conversationId,
    subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`,
    sentDateTime: new Date().toISOString(),
    from: { emailAddress: { address: env.msGraphUserId } },
  });

  logger.info(`Email reply sent to ${senderEmail} for "${subject}"`, {
    sessionId,
    replyTo: senderEmail,
    toolsUsed: (agentResult.toolsUsed || []).map((t) => t.name),
    processingTimeMs: agentResult.metadata?.processingTimeMs,
  });

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

    if (!backlogDrainComplete) {
      await drainInboxBacklog(client, { aggressive: true });
    } else {
      await drainInboxBacklog(client, { aggressive: false });
    }

    const [recentMessages, sentMessages] = await Promise.all([
      fetchRecentCustomerMessages(client),
      fetchRecentSentMessages(client),
    ]);

    const backlogBatch = await fetchBacklogUnread(client, env.emailBacklogDrainPerPoll);
    const backlogCustomer = backlogBatch.filter((msg) => {
      const triage = triageInboundEmailFast(buildTriageInput(msg), { ownMailbox: getOwnMailbox() });
      return triage.shouldRespond;
    });

    const byId = new Map();
    for (const msg of recentMessages) byId.set(msg.id, msg);
    for (const msg of backlogCustomer) if (!byId.has(msg.id)) byId.set(msg.id, msg);

    const messages = [...byId.values()]
      .sort((a, b) => new Date(b.receivedDateTime) - new Date(a.receivedDateTime))
      .slice(0, env.emailMaxPerPoll);

    if (messages.length === 0) {
      logger.debug('No recent unread customer emails in priority window', {
        priorityHours: env.emailPriorityHours,
      });
      return;
    }

    const unreadCount = messages.filter((m) => !m.isRead).length;
    logger.info(`Found ${messages.length} recent candidate email(s) (${unreadCount} unread, priority ${env.emailPriorityHours}h, newest first). Processing...`);

    const toProcess = [];
    for (const msg of messages) {
      if (processedMessageIds.has(msg.id)) {
        await skipHandledEmail(client, msg, 'already_processed_prefilter');
        continue;
      }
      if (wasAlreadyRepliedTo(msg, sentMessages) || await hasReplyInConversation(client, msg)) {
        logger.debug(`Pre-filter skip (already replied): "${msg.subject}"`, { messageId: msg.id });
        await skipHandledEmail(client, msg, 'already_replied_prefilter');
        continue;
      }
      toProcess.push(msg);
    }

    // Process concurrently in chunks of 5 to handle up to 50 emails reliably without rate limiting
    const chunkSize = 5;
    for (let i = 0; i < toProcess.length; i += chunkSize) {
      const chunk = toProcess.slice(i, i + chunkSize);
      await Promise.all(chunk.map(async (msg) => {
        try {
          await processInboundEmail(client, msg, sentMessages);
        } catch (error) {
          logger.error(`Failed to process email "${msg.subject}": ${error.message}`, {
            messageId: msg.id,
            stack: error.stack,
          });
          processedMessageIds.delete(msg.id);
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
      }));
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
  logger.info(`Starting Microsoft 365 Email Polling every ${intervalMs / 60000} minutes...`, {
    priorityHours: env.emailPriorityHours,
    maxPerPoll: env.emailMaxPerPoll,
    backlogDrainPerPoll: env.emailBacklogDrainPerPoll,
  });

  const runPoll = () => {
    pollEmails().catch((error) => {
      logger.error(`Unhandled email poll error: ${error.message}`, { stack: error.stack });
    });
  };

  runPoll();
  setInterval(runPoll, intervalMs);
}

/**
 * One-shot inbox backlog cleanup — marks old noise read so new customer mail is never starved.
 */
export async function drainEmailBacklog({ aggressive = true } = {}) {
  const client = getGraphClient();
  if (!client) throw new Error('Graph client not configured');

  let totalDrained = 0;
  let rounds = 0;
  const maxRounds = aggressive ? 20 : 1;

  while (rounds < maxRounds) {
    const result = await drainInboxBacklog(client, { aggressive });
    totalDrained += result.drained;
    rounds += 1;
    if (!result.remaining) break;
  }

  return { totalDrained, rounds, backlogDrainComplete };
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
    await markEmailAsRead(client, msg.id);
    trackProcessedMessage(msg.id);
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
  drainEmailBacklog,
  processInboundEmail,
  verifyGraphConnection,
  findInboxMessage,
  replyToSpecificEmail,
};
