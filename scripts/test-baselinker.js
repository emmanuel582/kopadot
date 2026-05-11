import 'dotenv/config';
import { baselinkerRequest } from '../src/tools/baselinker/client.js';
import env from '../src/config/env.js';

async function run() {
  const summary = {
    connected: false,
    checks: [],
  };

  try {
    const statuses = await baselinkerRequest('getOrderStatusList');
    summary.checks.push({
      method: 'getOrderStatusList',
      ok: true,
      count: Object.keys(statuses.statuses || {}).length,
    });
    summary.connected = true;
  } catch (error) {
    summary.checks.push({
      method: 'getOrderStatusList',
      ok: false,
      error: error.message,
    });
  }

  try {
    const couriers = await baselinkerRequest('getCouriersList');
    summary.checks.push({
      method: 'getCouriersList',
      ok: true,
      count: (couriers.couriers || []).length,
    });
    summary.connected = true;
  } catch (error) {
    summary.checks.push({
      method: 'getCouriersList',
      ok: false,
      error: error.message,
    });
  }

  if (env.baselinkerInventoryId) {
    try {
      const products = await baselinkerRequest('getInventoryProductsList', {
        inventory_id: env.baselinkerInventoryId,
        page: 1,
        limit: 5,
      });
      summary.checks.push({
        method: 'getInventoryProductsList',
        ok: true,
        inventory_id: env.baselinkerInventoryId,
        count: (products.products || []).length,
      });
      summary.connected = true;
    } catch (error) {
      summary.checks.push({
        method: 'getInventoryProductsList',
        ok: false,
        inventory_id: env.baselinkerInventoryId,
        error: error.message,
      });
    }
  } else {
    summary.checks.push({
      method: 'getInventoryProductsList',
      ok: false,
      skipped: true,
      reason: 'BASELINKER_INVENTORY_ID not set',
    });
  }

  console.log(JSON.stringify(summary, null, 2));

  if (!summary.connected) {
    process.exit(1);
  }
}

run().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
