import axios from "axios";
import nodemailer from "nodemailer";

const runStart = Date.now();
const utEmail = process.env.UT_EMAIL;
const utToken = process.env.UT_TOKEN;
const shopifyToken = process.env.SHOPIFY_TOKEN;
const gmailUser = process.env.GMAIL_USER;
const gmailPass = process.env.GMAIL_PASS;
const ALERT_EMAIL = "jamesrichardson15@gmail.com"; // ops alerts go to James, not Saul — this is diagnostic, not customer-facing
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

// The sync now runs every 5 min — this catches the two ways that cadence could
// start "falling over itself": a run taking long enough to risk backing up the
// queue behind it, or a spike in write failures (often a rate-limit symptom of
// running too often). Never throws — an alert failing shouldn't fail the sync.
const sendAlert = async (subject, message) => {
  if (!gmailUser || !gmailPass) {
    console.log(`Warning: GMAIL_USER/GMAIL_PASS not set — skipping alert: ${subject}`);
    return;
  }
  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: gmailUser, pass: gmailPass },
    });
    await transporter.sendMail({
      from: `Beer Hatch Sync <${gmailUser}>`,
      to: ALERT_EMAIL,
      subject: `Beer Hatch Sync — ${subject}`,
      text: message,
    });
    console.log(`Alert sent: ${subject}`);
  } catch (err) {
    console.log(`Warning: could not send alert email: ${err.message}`);
  }
};

// Shopify caps a single products.json response at 250 items; walk the
// Link header's cursor-based pagination to fetch the entire catalog.
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

// Only the fields we actually diff against — if none of these differ from what
// Shopify already has, the item hasn't meaningfully changed on Untappd and every
// downstream write (product PUT, variant PUT, category, metafields) can be skipped.
// Tags are compared order-independently: Shopify alphabetizes them on save, so a
// raw string comparison against our fixed generation order always mismatched.
const normalizeTags = (tags) => (tags || "").split(",").map(t => t.trim()).filter(Boolean).sort().join(",");

