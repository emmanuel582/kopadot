import { searchProducts } from '../src/tools/baselinker/products.js';

searchProducts({
  query: 'samsung',
  required_features: ['5G', 'Dual SIM', 'FE']
}).then(console.log).catch(console.error);
