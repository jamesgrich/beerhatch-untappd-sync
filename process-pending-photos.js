import axios from "axios";
import fs from "fs";
import path from "path";

const shopifyToken = process.env.SHOPIFY_TOKEN;
const shopifyBase = "https://beerhatch-com.myshopify.com/admin/api/2024-04";
const shopifyHeaders = {
  "X-Shopify-Access-Token": shopifyToken,
  "Content-Type": "application/json",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pendingDir = "./pending-photos";
const files = fs.readdirSync(pendingDir).filter(f =>
  /\.(jpg|jpeg|png|webp|gif)$/i.test(f)
);

if (!files.length) {
  console.log("No pending photos to process.");
  process.exit(0);
}

console.log(`Found ${files.length} pending photo(s). Fetching Shopify products...`);

const res = await axios.get(
  `${shopifyBase}/products.json?limit=250&fields=id,title,images`,
  { headers: shopifyHeaders }
);
const products = res.data.products || [];

const byFullTitle = new Map();
const byBeerName = new Map();
const bySpaceTitle = new Map();
for (const prod of products) {
  byFullTitle.set(prod.title.trim().toLowerCase(), prod);
  const dashIdx = prod.title.indexOf(" — ");
  if (dashIdx !== -1) {
    const brewery = prod.title.slice(0, dashIdx).trim();
    const beer = prod.title.slice(dashIdx + 3).trim();
    byBeerName.set(beer.toLowerCase(), prod);
    bySpaceTitle.set(`${brewery} ${beer}`.toLowerCase(), prod);
  }
}

for (const file of files) {
  const nameWithoutExt = path.basename(file, path.extname(file)).trim()
    .replace(/ [–-] /g, ' — ');  // normalise hyphens/en-dashes to em-dash
  const nameLower = nameWithoutExt.toLowerCase();
  const product = byFullTitle.get(nameLower) || byBeerName.get(nameLower) || bySpaceTitle.get(nameLower);

  if (!product) {
    console.log(`NO MATCH: ${file} — rename to match a product title and re-upload`);
    continue;
  }

  if ((product.images || []).length > 0) {
    console.log(`SKIP: ${file} — ${product.title} already has an image`);
    fs.unlinkSync(path.join(pendingDir, file));
    continue;
  }

  try {
    const attachment = fs.readFileSync(path.join(pendingDir, file)).toString("base64");
    await axios.post(
      `${shopifyBase}/products/${product.id}/images.json`,
      { image: { attachment, filename: file } },
      { headers: shopifyHeaders }
    );
    console.log(`UPLOADED: ${file} → ${product.title}`);
    fs.unlinkSync(path.join(pendingDir, file));
  } catch (err) {
    const detail = err.response?.data?.errors || err.message;
    console.log(`FAILED: ${file} — ${JSON.stringify(detail)}`);
  }

  await sleep(400);
}
