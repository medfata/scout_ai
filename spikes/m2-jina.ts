/**
 * Spike: Jina Reader (phase 2, section 10 rule 2).
 * Fetches ONE public page and prints the raw JSON so it can be recorded as
 * `tests/fixtures/vendor/jina-reader.json`. No API key: the anonymous tier allows
 * 20 requests/minute, which is plenty for v1 (see spikes/README.md).
 *
 * Run: pnpm exec tsx spikes/m2-jina.ts https://example.com
 */
const target = process.argv[2] ?? "https://example.com";

async function main(): Promise<void> {
  const response = await fetch(`https://r.jina.ai/${target}`, {
    headers: { accept: "application/json" },
  });

  console.log(`HTTP ${response.status}`);
  console.log(await response.text());
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

export {};
