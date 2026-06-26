import axios from "axios";

const shopifyBase = "https://beerhatch-com.myshopify.com/admin/api/2024-04";

const buildHeaders = () => ({
  "X-Shopify-Access-Token": process.env.SHOPIFY_TOKEN,
  "Content-Type": "application/json",
});

const extractError = (err) => {
  const body = err.response?.data;
  if (body?.errors) return JSON.stringify(body.errors);
  if (body?.error) return body.error;
  return err.message || "Unknown error";
};

export const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  let filename, attachment;
  try {
    ({ filename, attachment } = JSON.parse(event.body));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  if (!filename || !attachment) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing filename or attachment" }) };
  }

  // Fetch products fresh each call (serverless — no shared memory)
  let products;
  try {
    const res = await axios.get(
      `${shopifyBase}/products.json?limit=250&fields=id,title,images`,
      { headers: buildHeaders() }
    );
    products = res.data.products || [];
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: `Could not fetch products: ${extractError(err)}` }) };
  }

  // Build lookup maps — full title and beer-name-only
  const byFullTitle = new Map();
  const byBeerName = new Map();
  for (const prod of products) {
    byFullTitle.set(prod.title.trim().toLowerCase(), prod);
    const dashIdx = prod.title.indexOf(" — ");
    if (dashIdx !== -1) {
      byBeerName.set(prod.title.slice(dashIdx + 3).trim().toLowerCase(), prod);
    }
  }

  const ext = filename.lastIndexOf(".");
  const nameWithoutExt = (ext !== -1 ? filename.slice(0, ext) : filename).trim();
  const nameLower = nameWithoutExt.toLowerCase();

  const product = byFullTitle.get(nameLower) || byBeerName.get(nameLower);

  if (!product) {
    return {
      statusCode: 200,
      body: JSON.stringify({ status: "no_match", message: "No matching product found" }),
    };
  }

  if ((product.images || []).length > 0) {
    return {
      statusCode: 200,
      body: JSON.stringify({ status: "skipped", message: `${product.title} already has an image` }),
    };
  }

  try {
    await axios.post(
      `${shopifyBase}/products/${product.id}/images.json`,
      { image: { attachment, filename } },
      { headers: buildHeaders() }
    );
    return {
      statusCode: 200,
      body: JSON.stringify({ status: "uploaded", message: product.title }),
    };
  } catch (err) {
    return {
      statusCode: 200,
      body: JSON.stringify({ status: "failed", message: extractError(err) }),
    };
  }
};
