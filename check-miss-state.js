import axios from "axios";
import { readFileSync } from "fs";

const shopifyToken = process.env.SHOPIFY_TOKEN;
const shopifyBase = "https://beerhatch-com.myshopify.com/admin/api/2024-04";
const shopifyHeaders = {
  "X-Shopify-Access-Token": shopifyToken,
  "Content-Type": "application/json",
};
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

const missState = JSON.parse(readFileSync("public/sync-state.json", "utf8"));
const missSkus = Object.keys(missState).filter((k) => k.startsWith("UT-"));
console.log(`sync-state.json has ${missSkus.length} SKUs at risk of hitting a 2nd miss.`);

const products = await fetchAllProducts("id,title,status,variants");
const bySku = new Map();
for (const p of products) {
  for (const v of p.variants || []) {
    if (v.sku) bySku.set(v.sku, { productId: p.id, title: p.title, status: p.status });
  }
}

let active = [];
let archived = [];
let notFound = [];
for (const sku of missSkus) {
  const info = bySku.get(sku);
  if (!info) { notFound.push(sku); continue; }
  if (info.status === "active") active.push({ sku, ...info });
  else archived.push({ sku, ...info });
}

console.log(`\nAlready archived (harmless): ${archived.length}`);
console.log(`Not found in catalog at all: ${notFound.length}`);
console.log(`\n*** STILL ACTIVE — at real risk of wrongful archiving next run: ${active.length} ***`);
for (const a of active) {
  console.log(`  ${a.sku} — ${a.title} (product ${a.productId})`);
}
