import axios from "axios";

const utEmail = process.env.UT_EMAIL;
const utToken = process.env.UT_TOKEN;
const shopifyToken = process.env.SHOPIFY_TOKEN;
const tokenBuffer = Buffer.from(`${utEmail}:${utToken}`).toString("base64");
const shopifyBase = "https://beerhatch-com.myshopify.com/admin/api/2024-04";
const menuIds = [
  { id: "112250", label: "Can" },
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

const setProductMetafields = async (productId, metafields) => {
  try {
    await axios.post(
      `${shopifyBase}/graphql.json`,
      {
        query: `mutation($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            userErrors { field message }
          }
        }`,
        variables: {
          metafields: metafields.map(m => ({ ...m, ownerId: `gid://shopify/Product/${productId}` })),
        },
      },
      { headers: shopifyHeaders }
    );
  } catch (err) {
    console.log(`Warning: could not set metafields for ${productId}: ${extractError(err)}`);
  }
};

// --- MAP EXISTING CATALOG ---
console.log("Mapping existing catalog...");
const skuMap = new Map(); // SKU → { productId, variantId, hasImage }
const titleMap = new Map(); // normalized title → { productId, hasImage, variants: [{variantId, sku, option1}] }

try {
  const res = await axios.get(
    `${shopifyBase}/products.json?limit=250&fields=id,title,variants,images`,
    { headers: shopifyHeaders }
  );
  for (const prod of (res.data.products || [])) {
    const hasImage = (prod.images || []).length > 0;
    titleMap.set(prod.title.trim().toLowerCase(), {
      productId: prod.id,
      hasImage,
      variants: (prod.variants || []).map(v => ({ variantId: v.id, sku: v.sku, option1: v.option1 })),
    });
    for (const variant of (prod.variants || [])) {
      if (variant.sku) {
        skuMap.set(variant.sku.trim(), {
          productId: prod.id,
          variantId: variant.id,
          hasImage,
        });
      }
    }
  }
  console.log(`Mapped ${skuMap.size} existing variants across ${titleMap.size} products.`);
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
      rating >= 3 ? `<strong>Untappd Rating:</strong> ${rating.toFixed(2)} ⭐` : "",
      item.description || "",
    ].filter(Boolean).join("<br/><br/>");

    const container = (item.containers || [])[0];
    const sizeOptionValue = container?.container_size?.name || menu.label;
    const variantPrice = container?.price ? String(container.price) : undefined;

    const tagParts = [
      `Style: ${item.style || "Beer"}`,
      `ABV: ${item.abv || 0}%`,
    ];
    if (item.ibu && item.ibu !== "0.0") tagParts.push(`IBU: ${item.ibu}`);
    if (item.calories) tagParts.push(`Calories: ${item.calories}`);
    if (rating >= 3) tagParts.push(`Untappd Rating: ${Math.floor(rating)}`);
    const tags = tagParts.join(", ");

    const metafields = [
      { namespace: "custom", key: "abv", type: "number_decimal", value: String(parseFloat(item.abv) || 0) },
      { namespace: "custom", key: "style", type: "single_line_text_field", value: item.style || "Beer" },
    ];
    if (item.ibu && item.ibu !== "0.0") {
      metafields.push({ namespace: "custom", key: "ibu", type: "number_decimal", value: String(parseFloat(item.ibu)) });
    }
    if (item.calories) {
      metafields.push({ namespace: "custom", key: "calories", type: "number_integer", value: String(Math.round(item.calories)) });
    }
    if (rating >= 3) {
      metafields.push({ namespace: "custom", key: "untappd_rating", type: "number_integer", value: String(Math.floor(rating)) });
    }

    const labelImage = item.label_image_hd || item.label_image || null;

    if (skuMap.has(expectedSku)) {
      // --- UPDATE existing variant ---
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
        await setProductMetafields(productId, metafields);
        summary.existing_beers_updated++;
        console.log(`Updated: ${formattedTitle} | Size: ${sizeOptionValue}${variantPrice ? ` | £${variantPrice}` : ""}`);
      } catch (err) {
        summary.failed_items++;
        console.log(`Failed update for ${formattedTitle}: ${extractError(err)}`);
      }
    } else if (titleMap.has(formattedTitle.trim().toLowerCase())) {
      // --- RETARGET existing product by title (Untappd re-issued a new item ID, e.g. after OOS delete/re-add) ---
      const { productId, hasImage, variants } = titleMap.get(formattedTitle.trim().toLowerCase());
      const existingVariant = variants.find(v => v.option1 === sizeOptionValue) || variants[0];
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
            id: existingVariant.variantId,
            sku: expectedSku,
            barcode: item.upc || "",
            option1: sizeOptionValue,
          },
        };
        if (variantPrice !== undefined) variantPayload.variant.price = variantPrice;

        await axios.put(
          `${shopifyBase}/variants/${existingVariant.variantId}.json`,
          variantPayload,
          { headers: shopifyHeaders }
        );

        await setProductCategory(productId);
        await setProductMetafields(productId, metafields);
        summary.existing_beers_updated++;
        skuMap.set(expectedSku, { productId, variantId: existingVariant.variantId, hasImage });
        console.log(`Retargeted: ${formattedTitle} | Size: ${sizeOptionValue} | SKU ${existingVariant.sku || "(none)"} → ${expectedSku}`);
      } catch (err) {
        summary.failed_items++;
        console.log(`Failed retarget for ${formattedTitle}: ${extractError(err)}`);
      }
    } else {
      // --- CREATE new product ---
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

        const newProductId = res.data.product.id;
        await setProductCategory(newProductId);
        await setProductMetafields(newProductId, metafields);
        summary.new_beers_added++;
        console.log(`Created: ${formattedTitle} | Size: ${sizeOptionValue}${variantPrice ? ` | £${variantPrice}` : ""}`);

        skuMap.set(expectedSku, {
          productId: newProductId,
          variantId: res.data.product.variants[0].id,
          hasImage: !!labelImage,
        });
        titleMap.set(formattedTitle.trim().toLowerCase(), {
          productId: newProductId,
          hasImage: !!labelImage,
          variants: [{ variantId: res.data.product.variants[0].id, sku: expectedSku, option1: sizeOptionValue }],
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

// Write products.json for the Netlify photo uploader
try {
  const { writeFileSync } = await import("fs");
  const prodRes = await axios.get(
    `${shopifyBase}/products.json?limit=250&fields=id,title,images`,
    { headers: shopifyHeaders }
  );
  const productsJson = (prodRes.data.products || []).map(p => ({
    id: p.id,
    title: p.title,
    hasImage: (p.images || []).length > 0,
  }));
  writeFileSync("public/products.json", JSON.stringify(productsJson));
  console.log(`Wrote public/products.json (${productsJson.length} products)`);
} catch (err) {
  console.log(`Warning: could not write products.json: ${err.message}`);
}
