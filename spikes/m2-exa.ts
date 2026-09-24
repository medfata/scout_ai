/**
 * Spike: Exa search (phase 2, section 10 rule 2).
 * Calls the endpoint ONCE and prints the raw JSON so it can be recorded as
 * `tests/fixtures/vendor/exa-search.json`.
 *
 * Run: pnpm exec tsx --env-file=.env.local spikes/m2-exa.ts
 */
const key = process.env.EXA_API_KEY;

async function main(): Promise<void> {
  if (!key) {
    console.error("EXA_API_KEY is not set. Add it to .env.local, then run:");
    console.error("  pnpm exec tsx --env-file=.env.local spikes/m2-exa.ts");
    process.exitCode = 1;
    return;
  }

  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      query: "Head of Customer Support at a mid-size logistics company in Germany",
      numResults: 3,
      type: "auto",
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
