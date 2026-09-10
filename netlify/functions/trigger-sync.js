import axios from "axios";

const REPO = "jamesgrich/beerhatch-untappd-sync";

// GitHub's own `schedule:` trigger on sync.yml gets delayed by hours on this
// repo. workflow_dispatch fires near-instantly, so Netlify's scheduler
// (separate infra from GH Actions) drives it instead every 30 min.
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
  schedule: "*/30 * * * *",
};
