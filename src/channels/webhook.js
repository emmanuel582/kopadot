import express from 'express';
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
import { CHANNELS } from '../config/constants.js';

/**
 * Webhook Channel Handler
 *
 * REST API endpoint for receiving customer messages from any channel.
 * This is the primary integration point — external systems (CRMs, chat widgets,
 * email processors) POST messages here and get AI responses back.
 */

const router = express.Router();

/**
 * POST /api/chat
 *
 * Main chat endpoint. Receives a customer message, processes it through
 * the full Gemini AI pipeline, and returns the response.
 *
 * Body:
 *   - message (string, required): The customer's message
 *   - session_id (string, optional): Session ID for multi-turn conversations
 *   - channel (string, optional): Channel type (live_chat, email, whatsapp, webhook, api)
 *   - customer (object, optional): Pre-known customer info { name, email, phone }
 *
 * Response:
 *   - response (string): The AI's response text
 *   - session_id (string): Session ID for follow-up messages
 *   - metadata (object): Processing details
 */
router.post('/chat', async (req, res) => {
  const { message, session_id, channel, customer } = req.body;

  // ── Validate Input ──────────────────────────────────────────────
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({
      error: 'Missing or empty "message" field.',
      hint: 'Send a POST with { "message": "your question here" }',
    });
  }

  if (message.length > 5000) {
    return res.status(400).json({
      error: 'Message too long. Maximum 5000 characters.',
    });
  }

  try {
    // ── Session Setup ───────────────────────────────────────────
    const session = getSession(session_id, {
      channel: channel || CHANNELS.API,
    });

    // If customer info is provided, update identity
    if (customer) {
      updateCustomerIdentity(session.id, customer);
    }

    // ── Auto-Escalation Safety Check ────────────────────────────
    const escalationCheck = shouldAutoEscalate(session.id);
    if (escalationCheck.shouldEscalate) {
      return res.json({
        response: "It seems we've been going back and forth for a while. Let me connect you with a human agent who can help resolve this more efficiently. One moment please.",
        session_id: session.id,
        escalated: true,
        reason: escalationCheck.reason,
      });
    }

    // ── Process Through AI Engine ───────────────────────────────
    const conversationHistory = getHistory(session.id);

    const result = await processMessage(
      message.trim(),
      conversationHistory,
      {
        sessionId: session.id,
        channel: session.channel,
        customerIdentity: session.customerIdentity,
      },
    );

    // ── Update Session ──────────────────────────────────────────
    addToHistory(session.id, result.conversationUpdate);
    recordToolUsage(session.id, result.toolsUsed.length);

    // ── Format Response for Channel ─────────────────────────────
    const formatted = formatResponse(
      result.response,
      session.channel,
      {
        quickReplies: generateQuickReplies(result),
      },
    );

    // ── Return Response ─────────────────────────────────────────
    res.json({
      ...formatted,
      session_id: session.id,
      metadata: {
        processing_time_ms: result.metadata.processingTimeMs,
        tools_used: result.toolsUsed.map(t => t.name),
        tools_used_details: result.toolsUsed,
        model: result.metadata.model,
      },
    });

  } catch (error) {
    logger.error(`Webhook handler error: ${error.message}`, { stack: error.stack });

    res.status(500).json({
      error: 'Internal server error. Please try again.',
      message: "I'm sorry, something went wrong on our end. Please try again in a moment.",
    });
  }
});

/**
 * POST /api/chat/stream (future: SSE streaming)
 * Placeholder for streaming responses.
 */
router.post('/chat/stream', async (req, res) => {
  res.status(501).json({
    error: 'Streaming is not yet implemented. Use /api/chat for now.',
  });
});

/**
 * Generate contextual quick reply suggestions based on the AI's response.
 * These are hints for chat UIs — not hardcoded, but contextually derived.
 */
function generateQuickReplies(result) {
  const replies = [];

  // If tools were used, suggest relevant follow-ups
  const toolNames = result.toolsUsed.map(t => t.name);

  if (toolNames.includes('lookupOrderById') || toolNames.includes('lookupOrderByEmail')) {
    replies.push('Track my shipment', 'Request a return', 'Get my invoice');
  } else if (toolNames.includes('trackShipment')) {
    replies.push('When will it arrive?', 'I have a problem with delivery');
  } else if (toolNames.includes('searchKnowledgeBase')) {
    replies.push('I have another question', 'Talk to a human');
  }

  if (replies.length === 0) {
    replies.push('Check my order', 'Talk to support');
  }

  return replies.slice(0, 3); // Max 3 quick replies
}

export default router;
