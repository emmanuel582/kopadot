import process from 'node:process';
import 'dotenv/config';

const BASE_URL = process.env.TEST_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const CHAT_URL = `${BASE_URL}/api/chat`;
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const RETRIES = Number(process.env.TEST_RETRIES || 3);
const RETRY_DELAY_MS = Number(process.env.TEST_RETRY_DELAY_MS || 3000);
const REQUEST_TIMEOUT_MS = Number(process.env.TEST_REQUEST_TIMEOUT_MS || 45000);

// Delay between scenarios to avoid Gemini rate limiting
const INTER_SCENARIO_DELAY_MS = 2500;

const FALLBACK_PHRASES = [
  "I'm experiencing a temporary issue connecting to my systems",
  "I'm sorry, I'm having a temporary issue",
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isFallbackResponse(message) {
  if (!message || typeof message !== 'string') return true;
  return FALLBACK_PHRASES.some(phrase => message.includes(phrase));
}

async function fetchRealZendeskQuestions() {
  if (!ZENDESK_SUBDOMAIN) return [];

  const url = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/help_center/articles/search.json?query=return+shipping+refund&per_page=5`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Zendesk public API failed: HTTP ${res.status}`);

  const data = await res.json();
  const results = Array.isArray(data.results) ? data.results : [];

  return results
    .map(a => a?.title)
    .filter(Boolean)
    .slice(0, 3)
    .map(title => `Customer asks: "${title}". Can you explain this clearly and what steps I should follow?`);
}

function buildScenarios(zendeskDerivedQuestions) {
  // Real BaseLinker IDs discovered from the live account:
  //   Orders:   29828903, 29830694, 29825600, 29798711, 29941843
  //   Products: 362741125 (Motorola Moto Edge 40 Neo), 362741129 (Moto G84), 362741132 (Moto G35)
  //   Inventory: 63544 ("KopaDot")
  const baseline = [
    // ── Order lookup by ID (real order) ────────────────────────
    'Hi, can you look up order 29828903? I want to know its current status and what items are in it.',

    // ── Shipment tracking (real order) ─────────────────────────
    'Please track order 29830694. Has it been shipped? What courier was used?',

    // ── Payment history (real order) ───────────────────────────
    'I think I was charged twice for order 29825600. Please check the payment history and tell me what happened.',

    // ── Product info by ID (real product) ─────────────────────
    'I want the price and stock availability for product 362741125.',

    // ── Product search (natural language) ─────────────────────
    'Do you have any Motorola phones in stock? I am looking for a Moto G84.',

    // ── Order + follow-up cancel intent (real order) ──────────
    'Can you check order 29941843 and cancel it if it has not been shipped yet?',

    // ── Stock check (real product) ────────────────────────────
    'Is product 362741132 currently in stock? How many units do you have?',
  ];

  return [...zendeskDerivedQuestions, ...baseline];
}

async function askWithRetries(message, sessionId) {
  let last = null;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    const started = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const res = await fetch(CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, session_id: sessionId }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const data = await res.json();
      const elapsedMs = Date.now() - started;
      last = { ok: res.ok, status: res.status, data, elapsedMs, attempt };
    } catch (error) {
      const elapsedMs = Date.now() - started;
      last = {
        ok: false,
        status: 0,
        data: { message: error?.message || 'Request failed' },
        elapsedMs,
        attempt,
      };
    }

    if (!last.ok) {
      if (attempt < RETRIES) await sleep(RETRY_DELAY_MS * attempt);
      continue;
    }

    const reply = last.data?.message || '';
    if (!isFallbackResponse(reply)) return last;

    if (attempt < RETRIES) await sleep(RETRY_DELAY_MS * attempt);
  }
  return last;
}

async function run() {
  console.log('🚀 KopaDot Production Test Suite\n');
  console.log(`   Target: ${CHAT_URL}`);
  console.log(`   Retries per scenario: ${RETRIES}`);
  console.log(`   Inter-scenario delay: ${INTER_SCENARIO_DELAY_MS}ms\n`);

  const summary = {
    baseUrl: BASE_URL,
    chatUrl: CHAT_URL,
    retries: RETRIES,
    usedZendeskQuestions: false,
    results: [],
  };

  let zendeskQuestions = [];
  try {
    zendeskQuestions = await fetchRealZendeskQuestions();
    summary.usedZendeskQuestions = zendeskQuestions.length > 0;
    if (zendeskQuestions.length > 0) {
      console.log(`✅ Loaded ${zendeskQuestions.length} real Zendesk questions\n`);
    }
  } catch (error) {
    summary.zendeskError = error.message;
    console.log(`⚠️  Zendesk question fetch failed: ${error.message}\n`);
  }

  const scenarios = buildScenarios(zendeskQuestions);

  for (let i = 0; i < scenarios.length; i++) {
    const prompt = scenarios[i];
    const sessionId = `prod-test-${Date.now()}-${i + 1}`;

    // Add delay between scenarios to avoid rate limiting
    if (i > 0) {
      await sleep(INTER_SCENARIO_DELAY_MS);
    }

    console.log(`── Scenario ${i + 1}/${scenarios.length} ──`);
    console.log(`   Prompt: ${prompt.slice(0, 100)}...`);

    const result = await askWithRetries(prompt, sessionId);
    const reply = result?.data?.message || '';
    const toolsUsed = result?.data?.metadata?.tools_used || [];
    const toolsUsedDetails = result?.data?.metadata?.tools_used_details || [];
    const isFallback = isFallbackResponse(reply);

    summary.results.push({
      scenario: i + 1,
      prompt,
      sessionId,
      httpStatus: result?.status,
      attemptUsed: result?.attempt,
      latencyMs: result?.elapsedMs,
      toolsUsed,
      isFallback,
      replyPreview: reply.slice(0, 250),
    });

    const icon = isFallback ? '❌' : '✅';
    console.log(`   ${icon} Status: ${result?.status} | Tools: [${toolsUsed.join(', ')}] | ${result?.elapsedMs}ms | Attempt ${result?.attempt}`);
    console.log(`   Reply: ${reply.slice(0, 120)}...`);

    if (toolsUsedDetails.length > 0) {
      console.log(`   🛠️  Tool Results:`);
      toolsUsedDetails.forEach(t => {
        const resPreview = JSON.stringify(t.result).slice(0, 150);
        console.log(`       - ${t.name}: ${t.success ? '✅' : '❌'} ${resPreview}...`);
      });
    }
    console.log('\n');
  }

  const hardFailures = summary.results.filter(r => r.httpStatus !== 200);
  const fallbackCount = summary.results.filter(r => r.isFallback).length;
  const passCount = summary.results.length - fallbackCount;

  console.log('═══════════════════════════════════════════');
  console.log(JSON.stringify(summary, null, 2));
  console.log('═══════════════════════════════════════════');

  if (hardFailures.length > 0) {
    console.error(`\n❌ FAIL: ${hardFailures.length} scenario(s) returned non-200.`);
    process.exit(1);
  }

  if (fallbackCount === summary.results.length) {
    console.error('\n❌ FAIL: All scenarios returned fallback responses.');
    process.exit(1);
  }

  const pct = Math.round((passCount / summary.results.length) * 100);
  console.log(`\n${pct >= 80 ? '✅' : '⚠️'} Result: ${passCount}/${summary.results.length} scenarios passed (${pct}%)`);
}

run().catch((error) => {
  console.error('Production test runner crashed.');
  console.error(error?.message || error);
  process.exit(1);
});
