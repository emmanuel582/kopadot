import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import logger from '../middleware/logger.js';
import { processMessage } from '../agent/chatgptEngine.js';
import {
  getSession,
  addToHistory,
  getHistory,
  recordToolUsage,
  updateCustomerIdentity,
  destroySession,
} from '../agent/conversationMgr.js';
import { shouldAutoEscalate } from '../agent/escalation.js';
import { CHANNELS } from '../config/constants.js';

/**
 * Live Chat Channel — WebSocket handler.
 *
 * Provides real-time bidirectional communication for live chat widgets.
 * Features:
 *   - Automatic session creation on connect
 *   - Typing indicators
 *   - Reconnection support via session_id
 *   - Graceful error handling
 *
 * Protocol (JSON messages):
 *
 * Client → Server:
 *   { type: "message", text: "Where is my order?", session_id?: "abc" }
 *   { type: "typing", isTyping: true }
 *   { type: "reconnect", session_id: "abc" }
 *
 * Server → Client:
 *   { type: "welcome", session_id: "abc" }
 *   { type: "typing", isTyping: true }
 *   { type: "message", text: "...", metadata: {...} }
 *   { type: "error", message: "..." }
 */

/**
 * Attach the WebSocket server to an existing HTTP server.
 * @param {http.Server} server - The HTTP server instance.
 */
export function attachLiveChat(server) {
  const wss = new WebSocketServer({
    server,
    path: '/ws/chat',
    maxPayload: 16 * 1024, // 16KB max message size
  });

  logger.info('Live chat WebSocket server attached at /ws/chat');

  wss.on('connection', (ws, req) => {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    let sessionId = null;

    logger.info(`WebSocket client connected from ${clientIp}`);

    // ── Connection Setup ──────────────────────────────────────────
    ws.isAlive = true;

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    // Send welcome message with new session
    sessionId = uuidv4();
    const session = getSession(sessionId, { channel: CHANNELS.LIVE_CHAT });

    sendJson(ws, {
      type: 'welcome',
      session_id: session.id,
      message: 'Connected to KopaDot support. How can I help you today?',
    });

    // ── Message Handler ───────────────────────────────────────────
    ws.on('message', async (rawData) => {
      let data;

      try {
        data = JSON.parse(rawData.toString());
      } catch {
        sendJson(ws, { type: 'error', message: 'Invalid JSON format.' });
        return;
      }

      // Handle different message types
      switch (data.type) {
        case 'message':
          await handleChatMessage(ws, data, sessionId);
          break;

        case 'typing':
          // Client typing indicator — just acknowledge
          break;

        case 'reconnect':
          if (data.session_id) {
            sessionId = data.session_id;
            const existingSession = getSession(sessionId);
            sendJson(ws, {
              type: 'reconnected',
              session_id: sessionId,
              message: 'Welcome back! I remember our conversation. How can I continue helping you?',
            });
          }
          break;

        case 'end':
          sendJson(ws, {
            type: 'ended',
            message: 'Chat ended. Thank you for contacting us!',
          });
          break;

        default:
          sendJson(ws, { type: 'error', message: `Unknown message type: "${data.type}"` });
      }
    });

    // ── Disconnect Handler ────────────────────────────────────────
    ws.on('close', (code, reason) => {
      logger.info(`WebSocket client disconnected: ${code}`, {
        sessionId,
        reason: reason?.toString(),
      });
    });

    ws.on('error', (error) => {
      logger.error(`WebSocket error: ${error.message}`, { sessionId });
    });
  });

  // ── Heartbeat — detect dead connections ─────────────────────────
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        logger.debug('Terminating dead WebSocket connection');
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30_000);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  return wss;
}

/**
 * Handle an incoming chat message through the AI pipeline.
 */
async function handleChatMessage(ws, data, sessionId) {
  const { text, customer } = data;

  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    sendJson(ws, { type: 'error', message: 'Empty message.' });
    return;
  }

  if (text.length > 5000) {
    sendJson(ws, { type: 'error', message: 'Message too long. Maximum 5000 characters.' });
    return;
  }

  // Use provided session_id or the connection's session
  const activeSessionId = data.session_id || sessionId;

  try {
    // Update customer identity if provided
    if (customer) {
      updateCustomerIdentity(activeSessionId, customer);
    }

    // Auto-escalation check
    const escalationCheck = shouldAutoEscalate(activeSessionId);
    if (escalationCheck.shouldEscalate) {
      sendJson(ws, {
        type: 'message',
        text: "It seems like we need a human touch on this one. Let me connect you with a support agent who can help. They'll have the full context of our conversation.",
        escalated: true,
      });
      return;
    }

    // Send typing indicator
    sendJson(ws, { type: 'typing', isTyping: true });

    // Process through AI
    const history = getHistory(activeSessionId);
    const result = await processMessage(text.trim(), history, {
      sessionId: activeSessionId,
      channel: CHANNELS.LIVE_CHAT,
    });

    // Update session
    addToHistory(activeSessionId, result.conversationUpdate);
    recordToolUsage(activeSessionId, result.toolsUsed.length);

    // Stop typing indicator and send response
    sendJson(ws, { type: 'typing', isTyping: false });

    sendJson(ws, {
      type: 'message',
      text: result.response,
      session_id: activeSessionId,
      metadata: {
        processing_time_ms: result.metadata.processingTimeMs,
        tools_used: result.toolsUsed.map(t => t.name),
      },
    });
  } catch (error) {
    logger.error(`Live chat processing error: ${error.message}`, { sessionId: activeSessionId });

    sendJson(ws, { type: 'typing', isTyping: false });
    sendJson(ws, {
      type: 'message',
      text: "I'm sorry, I encountered a temporary issue. Could you try sending your message again?",
      error: true,
    });
  }
}

/**
 * Safely send a JSON message to a WebSocket client.
 */
function sendJson(ws, data) {
  if (ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify(data));
    } catch (error) {
      logger.error(`Failed to send WebSocket message: ${error.message}`);
    }
  }
}

export default { attachLiveChat };
