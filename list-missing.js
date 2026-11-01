import axios from "axios";

// Read-only: lists ACTIVE Shopify products whose UT-<id> SKU isn't on the
// current Untappd menu — i.e. what the archive pass would archive. Changes
// nothing on Shopify and doesn't touch sync-state.json.
const utEmail = process.env.UT_EMAIL;
const utToken = process.env.UT_TOKEN;
const shopifyToken = process.env.SHOPIFY_TOKEN;
const tokenBuffer = Buffer.from(`${utEmail}:${utToken}`).toString("base64");
const shopifyBase = "https://beerhatch-com.myshopify.com/admin/api/2024-04";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const utRes = await axios.get(
  "https://business.untappd.com/api/v1/menus/112250?full=true",
  { headers: { Authorization: `Basic ${tokenBuffer}` } }
);
const sections = utRes.data.menu?.sections || [];
const menuSkus = new Set(sections.flatMap(s => (s.items || []).map(i => `UT-${i.id}`)));
console.log(`Untappd Can menu: ${menuSkus.size} items across ${sections.length} sections`);
for (const s of sections) console.log(`  ${s.name}: ${(s.items || []).length}`);

const products = [];
let url = `${shopifyBase}/products.json?limit=250&status=active&fields=id,title,status,variants,updated_at`;
while (url) {
  const res = await axios.get(url, { headers: { "X-Shopify-Access-Token": shopifyToken } });
  products.push(...(res.data.products || []));
  const link = res.headers["link"];
  const match = link && link.match(/<([^>]+)>;\s*rel="next"/);
  url = match ? match[1] : null;
  if (url) await sleep(500);
}

const missing = products
  .filter(p => p.status === "active")
  .map(p => ({ p, skus: (p.variants || []).map(v => v.sku).filter(s => s && s.startsWith("UT-")) }))
  .filter(({ skus }) => skus.length && !skus.some(s => menuSkus.has(s)))
  .sort((a, b) => a.p.title.localeCompare(b.p.title));

console.log(`\nActive Shopify products: ${products.length}`);
console.log(`Active products NOT on the Untappd menu (would be archived): ${missing.length}\n`);
for (const { p, skus } of missing) {
  console.log(`${p.title} | ${skus.join(", ")} | Shopify ID ${p.id}`);
}
