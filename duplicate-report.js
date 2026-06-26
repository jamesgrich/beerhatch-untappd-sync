import axios from "axios";

const shopifyToken = process.env.SHOPIFY_TOKEN;
const resendApiKey = process.env.RESEND_API_KEY;
const shopifyBase = "https://beerhatch-com.myshopify.com/admin/api/2024-04";
const shopifyHeaders = { "X-Shopify-Access-Token": shopifyToken };
const SAUL_EMAIL = "info@beerhatch.com";
const STORE_HANDLE = "beerhatch-com";

const extractError = (err) => {
  const body = err.response?.data;
  if (body?.errors) return JSON.stringify(body.errors);
  if (body?.error) return body.error;
  return err.message || "Unknown error";
};

// Fetch all products
let products = [];
try {
  const res = await axios.get(
    `${shopifyBase}/products.json?limit=250&fields=id,title,variants`,
    { headers: shopifyHeaders }
  );
  products = res.data.products || [];
} catch (err) {
  console.error(`Failed to fetch products: ${extractError(err)}`);
  process.exit(1);
}

// Group by normalised title
const byTitle = new Map();
for (const prod of products) {
  const key = prod.title.trim().toLowerCase();
  if (!byTitle.has(key)) byTitle.set(key, []);
  byTitle.get(key).push(prod);
}

const duplicates = [...byTitle.values()].filter(group => group.length > 1);

if (duplicates.length === 0) {
  console.log("No duplicate products found. No email sent.");
  process.exit(0);
}

// Build email HTML
const adminBase = `https://admin.shopify.com/store/${STORE_HANDLE}/products`;

const tableRows = duplicates.map(group => {
  const links = group.map(p => {
    const variantSizes = (p.variants || []).map(v => v.option1).filter(Boolean).join(", ");
    return `<a href="${adminBase}/${p.id}" style="color:#1a73e8">${p.title}</a>${variantSizes ? ` <span style="color:#888;font-size:12px">(${variantSizes})</span>` : ""}`;
  }).join("<br>");
  return `<tr>
    <td style="padding:10px 12px;border-bottom:1px solid #eee;vertical-align:top">${links}</td>
    <td style="padding:10px 12px;border-bottom:1px solid #eee;color:#d93025;font-weight:600;white-space:nowrap">${group.length} products</td>
  </tr>`;
}).join("");

const html = `
<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;color:#333;max-width:700px;margin:0 auto;padding:24px">
  <h2 style="color:#1a73e8;margin-top:0">Beer Hatch — Duplicate Product Report</h2>
  <p>Hi Saul,</p>
  <p>The daily scan found <strong>${duplicates.length} group(s)</strong> of duplicate products in your Shopify store. These are usually the same beer appearing as separate products instead of one product with size variants (Can, Draught, etc.).</p>
  <p>Please review each group below and merge or delete the extras as needed.</p>
  <table style="border-collapse:collapse;width:100%;margin:16px 0">
    <thead>
      <tr style="background:#f8f8f8">
        <th style="text-align:left;padding:10px 12px;border-bottom:2px solid #ddd">Product(s)</th>
        <th style="text-align:left;padding:10px 12px;border-bottom:2px solid #ddd">Count</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
  <p style="color:#666;font-size:13px">The sync has been updated to prevent new duplicates — beers available in multiple sizes will now appear as one product with size variants going forward.</p>
  <p style="color:#aaa;font-size:12px;margin-top:32px">Beer Hatch Sync · ${new Date().toDateString()}</p>
</body>
</html>
`;

// Send via Resend
try {
  await axios.post(
    "https://api.resend.com/emails",
    {
      from: "Beer Hatch <noreply@beerhatch.com>",
      to: SAUL_EMAIL,
      subject: `Beer Hatch — ${duplicates.length} Duplicate Product${duplicates.length > 1 ? "s" : ""} Found`,
      html,
    },
    {
      headers: {
        "Authorization": `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
    }
  );
  console.log(`Duplicate report sent to ${SAUL_EMAIL} (${duplicates.length} group(s))`);
} catch (err) {
  console.error(`Failed to send email: ${extractError(err)}`);
  process.exit(1);
}
