/**
 * Spike: Apollo People API search (phase 2, section 10 rule 2).
 * Calls the endpoint ONCE and prints the raw JSON so it can be recorded as
 * `tests/fixtures/vendor/apollo-people-search.json`.
 *
 * Run: pnpm exec tsx --env-file=.env.local spikes/m2-apollo.ts
 */
const key = process.env.APOLLO_API_KEY;

async function main(): Promise<void> {
  if (!key) {
    console.error("APOLLO_API_KEY is not set. Add it to .env.local, then run:");
    console.error("  pnpm exec tsx --env-file=.env.local spikes/m2-apollo.ts");
    process.exitCode = 1;
    return;
  }

  const response = await fetch("https://api.apollo.io/api/v1/mixed_people/api_search", {
    method: "POST",
    headers: { "x-api-key": key, "content-type": "application/json", "cache-control": "no-cache" },
    body: JSON.stringify({
      person_titles: ["Head of Customer Support"],
      person_locations: ["Germany"],
      organization_num_employees_ranges: ["11,50"],
      organization_industries: ["logistics"],
      page: 1,
      per_page: 3,
    }),
  });

  console.log(`HTTP ${response.status}`);
  console.log(JSON.stringify(await response.json(), null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

export {};
