import dotenv from 'dotenv';
dotenv.config();

/** Strip whitespace and wrapping quotes — common on Render env var paste. */
function sanitizeEnv(value) {
  if (value == null || typeof value !== 'string') return value;
  let cleaned = value.trim();
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"'))
    || (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  return cleaned;
}

/**
 * Centralised environment configuration.
 * Every external value the app needs is validated and exported from here.
 */
const env = {
  // Server
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: (process.env.NODE_ENV || 'development') === 'development',

  // OpenAI
  openaiApiKey: process.env.OPENAI_API_KEY,
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',

  // Gemini
  geminiApiKey: process.env.GEMINI_API_KEY,
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  geminiFallbackModel: process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.0-flash',

  // BaseLinker
  baselinkerToken: process.env.BASELINKER_API_TOKEN,
  baselinkerEndpoint: 'https://api.baselinker.com/connector.php',
  baselinkerInventoryId: process.env.BASELINKER_INVENTORY_ID
    ? parseInt(process.env.BASELINKER_INVENTORY_ID, 10)
    : null,

  // Zendesk
  zendeskSubdomain: process.env.ZENDESK_SUBDOMAIN,
  zendeskApiToken: process.env.ZENDESK_API_TOKEN,
  zendeskEmail: process.env.ZENDESK_EMAIL,

  // Sunshine Conversations (Zendesk Messaging)
  sunshineAppId: process.env.SUNSHINE_APP_ID || null,
  sunshineKeyId: process.env.SUNSHINE_KEY_ID || null,
  sunshineKeySecret: process.env.SUNSHINE_KEY_SECRET || null,
  zendeskWebhookSecret: process.env.ZENDESK_WEBHOOK_SECRET || null,

  // Microsoft 365 / Graph API
  msGraphTenantId: sanitizeEnv(process.env.MS_GRAPH_TENANT_ID),
  msGraphClientId: sanitizeEnv(process.env.MS_GRAPH_CLIENT_ID),
  msGraphClientSecret: sanitizeEnv(process.env.MS_GRAPH_CLIENT_SECRET),
  msGraphUserId: sanitizeEnv(process.env.MS_GRAPH_USER_ID),
  emailPollIntervalMs: 30000, // Force 30s polling, ignoring process.env.EMAIL_POLL_INTERVAL_MS
  emailLookbackHours: parseInt(process.env.EMAIL_LOOKBACK_HOURS || '72', 10),
  emailPriorityHours: parseInt(process.env.EMAIL_PRIORITY_HOURS || '48', 10),
  emailMaxPerPoll: parseInt(process.env.EMAIL_MAX_PER_POLL || '50', 10),
  emailBacklogDrainPerPoll: parseInt(process.env.EMAIL_BACKLOG_DRAIN_PER_POLL || '50', 10),
  // Set EMAIL_POLLING_ENABLED=true on Render to start inbox polling (requires Mail.ReadWrite).
  emailPollingEnabled: process.env.EMAIL_POLLING_ENABLED === 'true',
  emailAgentSignoffName: sanitizeEnv(process.env.EMAIL_AGENT_SIGNOFF_NAME) || 'The KopaDot Support Team',
  emailEscalatedFolderName: process.env.EMAIL_ESCALATED_FOLDER_NAME || 'Escalated',
  // Cheap model for ambiguous email triage only (Layer 3). Defaults to gpt-4o-mini.
  emailClassifierModel: process.env.EMAIL_CLASSIFIER_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
  emailClassifyPreviewChars: parseInt(process.env.EMAIL_CLASSIFY_PREVIEW_CHARS || '400', 10),

  // Store
  storeName: process.env.STORE_NAME || 'Our Store',
  storeCurrency: process.env.STORE_CURRENCY || 'EUR',
  storeTimezone: process.env.STORE_TIMEZONE || 'Europe/Dublin',

  // Session
  sessionTtlMinutes: parseInt(process.env.SESSION_TTL_MINUTES || '120', 10),
  maxConversationHistory: parseInt(process.env.MAX_CONVERSATION_HISTORY || '20', 10),

  // Safety
  maxToolCallsPerTurn: parseInt(process.env.MAX_TOOL_CALLS_PER_TURN || '10', 10),
  confidenceThreshold: parseFloat(process.env.CONFIDENCE_THRESHOLD || '0.7'),
};

/**
 * Validate that critical environment variables are set.
 * Warns in dev, throws in production.
 */
const required = ['openaiApiKey', 'baselinkerToken'];
for (const key of required) {
  if (!env[key]) {
    const msg = `Missing required environment variable for "${key}". Check your .env file.`;
    if (env.nodeEnv === 'production') throw new Error(msg);
    console.warn(`⚠️  ${msg}`);
  }
}

export default env;
