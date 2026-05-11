import express from 'express';
import crypto from 'crypto';
import axios from 'axios';
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
import { CHANNELS } from '../config/constants.js';
import env from '../config/env.js';

/**
 * Zendesk Messaging Channel — Sunshine Conversations webhook handler.
 *
 * This channel connects the KopaDot AI agent to the Zendesk Messaging
 * web widget (the chat bubble on your site). It works via:
 *
 *   1. Customer sends a message through the Zendesk widget
 *   2. Zendesk fires a webhook (conversation:message) to this endpoint
 *   3. We process the message through Gemini AI
 *   4. We reply back via the Sunshine Conversations API
 *   5. The reply appears in the customer's chat widget instantly
 *
 * Setup in Zendesk Admin Center:
 *   → Apps & integrations → Integrations → Conversations integrations
 *   → Create integration → Webhook URL = https://your-domain/zendesk/webhooks
 *   → Select trigger: conversation:message
 *   → Note the App ID, Key ID, Key Secret, and Webhook Secret
 */

const router = express.Router();

// ── Session mapping: Zendesk conversation ID → internal session ID ──
const conversationSessionMap = new Map();

/**
 * GET /zendesk/webhooks — Verification endpoint.
 * Zendesk sends HEAD/GET probes to verify the webhook URL is reachable
 * before activating the integration. Return 200 OK.
 */
router.get('/webhooks', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'kopadot-zendesk-webhook',
    message: 'Webhook endpoint is active. Send POST requests with Sunshine Conversations events.',
  });
});

/**
 * POST /zendesk/webhooks
 *
 * Receives webhook events from Zendesk Sunshine Conversations.
 * Handles conversation:message events — processes through AI and replies.
 */
router.post('/webhooks', async (req, res) => {
  // Respond immediately with 200 to avoid Zendesk timeout
  // Process asynchronously in the background
  res.status(200).json({ ok: true });

  try {
    const body = req.body;

    // Verify webhook signature if secret is configured
    if (env.zendeskWebhookSecret && req.headers['x-zendesk-webhook-signature']) {
      const isValid = verifyWebhookSignature(req);
      if (!isValid) {
        logger.warn('Zendesk webhook signature verification failed');
        return;
      }
    }

    // Handle different event types
    const events = body.events || [body];

    for (const event of events) {
      const eventType = event.type || body.type;

      switch (eventType) {
        case 'conversation:message':
          await handleConversationMessage(event, body);
          break;

        case 'conversation:create':
          logger.info('New Zendesk conversation created', {
            conversationId: event.payload?.conversation?.id,
          });
          break;

        case 'conversation:read':
        case 'conversation:typing':
          // Ignore read receipts and typing indicators
          break;

        default:
          logger.debug(`Unhandled Zendesk event type: ${eventType}`);
      }
    }
  } catch (error) {
    logger.error(`Zendesk webhook processing error: ${error.message}`, {
      stack: error.stack,
    });
  }
});

/**
 * Handle an incoming conversation:message event.
 * Extracts the message, processes through AI, and replies via API.
 */
async function handleConversationMessage(event, fullPayload) {
  const payload = event.payload || event;
  const message = payload.message || {};
  const conversation = payload.conversation || {};
  const conversationId = conversation.id || conversation._id;

  // Skip messages from the business (our own replies) to avoid loops
  const authorType = message.author?.type || message.role;
  if (authorType === 'business' || authorType === 'app') {
    logger.debug('Skipping business/app message (our own reply)');
    return;
  }

  // Extract message text
  const messageText = message.content?.text || message.text;
  if (!messageText || typeof messageText !== 'string' || messageText.trim().length === 0) {
    logger.debug('Skipping non-text or empty message from Zendesk');
    return;
  }

  // Extract customer info
  const author = message.author || {};
  const user = payload.user || author.user || {};
  const customerName = user.name || user.givenName || author.displayName || null;
  const customerEmail = user.email || null;

  logger.info(`Zendesk message received: "${messageText.slice(0, 100)}"`, {
    conversationId,
    customerName,
    authorType,
  });

  // Get or create internal session mapped to this Zendesk conversation
  let sessionId = conversationSessionMap.get(conversationId);
  if (!sessionId) {
    const session = getSession(null, { channel: CHANNELS.LIVE_CHAT });
    sessionId = session.id;
    conversationSessionMap.set(conversationId, sessionId);
    logger.info(`New Zendesk session created: ${sessionId} → conversation ${conversationId}`);
  }

  // Update customer identity if available
  if (customerName || customerEmail) {
    updateCustomerIdentity(sessionId, {
      name: customerName,
      email: customerEmail,
      source: 'zendesk_messaging',
    });
  }

  try {
    // Auto-escalation safety check
    const escalationCheck = shouldAutoEscalate(sessionId);
    if (escalationCheck.shouldEscalate) {
      await sendZendeskReply(
        conversationId,
        "It seems like we need a human touch here. I'm connecting you with a support agent who'll have the full context of our conversation. They'll be with you shortly! 🙋",
      );
      return;
    }

    // Process through Gemini AI engine
    const history = getHistory(sessionId);
    const result = await processMessage(messageText.trim(), history, {
      sessionId,
      channel: CHANNELS.LIVE_CHAT,
      customerIdentity: { name: customerName, email: customerEmail },
    });

    // Update session history
    addToHistory(sessionId, result.conversationUpdate);
    recordToolUsage(sessionId, result.toolsUsed.length);

    // Send AI response back to the Zendesk conversation
    await sendZendeskReply(conversationId, result.response);

    logger.info(`Zendesk reply sent`, {
      conversationId,
      sessionId,
      processingTimeMs: result.metadata.processingTimeMs,
      toolsUsed: result.toolsUsed.map(t => t.name),
    });
  } catch (error) {
    logger.error(`Failed to process Zendesk message: ${error.message}`, {
      conversationId,
      sessionId,
      stack: error.stack,
    });

    // Send a graceful error reply to the customer
    await sendZendeskReply(
      conversationId,
      "I'm sorry, I hit a temporary snag. Could you try sending your message again? If the issue persists, I'll connect you with a human agent.",
    );
  }
}

