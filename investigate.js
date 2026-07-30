import axios from "axios";

const utEmail = process.env.UT_EMAIL;
const utToken = process.env.UT_TOKEN;
const shopifyToken = process.env.SHOPIFY_TOKEN;
const tokenBuffer = Buffer.from(`${utEmail}:${utToken}`).toString("base64");
const shopifyBase = "https://beerhatch-com.myshopify.com/admin/api/2024-04";
const SEARCH = (process.env.SEARCH || "radler").toLowerCase();

// --- Shopify: find matching products ---
console.log(`\n=== SHOPIFY: products matching "${SEARCH}" ===`);
const shopRes = await axios.get(
  `${shopifyBase}/products.json?limit=250&fields=id,title,tags,variants,created_at,updated_at`,
  { headers: { "X-Shopify-Access-Token": shopifyToken } }
);
const matches = (shopRes.data.products || []).filter(p =>
  p.title.toLowerCase().includes(SEARCH)
);
if (!matches.length) {
  console.log("No matching Shopify products found.");
} else {
  for (const p of matches) {
    console.log(`\nTitle:   ${p.title}`);
    console.log(`ID:      ${p.id}`);
    console.log(`Tags:    ${p.tags}`);
    console.log(`Created: ${p.created_at}`);
    for (const v of p.variants) {
      console.log(`  Variant — SKU: ${v.sku || "(none)"}  |  Option: ${v.option1 || "(none)"}  |  Price: £${v.price}`);
    }
  }
}

// --- Untappd: find matching items across all menu sections ---
console.log(`\n=== UNTAPPD (Can menu): items matching "${SEARCH}" ===`);
const utRes = await axios.get(
  "https://business.untappd.com/api/v1/menus/112250?full=true",
  { headers: { Authorization: `Basic ${tokenBuffer}` } }
);
const sections = utRes.data.menu?.sections || [];
const utMatches = sections.flatMap(s =>
  (s.items || [])
    .filter(i => (i.name || "").toLowerCase().includes(SEARCH))
    .map(i => ({ ...i, sectionName: s.name }))
);
if (!utMatches.length) {
  console.log("No matching items in Untappd Can menu.");
} else {
  for (const i of utMatches) {
    console.log(`\nName:     ${i.name}`);
    console.log(`Brewery:  ${i.brewery_name || i.brewery}`);
    console.log(`Item ID:  ${i.id}  (Shopify SKU would be: UT-${i.id})`);
    console.log(`Section:  ${i.sectionName}`);
    console.log(`Style:    ${i.style}  |  ABV: ${i.abv}%`);
    for (const c of (i.containers || [])) {
      console.log(`  Container — ${c.container_size?.name || "?"} | Price: £${c.price}`);
    }
  }
}
