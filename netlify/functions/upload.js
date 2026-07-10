import axios from "axios";
import path from "path";

const REPO = "jamesgrich/beerhatch-untappd-sync";

function normalise(name) {
  return name.replace(/ [–-] /g, ' — ').trim().toLowerCase();
}

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405 };

  let filename, attachment;
  try {
    ({ filename, attachment } = JSON.parse(event.body));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request" }) };
  }

  if (!filename || !attachment) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing filename or image data" }) };
  }

  // Validate filename matches a known product before committing to GitHub
  try {
    const productsRes = await axios.get(
      `https://raw.githubusercontent.com/${REPO}/main/public/products.json`
    );
    const products = productsRes.data || [];

    const byFullTitle = new Map();
    const byBeerName = new Map();
    const bySpaceTitle = new Map();
    for (const prod of products) {
      byFullTitle.set(normalise(prod.title), prod);
      const dashIdx = prod.title.indexOf(" — ");
      if (dashIdx !== -1) {
        const brewery = prod.title.slice(0, dashIdx).trim();
        const beer = prod.title.slice(dashIdx + 3).trim();
        byBeerName.set(normalise(beer), prod);
        bySpaceTitle.set(normalise(`${brewery} ${beer}`), prod);
      }
    }

    const nameWithoutExt = normalise(path.basename(filename, path.extname(filename)));
    const product = byFullTitle.get(nameWithoutExt) || byBeerName.get(nameWithoutExt) || bySpaceTitle.get(nameWithoutExt);

    if (!product) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          status: "no_match",
          message: "Filename doesn't match any product — rename it to the beer name (e.g. Mesa.png) and try again",
        }),
      };
    }

    if (product.hasImage) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          status: "skipped",
          message: `${product.title} already has a photo`,
        }),
      };
    }
  } catch {
    // If product list can't be fetched, proceed anyway and let the workflow handle it
  }

  const githubPat = process.env.GITHUB_PAT;
  const filePath = `pending-photos/${filename}`;
  const apiUrl = `https://api.github.com/repos/${REPO}/contents/${filePath}`;
  const headers = {
    Authorization: `Bearer ${githubPat}`,
    Accept: "application/vnd.github+json",
  };

  let sha;
  try {
    const existing = await axios.get(apiUrl, { headers });
    sha = existing.data.sha;
  } catch {
    // File doesn't exist yet — fine
  }

  try {
    await axios.put(apiUrl, {
      message: `Add pending photo: ${filename}`,
      content: attachment,
      ...(sha ? { sha } : {}),
    }, { headers });

    return {
      statusCode: 200,
      body: JSON.stringify({
        status: "queued",
        message: "Queued — will appear in Shopify within ~1 minute",
      }),
    };
  } catch (err) {
    const detail = err.response?.data?.message || err.message;
    return {
      statusCode: 200,
      body: JSON.stringify({ status: "failed", message: detail }),
    };
  }
};
