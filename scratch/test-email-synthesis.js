import { processMessage } from '../src/agent/chatgptEngine.js';
import { CHANNELS } from '../src/config/constants.js';

const msg = `Reply to this customer's email. Write like a real KopaDot support team member.

Customer name: Emmanuel
Customer email: emmanuelwritecode@gmail.com

Subject: Order #32953972 — DPD shows delivered but I never got my Samsung Watch Ultra (payment concern too)

Hi KopaDot team,

I'm writing about order #32953972 placed on 8 March 2026 for the Samsung Galaxy Watch Ultra 2025 LTE 47mm Titanium Silver Smartwatch (£379.99).

DPD tracking number 15503891797285 now shows the parcel as delivered, but nothing has arrived at my Nottingham address.

Separately, my bank app is showing two pending £379.99 charges. Can you confirm how many payments you have recorded?

If the watch does turn up but is damaged, what are my options under your returns policy? Also, product ID 362741125 — is it in stock, and could I exchange the watch for that instead?

Thanks, Emmanuel`;

const r = await processMessage(msg, [], {
  sessionId: `test-email-synth-${Date.now()}`,
  channel: CHANNELS.EMAIL,
  customerIdentity: { name: 'Emmanuel', email: 'emmanuelwritecode@gmail.com' },
});

console.log('TOOLS:', r.metadata?.tools_used);
console.log('---REPLY---');
console.log(r.response);
const bad = /which part|focus on first|clarify which/i.test(r.response || '');
console.log('\nBAD_PHRASE:', bad ? 'YES FAIL' : 'NO OK');
