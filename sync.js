import axios from "axios";

const utEmail = process.env.UT_EMAIL;
const utToken = process.env.UT_TOKEN;
const shopifyToken = process.env.SHOPIFY_TOKEN;
const tokenBuffer = Buffer.from(`${utEmail}:${utToken}`).toString("base64");
const shopifyBase = "https://beerhatch-com.myshopify.com/admin/api/2024-04";
const menuIds = [
  { id: "112250", label: "Can" },
  { id: "110590", label: "Draught" },
];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const shopifyHeaders = {
  "X-Shopify-Access-Token": shopifyToken,
  "Content-Type": "application/json",
};

const extractError = (err) => {
  const body = err.response?.data;
  if (body?.errors) return JSON.stringify(body.errors);
  if (body?.error) return body.error;
  return err.message || "Unknown error";
};

// --- MAP EXISTING CATALOG ---
console.log("Mapping existing catalog...");
const skuMap = new Map();

try {
  const res = await axios.get(
    `${shopifyBase}/products.json?limit=250&fields=id,variants`,
    { headers: shopifyHeaders }
  );
  for (const prod of (res.data.products || [])) {
    for (const variant of (prod.variants || [])) {
      if (variant.sku) {
        skuMap.set(variant.sku.trim(), {
          productId: prod.id,
          variantId: variant.id,
        });
      }
    }
  }
  console.log(`Mapped ${skuMap.size} existing variants.`);
} catch (err) {
  console.log(`Warning mapping catalog: ${extractError(err)}`);
}

const summary = {
  total_items_checked: 0,
  new_beers_added: 0,
  existing_beers_updated: 0,
  failed_items: 0,
};

// --- PROCESS MENUS ---
for (const menu of menuIds) {
  console.log(`Fetching Untappd menu ${menu.id} (${menu.label})...`);
  let utfbResponse;
  try {
    utfbResponse = await axios.get(
      `https://business.untappd.com/api/v1/menus/${menu.id}?full=true`,
      { headers: { "Authorization": `Basic ${tokenBuffer}` } }
    );
  } catch (err) {
    console.log(`Failed to fetch menu ${menu.id}: ${extractError(err)}`);
    continue;
  }

  const sections = utfbResponse.data.menu?.sections || [];

  for (const section of sections) {
    for (const item of (section.items || [])) {
      summary.total_items_checked++;
      const expectedSku = `UT-${item.id}`;
      const brewery = (item.brewery_name || item.brewery || "Unknown Brewery").trim();
      const beerName = (item.name || "Unknown Beer").trim();
      const sizeOptionValue = menu.label;
      const formattedTitle = `${brewery} — ${beerName}`;
      const bodyHtml = item.description || "";
      const tags = [
        `Style: ${item.style || "Beer"}`,
        `ABV: ${item.abv || 0}%`,
      ].join(", ");

      if (skuMap.has(expectedSku)) {
        const { productId, variantId } = skuMap.get(expectedSku);
        try {
          await axios.put(
            `${shopifyBase}/products/${productId}.json`,
            {
              product: {
                id: productId,
                title: formattedTitle,
                body_html: bodyHtml,
                vendor: brewery,
                tags,
                options: [{ name: "Size" }],
              },
            },
            { headers: shopifyHeaders }
          );

          await sleep(300);

          await axios.put(
            `${shopifyBase}/variants/${variantId}.json`,
            {
              variant: {
                id: variantId,
                sku: expectedSku,
                barcode: item.upc || "",
                option1: sizeOptionValue,
              },
            },
            { headers: shopifyHeaders }
          );

          summary.existing_beers_updated++;
          console.log(`Updated: ${formattedTitle}`);
        } catch (err) {
          summary.failed_items++;
          console.log(`Failed update for ${formattedTitle}: ${extractError(err)}`);
        }
      } else {
        try {
          const res = await axios.post(
            `${shopifyBase}/products.json`,
            {
              product: {
                title: formattedTitle,
                body_html: bodyHtml,
                vendor: brewery,
                product_type: "Beer",
                tags,
                status: "draft",
                options: [{ name: "Size" }],
                variants: [
                  {
                    sku: expectedSku,
                    barcode: item.upc || "",
                    inventory_management: "shopify",
                    option1: sizeOptionValue,
                  },
                ],
              },
            },
            { headers: shopifyHeaders }
          );

          summary.new_beers_added++;
          console.log(`Created: ${formattedTitle}`);

          skuMap.set(expectedSku, {
            productId: res.data.product.id,
            variantId: res.data.product.variants[0].id,
          });
        } catch (err) {
          summary.failed_items++;
          console.log(`Failed creation for ${formattedTitle}: ${extractError(err)}`);
        }
      }

      await sleep(500);
    }
  }
}

console.log("\n--- Sync complete ---");
console.log(`Total checked: ${summary.total_items_checked}`);
console.log(`Created: ${summary.new_beers_added}`);
console.log(`Updated: ${summary.existing_beers_updated}`);
console.log(`Failed: ${summary.failed_items}`);
