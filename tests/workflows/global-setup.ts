import { buildWorkflowTests } from "@workflow/vitest";

/**
 * Phase 5 gate: `@workflow/vitest` compiles every `"use workflow"` / `"use step"` file into
 * the bundles the in-process test world dispatches (see node_modules/workflow/docs/testing).
 * The build runs once for the whole run, in Vitest's global setup, because it is expensive
 * and every worker must see the same bundles.
 *
 * `tests/workflows/setup.ts` patches the generated bundles for Node 22's JSON import
 * attribute requirement; the plugin's own global setup runs after this one, which is why
 * the patch cannot live here.
 */
export async function setup(): Promise<void> {
  await buildWorkflowTests();
}
