import axios from "axios";

const REPO = "jamesgrich/beerhatch-untappd-sync";

// GitHub's own `schedule:` trigger on sync.yml gets delayed by hours on this
// repo, so it's been removed entirely. This function and a cron-job.org job
// both call workflow_dispatch independently instead — this one on the :00/:10/
// :20/:30/:40/:50 slots, cron-job.org offset to :05/:15/:25/:35/:45/:55, so
// combined they cover every 5 min with no overlap. Either alone degrades
// gracefully to a 10min cadence rather than silent total failure.
//
// Confirmed via the Netlify usage dashboard (2026-09-10): the earlier "50% of
// credits used" alert was from repeated *deploys* (14 deploys = 210 credits =
// ~all of it) during active development, not from this function's own
// invocations (compute usage was <1 credit) — frequency here isn't the cost driver.
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
  schedule: "*/10 * * * *",
};
