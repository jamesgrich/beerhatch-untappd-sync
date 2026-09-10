import axios from "axios";

const REPO = "jamesgrich/beerhatch-untappd-sync";

// GitHub's own `schedule:` trigger on sync.yml gets delayed by hours on this
// repo. workflow_dispatch fires near-instantly, so Netlify's scheduler
// (separate infra from GH Actions) drives it instead. sync.js now skips writes
// for anything unchanged (~1min for a no-op run vs ~5min before) and self-alerts
// by email if a run runs long or fails a lot, so 5 min is safe — no documented
// Untappd rate limit, and Shopify's own throttling is unaffected by how often
// we ask, only by how many writes happen per ask.
export default async () => {
  await axios.post(
    `https://api.github.com/repos/${REPO}/actions/workflows/sync.yml/dispatches`,
    { ref: "main", inputs: { source: "netlify" } },
    {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_PAT}`,
        Accept: "application/vnd.github+json",
      },
    }
  );
  return new Response("ok");
};

export const config = {
  schedule: "*/5 * * * *",
};
