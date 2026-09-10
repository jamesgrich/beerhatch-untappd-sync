import axios from "axios";

const REPO = "jamesgrich/beerhatch-untappd-sync";

// GitHub's own `schedule:` trigger on sync.yml gets delayed by hours on this
// repo. workflow_dispatch fires near-instantly, so Netlify's scheduler
// (separate infra from GH Actions) drives it instead.
//
// REVERTED from 5min back to 30min (2026-09-10): hit a "50% of Netlify credits
// used" alert shortly after tightening to 5min. Root cause unconfirmed — could be
// this function's invocation frequency, or could be the ~10 redeploys pushed to
// this repo today (every push triggers a full Netlify rebuild, unrelated to this
// function's own schedule). 30min ran for hours earlier today with no alert, so
// reverting to that known-safe baseline until the actual driver is confirmed via
// the Netlify usage dashboard, rather than guessing further.
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