// Shopify decodes HTML entities in body_html on save (&amp; -> &, etc.) — Untappd's
// raw descriptions contain literal &amp;, so generate the already-decoded form to
// match what actually ends up stored, same as the <br> normalization above.
const decodeHtmlEntities = (str) => (str || "")
  .replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, "\"")
  .replace(/&#0?39;|&apos;/g, "'");

const needsUpdate = (current, next) => {
  const reasons = [];
  if (current.title !== next.title) reasons.push(`title: ${JSON.stringify(current.title)} vs ${JSON.stringify(next.title)}`);
  if (current.body_html !== next.body_html) reasons.push(`body_html: ${JSON.stringify(current.body_html)} vs ${JSON.stringify(next.body_html)}`);
  if (current.vendor !== next.vendor) reasons.push(`vendor: ${JSON.stringify(current.vendor)} vs ${JSON.stringify(next.vendor)}`);
  if (normalizeTags(current.tags) !== normalizeTags(next.tags)) reasons.push(`tags: ${JSON.stringify(current.tags)} vs ${JSON.stringify(next.tags)}`);
  if (current.option1 !== next.option1) reasons.push(`option1: ${JSON.stringify(current.option1)} vs ${JSON.stringify(next.option1)}`);
  if (current.barcode !== next.barcode) reasons.push(`barcode: ${JSON.stringify(current.barcode)} vs ${JSON.stringify(next.barcode)}`);
  if (next.price !== undefined && Number(current.price || 0).toFixed(2) !== Number(next.price).toFixed(2)) reasons.push(`price: ${current.price} vs ${next.price}`);
  if (next.needsImage) reasons.push("needsImage");
  if (reasons.length) console.log(`DIFF DEBUG [${next.title}]: ${reasons.join(" | ")}`);
  return reasons.length > 0;
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
const exportPatches = new Map(); // productId → fresh {id,title,hasImage} for anything created/updated this run

let allProducts = [];
try {
  allProducts = await fetchAllProducts("id,title,body_html,vendor,tags,variants,images");
  for (const prod of allProducts) {
    const hasImage = (prod.images || []).length > 0;
    const productFields = {
      title: prod.title,
      body_html: prod.body_html || "",
      vendor: prod.vendor || "",
      tags: prod.tags || "",
    };
    titleMap.set(prod.title.trim().toLowerCase(), {
      productId: prod.id,
      hasImage,
      ...productFields,
      variants: (prod.variants || []).map(v => ({
        variantId: v.id, sku: v.sku, option1: v.option1, price: v.price, barcode: v.barcode || "",
      })),
    });
    for (const variant of (prod.variants || [])) {
      if (variant.sku) {
        skuMap.set(variant.sku.trim(), {
          productId: prod.id,
          variantId: variant.id,
          hasImage,
          ...productFields,
          option1: variant.option1,
          price: variant.price,
          barcode: variant.barcode || "",
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
  unchanged_items: 0,
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
    const bodyHtml = decodeHtmlEntities([
      `<strong>Style:</strong> ${item.style || "Beer"}`,
      `<strong>ABV:</strong> ${item.abv || 0}%`,
      rating >= 3 ? `<strong>Untappd Rating:</strong> ${rating.toFixed(2)} ⭐` : "",
      item.description || "",
    ].filter(Boolean).join("<br><br>")); // matches Shopify's stored form: no self-closing slash, entities decoded

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
      const cached = skuMap.get(expectedSku);
      const { productId, variantId, hasImage } = cached;

      if (!needsUpdate(cached, {
        title: formattedTitle, body_html: bodyHtml, vendor: brewery, tags,
        option1: sizeOptionValue, barcode: item.upc || "", price: variantPrice,
        needsImage: !!(labelImage && !hasImage),
      })) {
        summary.unchanged_items++;
        continue;
      }

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

        await setProductMetafields(productId, metafields);
        summary.existing_beers_updated++;
        exportPatches.set(productId, { id: productId, title: formattedTitle, hasImage: hasImage || !!labelImage });
        console.log(`Updated: ${formattedTitle} | Size: ${sizeOptionValue}${variantPrice ? ` | £${variantPrice}` : ""}`);
      } catch (err) {
        summary.failed_items++;
        console.log(`Failed update for ${formattedTitle}: ${extractError(err)}`);
      }
    } else if (titleMap.has(formattedTitle.trim().toLowerCase())) {
      // --- RETARGET existing product by title (Untappd re-issued a new item ID, e.g. after OOS delete/re-add) ---
      // Always writes: the SKU itself is stale here (that's why we matched by
      // title instead), so there's no "unchanged" case to diff against — skipping
      // would leave the variant permanently pointed at the old SKU.
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

        await setProductMetafields(productId, metafields);
        summary.existing_beers_updated++;
        skuMap.set(expectedSku, { productId, variantId: existingVariant.variantId, hasImage });
        exportPatches.set(productId, { id: productId, title: formattedTitle, hasImage: hasImage || !!labelImage });
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
        exportPatches.set(newProductId, { id: newProductId, title: formattedTitle, hasImage: !!labelImage });
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

const elapsedMin = (Date.now() - runStart) / 60000;

console.log("\n--- Sync complete ---");
console.log(`Total checked: ${summary.total_items_checked}`);
console.log(`Created: ${summary.new_beers_added}`);
console.log(`Updated: ${summary.existing_beers_updated}`);
console.log(`Unchanged (skipped): ${summary.unchanged_items}`);
console.log(`Failed: ${summary.failed_items}`);
console.log(`Duration: ${elapsedMin.toFixed(1)} min`);

// The trigger cadence is 5 min — a run taking most of that risks the next
// trigger queuing up behind it instead of running on time, which compounds
// every cycle if it keeps happening. 3 min leaves a real buffer.
const DURATION_ALERT_MIN = 3;
const FAILURE_ALERT_COUNT = 3;
if (elapsedMin > DURATION_ALERT_MIN) {
  await sendAlert(
    "sync run is running long",
    `This run took ${elapsedMin.toFixed(1)} min, out of a 5 min trigger interval — getting close to or over the ceiling where runs start queuing up behind each other instead of finishing before the next one fires.\n\nChecked: ${summary.total_items_checked} | Created: ${summary.new_beers_added} | Updated: ${summary.existing_beers_updated} | Unchanged: ${summary.unchanged_items} | Failed: ${summary.failed_items}\n\nWorth checking whether runs are backing up in the Actions history, and considering a longer interval if this keeps happening.`
  );
}
if (summary.failed_items > FAILURE_ALERT_COUNT) {
  await sendAlert(
    `${summary.failed_items} item(s) failed to sync`,
    `${summary.failed_items} of ${summary.total_items_checked} items failed this run — check the Action log for specifics. A spike like this can be a sign of Shopify API rate-limiting, which becomes more likely the more often the sync runs.\n\nChecked: ${summary.total_items_checked} | Created: ${summary.new_beers_added} | Updated: ${summary.existing_beers_updated} | Unchanged: ${summary.unchanged_items} | Duration: ${elapsedMin.toFixed(1)} min`
  );
}

// Write products.json for the Netlify photo uploader. Reuses the catalog already
// fetched at the top instead of re-fetching everything again — patched with
// anything created or updated this run so titles/images stay current.
try {
  const { writeFileSync } = await import("fs");
  const merged = new Map();
  for (const p of allProducts) {
    merged.set(p.id, { id: p.id, title: p.title, hasImage: (p.images || []).length > 0 });
  }
  for (const [id, patch] of exportPatches) {
    merged.set(id, patch);
  }
  const productsJson = [...merged.values()];
  writeFileSync("public/products.json", JSON.stringify(productsJson));
  console.log(`Wrote public/products.json (${productsJson.length} products)`);
} catch (err) {
  console.log(`Warning: could not write products.json: ${err.message}`);
}
