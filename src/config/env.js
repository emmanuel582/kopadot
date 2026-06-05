import dotenv from 'dotenv';
dotenv.config();

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
  msGraphTenantId: process.env.MS_GRAPH_TENANT_ID,
  msGraphClientId: process.env.MS_GRAPH_CLIENT_ID,
  msGraphClientSecret: process.env.MS_GRAPH_CLIENT_SECRET,
  msGraphUserId: process.env.MS_GRAPH_USER_ID,
  emailPollIntervalMs: parseInt(process.env.EMAIL_POLL_INTERVAL_MS || '180000', 10),

  // Store
  storeName: process.env.STORE_NAME || 'Our Store',
  storeCurrency: process.env.STORE_CURRENCY || 'EUR',
  storeTimezone: process.env.STORE_TIMEZONE || 'Europe/Dublin',

  // Session
  sessionTtlMinutes: parseInt(process.env.SESSION_TTL_MINUTES || '120', 10),
  maxConversationHistory: parseInt(process.env.MAX_CONVERSATION_HISTORY || '20', 10),

  // Safety
  maxToolCallsPerTurn: parseInt(process.env.MAX_TOOL_CALLS_PER_TURN || '5', 10),
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
