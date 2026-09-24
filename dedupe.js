import axios from "axios";

const shopifyToken = process.env.SHOPIFY_TOKEN;
const shopifyBase = "https://beerhatch-com.myshopify.com/admin/api/2024-04";
const shopifyHeaders = {
  "X-Shopify-Access-Token": shopifyToken,
  "Content-Type": "application/json",
};
const APPLY = process.env.APPLY === "true";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same pagination approach as sync.js's fetchAllProducts.
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

const products = await fetchAllProducts("id,title,created_at,variants,status");

// sync.js always sets variant.sku = `UT-${untappdItemId}` on every create path,
// deterministically from Untappd's own item id — so two products sharing a SKU
// are unambiguously the same beer, never a legitimate coincidence.
const bySku = new Map();
for (const p of products) {
  for (const v of p.variants || []) {
    if (!v.sku || !v.sku.startsWith("UT-")) continue;
    if (!bySku.has(v.sku)) bySku.set(v.sku, []);
    bySku.get(v.sku).push({ productId: p.id, title: p.title, createdAt: p.created_at, status: p.status });
  }
}

const duplicateGroups = [...bySku.entries()].filter(([, list]) => list.length > 1);
console.log(`Found ${duplicateGroups.length} SKUs with more than one product.\n`);

const toDelete = [];
for (const [sku, list] of duplicateGroups) {
  list.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const [keep, ...dupes] = list;
  console.log(`SKU ${sku}: keeping ${keep.productId} (${keep.title}, created ${keep.createdAt})`);
  for (const d of dupes) {
    console.log(`  duplicate: ${d.productId} (${d.title}, created ${d.createdAt}, status ${d.status})`);
    toDelete.push(d);
  }
}

console.log(`\nTotal duplicates identified: ${toDelete.length}`);

if (!APPLY) {
  console.log("\nDry run — nothing deleted. Re-run with apply=true to actually delete the duplicates listed above.");
} else {
  console.log("\nApplying — deleting duplicates now.");
  let deleted = 0;
  let failed = 0;
  for (const d of toDelete) {
    try {
      await axios.delete(`${shopifyBase}/products/${d.productId}.json`, { headers: shopifyHeaders });
      console.log(`Deleted ${d.productId} (${d.title})`);
      deleted++;
    } catch (err) {
      console.log(`Failed to delete ${d.productId} (${d.title}): ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`);
      failed++;
    }
    await sleep(500);
  }
  console.log(`\nDone. Deleted ${deleted}, failed ${failed}.`);
}
