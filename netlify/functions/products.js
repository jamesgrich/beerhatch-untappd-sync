import axios from "axios";

const shopifyBase = "https://beerhatch-com.myshopify.com/admin/api/2024-04";

const buildHeaders = () => ({
  "X-Shopify-Access-Token": process.env.SHOPIFY_TOKEN,
  "Content-Type": "application/json",
});

export const handler = async () => {
  try {
    const res = await axios.get(
      `${shopifyBase}/products.json?limit=250&fields=id,title,images`,
      { headers: buildHeaders() }
    );
    const products = (res.data.products || []).map(p => ({
      id: p.id,
      title: p.title,
      hasImage: (p.images || []).length > 0,
    }));
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(products),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
