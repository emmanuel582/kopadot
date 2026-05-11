import 'dotenv/config';
import { baselinkerRequest } from '../src/tools/baselinker/client.js';

async function getOrders() {
  try {
    const response = await baselinkerRequest('getOrders', {
      limit: 5
    });
    console.log(JSON.stringify(response.orders || [], null, 2));
    
    const statuses = await baselinkerRequest('getOrderStatusList');
    console.log(JSON.stringify(statuses.statuses || {}, null, 2));
  } catch (err) {
    console.error(err);
  }
}

getOrders();
