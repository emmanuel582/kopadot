import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import env from '../config/env.js';
import logger from '../middleware/logger.js';

/**
 * Conversation Manager — handles session memory & multi-turn context.
 *
 * In-memory session store with TTL expiration.
 * Each session tracks:
 *   - Conversation history (in Gemini's content format)
 *   - Customer identity (extracted by AI, not regex)
 *   - Session metadata (channel, timestamps, tool usage)
 *
 * For production, swap this with Redis for persistence across restarts.
 */

// ── Session Store ───────────────────────────────────────────────────
const DATA_DIR = path.join(process.cwd(), '.data');
const DATA_FILE = path.join(DATA_DIR, 'sessions.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let sessions = new Map();

// Load sessions from disk on startup
try {
  if (fs.existsSync(DATA_FILE)) {
    const data = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(data);
    sessions = new Map(parsed);
    logger.info(`Loaded ${sessions.size} persistent sessions from disk.`);
  }
} catch (error) {
  logger.error(`Failed to load persistent sessions: ${error.message}`);
}

function saveSessions() {
  try {
    const data = JSON.stringify([...sessions.entries()]);
    fs.writeFileSync(DATA_FILE, data, 'utf8');
  } catch (error) {
    logger.error(`Failed to save sessions to disk: ${error.message}`);
  }
}

const SESSION_TTL_MS = env.sessionTtlMinutes * 60 * 1000;
const MAX_HISTORY = env.maxConversationHistory;

// Clean up expired sessions every 5 minutes
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      sessions.delete(id);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    saveSessions();
    logger.debug(`Cleaned up ${cleaned} expired session(s). Active: ${sessions.size}`);
  }
}, 5 * 60 * 1000);

cleanupInterval.unref();

// ── Session Interface ───────────────────────────────────────────────

/**
 * Get or create a session.
 * @param {string} sessionId - Unique session identifier. If null, generates one.
 * @param {object} options - Optional session creation options.
 * @returns {object} The session object.
 */
export function getSession(sessionId, options = {}) {
  // Generate a session ID if none provided
  const id = sessionId || uuidv4();

  if (sessions.has(id)) {
    const session = sessions.get(id);
    session.lastActivity = Date.now();
    return session;
  }

  // Create new session
  const session = {
    id,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    channel: options.channel || 'api',
    conversationHistory: [],
    customerIdentity: {
      verified: false,
      name: null,
      email: null,
      phone: null,
    },
    metadata: {
      messageCount: 0,
      toolCallsTotal: 0,
      escalated: false,
      pausedUntil: 0,
    },
  };

  sessions.set(id, session);
  saveSessions();
  logger.info(`New session created: ${id}`, { channel: session.channel });

  return session;
}

/**
 * Add messages to the conversation history.
 * Automatically trims to MAX_HISTORY to stay within token limits.
 *
 * @param {string} sessionId - Session identifier.
 * @param {Array} newEntries - New conversation entries in Gemini format.
 */
export function addToHistory(sessionId, newEntries) {
  const session = getSession(sessionId);

  session.conversationHistory.push(...newEntries);
  session.metadata.messageCount += newEntries.filter(e => e.role === 'user').length;
  session.lastActivity = Date.now();

  // Trim history if it exceeds the limit
  // Keep the oldest message for context, then the most recent ones
  if (session.conversationHistory.length > MAX_HISTORY * 2) {
    const excess = session.conversationHistory.length - MAX_HISTORY * 2;
    session.conversationHistory = session.conversationHistory.slice(excess);
    logger.debug(`Trimmed conversation history for session ${sessionId}, removed ${excess} entries`);
  }
  
  saveSessions();
}

/**
 * Get the conversation history for a session.
 * @param {string} sessionId - Session identifier.
 * @returns {Array} Conversation history in Gemini format.
 */
export function getHistory(sessionId) {
  const session = getSession(sessionId);
  return session.conversationHistory;
}

/**
 * Update the customer identity for a session.
 * Called when the AI extracts customer details from the conversation.
 *
 * @param {string} sessionId - Session identifier.
 * @param {object} identity - Customer identity fields to update.
 */
export function updateCustomerIdentity(sessionId, identity) {
  const session = getSession(sessionId);

  if (identity.name) session.customerIdentity.name = identity.name;
  if (identity.email) session.customerIdentity.email = identity.email;
  if (identity.phone) session.customerIdentity.phone = identity.phone;

  // Consider verified if we have at least email or phone
  if (session.customerIdentity.email || session.customerIdentity.phone) {
    session.customerIdentity.verified = true;
  }

  logger.debug(`Customer identity updated for session ${sessionId}`, {
    verified: session.customerIdentity.verified,
  });
  saveSessions();
}

/**
 * Record tool usage in the session metadata.
 * @param {string} sessionId - Session identifier.
 * @param {number} count - Number of tools called this turn.
 */
export function recordToolUsage(sessionId, count) {
  const session = getSession(sessionId);
  session.metadata.toolCallsTotal += count;
  saveSessions();
}

/**
 * Mark a session as escalated.
 * @param {string} sessionId - Session identifier.
 */
export function markEscalated(sessionId) {
  const session = getSession(sessionId);
  session.metadata.escalated = true;
  saveSessions();
  logger.info(`Session ${sessionId} marked as escalated`);
}

/**
 * Get session summary (for monitoring / debugging).
 * @param {string} sessionId - Session identifier.
 * @returns {object} Session summary.
 */
export function getSessionSummary(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;

  return {
    id: session.id,
    channel: session.channel,
    createdAt: new Date(session.createdAt).toISOString(),
    lastActivity: new Date(session.lastActivity).toISOString(),
    durationMinutes: Math.round((session.lastActivity - session.createdAt) / 60000),
    messageCount: session.metadata.messageCount,
    toolCallsTotal: session.metadata.toolCallsTotal,
    escalated: session.metadata.escalated,
    customerVerified: session.customerIdentity.verified,
    historyLength: session.conversationHistory.length,
  };
}

/**
 * Destroy a session explicitly.
 * @param {string} sessionId - Session identifier.
 */
export function destroySession(sessionId) {
  const had = sessions.delete(sessionId);
  if (had) {
    saveSessions();
    logger.info(`Session destroyed: ${sessionId}`);
  }
  return had;
}

/**
 * Pause a session to stop AI from responding, typically when a human takes over.
 * @param {string} sessionId - Session identifier.
 * @param {number} hours - Number of hours to pause the session.
 */
export function pauseSession(sessionId, hours) {
  const session = getSession(sessionId);
  session.metadata.pausedUntil = Date.now() + hours * 60 * 60 * 1000;
  saveSessions();
  logger.info(`Session ${sessionId} paused for ${hours} hours`);
}

/**
 * Check if a session is currently paused.
 * @param {string} sessionId - Session identifier.
 * @returns {boolean} True if the session is paused.
 */
export function isSessionPaused(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || !session.metadata.pausedUntil) return false;
  return Date.now() < session.metadata.pausedUntil;
}

/**
 * Get counts for monitoring.
 * @returns {object} Active session stats.
 */
export function getSessionStats() {
  return {
    activeSessions: sessions.size,
    escalatedSessions: [...sessions.values()].filter(s => s.metadata.escalated).length,
    totalMessages: [...sessions.values()].reduce((sum, s) => sum + s.metadata.messageCount, 0),
  };
}

export default {
  getSession,
  addToHistory,
  getHistory,
  updateCustomerIdentity,
  recordToolUsage,
  markEscalated,
  getSessionSummary,
  destroySession,
  pauseSession,
  isSessionPaused,
  getSessionStats,
};
