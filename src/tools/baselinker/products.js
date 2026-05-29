import { baselinkerRequest } from './client.js';
import env from '../../config/env.js';
import logger from '../../middleware/logger.js';

/**
 * BaseLinker Product Tools
 *
 * Product catalog, inventory, and stock availability tools.
 *
 * IMPORTANT: BaseLinker returns products as OBJECTS (keyed by product ID),
 * not as arrays. All handlers must account for this.
 */

/**
 * Get detailed product information by product ID.
 * @param {object} params - { product_id: string }
 * @returns {object} Product details for the AI to narrate.
 */
export async function getProductInfo({ product_id }) {
  logger.info(`Getting product info: ${product_id}`);
  const numericProductId = parseInt(product_id, 10);
  const inventoryId = env.baselinkerInventoryId;

  try {
    if (!inventoryId) {
      return {
        found: false,
        message: 'Product catalog is not configured. Please contact support for product information.',
      };
    }

    // getInventoryProductsData: products param is an array of ints
    const data = await baselinkerRequest('getInventoryProductsData', {
      inventory_id: inventoryId,
      products: [numericProductId],
    });

    const products = data.products || {};
    const productKeys = Object.keys(products);

    if (productKeys.length === 0) {
      return {
        found: false,
        message: `No product found with ID "${product_id}".`,
      };
    }

    const pid = productKeys[0];
    const product = products[pid];
    return formatProductDetail(pid, product);
  } catch (error) {
    logger.error(`Failed to get product info: ${error.message}`);
    return {
      found: false,
      message: `Unable to retrieve product information for ID "${product_id}". Error: ${error.message}`,
    };
  }
}

/**
 * Search the product catalog by name or keywords.
 * @param {object} params - { query: string, category_id?: string, required_features?: string[], max_price?: number, in_stock_only?: boolean }
 * @returns {object} Matching products.
 */
export async function searchProducts({ query, category_id, required_features = [], max_price, in_stock_only }) {
  logger.info(`Searching products: "${query}"${category_id ? ` in category ${category_id}` : ''}`);
  const inventoryId = env.baselinkerInventoryId;

  try {
    if (!inventoryId) {
      return {
        found: false,
        count: 0,
        message: 'Product catalog is not configured.',
      };
    }

    const params = {
      inventory_id: inventoryId,
      filter_name: query,
      page: 1,
    };

    if (category_id) {
      params.filter_category_id = parseInt(category_id, 10);
    }

    const data = await baselinkerRequest('getInventoryProductsList', params);

    // BaseLinker returns products as an OBJECT { "id": {...}, "id2": {...} }
    const productsObj = data.products || {};
    let productEntries = Object.entries(productsObj);

    // Apply smart in-memory filtering
    productEntries = productEntries.filter(([pid, p]) => {
      const name = extractProductName(p).toLowerCase();
      // Description is often in text_fields or description field
      const desc = (p.description || p.text_fields?.description || '').toLowerCase();
      const price = extractProductPrice(p);
      const stock = calculateTotalStock(p);

      // 1. Price Filter
      if (max_price !== undefined && max_price !== null && typeof price === 'number') {
        if (price > max_price) return false;
      }

      // 2. Stock Filter
      if (in_stock_only && stock <= 0) return false;

      // 3. Deep Feature Filter (ALL required features must match name or desc)
      if (Array.isArray(required_features) && required_features.length > 0) {
        for (const feature of required_features) {
          const f = feature.toLowerCase();
          if (!name.includes(f) && !desc.includes(f)) {
            return false;
          }
        }
      }

      return true;
    });

    if (productEntries.length === 0) {
      return {
        found: false,
        count: 0,
        message: `No products found matching "${query}" with your specific filters.`,
      };
    }

    return formatProductSearchResults(productEntries, query);
  } catch (error) {
    logger.error(`Product search failed: ${error.message}`);
    return {
      found: false,
      count: 0,
      message: `Unable to search products at this time. Error: ${error.message}`,
    };
  }
}

/**
 * Check real-time stock availability for a product.
 * Uses getInventoryProductsData which includes stock info.
 * @param {object} params - { product_id: string }
 * @returns {object} Stock information.
 */