/**
 * Send a reply to a Zendesk Messaging conversation via Sunshine Conversations API.
 *
 * @param {string} conversationId - The Zendesk conversation ID.
 * @param {string} text - The reply text.
 */
async function sendZendeskReply(conversationId, text) {
  if (!env.sunshineAppId || !env.sunshineKeyId || !env.sunshineKeySecret) {
    logger.error('Sunshine Conversations API credentials not configured — cannot reply to Zendesk chat');
    logger.error('Set SUNSHINE_APP_ID, SUNSHINE_KEY_ID, and SUNSHINE_KEY_SECRET in .env');
    return;
  }

  const url = `https://${env.zendeskSubdomain}.zendesk.com/sc/v2/apps/${env.sunshineAppId}/conversations/${conversationId}/messages`;
  const auth = Buffer.from(`${env.sunshineKeyId}:${env.sunshineKeySecret}`).toString('base64');

  try {
    const response = await axios.post(
      url,
      {
        author: { type: 'business' },
        content: {
          type: 'text',
          text: text,
        },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${auth}`,
        },
        timeout: 15_000,
      },
    );

    logger.debug('Sunshine Conversations reply sent', {
      conversationId,
      messageId: response.data?.messages?.[0]?.id,
    });

    return response.data;
  } catch (error) {
    const status = error.response?.status;
    const errData = error.response?.data;

    logger.error(`Failed to send Zendesk reply: ${error.message}`, {
      status,
      conversationId,
      responseData: errData,
    });

    // Retry once on transient errors
    if (status === 429 || (status >= 500 && status < 600)) {
      logger.info('Retrying Zendesk reply in 2s...');
      await new Promise(r => setTimeout(r, 2000));
      try {
        await axios.post(
          url,
          {
            author: { type: 'business' },
            content: { type: 'text', text },
          },
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Basic ${auth}`,
            },
            timeout: 15_000,
          },
        );
        logger.info('Zendesk reply retry succeeded');
      } catch (retryErr) {
        logger.error(`Zendesk reply retry also failed: ${retryErr.message}`);
      }
    }
  }
}

/**
 * Verify the webhook signature from Zendesk.
 * Uses HMAC-SHA256 with the webhook shared secret.
 */
function verifyWebhookSignature(req) {
  try {
    const signature = req.headers['x-zendesk-webhook-signature'];
    const timestamp = req.headers['x-zendesk-webhook-signature-timestamp'];

    if (!signature || !timestamp) return false;

    const payload = timestamp + JSON.stringify(req.body);
    const expected = crypto
      .createHmac('sha256', env.zendeskWebhookSecret)
      .update(payload)
      .digest('base64');

    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch (error) {
    logger.warn(`Webhook signature verification error: ${error.message}`);
    return false;
  }
}

/**
 * Health/status endpoint for the Zendesk channel.
 */
router.get('/status', (req, res) => {
  const configured = !!(env.sunshineAppId && env.sunshineKeyId && env.sunshineKeySecret);
  res.json({
    channel: 'zendesk_messaging',
    configured,
    activeSessions: conversationSessionMap.size,
    credentials: {
      sunshineAppId: env.sunshineAppId ? '✅ Set' : '❌ Missing',
      sunshineKeyId: env.sunshineKeyId ? '✅ Set' : '❌ Missing',
      sunshineKeySecret: env.sunshineKeySecret ? '✅ Set (hidden)' : '❌ Missing',
      zendeskSubdomain: env.zendeskSubdomain || '❌ Missing',
      webhookSecret: env.zendeskWebhookSecret ? '✅ Set' : '⚠️ Not set (signature verification disabled)',
    },
  });
});

export default router;
