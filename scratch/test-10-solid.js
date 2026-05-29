import { processMessage } from '../src/agent/chatgptEngine.js';

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

const SCENARIOS = [
  // ═══ Orders & Delivery ═══
  {
    name: "Change delivery address",
    message: "I placed an order but need to change my delivery address — what can I do?",
    mustUseTools: ['searchKnowledgeBase'],
    mustNotLeak: true
  },
  {
    name: "Delivered but not received",
    message: "My parcel says it's been delivered but I haven't received anything. What should I do?",
    mustUseTools: ['searchKnowledgeBase'],
    mustNotLeak: true
  },
  {
    name: "Delivery time and cost",
    message: "How long will my order take to arrive and how much does delivery cost?",
    mustUseTools: ['searchKnowledgeBase'],
    mustNotLeak: true
  },
  
  // ═══ Returns & Refunds ═══
  {
    name: "Return opened phone",
    message: "I want to return my phone but I've already opened it — am I still eligible for a refund?",
    mustUseTools: ['searchKnowledgeBase'],
    mustNotLeak: true
  },
  {
    name: "Fault after 3 months",
    message: "It's been 3 months since I bought my Samsung and it's developed a fault. What are my options?",
    mustUseTools: ['searchKnowledgeBase'],
    mustNotLeak: true
  },
  {
    name: "Refund timeframe after sending back",
    message: "How long will it take to get my refund once I've sent the item back?",
    mustUseTools: ['searchKnowledgeBase'],
    mustNotLeak: true
  },

  // ═══ Payments ═══
  {
    name: "Pay in instalments",
    message: "Can I pay for my order in instalments, and if so, how?",
    mustUseTools: ['searchKnowledgeBase'],
    mustNotLeak: true
  },
  {
    name: "Discount code not working",
    message: "My discount code isn't working at checkout — what should I try?",
    mustUseTools: ['searchKnowledgeBase'],
    mustNotLeak: true
  },

  // ═══ Products & Warranty ═══
  {
    name: "Phone condition and network",
    message: "Is the phone I'm buying brand new and will it work on all UK networks?",
    mustUseTools: ['searchKnowledgeBase'],
    mustNotLeak: true
  },
  {
    name: "Warranty repair/replace",
    message: "My Motorola is faulty and it's within the warranty period — how do I get it repaired or replaced?",
    mustUseTools: ['searchKnowledgeBase'],
    mustNotLeak: true
  }
];

async function runSingleTest(scenario) {
  const result = await processMessage(scenario.message, [], { sessionId: `test-10-${Date.now()}` });
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

  // CHECK 3: Escalation checking (if KB has no results, AI MUST escalate)
  const kbTool = result.toolsUsed.find(t => t.name === 'searchKnowledgeBase');
  const kbHadResults = kbTool && kbTool.result?.found && kbTool.result?.count > 0;
  const didEscalate = toolNames.includes('createEscalationTicket');

  if (kbTool && !kbHadResults && !didEscalate) {
    errors.push(`KB returned NO results but did NOT call createEscalationTicket (should silently escalate)`);
  }

  return { response, toolNames, errors, kbHadResults, didEscalate };
}

async function main() {
  console.log("══════════════════════════════════════════════════════════════════");
  console.log("  10 SOLID QUESTIONS TEST SUITE");
  console.log("══════════════════════════════════════════════════════════════════\n");

  let totalPassed = 0;
  let totalFailed = 0;
  const failedTests = [];

  for (const scenario of SCENARIOS) {
    console.log(`\n── ${scenario.name} ──`);
    console.log(`   💬 "${scenario.message}"`);

    try {
      const { response, toolNames, errors, kbHadResults, didEscalate } = await runSingleTest(scenario);

      console.log(`   🤖 ${response.substring(0, 150)}${response.length > 150 ? '...' : ''}`);
      console.log(`   🔧 Tools: ${toolNames.join(' → ') || 'none'}`);
      
      if (!kbHadResults) {
        console.log(`   ℹ️  No KB articles found.`);
      }

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
