/**
 * Application-wide constants — intent taxonomy, status maps, limits.
 */

// ── Customer Intent Taxonomy ────────────────────────────────────────
export const INTENTS = {
  ORDER_STATUS: 'order_status',
  RETURN_REQUEST: 'return_request',
  REFUND_STATUS: 'refund_status',
  PRODUCT_INQUIRY: 'product_inquiry',
  SHIPPING_INFO: 'shipping_info',
  PAYMENT_ISSUE: 'payment_issue',
  CANCEL_ORDER: 'cancel_order',
  INVOICE_REQUEST: 'invoice_request',
  PRODUCT_COMPLAINT: 'product_complaint',
  POLICY_QUESTION: 'policy_question',
  ACCOUNT_HELP: 'account_help',
  GENERAL_FAQ: 'general_faq',
  ESCALATE_HUMAN: 'escalate_human',
};

// ── Intent Priority Levels ───────────────────────────────────
export const PRIORITY = {
  IMMEDIATE: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

export const INTENT_PRIORITY = {
  [INTENTS.ESCALATE_HUMAN]: PRIORITY.IMMEDIATE,
  [INTENTS.ORDER_STATUS]: PRIORITY.HIGH,
  [INTENTS.RETURN_REQUEST]: PRIORITY.HIGH,
  [INTENTS.REFUND_STATUS]: PRIORITY.HIGH,
  [INTENTS.PAYMENT_ISSUE]: PRIORITY.HIGH,
  [INTENTS.CANCEL_ORDER]: PRIORITY.HIGH,
  [INTENTS.PRODUCT_COMPLAINT]: PRIORITY.HIGH,
  [INTENTS.PRODUCT_INQUIRY]: PRIORITY.MEDIUM,
  [INTENTS.SHIPPING_INFO]: PRIORITY.MEDIUM,
  [INTENTS.ACCOUNT_HELP]: PRIORITY.MEDIUM,
  [INTENTS.INVOICE_REQUEST]: PRIORITY.LOW,
  [INTENTS.POLICY_QUESTION]: PRIORITY.LOW,
  [INTENTS.GENERAL_FAQ]: PRIORITY.LOW,
};

// ── BaseLinker Tracking Status Codes ────────────────────────────────
export const TRACKING_STATUS = {
  1: 'Label created',
  2: 'Shipped',
  3: 'In transit',
  4: 'Out for delivery',
  5: 'Delivered',
  6: 'Return to sender',
  7: 'Exception / Problem',
};

// ── Conversation Roles ──────────────────────────────────────────────
export const ROLES = {
  USER: 'user',
  MODEL: 'model',
  SYSTEM: 'system',
  FUNCTION: 'function',
};

// ── Channel Types ───────────────────────────────────────────────────
export const CHANNELS = {
  LIVE_CHAT: 'live_chat',
  EMAIL: 'email',
  WHATSAPP: 'whatsapp',
  WEBHOOK: 'webhook',
  API: 'api',
};

// ── Rate Limits ─────────────────────────────────────────────────────
export const RATE_LIMITS = {
  BASELINKER_RPM: 90,   // 100 official, 90 for safety margin
  CUSTOMER_RPM: 30,   // per-customer rate limit
  ZENDESK_RPM: 200,
  ZOHO_RPM: 100,
};

// ── Cache TTLs (milliseconds) ───────────────────────────────────────
export const CACHE_TTL = {
  ORDER_STATUS_LIST: 15 * 60 * 1000,   // 15 minutes
  COURIER_LIST: 15 * 60 * 1000,
  KB_ARTICLES: 60 * 60 * 1000,   // 1 hour
  PRODUCT_DATA: 5 * 60 * 1000,   // 5 minutes
};
