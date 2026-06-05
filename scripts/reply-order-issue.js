import { replyToSpecificEmail } from '../src/channels/email.js';

/**
 * Reply to a specific customer test email — no inbox poll, no wasted GPT on spam.
 *
 * Usage:
 *   node scripts/reply-order-issue.js
 */
async function main() {
  console.log('Replying to Order Issue from emmanuelwritecode@gmail.com...');

  const result = await replyToSpecificEmail({
    fromEmail: 'emmanuelwritecode@gmail.com',
    subjectContains: 'Order Issue',
    force: true,
  });

  console.log(JSON.stringify(result, null, 2));
  console.log('\nDone — check emmanuelwritecode@gmail.com inbox for the reply.');
}

main().catch((error) => {
  console.error('Failed:', error.message);
  process.exit(1);
});
