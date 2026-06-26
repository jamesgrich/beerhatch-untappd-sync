import axios from "axios";

const REPO = "jamesgrich/beerhatch-untappd-sync";

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

  const githubPat = process.env.GITHUB_PAT;
  const filePath = `pending-photos/${filename}`;
  const apiUrl = `https://api.github.com/repos/${REPO}/contents/${filePath}`;
  const headers = {
    Authorization: `Bearer ${githubPat}`,
    Accept: "application/vnd.github+json",
  };

  // Check if file already exists (need its sha to overwrite)
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
