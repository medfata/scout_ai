import { readFileSync, writeFileSync } from "node:fs";

import { afterAll } from "vitest";
import { setupWorkflowTests, teardownWorkflowTests } from "@workflow/vitest";

/**
 * Phase 5 gate: switches on the in-process workflow runtime (`Local World`) in each test
 * worker. The plugin's own setup file also calls this, but the explicit call is what the
 * `vitest.workflows.config.ts` wiring promises (node_modules/workflow/docs/api-reference/vitest).
 *
 * The teardown is registered from *this* module instance too: Vitest loads the plugin's
 * setup file and this file separately, so each call keeps its own Local World handle.
 * Without closing our handle, every test file would leak one live world, and the leaked
 * queues fight over `.workflow-data` (EPERM on atomic writes, runs stalling through
 * retries). `teardownWorkflowTests` is a no-op when the handle is already closed.
 *
 * The Gmail adapter factory returns `null` when the Internal OAuth app is not configured,
 * and the guard then blocks every send with `config_incomplete`. The workflow tests fake
 * Google's API with MSW, so the factory only needs *some* client id/secret to build a real
 * channel; a valid access token is seeded with the mailbox, so no token call happens.
 * Values already in the environment win.
 */
if (!process.env.GMAIL_OAUTH_CLIENT_ID) process.env.GMAIL_OAUTH_CLIENT_ID = "workflow-test-client";
if (!process.env.GMAIL_OAUTH_CLIENT_SECRET) process.env.GMAIL_OAUTH_CLIENT_SECRET = "workflow-test-secret";

addJsonImportAttributes();
await setupWorkflowTests();
afterAll(async () => {
  await teardownWorkflowTests();
});

/**
 * The SDK bundles its own dependencies into `steps.mjs`, and one of them
 * (`builtin-modules`) is a JSON module. Node 22.20 requires `with { type: "json" }` on JSON
 * imports, which the generated bundle omits, so the step handler fails to load with
 * `ERR_IMPORT_ATTRIBUTE_MISSING`. The bundles are build artefacts under `.workflow-vitest/`,
 * not source.
 *
 * This runs once per test file in the same worker, so the replacement must be idempotent:
 * existing attributes are collapsed to exactly one and a specifier without one gets one,
 * otherwise a second pass would emit `with { type: "json" }` twice and break the bundle
 * with `SyntaxError: Unexpected token 'with'`.
 */
function addJsonImportAttributes(): void {
  for (const file of [".workflow-vitest/workflows.mjs", ".workflow-vitest/steps.mjs"]) {
    const source = readFileSync(file, "utf8");
    const collapsed = source.replace(
      /(["'][^"']+\.json["'])(?:\s*with\s*\{\s*type:\s*["']json["']\s*\})+/g,
      '$1 with { type: "json" }',
    );
    const patched = collapsed.replace(
      /(import\s+[^;\n]*?\s+from\s+["'][^"']+\.json["'])(?!\s*with\s*\{)/g,
      '$1 with { type: "json" }',
    );
    if (patched !== source) writeFileSync(file, patched);
  }
}
