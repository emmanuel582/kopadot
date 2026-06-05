import env from '../src/config/env.js';
import { pollEmails } from '../src/channels/email.js';

/**
 * Run one inbox poll cycle — classifies unread emails, generates AI replies,
 * and sends HTML responses for genuine customer support enquiries.
 *
 * Usage:
 *   node scripts/test-email-agent.js
 */
async function main() {
  console.log('KopaDot Email Agent — single poll test');
  console.log(`Mailbox: ${env.msGraphUserId || '(not set)'}`);
  console.log(`Store:   ${env.storeName}`);
  console.log('');

  if (!env.msGraphTenantId || !env.msGraphClientId || !env.msGraphClientSecret || !env.msGraphUserId) {
    console.error('Missing Microsoft Graph env vars. Set MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID, MS_GRAPH_CLIENT_SECRET, MS_GRAPH_USER_ID.');
    process.exit(1);
  }

  if (!env.openaiApiKey) {
    console.error('Missing OPENAI_API_KEY.');
    process.exit(1);
  }

  console.log('Running one email poll cycle...');
  await pollEmails();
  console.log('\nDone. Check server logs for classification, AI replies, and any errors.');
}

main().catch((error) => {
  console.error('Email agent test failed:', error.message);
  process.exit(1);
});
