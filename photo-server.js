import express from "express";
import multer from "multer";
import axios from "axios";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const shopifyToken = process.env.SHOPIFY_TOKEN;
const shopifyBase = "https://beerhatch-com.myshopify.com/admin/api/2024-04";
const shopifyHeaders = {
  "X-Shopify-Access-Token": shopifyToken,
  "Content-Type": "application/json",
};

if (!shopifyToken) {
  console.error("SHOPIFY_TOKEN environment variable is not set.");
  process.exit(1);
}

app.use(express.static(path.join(__dirname, "public")));

// Product cache — loaded once, refreshed on demand
let productCache = null;

const loadProducts = async () => {
  const res = await axios.get(
    `${shopifyBase}/products.json?limit=250&fields=id,title,images`,
    { headers: shopifyHeaders }
  );
  productCache = res.data.products || [];
  return productCache;
};

const buildLookups = (products) => {
  const byFullTitle = new Map();
  const byBeerName = new Map();
  for (const prod of products) {
    byFullTitle.set(prod.title.trim().toLowerCase(), prod);
    const dashIdx = prod.title.indexOf(" — ");
    if (dashIdx !== -1) {
      byBeerName.set(prod.title.slice(dashIdx + 3).trim().toLowerCase(), prod);
    }
  }
  return { byFullTitle, byBeerName };
};

// POST /upload — accepts multiple image files
app.post("/upload", upload.array("photos"), async (req, res) => {
  if (!req.files?.length) {
    return res.status(400).json({ error: "No files received" });
  }

  let products;
  try {
    products = productCache || await loadProducts();
  } catch (err) {
    return res.status(500).json({ error: "Could not fetch Shopify products" });
  }

  const { byFullTitle, byBeerName } = buildLookups(products);
  const results = [];

  for (const file of req.files) {
    const nameWithoutExt = path.basename(file.originalname, path.extname(file.originalname)).trim();
    const nameLower = nameWithoutExt.toLowerCase();
    const product = byFullTitle.get(nameLower) || byBeerName.get(nameLower);

    if (!product) {
      results.push({ file: file.originalname, status: "no_match", message: "No matching product found" });
      continue;
    }

    if ((product.images || []).length > 0) {
      results.push({ file: file.originalname, status: "skipped", message: `Already has an image — ${product.title}` });
      continue;
    }

    try {
      const attachment = file.buffer.toString("base64");
      await axios.post(
        `${shopifyBase}/products/${product.id}/images.json`,
        { image: { attachment, filename: file.originalname } },
        { headers: shopifyHeaders }
      );
      product.images = [{ src: "uploaded" }]; // update cache so re-uploads in same session are skipped
      results.push({ file: file.originalname, status: "uploaded", message: product.title });
    } catch (err) {
      const body = err.response?.data;
      const detail = body?.errors ? JSON.stringify(body.errors) : err.message;
      results.push({ file: file.originalname, status: "failed", message: detail });
    }
  }

  res.json(results);
});

// POST /refresh — clears product cache
app.post("/refresh", async (_req, res) => {
  try {
    await loadProducts();
    res.json({ count: productCache.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /products — returns product titles for the hint list
app.get("/products", async (_req, res) => {
  try {
    const products = productCache || await loadProducts();
    res.json(products.map(p => ({ id: p.id, title: p.title, hasImage: (p.images || []).length > 0 })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nBeer Hatch photo uploader running at http://localhost:${PORT}\n`);
});