export async function checkStock({ product_id }) {
  logger.info(`Checking stock for product: ${product_id}`);
  const numericProductId = parseInt(product_id, 10);
  const inventoryId = env.baselinkerInventoryId;

  try {
    if (!inventoryId) {
      return {
        found: false,
        message: 'Inventory is not configured.',
      };
    }

    // Use getInventoryProductsData which includes stock info per product
    const data = await baselinkerRequest('getInventoryProductsData', {
      inventory_id: inventoryId,
      products: [numericProductId],
    });

    const productsObj = data.products || {};
    const productKeys = Object.keys(productsObj);

    if (productKeys.length === 0) {
      return {
        found: false,
        message: `No product found with ID "${product_id}".`,
      };
    }

    const pid = productKeys[0];
    const product = productsObj[pid];

    // Stock is an object: { "warehouse_id": quantity, ... }
    const stockObj = product.stock || {};
    const warehouses = Object.entries(stockObj).map(([warehouseId, qty]) => ({
      warehouse_id: warehouseId,
      quantity: typeof qty === 'number' ? qty : parseInt(qty, 10) || 0,
    }));

    const totalStock = warehouses.reduce((sum, w) => sum + w.quantity, 0);
    const productName = extractProductName(product);

    return {
      found: true,
      product_id: pid,
      product_name: productName,
      total_stock: totalStock,
      is_in_stock: totalStock > 0,
      warehouses,
      message: totalStock > 0
        ? `${productName} (ID: ${pid}) is in stock with ${totalStock} unit(s) available.`
        : `${productName} (ID: ${pid}) is currently out of stock.`,
    };
  } catch (error) {
    logger.error(`Stock check failed: ${error.message}`);
    return {
      found: false,
      message: `Unable to check stock for product "${product_id}". Error: ${error.message}`,
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Extract the product name from BaseLinker's product data.
 * The name can be in different locations depending on catalog config.
 */
function extractProductName(product) {
  // Direct name field
  if (product.name && typeof product.name === 'string' && product.name.trim()) {
    return product.name.trim();
  }

  // text_fields might contain localized names
  if (product.text_fields) {
    // Try common keys
    const tf = product.text_fields;
    for (const key of Object.keys(tf)) {
      if (key === 'name' || key.startsWith('name|') || key.startsWith('name/')) {
        if (tf[key] && typeof tf[key] === 'string' && tf[key].trim()) {
          return tf[key].trim();
        }
      }
    }
    // Fallback: first text field value
    const firstKey = Object.keys(tf)[0];
    if (firstKey && tf[firstKey] && typeof tf[firstKey] === 'string') {
      return tf[firstKey].trim();
    }
  }

  return 'Unknown Product';
}

/**
 * Extract the price from BaseLinker's product data.
 * Prices are stored as { "price_group_id": price_value }.
 */
function extractProductPrice(product) {
  // Direct price fields
  if (product.price_brutto != null) return product.price_brutto;
  if (product.price_netto != null) return product.price_netto;

  // Prices object (BaseLinker Inventory format)
  if (product.prices && typeof product.prices === 'object') {
    const priceValues = Object.values(product.prices);
    if (priceValues.length > 0) {
      // Return the first (default) price
      return parseFloat(priceValues[0]) || 0;
    }
  }

  return 'N/A';
}

/**
 * Calculate total stock from BaseLinker's stock object.
 */
function calculateTotalStock(product) {
  // Direct quantity field
  if (product.quantity != null) return product.quantity;

  // Stock object: { "warehouse_id": quantity }
  if (product.stock && typeof product.stock === 'object') {
    return Object.values(product.stock)
      .reduce((sum, qty) => sum + (typeof qty === 'number' ? qty : parseInt(qty, 10) || 0), 0);
  }

  return 0;
}

/**
 * Format a single product's full details.
 */
function formatProductDetail(pid, product) {
  const name = extractProductName(product);
  const price = extractProductPrice(product);
  const totalStock = calculateTotalStock(product);

  // Extract images
  let images = [];
  if (product.images) {
    if (Array.isArray(product.images)) {
      images = product.images.slice(0, 3);
    } else if (typeof product.images === 'object') {
      images = Object.values(product.images).slice(0, 3);
    }
  }

  // Extract variants
  let variants = [];
  if (Array.isArray(product.variants)) {
    variants = product.variants.map(v => ({
      id: v.variant_id,
      name: v.name || 'N/A',
      price: v.price || price,
      quantity: v.quantity || 0,
    }));
  }

  return {
    found: true,
    product_id: pid,
    name,
    sku: product.sku || 'N/A',
    ean: product.ean || 'N/A',
    description: product.description ||
      (product.text_fields?.description) ||
      (product.text_fields ? Object.entries(product.text_fields).find(([k]) =>
        k.startsWith('description'))?.[1] : null) ||
      'No description available.',
    price,
    tax_rate: product.tax_rate || 0,
    weight: product.weight || 'N/A',
    category: product.category || product.category_id || 'Uncategorised',
    images,
    variants,
    stock: totalStock,
    is_in_stock: totalStock > 0,
    message: `Product: ${name} — Price: ${price} — ${totalStock > 0 ? `In stock (${totalStock} available)` : 'Out of stock'}`,
  };
}

/**
 * Format product search results from BaseLinker's object format.
 */
function formatProductSearchResults(productEntries, query) {
  const products = productEntries.slice(0, 10).map(([pid, p]) => {
    const name = extractProductName(p);
    const price = extractProductPrice(p);
    const stock = calculateTotalStock(p);

    return {
      product_id: pid,
      name,
      sku: p.sku || 'N/A',
      ean: p.ean || 'N/A',
      price,
      stock,
      is_in_stock: stock > 0,
    };
  });

  return {
    found: true,
    count: productEntries.length,
    products,
    message: `Found ${productEntries.length} product(s) matching "${query}".`,
  };
}

export default { getProductInfo, searchProducts, checkStock };
