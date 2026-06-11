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

const BEER_CATEGORY_GID = "gid://shopify/TaxonomyCategory/fb-1-1-1";

const setProductCategory = async (productId) => {
  try {
    await axios.post(
      `${shopifyBase}/graphql.json`,
      {
        query: `mutation($id: ID!) {
          productUpdate(input: { id: $id, category: "${BEER_CATEGORY_GID}" }) {
            userErrors { field message }
          }
        }`,
        variables: { id: `gid://shopify/Product/${productId}` },
      },
      { headers: shopifyHeaders }
    );
  } catch (err) {
    console.log(`Warning: could not set category for ${productId}: ${extractError(err)}`);
  }
};

// --- MAP EXISTING CATALOG ---
console.log("Mapping existing catalog...");
const skuMap = new Map();

try {
  const res = await axios.get(
    `${shopifyBase}/products.json?limit=250&fields=id,variants,images`,
    { headers: shopifyHeaders }
  );
  for (const prod of (res.data.products || [])) {
    for (const variant of (prod.variants || [])) {
      if (variant.sku) {
        skuMap.set(variant.sku.trim(), {
          productId: prod.id,
          variantId: variant.id,
          hasImage: (prod.images || []).length > 0,
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

  for (const item of sections.flatMap(s => s.items || [])) {
    summary.total_items_checked++;
    const expectedSku = `UT-${item.id}`;
    const brewery = (item.brewery_name || item.brewery || "Unknown Brewery").trim();
    const beerName = (item.name || "Unknown Beer").trim();
    const formattedTitle = `${brewery} — ${beerName}`;
    const rating = parseFloat(item.rating) || 0;
    const bodyHtml = [
      `<strong>Style:</strong> ${item.style || "Beer"} &nbsp;|&nbsp; <strong>ABV:</strong> ${item.abv || 0}%`,
      rating > 3.8 ? `<strong>Untappd Rating:</strong> ${rating.toFixed(2)} ⭐` : "",
      item.description || "",
    ].filter(Boolean).join("<br/><br/>");

    // Container: use first container's size name, fallback to menu label
    const container = (item.containers || [])[0];
    const sizeOptionValue = container?.container_size?.name || menu.label;
    const variantPrice = container?.price ? String(container.price) : undefined;

    const tagParts = [
      `Style: ${item.style || "Beer"}`,
      `ABV: ${item.abv || 0}%`,
    ];
    if (item.ibu && item.ibu !== "0.0") tagParts.push(`IBU: ${item.ibu}`);
    if (item.calories) tagParts.push(`Calories: ${item.calories}`);
    if (rating > 3.8) tagParts.push(`Untappd: ${rating.toFixed(2)}`);
    const tags = tagParts.join(", ");

    // Label image from Untappd
    const labelImage = item.label_image_hd || item.label_image || null;

    if (skuMap.has(expectedSku)) {
      const { productId, variantId, hasImage } = skuMap.get(expectedSku);
      try {
        const productPayload = {
          product: {
            id: productId,
            title: formattedTitle,
            body_html: bodyHtml,
            vendor: brewery,
            tags,
            options: [{ name: "Size" }],
          },
        };
        // Only set image if product has none yet
        if (labelImage && !hasImage) {
          productPayload.product.images = [{ src: labelImage }];
        }

        await axios.put(
          `${shopifyBase}/products/${productId}.json`,
          productPayload,
          { headers: shopifyHeaders }
        );

        await sleep(300);

        const variantPayload = {
          variant: {
            id: variantId,
            sku: expectedSku,
            barcode: item.upc || "",
            option1: sizeOptionValue,
          },
        };
        if (variantPrice !== undefined) variantPayload.variant.price = variantPrice;

        await axios.put(
          `${shopifyBase}/variants/${variantId}.json`,
          variantPayload,
          { headers: shopifyHeaders }
        );

        await setProductCategory(productId);
        summary.existing_beers_updated++;
        console.log(`Updated: ${formattedTitle} | Size: ${sizeOptionValue}${variantPrice ? ` | £${variantPrice}` : ""}`);
      } catch (err) {
        summary.failed_items++;
        console.log(`Failed update for ${formattedTitle}: ${extractError(err)}`);
      }
    } else {
      try {
        const newVariant = {
          sku: expectedSku,
          barcode: item.upc || "",
          inventory_management: "shopify",
          option1: sizeOptionValue,
        };
        if (variantPrice !== undefined) newVariant.price = variantPrice;

        const createPayload = {
          product: {
            title: formattedTitle,
            body_html: bodyHtml,
            vendor: brewery,
            product_type: "Beer",
            tags,
            status: "active",
            published_scope: "global",
            options: [{ name: "Size" }],
            variants: [newVariant],
          },
        };
        if (labelImage) {
          createPayload.product.images = [{ src: labelImage }];
        }

        const res = await axios.post(
          `${shopifyBase}/products.json`,
          createPayload,
          { headers: shopifyHeaders }
        );

        await setProductCategory(res.data.product.id);
        summary.new_beers_added++;
        console.log(`Created: ${formattedTitle} | Size: ${sizeOptionValue}${variantPrice ? ` | £${variantPrice}` : ""}`);

        skuMap.set(expectedSku, {
          productId: res.data.product.id,
          variantId: res.data.product.variants[0].id,
          hasImage: !!labelImage,
        });
      } catch (err) {
        summary.failed_items++;
        console.log(`Failed creation for ${formattedTitle}: ${extractError(err)}`);
      }
    }

    await sleep(500);
  }
}

console.log("\n--- Sync complete ---");
console.log(`Total checked: ${summary.total_items_checked}`);
console.log(`Created: ${summary.new_beers_added}`);
console.log(`Updated: ${summary.existing_beers_updated}`);
console.log(`Failed: ${summary.failed_items}`);
