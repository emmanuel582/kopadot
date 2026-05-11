import logger from '../middleware/logger.js';
import { markEscalated, getSession } from './conversationMgr.js';

/**
 * Escalation Module — handles human handoff decisions.
 *
 * This module does NOT use regex or static rules to detect escalation.
 * The AI engine (Gemini) decides when to escalate via its own reasoning
 * and calls the `createEscalationTicket` tool.
 *
 * This module provides:
 *  - Post-escalation session handling
 *  - Escalation metadata enrichment
 *  - Webhook notifications to external systems
 */

/**
 * Handle an escalation event after the AI has decided to escalate.
 * Called after the `createEscalationTicket` tool succeeds.
 *
 * @param {string} sessionId - The session being escalated.
 * @param {object} ticketData - Data from the escalation ticket creation.
 * @returns {object} Escalation result with handoff instructions.
 */
export function handleEscalation(sessionId, ticketData) {
  const session = getSession(sessionId);

  // Mark session as escalated
  markEscalated(sessionId);

  const escalationRecord = {
    sessionId,
    ticketId: ticketData.ticket_id || null,
    timestamp: new Date().toISOString(),
    customerIdentity: session.customerIdentity,
    channel: session.channel,
    messageCount: session.metadata.messageCount,
    toolCallsTotal: session.metadata.toolCallsTotal,
    conversationSummary: buildConversationSummary(session),
  };

  logger.info('Escalation handled', {
    sessionId,
    ticketId: escalationRecord.ticketId,
    messageCount: escalationRecord.messageCount,
  });

  return escalationRecord;
}

/**
 * Build a text summary of the conversation for the human agent.
 * Extracts key points from the conversation history.
 */
function buildConversationSummary(session) {
  const history = session.conversationHistory || [];

  const messages = history
    .filter(entry => entry.parts?.some(p => p.text))
    .map(entry => {
      const role = entry.role === 'user' ? 'Customer' : 'AI Agent';
      const text = entry.parts.filter(p => p.text).map(p => p.text).join(' ');
      return `${role}: ${text}`;
    });

  return messages.join('\n---\n');
}

/**
 * Check if a session should be auto-escalated based on
 * session metrics (not message content — the AI handles that).
 *
 * This is a safety net, not the primary escalation mechanism.
 */
export function shouldAutoEscalate(sessionId) {
  const session = getSession(sessionId);

  // Auto-escalate if conversation is very long without resolution
  if (session.metadata.messageCount > 15) {
    logger.info(`Auto-escalation triggered for session ${sessionId}: too many messages (${session.metadata.messageCount})`);
    return {
      shouldEscalate: true,
      reason: 'Conversation exceeded 15 messages without resolution',
    };
  }

  // Auto-escalate if too many tool calls (indicates confusion/loops)
  if (session.metadata.toolCallsTotal > 20) {
    logger.info(`Auto-escalation triggered for session ${sessionId}: too many tool calls (${session.metadata.toolCallsTotal})`);
    return {
      shouldEscalate: true,
      reason: 'Excessive tool usage indicates complex unresolved issue',
    };
  }

  return { shouldEscalate: false };
}

export default { handleEscalation, shouldAutoEscalate };
