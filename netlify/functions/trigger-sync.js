import axios from "axios";

const REPO = "jamesgrich/beerhatch-untappd-sync";

// GitHub's own `schedule:` trigger on sync.yml gets delayed by hours on this
// repo. workflow_dispatch fires near-instantly, so Netlify's scheduler
// (separate infra from GH Actions) drives it instead.
//
// Confirmed via the Netlify usage dashboard (2026-09-10): the earlier "50% of
// credits used" alert was from repeated *deploys* (14 deploys = 210 credits =
// ~all of it) during active development, not from this function's own
// invocations (compute usage was <1 credit). Safe to run every 5 min — the
// real lesson was to push fewer, larger commits, not to slow this down.
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
