import OpenAI from 'openai';
import env from '../config/env.js';
import logger from '../middleware/logger.js';

const openai = new OpenAI({ apiKey: env.openaiApiKey });

/** Layer 1 — instant skip (zero token cost). */
const AUTOMATED_SENDER_PATTERNS = [
  /no[-_.]?reply/i,
  /donotreply/i,
  /do[-_.]?not[-_.]?reply/i,
  /mailer-daemon/i,
  /postmaster@/i,
  /bounce@/i,
  /notifications?@/i,
  /alerts?@/i,
  /newsletter@/i,
  /marketing@/i,
  /promo(tions?)?@/i,
  /seller@/i,
  /orders?@.*temu/i,
  /@messaging\.ebay/i,
  /vendor@/i,
  /@sell\.amazon/i,
  /@agl\.amazon\.com/i,
  /payments?@/i,
  /billing@/i,
  /tracking@/i,
  /tracking-reply@/i,
  /shipment id:/i,
  /account linking/i,
  /new information required/i,
];

const INTERNAL_NOTIFICATION_PATTERNS = [
  /^\[KopaDot\]/i,
  /ticket\s*\(#\d+\)\s*by/i,
  /has been received\.\s*It is unassigned/i,
  /clearance notification/i,
  /\boperator(s)?\b/i,
];

const PLATFORM_SENDER_DOMAINS = [
  '@amazon.',
  '@ebay.',
  '@zendesk.com',
  '@parcelpanel',
  '@ingrammicro',
  '@marketplace.',
  '@google.com',
  '@facebookmail.com',
  '@walmart.com',
  '@comms.walmart.com',
  '@sellercentral',
  '@messaging.ebay',
  '@temu',
  '@temuemail',
  '@orders.temu',
  '@roblox.com',
  '@mirakl.net',
  '@notification.mirakl',
  '@shipping.temuemail',
  '@paypal.com',
  '@stripe.com',
  '@klarna.com',
  '@clearpay.co.uk',
  '@dpd.co.uk',
  '@royalmail.com',
  '@evri.com',
  '@myhermes.co.uk',
  '@ups.com',
  '@fedex.com',
  '@dhl.com',
  '@shop.tiktok.com',
];

const SECURITY_NOTIFICATION_SUBJECT_PATTERNS = [
  /2[- ]step verification/i,
  /password reset/i,
  /authenticator (app|activated|enabled)/i,
  /security alert/i,
  /verify your (email|account)/i,
];

const VENDOR_SUBJECT_PATTERNS = [
  /pricelist/i,
  /price\s*list/i,
  /\bdistributor\b/i,
  /trade account/i,
  /mobile accessories distributor/i,
  /wkd distribution/i,
];

const MARKETING_SENDER_PATTERNS = [
  /@comms\./i,
  /marketplace@/i,
  /@sell\.amazon/i,
  /noreply@/i,
  /@mail\.(chimp|gun|jet)/i,
  /@sendgrid\./i,
  /@emails\./i,
  /@e\./i,
  /@mcsv\./i,
  /@mktomail\./i,
  /@hs-\d+\./i,
  /@hubspot/i,
];

const ESP_SENDER_DOMAINS = [
  'sendgrid.net',
  'mailchimp.com',
  'mandrillapp.com',
  'sparkpostmail.com',
  'mailgun.org',
  'constantcontact.com',
  'campaign-archive.com',
  'createsend.com',
  'emarsys.net',
  'exacttarget.com',
];

const MARKETING_SUBJECT_PATTERNS = [
  /ship now/i,
  /you made the sale/i,
  /you have a new order/i,
  /upgrade reminder/i,
  /newsletter/i,
  /\bseo\b/i,
  /partnership opportunity/i,
  /wholesale/i,
  /traffic magnet/i,
  /conversion flow/i,
  /website design/i,
  /refurbished.*screen/i,
  /months pro free/i,
  /could we discuss/i,
  /store structure observation/i,
  /re:\s*\[\[/i,
  /reminder to speed up/i,
  /approaching delivery times/i,
  /order\(s\) about to be late/i,
  /successfully cancelled an order/i,
  /buyer wants to cancel/i,
  /statement summary is ready/i,
  /you have products with unappealing/i,
  /seller center/i,
  /ship now/i,
  /statement summary is ready/i,
  /new device is using your account/i,
  /has shipped your sold item/i,
  /your order has shipped/i,
  /fulfilment order/i,
  /refund initiated/i,
  /feedback notification/i,
  /sent a message about/i,
  /limited-time.*discount/i,
  /sell with .* unlock/i,
  /unlock global markets/i,
  /\boffer\s+\d{2}[./]\d{2}[./]\d{4}/i,
  /please restock to avoid/i,
  /advertise your listings/i,
  /featured offer.*buy box/i,
  /has been listed/i,
  /weekly (digest|roundup)/i,
  /\bunsubscribe\b/i,
  /act now/i,
  /limited time/i,
  /\d+%\s*off/i,
  /exclusive deal/i,
  /book a (demo|call)/i,
  /schedule a (demo|call)/i,
  /clearance/i,
];

const PROMOTIONAL_BODY_PATTERNS = [
  /view (this email )?in (your )?browser/i,
  /\bunsubscribe\b/i,
  /manage (your )?preferences/i,
  /email preferences/i,
  /no longer wish to receive/i,
  /you('re| are) receiving this (email )?because/i,
  /add us to your address book/i,
  /forward to a friend/i,
];

const CUSTOMER_SUPPORT_SIGNALS = [
  { pattern: /\border\s*#?\d{4,}\b/i, weight: 4, label: 'order_number' },
  { pattern: /\bdux\d+\b/i, weight: 4, label: 'order_reference' },
  { pattern: /\b(my order|order number|placed an order|i ordered)\b/i, weight: 3, label: 'order_context' },
  { pattern: /\b(where is my|haven'?t received|not received|never received|missing (parcel|package|item))\b/i, weight: 3, label: 'delivery_issue' },
  { pattern: /\b(refund|return|cancel(l)?(ing|ation)?|exchange)\b/i, weight: 2, label: 'after_sales' },
  { pattern: /\b(track(ing)?|delivery|dispatch(ed)?|shipment)\b/i, weight: 2, label: 'shipping' },
  { pattern: /\b(help|issue|problem|complaint|concern|wrong item|damaged|faulty)\b/i, weight: 2, label: 'support_intent' },
  { pattern: /\b(writing (to|about)|reaching out|contacting you)\b/i, weight: 2, label: 'direct_outreach' },
  { pattern: /\b(hi|hello|dear)\s+(kopadot|support|team)\b/i, weight: 2, label: 'store_addressed' },
  { pattern: /\b(i am|i'm|my name is)\b/i, weight: 1, label: 'first_person' },
  { pattern: /\?/, weight: 2, label: 'question' },
  { pattern: /\b(payment|charged|charge|invoice|receipt)\b/i, weight: 2, label: 'payment' },
  { pattern: /\b(warranty|guarantee|policy)\b/i, weight: 1, label: 'policy_question' },
];

const MARKETING_SCORE_SKIP = 5;
const MARKETING_SCORE_HARD_SKIP = 8;
const CUSTOMER_SCORE_REPLY = 5;
const CUSTOMER_SCORE_SOFT_REPLY = 3;

/**
 * Normalize Graph internetMessageHeaders into a lowercase lookup map.
 */
export function parseEmailHeaders(internetMessageHeaders = []) {
  const map = new Map();
  for (const header of internetMessageHeaders) {
    if (!header?.name) continue;
    map.set(header.name.toLowerCase(), header.value || '');
  }
  return map;
}

function getHeader(headers, name) {
  return headers.get(name.toLowerCase()) || '';
}

function isBulkMarketingHeader(headers) {
  const listUnsub = getHeader(headers, 'list-unsubscribe');
  const listId = getHeader(headers, 'list-id');
  const precedence = getHeader(headers, 'precedence').toLowerCase();
  const autoSubmitted = getHeader(headers, 'auto-submitted').toLowerCase();

  if (listUnsub && (listId || /^(bulk|list|junk)$/i.test(precedence))) {
    return true;
  }
  if (listUnsub && getHeader(headers, 'list-unsubscribe-post')) {
    return true;
  }
  if (/^(auto-generated|auto-replied)$/i.test(autoSubmitted) && listUnsub) {
    return true;
  }
  return false;
}

function isAutomatedHeader(headers) {
  const autoSubmitted = getHeader(headers, 'auto-submitted').toLowerCase();
  const precedence = getHeader(headers, 'precedence').toLowerCase();
  return /^(auto-generated|auto-replied)$/i.test(autoSubmitted)
    || /^(bulk|list|junk)$/i.test(precedence);
}

function scoreCustomerSignals(subject, preview) {
  const combined = `${subject}\n${preview}`;
  let score = 0;
  const hits = [];

  for (const signal of CUSTOMER_SUPPORT_SIGNALS) {
    if (signal.pattern.test(combined)) {
      score += signal.weight;
      hits.push(signal.label);
    }
  }

  return { score, hits };
}

function scoreMarketingSignals(senderEmail, subject, preview, headers) {
  let score = 0;
  const hits = [];
  const normalizedSender = senderEmail?.toLowerCase() || '';
  const combined = `${subject}\n${preview}`;

  if (isBulkMarketingHeader(headers)) {
    score += 5;
    hits.push('bulk_marketing_headers');
  } else if (getHeader(headers, 'list-unsubscribe')) {
    score += 3;
    hits.push('list_unsubscribe_header');
  } else if (getHeader(headers, 'list-id')) {
    score += 2;
    hits.push('list_id_header');
  }
  if (isAutomatedHeader(headers)) {
    score += 3;
    hits.push('automated_header');
  }
  if (MARKETING_SENDER_PATTERNS.some((p) => p.test(normalizedSender))) {
    score += 3;
    hits.push('marketing_sender');
  }
  if (ESP_SENDER_DOMAINS.some((d) => normalizedSender.includes(d))) {
    score += 2;
    hits.push('esp_sender');
  }
  if (MARKETING_SUBJECT_PATTERNS.some((p) => p.test(subject))) {
    score += 3;
    hits.push('marketing_subject');
  }
  if (PROMOTIONAL_BODY_PATTERNS.some((p) => p.test(combined))) {
    score += 2;
    hits.push('promotional_body');
  }
  if (!/\?/.test(combined) && /\b(offer|discount|promo|sale|deal|unlock|subscribe)\b/i.test(combined)) {
    score += 1;
    hits.push('promotional_language');
  }
  if (/\b(wts|price\s*list|stock\s*list|availability\s*list|catalogue|catalog)\b/i.test(combined)) {
    score += 3;
    hits.push('vendor_catalog');
  }
  if (/\b(dear\s+(team|buyer|partner)|grow your business|join\s+\d+\s*(sellers|brands))\b/i.test(combined)) {
    score += 2;
    hits.push('outreach_template');
  }

  return { score, hits };
}

function runLayer1HardDeny({ senderEmail, subject, bodyPreview, headers, ownMailbox }) {
  if (!senderEmail) {
    return { skip: true, reason: 'no_sender_address', confidence: 1 };
  }

  const normalized = senderEmail.toLowerCase().trim();
  if (ownMailbox && normalized === ownMailbox) {
    return { skip: true, reason: 'sent_from_own_mailbox', confidence: 1 };
  }

  if (AUTOMATED_SENDER_PATTERNS.some((p) => p.test(normalized))) {
    return { skip: true, reason: 'automated_sender_address', confidence: 1 };
  }

  if (PLATFORM_SENDER_DOMAINS.some((d) => normalized.includes(d))) {
    return { skip: true, reason: 'platform_notification_sender', confidence: 1 };
  }

  const combined = `${subject}\n${bodyPreview}`;
  if (INTERNAL_NOTIFICATION_PATTERNS.some((p) => p.test(combined))) {
    return { skip: true, reason: 'internal_system_notification', confidence: 1 };
  }

  if (SECURITY_NOTIFICATION_SUBJECT_PATTERNS.some((p) => p.test(subject))) {
    return { skip: true, reason: 'security_notification_subject', confidence: 1 };
  }

  if (VENDOR_SUBJECT_PATTERNS.some((p) => p.test(subject))
    && !/\border\s*#?\d{4,}\b/i.test(combined)) {
    return { skip: true, reason: 'vendor_outreach_subject', confidence: 0.95 };
  }

  // Bulk headers (List-Unsubscribe etc.) are scored in Layer 2 so real customer
  // mail from ESP-backed senders is not hard-blocked before content is weighed.

  return null;
}

function runLayer2SignalScoring(input) {
  const preview = (input.bodyPreview || input.plainBody || '').slice(0, 600);
  const customer = scoreCustomerSignals(input.subject, preview);
  const marketing = scoreMarketingSignals(input.senderEmail, input.subject, preview, input.headers);

  // Never hard-block when customer signals are present — ambiguous mail goes to GPT instead.
  if (
    marketing.score >= MARKETING_SCORE_HARD_SKIP
    && customer.score < CUSTOMER_SCORE_SOFT_REPLY
  ) {
    return {
      shouldRespond: false,
      layer: 2,
      reason: 'high_marketing_score',
      confidence: 0.95,
      customerScore: customer.score,
      marketingScore: marketing.score,
      customerHits: customer.hits,
      marketingHits: marketing.hits,
    };
  }

  if (marketing.score >= MARKETING_SCORE_SKIP && customer.score < CUSTOMER_SCORE_SOFT_REPLY) {
    return {
      shouldRespond: false,
      layer: 2,
      reason: 'marketing_signals_dominate',
      confidence: 0.9,
      customerScore: customer.score,
      marketingScore: marketing.score,
      customerHits: customer.hits,
      marketingHits: marketing.hits,
    };
  }

  // Mixed signals — never auto-skip; escalate to GPT (which defaults to reply when unsure).
  if (customer.score >= CUSTOMER_SCORE_SOFT_REPLY && marketing.score >= MARKETING_SCORE_SKIP) {
    return {
      ambiguous: true,
      customerScore: customer.score,
      marketingScore: marketing.score,
      customerHits: customer.hits,
      marketingHits: marketing.hits,
    };
  }

  if (customer.score >= CUSTOMER_SCORE_REPLY) {
    return {
      shouldRespond: true,
      layer: 2,
      reason: 'strong_customer_signals',
      confidence: 0.92,
      customerScore: customer.score,
      marketingScore: marketing.score,
      customerHits: customer.hits,
      marketingHits: marketing.hits,
    };
  }

  if (customer.score >= CUSTOMER_SCORE_SOFT_REPLY && marketing.score === 0) {
    return {
      shouldRespond: true,
      layer: 2,
      reason: 'customer_signals_no_marketing',
      confidence: 0.85,
      customerScore: customer.score,
      marketingScore: marketing.score,
      customerHits: customer.hits,
      marketingHits: marketing.hits,
    };
  }


  return {
    ambiguous: true,
    customerScore: customer.score,
    marketingScore: marketing.score,
    customerHits: customer.hits,
    marketingHits: marketing.hits,
  };
}

/**
 * Layer 3 — cheap GPT gate for ambiguous mail only (~300 tokens).
 * Industry pattern: rules first, small model last (Automation Labz, LobsterMail, UpGPT).
 */
async function runLayer3GptClassify(input, scores) {
  const preview = (input.bodyPreview || input.plainBody || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, env.emailClassifyPreviewChars);

  try {
    const response = await openai.chat.completions.create({
      model: env.emailClassifierModel,
      messages: [
        {
          role: 'system',
          content: `You gate emails for ${env.storeName} customer support. Real customers use personal AND company email domains.

Reply YES only if a person needs help from the store: orders, delivery, refunds, returns, product issues, payments, account help.
Reply NO for: marketing, newsletters, marketplace seller alerts, supplier/WTS offers, platform notifications, spam, auto-replies, vendor outreach, B2B distributors, pricelists, security/account emails from third-party platforms (Roblox, Temu, etc.).

CRITICAL INSTRUCTIONS:
- Automated shipment updates, shipment IDs, vendor account warnings, platform seller linking requests, clearance notifications, operator alerts, and courier support replies (from DHL, DPD, TikTok, Amazon, etc.) are NOT customer support queries and MUST NOT receive a response. Reply NO.
- We DO respond to questions from eBay or Debenhams if they are forwarded by Customer Service (e.g. customerservices@debenhams.com) AND they contain a real customer question inside. Reply YES for these.
- If it looks like a random marketing or B2B outreach email, definitively reply NO. We receive millions of spam emails, be extremely strict on spam/marketing.

JSON only: {"needs_response":true/false,"confidence":0.0-1.0,"reason":"brief"}`,
        },
        {
          role: 'user',
          content: [
            `From: ${input.senderEmail || 'unknown'}`,
            `Subject: ${input.subject || '(no subject)'}`,
            `Preview: ${preview}`,
            `Heuristic hints: customer=${scores.customerScore}, marketing=${scores.marketingScore}`,
            `CRITICAL RULE: If the email is from a marketplace like Temu, Amazon, TikTok, or is a vendor/seller alert, or a courier like DHL, output needs_response: false.`,
            `EXCEPTION: If it is a real customer question forwarded by Debenhams or eBay CS, output needs_response: true.`
          ].join('\n'),
        },
      ],
      temperature: 0,
      max_tokens: 80,
      response_format: { type: 'json_object' },
    });

    const result = JSON.parse(response.choices[0].message.content);
    const needsResponse = Boolean(result.needs_response);
    const confidence = Number(result.confidence) || (needsResponse ? 0.75 : 0.8);

    return {
      shouldRespond: needsResponse,
      layer: 3,
      reason: result.reason || 'gpt_classification',
      confidence,
      gptUsed: true,
      customerScore: scores.customerScore,
      marketingScore: scores.marketingScore,
      customerHits: scores.customerHits,
      marketingHits: scores.marketingHits,
    };
  } catch (error) {
    logger.warn(`Email GPT triage failed: ${error.message}`);
    const fallbackReply = scores.customerScore >= 2;
    return {
      shouldRespond: fallbackReply,
      layer: 3,
      reason: fallbackReply ? 'gpt_failed_customer_signals_present' : 'gpt_failed_default_skip',
      confidence: 0.5,
      gptUsed: true,
      customerScore: scores.customerScore,
      marketingScore: scores.marketingScore,
      customerHits: scores.customerHits,
      marketingHits: scores.marketingHits,
    };
  }
}

/**
 * Multi-layer triage pipeline:
 *   Layer 1 — hard deny (headers, platform senders, noreply)     ~60-70% of noise, $0
 *   Layer 2 — weighted signal scoring                              next ~20-25%, $0
 *   Layer 3 — lightweight GPT on ambiguous only                    ~5-15% of inbox, ~300 tokens each
 */
/**
 * Fast triage for backlog drain — Layers 1–2 only, no GPT tokens.
 * Ambiguous mail is treated as skip (mark read). Strong customer signals still pass through.
 */
export function triageInboundEmailFast(input, { ownMailbox = '' } = {}) {
  const headers = input.headers instanceof Map
    ? input.headers
    : parseEmailHeaders(input.internetMessageHeaders || []);

  const normalized = {
    senderEmail: input.senderEmail || null,
    senderName: input.senderName || null,
    subject: input.subject || '(no subject)',
    bodyPreview: input.bodyPreview || '',
    plainBody: input.plainBody || '',
    headers,
  };

  const layer1 = runLayer1HardDeny({ ...normalized, ownMailbox });
  if (layer1) {
    return {
      shouldRespond: false,
      layer: 1,
      reason: layer1.reason,
      confidence: layer1.confidence,
      gptUsed: false,
    };
  }

  const layer2 = runLayer2SignalScoring(normalized);
  if (!layer2.ambiguous) {
    return { ...layer2, gptUsed: false };
  }

  // Any customer signals at all → keep for full processing (never silently discard)
  if (layer2.customerScore >= CUSTOMER_SCORE_SOFT_REPLY) {
    return {
      shouldRespond: true,
      layer: 2,
      reason: 'backlog_customer_signals_need_review',
      confidence: 0.8,
      gptUsed: false,
      customerScore: layer2.customerScore,
      marketingScore: layer2.marketingScore,
    };
  }

  // Ambiguous with ANY customer signal (score >= 1) — default to respond.
  // Real customers from Gmail/Outlook/Yahoo have zero marketing headers,
  // so they land here. Better to reply to one extra marketing email than
  // miss a real customer. Only skip if truly zero customer signals AND
  // high marketing indicators.
  if (layer2.customerScore >= 1) {
    return {
      shouldRespond: true,
      layer: 2,
      reason: 'backlog_ambiguous_has_customer_signal',
      confidence: 0.7,
      gptUsed: false,
      customerScore: layer2.customerScore,
      marketingScore: layer2.marketingScore,
    };
  }

  // Truly zero customer signals — check if it looks like a personal email
  // (no marketing headers, no ESP domain, no list-unsubscribe). Personal
  // emails from customers who didn't mention order numbers still deserve a reply.
  const senderLower = (normalized.senderEmail || '').toLowerCase();
  const isPersonalDomain = /(@gmail\.|@yahoo\.|@hotmail\.|@outlook\.|@icloud\.|@aol\.|@live\.|@proton)/i.test(senderLower);
  const hasMarketingHeaders = isBulkMarketingHeader(headers) || isAutomatedHeader(headers);

  if (isPersonalDomain && !hasMarketingHeaders && layer2.marketingScore < MARKETING_SCORE_SKIP) {
    return {
      shouldRespond: true,
      layer: 2,
      reason: 'backlog_personal_email_benefit_of_doubt',
      confidence: 0.65,
      gptUsed: false,
      customerScore: layer2.customerScore,
      marketingScore: layer2.marketingScore,
    };
  }

  return {
    shouldRespond: false,
    layer: 2,
    reason: 'backlog_ambiguous_skip',
    confidence: 0.7,
    gptUsed: false,
    customerScore: layer2.customerScore,
    marketingScore: layer2.marketingScore,
  };
}

export async function triageInboundEmail(input, { ownMailbox = '' } = {}) {
  const headers = input.headers instanceof Map
    ? input.headers
    : parseEmailHeaders(input.internetMessageHeaders || []);

  const normalized = {
    senderEmail: input.senderEmail || null,
    senderName: input.senderName || null,
    subject: input.subject || '(no subject)',
    bodyPreview: input.bodyPreview || '',
    plainBody: input.plainBody || '',
    headers,
  };

  const layer1 = runLayer1HardDeny({ ...normalized, ownMailbox });
  if (layer1) {
    return {
      shouldRespond: false,
      layer: 1,
      reason: layer1.reason,
      confidence: layer1.confidence,
      gptUsed: false,
    };
  }

  const layer2 = runLayer2SignalScoring(normalized);
  if (!layer2.ambiguous) {
    return { ...layer2, gptUsed: false };
  }

  return runLayer3GptClassify(normalized, layer2);
}

export default {
  triageInboundEmail,
  triageInboundEmailFast,
  parseEmailHeaders,
};
