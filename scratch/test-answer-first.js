import { processMessage } from '../src/agent/chatgptEngine.js';

/**
 * COMPREHENSIVE KOPADOT AGENT TEST SUITE
 * 
 * Tests ALL tools: KB search, order lookup, tracking, inventory,
 * product search, returns, payments, escalation, and follow-up conversations.
 * 
 * Validates:
 *  1. Every question queries Zendesk KB first
 *  2. AI answers questions using KB data (never guesses)
 *  3. When KB has no results → silently escalates (createEscalationTicket)
 *  4. Escalation is INVISIBLE — no leak to customer
 *  5. Correct tools are used for each scenario
 *  6. Follow-up conversations maintain context
 */

const FORBIDDEN_PHRASES = [
  'created a support ticket',
  'created a ticket',
  'raised a ticket',
  'human agent',
  'transferring you',
  'connecting you with',
  'escalated',
  "they'll have",
  "won't need to repeat",
  'ticket has been',
  'team will follow up',
  'support ticket',
  'ticket regarding',
  'agent will be with you',
  'i\'ve raised this',
  'our team will',
  'contact our customer service',
  'contact us directly',
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Test Scenarios ──────────────────────────────────────────────────

const SCENARIOS = [
  // ═══ CATEGORY 1: KB Questions (must query KB, answer or escalate) ═══
  {
    name: "KB: Return policy for opened item",
    message: "I bought a brand new Samsung phone, I've already opened and used it for a week, and now I want to return it for a full refund. Can I do that?",
    mustUseTools: ['searchKnowledgeBase'],
    mustNotLeak: true,
    category: 'KB Query',
  },
  {
    name: "KB: International shipping (must NOT guess)",
    message: "I live in Ireland — can KopaDot deliver to me?",
    mustUseTools: ['searchKnowledgeBase'],
    mustNotLeak: true,
    mustEscalateIfNoKB: true,
    category: 'KB Query',
  },
  {
    name: "KB: Warranty coverage question",
    message: "My refurbished phone's screen has scratches from normal everyday use after 2 months — is this covered under warranty?",
    mustUseTools: ['searchKnowledgeBase'],
    mustNotLeak: true,
    mustEscalateIfNoKB: true,
    category: 'KB Query',
  },
  {
    name: "KB: International return policy",
    message: "Can I return an international order?",
    mustUseTools: ['searchKnowledgeBase'],
    mustNotLeak: true,
    mustEscalateIfNoKB: true,
    category: 'KB Query',
  },
  {
    name: "KB: Order tracking capability",
    message: "Can I track my order?",
    mustUseTools: ['searchKnowledgeBase'],
    mustNotLeak: true,
    category: 'KB Query',
  },
  {
    name: "KB: Refund timeframe",
    message: "How long does it take to get a refund?",
    mustUseTools: ['searchKnowledgeBase'],
    mustNotLeak: true,
    mustEscalateIfNoKB: true,
    category: 'KB Query',
  },

  // ═══ CATEGORY 2: Order Lookup (must use order tools) ═══
  {
    name: "ORDER: Lookup by order ID",
    message: "Hi, can you check order 29828903 for me? I want to know the status.",
    mustUseTools: ['lookupOrderById'],
    mustNotLeak: true,
    category: 'Order',
  },

  // ═══ CATEGORY 3: Shipment Tracking ═══
  {
    name: "TRACK: Track a specific order",
    message: "Please track order 29830694. Has it been shipped?",
    mustUseToolsAny: ['trackShipment', 'lookupOrderById'],
    mustNotLeak: true,
    category: 'Tracking',
  },

  // ═══ CATEGORY 4: Product & Inventory ═══
  {
    name: "PRODUCT: Search for a product",
    message: "Do you have any Motorola phones in stock? I'm looking for a Moto G84.",
    mustUseToolsAny: ['searchProducts', 'getProductInfo'],
    mustNotLeak: true,
    category: 'Product',
  },
  {
    name: "STOCK: Check inventory for a product",
    message: "Is product 362741132 currently in stock? How many units do you have?",
    mustUseToolsAny: ['checkStock', 'getProductInfo'],
    mustNotLeak: true,
    category: 'Inventory',
  },

  // ═══ CATEGORY 5: Payment ═══
  {
    name: "PAYMENT: Check payment history",
    message: "I think I was charged twice for order 29825600. Can you check the payment history?",
    mustUseToolsAny: ['getPaymentHistory', 'lookupOrderById'],
    mustNotLeak: true,
    category: 'Payment',
  },

  // ═══ CATEGORY 6: Silent Escalation (KB miss → must escalate invisibly) ═══
  {
    name: "ESCALATE: Obscure question with no KB answer",
    message: "What is KopaDot's policy on bulk corporate purchases for companies with more than 500 employees?",
    mustUseTools: ['searchKnowledgeBase'],
    mustEscalateIfNoKB: true,
    mustNotLeak: true,
    category: 'Escalation',
  },

  // ═══ CATEGORY 7: 10 NEW SOLID QUESTIONS ═══
  {
    name: "FRUSTRATED: Angry customer wanting refund (should answer + silently escalate)",
    message: "I'm really upset right now. I paid €300 for a phone and it arrived with a cracked screen! This is unacceptable. I want a full refund immediately!",
    mustUseTools: ['searchKnowledgeBase'],
    mustNotLeak: true,
    mustEscalateIfNoKB: true,
    category: 'Frustrated',
  },
  {
    name: "KB: Payment methods accepted",
    message: "What payment methods does KopaDot accept? Can I pay with PayPal?",
    mustUseTools: ['searchKnowledgeBase'],
    mustNotLeak: true,
    mustEscalateIfNoKB: true,
    category: 'KB Query',
  },
  {
    name: "KB: Exchange policy",
    message: "Can I exchange my phone for a different model instead of returning it?",
    mustUseTools: ['searchKnowledgeBase'],
    mustNotLeak: true,
    mustEscalateIfNoKB: true,
    category: 'KB Query',
  },
  {
    name: "PRODUCT: Compare two phones",
    message: "What's the difference between product 362741125 and 362741132? Which one is better?",
    mustUseToolsAny: ['getProductInfo', 'checkStock', 'searchProducts'],
    mustNotLeak: true,
    category: 'Product',
  },
  {
    name: "ORDER+CANCEL: Customer wants to cancel",
    message: "I placed order 29941843 by mistake. Can I cancel it? It hasn't shipped yet.",
    mustUseToolsAny: ['lookupOrderById'],
    mustNotLeak: true,
    category: 'Order',
  },
  {
    name: "KB: Delivery timeframe",
    message: "How long does delivery usually take within the UK?",
    mustUseTools: ['searchKnowledgeBase'],
    mustNotLeak: true,
    mustEscalateIfNoKB: true,
    category: 'KB Query',
  },
  {
    name: "PRODUCT: Looking for a recommendation",
    message: "I need a phone under €200 with good battery life. What do you recommend?",
    mustUseToolsAny: ['searchProducts'],
    mustNotLeak: true,
    category: 'Product',
  },
  {
    name: "ANGRY: Wants to speak to a manager",
    message: "This is ridiculous! I've been waiting 3 weeks for my order and nobody is helping me. I want to speak to a manager RIGHT NOW!",
    mustNotLeak: true,
    category: 'Escalation',
  },
  {
    name: "STOCK: Check specific product availability",
    message: "Is the Motorola Moto Edge 40 Neo still available? Product ID 362741125.",
    mustUseToolsAny: ['checkStock', 'getProductInfo'],
    mustNotLeak: true,
    category: 'Inventory',
  },
  {
    name: "KB: Gift wrapping or special packaging",
    message: "Does KopaDot offer gift wrapping or special packaging for birthdays?",
    mustUseTools: ['searchKnowledgeBase'],
    mustNotLeak: true,
    mustEscalateIfNoKB: true,
    category: 'KB Query',
  },
];

// ═══ CATEGORY 7: Follow-up Conversation ═══
const FOLLOW_UP_SCENARIO = {
  name: "FOLLOW-UP: Multi-turn conversation",
  steps: [
    {
      message: "Hi there, I need help with my order.",
      expectResponse: true,
      description: "Initial greeting",
    },
    {
      message: "My order number is 29828903.",
      mustUseToolsAny: ['lookupOrderById'],
      description: "Provides order ID → should lookup",
    },
    {
      message: "Can you also check if product 362741125 is in stock?",
      mustUseToolsAny: ['checkStock', 'getProductInfo'],
      description: "Follow-up product query",
    },
  ],
  category: 'Follow-up',
};


async function runSingleTest(scenario) {
  const result = await processMessage(scenario.message, [], { sessionId: `test-${Date.now()}` });
  const response = result.response || '';
  const toolNames = result.toolsUsed.map(t => t.name);
  const errors = [];

  // CHECK 1: Forbidden phrases
  if (scenario.mustNotLeak) {
    const responseLower = response.toLowerCase();
    const leakedPhrases = FORBIDDEN_PHRASES.filter(phrase => responseLower.includes(phrase));
    if (leakedPhrases.length > 0) {
      errors.push(`LEAKED escalation: "${leakedPhrases.join('", "')}"`);
    }
  }

  // CHECK 2: Must use specific tools
  if (scenario.mustUseTools) {
    for (const tool of scenario.mustUseTools) {
      if (!toolNames.includes(tool)) {
        errors.push(`Missing required tool: ${tool}`);
      }
    }
  }

  // CHECK 3: Must use at least one of these tools
  if (scenario.mustUseToolsAny) {
    const usedAny = scenario.mustUseToolsAny.some(tool => toolNames.includes(tool));
    if (!usedAny) {
      errors.push(`Did NOT use any of: ${scenario.mustUseToolsAny.join(', ')}`);
    }
  }

  // CHECK 4: If KB returned no results and mustEscalateIfNoKB, must have called createEscalationTicket
  if (scenario.mustEscalateIfNoKB) {
    const kbTool = result.toolsUsed.find(t => t.name === 'searchKnowledgeBase');
    const kbHadResults = kbTool && kbTool.result?.found && kbTool.result?.count > 0;
    const didEscalate = toolNames.includes('createEscalationTicket');

    if (kbTool && !kbHadResults && !didEscalate) {
      errors.push(`KB returned NO results but did NOT call createEscalationTicket (should silently escalate)`);
    }
  }

  return { response, toolNames, errors, toolsUsed: result.toolsUsed };
}

async function runFollowUpTest() {
  const scenario = FOLLOW_UP_SCENARIO;
  let conversationHistory = [];
  const stepResults = [];

  for (let i = 0; i < scenario.steps.length; i++) {
    const step = scenario.steps[i];
    const result = await processMessage(step.message, conversationHistory, { sessionId: `followup-test-${Date.now()}` });
    const response = result.response || '';
    const toolNames = result.toolsUsed.map(t => t.name);
    const errors = [];

    // Update conversation history
    if (result.conversationUpdate) {
      conversationHistory = [...conversationHistory, ...result.conversationUpdate];
    }

    // Check forbidden phrases
    const responseLower = response.toLowerCase();
    const leakedPhrases = FORBIDDEN_PHRASES.filter(phrase => responseLower.includes(phrase));
    if (leakedPhrases.length > 0) {
      errors.push(`LEAKED: "${leakedPhrases.join('", "')}"`);
    }

    // Check required tools
    if (step.mustUseToolsAny) {
      const usedAny = step.mustUseToolsAny.some(tool => toolNames.includes(tool));
      if (!usedAny) {
        errors.push(`Missing tools: expected one of ${step.mustUseToolsAny.join(', ')}`);
      }
    }

    stepResults.push({ step: i + 1, description: step.description, response, toolNames, errors });
    await sleep(1000);
  }

  return stepResults;
}


async function main() {
  console.log("══════════════════════════════════════════════════════════════════");
  console.log("  KOPADOT COMPREHENSIVE AGENT TEST SUITE");
  console.log("  KB Query | Order | Tracking | Product | Payment | Escalation | Follow-up");
  console.log("══════════════════════════════════════════════════════════════════\n");

  let totalPassed = 0;
  let totalFailed = 0;
  const failedTests = [];

  // ── Run Single-Turn Tests ──
  for (const scenario of SCENARIOS) {
    console.log(`\n── [${scenario.category}] ${scenario.name} ──`);
    console.log(`   💬 "${scenario.message}"`);

    try {
      const { response, toolNames, errors } = await runSingleTest(scenario);

      console.log(`   🤖 ${response.substring(0, 150)}${response.length > 150 ? '...' : ''}`);
      console.log(`   🔧 Tools: ${toolNames.join(' → ') || 'none'}`);

      if (errors.length > 0) {
        errors.forEach(e => console.log(`   ❌ FAIL: ${e}`));
        totalFailed++;
        failedTests.push({ name: scenario.name, errors });
      } else {
        console.log(`   ✅ PASS`);
        totalPassed++;
      }
    } catch (err) {
      console.log(`   ❌ ERROR: ${err.message}`);
      totalFailed++;
      failedTests.push({ name: scenario.name, errors: [err.message] });
    }

    await sleep(1500); // rate limit protection
  }

  // ── Run Follow-Up Test ──
  console.log(`\n\n══ [Follow-up] ${FOLLOW_UP_SCENARIO.name} ══`);
  try {
    const stepResults = await runFollowUpTest();
    let followUpPassed = true;

    for (const step of stepResults) {
      console.log(`\n   Step ${step.step}: ${step.description}`);
      console.log(`   🤖 ${step.response.substring(0, 150)}${step.response.length > 150 ? '...' : ''}`);
      console.log(`   🔧 Tools: ${step.toolNames.join(' → ') || 'none'}`);

      if (step.errors.length > 0) {
        step.errors.forEach(e => console.log(`   ❌ FAIL: ${e}`));
        followUpPassed = false;
      } else {
        console.log(`   ✅ PASS`);
      }
    }

    if (followUpPassed) {
      totalPassed++;
      console.log(`\n   ✅ Follow-up conversation: ALL STEPS PASSED`);
    } else {
      totalFailed++;
      failedTests.push({ name: FOLLOW_UP_SCENARIO.name, errors: ['One or more steps failed'] });
      console.log(`\n   ❌ Follow-up conversation: SOME STEPS FAILED`);
    }
  } catch (err) {
    console.log(`   ❌ Follow-up ERROR: ${err.message}`);
    totalFailed++;
    failedTests.push({ name: FOLLOW_UP_SCENARIO.name, errors: [err.message] });
  }

  // ── Summary ──
  const total = totalPassed + totalFailed;
  console.log("\n══════════════════════════════════════════════════════════════════");
  console.log(`  RESULTS: ${totalPassed} passed, ${totalFailed} failed out of ${total}`);
  console.log("══════════════════════════════════════════════════════════════════");

  if (failedTests.length > 0) {
    console.log("\n  ❌ FAILED TESTS:");
    failedTests.forEach(f => {
      console.log(`     • ${f.name}: ${f.errors.join('; ')}`);
    });
  }

  console.log("");
}

main();
