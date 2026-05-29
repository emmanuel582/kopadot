import { ConfidentialClientApplication } from '@azure/msal-node';
import { Client } from '@microsoft/microsoft-graph-client';
import 'isomorphic-fetch';
import env from '../src/config/env.js';

/**
 * Basic script to verify Microsoft Graph authentication
 * and check if we can read emails.
 */
async function testEmailGraphApi() {
  console.log('Testing MS Graph API Authentication...');
  console.log(`Tenant ID: ${env.msGraphTenantId}`);
  console.log(`Client ID: ${env.msGraphClientId}`);
  console.log(`User ID (Mailbox): ${env.msGraphUserId}`);

  if (!env.msGraphTenantId || !env.msGraphClientId || !env.msGraphClientSecret || !env.msGraphUserId) {
    console.error('Missing required Microsoft Graph environment variables.');
    return;
  }

  try {
    const msalConfig = {
      auth: {
        clientId: env.msGraphClientId,
        authority: `https://login.microsoftonline.com/${env.msGraphTenantId}`,
        clientSecret: env.msGraphClientSecret,
      }
    };

    const cca = new ConfidentialClientApplication(msalConfig);

    const authProvider = async (done) => {
      try {
        const authResponse = await cca.acquireTokenByClientCredential({
          scopes: ['https://graph.microsoft.com/.default'],
        });
        console.log('Successfully acquired access token!');
        done(null, authResponse.accessToken);
      } catch (error) {
        console.error('Failed to acquire token:', error.message);
        done(error, null);
      }
    };

    const client = Client.init({
      authProvider,
    });

    console.log(`Fetching emails for ${env.msGraphUserId}...`);
    const response = await client
      .api(`/users/${env.msGraphUserId}/messages`)
      .top(2)
      .select('subject,from,isRead')
      .get();

    console.log('Recent Emails:');
    console.log(JSON.stringify(response.value, null, 2));
    
    console.log('\\n✅ Microsoft Graph API test completed successfully.');
  } catch (error) {
    console.error('❌ Error during Microsoft Graph API test:', error.message);
  }
}

testEmailGraphApi();
