/**
 * Bulk photo uploader for Beer Hatch Shopify products.
 *
 * Usage:
 *   node upload-photos.js [path/to/photos/folder]
 *
 * Naming convention for photo files:
 *   - Best match: "Brewery Name — Beer Name.jpg"  (matches the full Shopify product title)
 *   - Partial match: "Beer Name.jpg"               (matched against the beer name portion)
 *
 * Supported formats: jpg, jpeg, png, webp, gif
 *
 * Products that already have an image are skipped.
 * Set OVERWRITE=true to replace existing images.
 */

import axios from "axios";
import fs from "fs";
import path from "path";

const shopifyToken = process.env.SHOPIFY_TOKEN;
const shopifyBase = "https://beerhatch-com.myshopify.com/admin/api/2024-04";
const shopifyHeaders = {
  "X-Shopify-Access-Token": shopifyToken,
  "Content-Type": "application/json",
};
const overwrite = process.env.OVERWRITE === "true";
const photosDir = process.argv[2] || "./photos";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const extractError = (err) => {
  const body = err.response?.data;
  if (body?.errors) return JSON.stringify(body.errors);
  if (body?.error) return body.error;
  return err.message || "Unknown error";
};

if (!fs.existsSync(photosDir)) {
  console.error(`Photos folder not found: ${photosDir}`);
  console.error(`Create a folder called "photos" and drop your beer images in it, then re-run.`);
  process.exit(1);
}

const imageFiles = fs.readdirSync(photosDir).filter(f =>
  /\.(jpg|jpeg|png|webp|gif)$/i.test(f)
);

if (imageFiles.length === 0) {
  console.log(`No image files found in ${photosDir}`);
  process.exit(0);
}

console.log(`Found ${imageFiles.length} image(s). Fetching Shopify products...`);

// Fetch all products
let products = [];
try {
  const res = await axios.get(
    `${shopifyBase}/products.json?limit=250&fields=id,title,images`,
    { headers: shopifyHeaders }
  );
  products = res.data.products || [];
} catch (err) {
  console.error(`Failed to fetch products: ${extractError(err)}`);
  process.exit(1);
}

// Build lookup maps
const byFullTitle = new Map();  // "brewery — beer name" (lowercase) → product
const byBeerName = new Map();   // "beer name" portion (lowercase) → product

for (const prod of products) {
  const fullTitle = prod.title.trim().toLowerCase();
  byFullTitle.set(fullTitle, prod);

  // Extract the beer name part after " — "
  const dashIdx = prod.title.indexOf(" — ");
  if (dashIdx !== -1) {
    const beerPart = prod.title.slice(dashIdx + 3).trim().toLowerCase();
    byBeerName.set(beerPart, prod);
  }
}

const results = { uploaded: 0, skipped: 0, noMatch: 0, failed: 0 };

for (const file of imageFiles) {
  const nameWithoutExt = path.basename(file, path.extname(file)).trim();
  const nameLower = nameWithoutExt.toLowerCase();

  // Match: full title first, then beer name portion
  const product = byFullTitle.get(nameLower) || byBeerName.get(nameLower);

  if (!product) {
    console.log(`  [NO MATCH]  ${file}`);
    results.noMatch++;
    continue;
  }

  const hasImage = (product.images || []).length > 0;
  if (hasImage && !overwrite) {
    console.log(`  [SKIP]      ${file} → ${product.title} (already has image)`);
    results.skipped++;
    continue;
  }

  try {
    const imageBuffer = fs.readFileSync(path.join(photosDir, file));
    const attachment = imageBuffer.toString("base64");

    await axios.post(
      `${shopifyBase}/products/${product.id}/images.json`,
      { image: { attachment, filename: file } },
      { headers: shopifyHeaders }
    );

    console.log(`  [UPLOADED]  ${file} → ${product.title}`);
    results.uploaded++;
  } catch (err) {
    console.log(`  [FAILED]    ${file} → ${product.title}: ${extractError(err)}`);
    results.failed++;
  }

  await sleep(400);
}

console.log("\n--- Upload complete ---");
console.log(`Uploaded:  ${results.uploaded}`);
console.log(`Skipped:   ${results.skipped}`);
console.log(`No match:  ${results.noMatch}`);
console.log(`Failed:    ${results.failed}`);

if (results.noMatch > 0) {
  console.log(`\nTip: rename unmatched files to match the product title (e.g. "Gamma Ray.jpg" or "Beavertown — Gamma Ray.jpg")`);
}
