import axios from "axios";

const shopifyToken = process.env.SHOPIFY_TOKEN;
const shopifyBase = "https://beerhatch-com.myshopify.com/admin/api/2024-04";
const shopifyHeaders = { "X-Shopify-Access-Token": shopifyToken };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fetchAllProducts = async (fields) => {
  const all = [];
  let url = `${shopifyBase}/products.json?limit=250&fields=${fields}`;
  while (url) {
    const res = await axios.get(url, { headers: shopifyHeaders });
    all.push(...(res.data.products || []));
    const link = res.headers["link"];
    const match = link && link.match(/<([^>]+)>;\s*rel="next"/);
    url = match ? match[1] : null;
    if (url) await sleep(500);
  }
  return all;
};

const products = await fetchAllProducts("id,title,status,created_at,variants");
console.log(`Total products: ${products.length}`);

const skuCounts = new Map();
const noSku = [];

for (const p of products) {
  for (const v of p.variants || []) {
    if (!v.sku || !v.sku.trim()) {
      noSku.push({ productId: p.id, title: p.title, status: p.status, createdAt: p.created_at });
      continue;
    }
    const sku = v.sku.trim();
    if (!skuCounts.has(sku)) skuCounts.set(sku, []);
    skuCounts.get(sku).push({ productId: p.id, title: p.title, status: p.status });
  }
}

console.log(`\nVariants with no SKU at all: ${noSku.length}`);
for (const p of noSku) {
  console.log(`  ${p.productId} — "${p.title}" (status: ${p.status}, created ${p.createdAt})`);
}

const dupeSkus = [...skuCounts.entries()].filter(([, list]) => list.length > 1);
console.log(`\nSKUs shared by more than one product: ${dupeSkus.length}`);
for (const [sku, list] of dupeSkus) {
  console.log(`  ${sku}:`);
  for (const p of list) console.log(`    ${p.productId} — "${p.title}" (status: ${p.status})`);
}
