/**
 * Spike: Reoon email verifier (phase 2, section 10 rule 2).
 * Calls the endpoint ONCE and prints the raw JSON so it can be recorded as
 * `tests/fixtures/vendor/reoon-verify.json`.
 *
 * Run: pnpm exec tsx --env-file=.env.local spikes/m2-reoon.ts
 */
const key = process.env.REOON_API_KEY;

async function main(): Promise<void> {
  if (!key) {
    console.error("REOON_API_KEY is not set. Add it to .env.local, then run:");
    console.error("  pnpm exec tsx --env-file=.env.local spikes/m2-reoon.ts");
    process.exitCode = 1;
    return;
  }

  const url = new URL("https://emailverifier.reoon.com/api/v1/verify");
  url.searchParams.set("email", "test@example.com");
  url.searchParams.set("key", key);
  url.searchParams.set("mode", "power");

  const response = await fetch(url, { headers: { accept: "application/json" } });
  console.log(`HTTP ${response.status}`);
  console.log(JSON.stringify(await response.json(), null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

export {};
