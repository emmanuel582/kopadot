import { ConfidentialClientApplication } from '@azure/msal-node';
import { Client } from '@microsoft/microsoft-graph-client';
import 'isomorphic-fetch';
import env from '../src/config/env.js';

const TEST_RECIPIENT = 'emmanuelwritecode@gmail.com';

/**
 * Send a one-off test email via Microsoft Graph to verify Mail.Send works.
 *
 * Usage:
 *   node scripts/test-send-email.js
 */
async function createGraphClient() {
  const msalConfig = {
    auth: {
      clientId: env.msGraphClientId,
      authority: `https://login.microsoftonline.com/${env.msGraphTenantId}`,
      clientSecret: env.msGraphClientSecret,
    },
  };

  const cca = new ConfidentialClientApplication(msalConfig);

  const authProvider = async (done) => {
    try {
      const authResponse = await cca.acquireTokenByClientCredential({
        scopes: ['https://graph.microsoft.com/.default'],
      });
      done(null, authResponse.accessToken);
    } catch (error) {
      done(error, null);
    }
  };

  return Client.init({ authProvider });
}

async function sendTestEmail() {
  console.log('KopaDot — send test email');
  console.log(`From mailbox: ${env.msGraphUserId || '(not set)'}`);
  console.log(`To:           ${TEST_RECIPIENT}`);
  console.log('');

  if (!env.msGraphTenantId || !env.msGraphClientId || !env.msGraphClientSecret || !env.msGraphUserId) {
    console.error('Missing Microsoft Graph env vars. Set MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID, MS_GRAPH_CLIENT_SECRET, MS_GRAPH_USER_ID.');
    process.exit(1);
  }

  const client = await createGraphClient();
  const timestamp = new Date().toISOString();

  const payload = {
    message: {
      subject: `KopaDot test email — ${timestamp}`,
      body: {
        contentType: 'HTML',
        content: [
          '<p>Hi Emmanuel,</p>',
          '<p>This is a test email from the KopaDot support agent.</p>',
          `<p>If you received this, Microsoft Graph <strong>Mail.Send</strong> is working correctly.</p>`,
          `<p><small>Sent at ${timestamp}</small></p>`,
        ].join('\n'),
      },
      toRecipients: [
        {
          emailAddress: {
            address: TEST_RECIPIENT,
            name: 'Emmanuel',
          },
        },
      ],
    },
    saveToSentItems: true,
  };

  console.log('Sending...');
  await client
    .api(`/users/${env.msGraphUserId}/sendMail`)
    .post(payload);

  console.log(`\n✅ Test email sent to ${TEST_RECIPIENT}`);
  console.log('Check the inbox (and spam folder) in a minute or two.');
}

sendTestEmail().catch((error) => {
  console.error(`\n❌ Failed to send test email: ${error.message}`);
  if (/Access is denied/i.test(error.message)) {
    console.error('Hint: ensure the Azure app has Mail.Send (application) permission with admin consent.');
  }
  process.exit(1);
});
