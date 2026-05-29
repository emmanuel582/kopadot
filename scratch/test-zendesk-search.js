import env from '../src/config/env.js';
import { zendeskRequest } from '../src/tools/zendesk/client.js';

async function testSearch() {
  try {
    const data = await zendeskRequest('/api/v2/help_center/articles/search.json', { query: 'warranty' }, { requireAuth: true });
    console.log('Results count:', data.count);
    console.log('Results data:', data);
  } catch (err) {
    console.error(err);
  }
}

testSearch();
