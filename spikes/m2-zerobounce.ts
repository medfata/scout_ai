/**
 * Spike: ZeroBounce email validation v2 (phase 2, section 10 rule 2).
 * Calls the endpoint ONCE and prints the raw JSON so it can be recorded as
 * `tests/fixtures/vendor/zerobounce-validate.json`.
 *
 * Run: pnpm exec tsx --env-file=.env.local spikes/m2-zerobounce.ts
 */
const key = process.env.ZEROBOUNCE_API_KEY;

async function main(): Promise<void> {
  if (!key) {
    console.error("ZEROBOUNCE_API_KEY is not set. Add it to .env.local, then run:");
    console.error("  pnpm exec tsx --env-file=.env.local spikes/m2-zerobounce.ts");
    process.exitCode = 1;
    return;
  }

  const url = new URL("https://api.zerobounce.net/v2/validate");
  url.searchParams.set("api_key", key);
  url.searchParams.set("email", "test@example.com");

  const response = await fetch(url, { headers: { accept: "application/json" } });
  console.log(`HTTP ${response.status}`);
  console.log(await response.text());
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

export {};
