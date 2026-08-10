import axios from "axios";

const shopifyToken = process.env.SHOPIFY_TOKEN;
const shopifyBase = "https://beerhatch-com.myshopify.com/admin/api/2024-04";
const shopifyHeaders = { "X-Shopify-Access-Token": shopifyToken };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const extractError = (err) => {
  const body = err.response?.data;
  if (body?.errors) return JSON.stringify(body.errors);
  if (body?.error) return body.error;
  return err.message || "Unknown error";
};

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

console.log("Fetching full catalog...");
const products = await fetchAllProducts("id,title");
console.log(`Fetched ${products.length} products.`);

const byTitle = new Map();
for (const prod of products) {
  const key = prod.title.trim().toLowerCase();
  if (!byTitle.has(key)) byTitle.set(key, []);
  byTitle.get(key).push(prod);
}

const groups = [...byTitle.values()].filter((g) => g.length > 1);
if (groups.length === 0) {
  console.log("No duplicate products found. Nothing to do.");
  process.exit(0);
}

let totalDeleted = 0;
let totalFailed = 0;

for (const group of groups) {
  group.sort((a, b) => a.id - b.id);
  const [keep, ...remove] = group;
  console.log(`\n${group[0].title}: keeping ${keep.id}, deleting ${remove.length} duplicate(s)`);

  for (const dupe of remove) {
    try {
      await axios.delete(`${shopifyBase}/products/${dupe.id}.json`, { headers: shopifyHeaders });
      console.log(`  Deleted ${dupe.id}`);
      totalDeleted++;
    } catch (err) {
      console.log(`  Failed to delete ${dupe.id}: ${extractError(err)}`);
      totalFailed++;
    }
    await sleep(550);
  }
}

console.log(`\n--- Cleanup complete ---`);
console.log(`Deleted: ${totalDeleted}`);
console.log(`Failed: ${totalFailed}`);
