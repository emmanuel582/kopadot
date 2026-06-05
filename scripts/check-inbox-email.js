import { ConfidentialClientApplication } from '@azure/msal-node';
import { Client } from '@microsoft/microsoft-graph-client';
import 'isomorphic-fetch';
import env from '../src/config/env.js';

const SEARCH_FROM = 'emmanuelwritecode@gmail.com';
const SEARCH_SUBJECT = 'Order Issue';

async function main() {
  const cca = new ConfidentialClientApplication({
    auth: {
      clientId: env.msGraphClientId,
      authority: `https://login.microsoftonline.com/${env.msGraphTenantId}`,
      clientSecret: env.msGraphClientSecret,
    },
  });

  const client = Client.init({
    authProvider: async (done) => {
      const r = await cca.acquireTokenByClientCredential({
        scopes: ['https://graph.microsoft.com/.default'],
      });
      done(null, r.accessToken);
    },
  });

  const mailbox = env.msGraphUserId;
  console.log(`Mailbox: ${mailbox}\n`);

  const fromSearch = await client
    .api(`/users/${mailbox}/messages`)
    .filter(`from/emailAddress/address eq '${SEARCH_FROM}'`)
    .select('id,subject,from,receivedDateTime,isRead,bodyPreview')
    .top(10)
    .get();

  console.log(`--- From ${SEARCH_FROM} (${fromSearch.value?.length || 0}) ---`);
  for (const m of fromSearch.value || []) {
    console.log(JSON.stringify({
      subject: m.subject,
      received: m.receivedDateTime,
      isRead: m.isRead,
      preview: m.bodyPreview?.slice(0, 120),
    }, null, 2));
  }

  const recent = await client
    .api(`/users/${mailbox}/messages`)
    .select('id,subject,from,receivedDateTime,isRead,bodyPreview')
    .top(50)
    .orderby('receivedDateTime desc')
    .get();

  const orderIssue = (recent.value || []).filter(
    (m) => m.subject?.toLowerCase().includes('order issue')
      || m.from?.emailAddress?.address?.toLowerCase() === SEARCH_FROM,
  );

  console.log(`\n--- Recent Order Issue / Emmanuel emails in last 50 ---`);
  for (const m of orderIssue) {
    console.log(JSON.stringify({
      subject: m.subject,
      from: m.from?.emailAddress?.address,
      received: m.receivedDateTime,
      isRead: m.isRead,
      preview: m.bodyPreview?.slice(0, 120),
    }, null, 2));
  }

  const unread = await client
    .api(`/users/${mailbox}/messages`)
    .filter('isRead eq false')
    .select('id,subject,from,receivedDateTime')
    .top(30)
    .get();

  const unreadMatch = (unread.value || []).filter(
    (m) => m.from?.emailAddress?.address?.toLowerCase() === SEARCH_FROM
      || m.subject?.toLowerCase().includes('order issue'),
  );

  console.log(`\n--- Unread matching (${unreadMatch.length} of ${unread.value?.length || 0} unread) ---`);
  for (const m of unreadMatch) {
    console.log(JSON.stringify({
      subject: m.subject,
      from: m.from?.emailAddress?.address,
      received: m.receivedDateTime,
    }, null, 2));
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
