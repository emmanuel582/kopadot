import { CHANNELS } from '../config/constants.js';

/**
 * Response Formatter — adapts the AI's raw text response
 * for different output channels (chat, email, WhatsApp, etc.).
 */

/**
 * Format a response for the given channel.
 * @param {string} text - Raw AI response text.
 * @param {string} channel - One of CHANNELS values.
 * @param {object} metadata - Extra data (e.g. attachments, quick replies).
 * @returns {object} Formatted response payload.
 */
export function formatResponse(text, channel = CHANNELS.API, metadata = {}) {
  switch (channel) {
    case CHANNELS.LIVE_CHAT:
      return formatForLiveChat(text, metadata);
    case CHANNELS.EMAIL:
      return formatForEmail(text, metadata);
    case CHANNELS.WHATSAPP:
      return formatForWhatsApp(text, metadata);
    default:
      return formatForApi(text, metadata);
  }
}

/**
 * API / Webhook — clean JSON response.
 */
function formatForApi(text, metadata) {
  return {
    type: 'text',
    message: text.trim(),
    timestamp: new Date().toISOString(),
    ...metadata,
  };
}

/**
 * Live Chat — split long responses into digestible chunks,
 * add quick reply suggestions where appropriate.
 */
function formatForLiveChat(text, metadata) {
  const chunks = splitIntoChunks(text, 500);

  return {
    type: 'chat',
    messages: chunks.map(chunk => ({
      text: chunk.trim(),
      timestamp: new Date().toISOString(),
    })),
    quickReplies: metadata.quickReplies || [],
    typing: false,
  };
}

/**
 * Email — professional HTML structure with optional personalization.
 */
function formatForEmail(text, metadata) {
  const cleaned = stripMarkdown(text).trim();
  const paragraphs = cleaned
    .split('\n\n')
    .map((p) => p.trim())
    .filter(Boolean);

  const hasGreeting = /^(dear|hi|hello|good (morning|afternoon|evening))/i.test(paragraphs[0] || '');
  const hasSignOff = /(kind regards|best regards|warm regards|sincerely|thank you)/i.test(
    paragraphs[paragraphs.length - 1] || '',
  );

  const greeting = !hasGreeting && metadata.customerName
    ? `<p style="margin: 0 0 16px;">Dear ${escapeHtml(metadata.customerName)},</p>`
    : '';

  const bodyHtml = paragraphs
    .map((p) => `<p style="margin: 0 0 16px; line-height: 1.6; color: #333;">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');

  const signOff = !hasSignOff
    ? `<p style="margin: 24px 0 0; line-height: 1.6; color: #333;">Kind regards,<br><strong>${escapeHtml(metadata.storeName || 'Customer Support Team')}</strong></p>`
    : '';

  return {
    type: 'email',
    subject: metadata.subject || 'Re: Your inquiry',
    html: `
      <div style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
        <div style="background: #ffffff; border: 1px solid #e8e8e8; border-radius: 8px; padding: 28px;">
          ${greeting}
          ${bodyHtml}
          ${signOff}
        </div>
        <p style="color: #888; font-size: 12px; margin-top: 16px; line-height: 1.5;">
          If you need further assistance, simply reply to this email and our team will be happy to help.
        </p>
      </div>`,
    plain: cleaned,
    timestamp: new Date().toISOString(),
  };
}

function stripMarkdown(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/^[-*]\s+/gm, '')
    .replace(/^#{1,6}\s+/gm, '');
}

/**
 * WhatsApp — respect character limits and formatting rules.
 */
function formatForWhatsApp(text, metadata) {
  // WhatsApp has a 4096 character limit per message
  const chunks = splitIntoChunks(text, 4000);

  return {
    type: 'whatsapp',
    messages: chunks.map(chunk => ({
      text: chunk.trim(),
    })),
    timestamp: new Date().toISOString(),
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Split text into chunks at sentence boundaries.
 */
function splitIntoChunks(text, maxLength) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('. ', maxLength);
    if (splitAt === -1 || splitAt < maxLength * 0.5) {
      splitAt = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitAt === -1) splitAt = maxLength;

    chunks.push(remaining.slice(0, splitAt + 1));
    remaining = remaining.slice(splitAt + 1).trimStart();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * Escape HTML special characters.
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Redact PII from text for logging.
 */
export function redactPII(text) {
  if (!text) return text;
  return text
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL]')
    .replace(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g, '[PHONE]')
    .replace(/\b\d{13,19}\b/g, '[CARD]');
}

export default { formatResponse, redactPII };
