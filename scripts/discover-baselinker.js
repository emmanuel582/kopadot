/**
 * Quick discovery script — fetches real IDs from your BaseLinker account
 * so we can build test scenarios using actual data.
 */
import 'dotenv/config';
import axios from 'axios';

const TOKEN = process.env.BASELINKER_API_TOKEN;
const ENDPOINT = 'https://api.baselinker.com/connector.php';

async function bl(method, parameters = {}) {
  const res = await axios.post(
    ENDPOINT,
    new URLSearchParams({ method, parameters: JSON.stringify(parameters) }),
    { headers: { 'X-BLToken': TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 },
  );
  if (res.data.status === 'ERROR') throw new Error(`${method}: ${res.data.error_message}`);
  return res.data;
}

async function run() {
  console.log('=== BaseLinker Discovery ===\n');

  // 1. Get recent orders
  console.log('--- Recent Orders ---');
  try {
    const ordersData = await bl('getOrders', { date_from: 0, get_unconfirmed_orders: false });
    const orders = (ordersData.orders || []).slice(0, 5);
    for (const o of orders) {
      console.log(`  Order #${o.order_id} | ${o.email || 'no-email'} | ${o.phone || 'no-phone'} | Status: ${o.order_status_id} | Items: ${(o.products || []).length} | Date: ${new Date(o.date_add * 1000).toISOString()}`);
    }
    if (orders.length === 0) console.log('  (no orders found)');
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }

  // 2. Get order statuses
  console.log('\n--- Order Statuses ---');
  try {
    const statusData = await bl('getOrderStatusList');
    for (const s of (statusData.statuses || [])) {
      console.log(`  Status ${s.id}: "${s.name}" (color: ${s.color})`);
    }
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }

  // 3. Get inventories
  console.log('\n--- Inventories ---');
  try {
    const invData = await bl('getInventories');
    for (const inv of (invData.inventories || [])) {
      console.log(`  Inventory ${inv.inventory_id}: "${inv.name}" (${inv.is_default ? 'DEFAULT' : 'secondary'})`);
    }
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }

  // 4. Try to get products from inventory
  console.log('\n--- Products (first inventory) ---');
  try {
    const invData = await bl('getInventories');
    const firstInv = (invData.inventories || [])[0];
    if (firstInv) {
      const prodData = await bl('getInventoryProductsList', { inventory_id: firstInv.inventory_id, page: 1 });
      const products = prodData.products || {};
      const keys = Object.keys(products).slice(0, 5);
      for (const k of keys) {
        const p = products[k];
        console.log(`  Product ${k}: "${p.name || p.text_fields?.name || 'unnamed'}" | SKU: ${p.sku || 'N/A'} | Price: ${p.price_brutto || p.prices?.['0'] || 'N/A'}`);
      }
      if (keys.length === 0) console.log('  (no products found)');
    } else {
      console.log('  (no inventories found)');
    }
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }

  // 5. Get couriers
  console.log('\n--- Couriers ---');
  try {
    const courierData = await bl('getOrderSources');
    const sources = courierData.sources || {};
    const keys = Object.keys(sources).slice(0, 5);
    for (const k of keys) {
      console.log(`  Source ${k}: ${JSON.stringify(sources[k])}`);
    }
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }

  console.log('\n=== Discovery Complete ===');
}

run().catch(e => { console.error('Discovery failed:', e.message); process.exit(1); });
