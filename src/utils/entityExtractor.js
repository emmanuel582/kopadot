import logger from '../middleware/logger.js';

/**
 * Entity Extractor — AI-Powered
 *
 * This module is now a THIN WRAPPER. All entity extraction is handled
 * dynamically by the ChatGPT AI engine (chatgptEngine.js).
 *
 * Why no regex?
 *   - Regex patterns are brittle and miss edge cases
 *   - AI understands context ("my order is twelve thirty four" → 1234)
 *   - AI handles typos, abbreviations, and natural language variations
 *   - AI extracts intent + sentiment + urgency alongside entities
 *
 * The main extractEntitiesWithAI() function lives in chatgptEngine.js
 * and uses a focused Gemini call to extract structured entities.
 *
 * This file exports a lightweight helper that the webhook/chat handlers
 * can use for quick pre-processing. The heavy lifting is in the AI engine.
 */

/**
 * Pre-process a message to provide optional hints to the AI engine.
 *
 * This does NOT use regex for detection. It simply normalises the message
 * and passes it through. The actual entity extraction is done by Gemini.
 *
 * @param {string} message - Raw customer message text.
 * @returns {object} Normalised message data.
 */
export function preprocessMessage(message) {
  if (!message || typeof message !== 'string') {
    return { original: '', normalised: '', length: 0 };
  }

  const normalised = message.trim();

  return {
    original: message,
    normalised,
    length: normalised.length,
    isEmpty: normalised.length === 0,
    // Language hint (basic detection — the AI does the real analysis)
    isLikelyNonEnglish: hasNonLatinCharacters(normalised),
  };
}

/**
 * Check if a string contains significant non-Latin characters.
 * This is just a hint for the AI — not a language detector.
 */
function hasNonLatinCharacters(text) {
  const nonLatinRatio = (text.match(/[^\u0000-\u024F\s.,!?@#$%&*()_+-=:;"'<>]/g) || []).length / text.length;
  return nonLatinRatio > 0.3;
}

/**
 * Build entity context string for the AI prompt.
 *
 * Since the AI handles all entity extraction natively through function calling,
 * this function now simply passes the message through without modification.
 * The ChatGPT engine's system prompt instructs it to identify entities dynamically.
 *
 * @param {object} entities - Any pre-extracted entities (from AI pre-processing).
 * @returns {string} Context string (empty if no pre-extracted entities).
 */
export function buildEntityContext(entities) {
  if (!entities || Object.keys(entities).length === 0) return '';

  const parts = [];

  // These come from the AI entity extraction (chatgptEngine.extractEntitiesWithAI)
  if (entities.order_ids?.length) {
    parts.push(`[AI detected order ID(s): ${entities.order_ids.join(', ')}]`);
  }
  if (entities.emails?.length) {
    parts.push(`[AI detected email(s): ${entities.emails.join(', ')}]`);
  }
  if (entities.phones?.length) {
    parts.push(`[AI detected phone(s): ${entities.phones.join(', ')}]`);
  }
  if (entities.product_names?.length) {
    parts.push(`[AI detected product(s): ${entities.product_names.join(', ')}]`);
  }
  if (entities.intent_hint) {
    parts.push(`[AI intent hint: ${entities.intent_hint}]`);
  }
  if (entities.sentiment) {
    parts.push(`[AI sentiment: ${entities.sentiment}]`);
  }

  const context = parts.length > 0 ? parts.join(' ') : '';
  if (context) {
    logger.debug('AI entity context built', { context });
  }

  return context;
}

export default { preprocessMessage, buildEntityContext };
