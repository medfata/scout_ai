/**
 * Throwaway: emits the four promptfoo config files from the golden fixtures so no lead or
 * reply id is transcribed by hand. Deleted after it runs; the YAML it writes is committed.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { GOLDEN_LEADS } from "./golden/leads";
import { GOLDEN_REPLIES } from "./golden/replies";

const OUT = resolve(process.cwd(), "evals");

const HEADER = [
  "# Generated from the fixtures in evals/golden/ by evals/generate-configs.ts.",
  "# Change a fixture and re-run `pnpm tsx evals/generate-configs.ts` to keep every id in sync.",
  "",
];

const SCORER_ASSERTS = [
  "    assert:",
  "      # Fixture integrity first (code), then the scorer expectations (code).",
  "      - type: javascript",
  "        value: file://assertions/lead-facts.ts",
  "      - type: javascript",
  "        value: file://assertions/scorer-expectations.ts",
];

const COPY_ASSERTS = [
  "    assert:",
  "      # Code: evaluateCopyRules (zero errors), DraftSchema, one CTA question outside the signature.",
  "      - type: javascript",
  "        value: file://assertions/copy-rules.ts",
  "      # Model-graded, and only for this: one concrete idea tied to a signal.",
  "      - type: javascript",
  "        value: file://assertions/concrete-idea.ts",
];

const CLASSIFIER_ASSERTS = [
  "    assert:",
  "      - type: javascript",
  "        value: file://assertions/classifier-intent.ts",
  "      - type: javascript",
  "        value: file://assertions/classifier-details.ts",
];

interface CopyScenario {
  leadId: string;
  stepKey: string;
  offerVariant?: string;
}

const COPY_SCENARIOS: readonly CopyScenario[] = [
  { leadId: "clear-fit-support-saas", stepKey: "email_1" },
  { leadId: "thin-website-stealth", stepKey: "email_1" },
  { leadId: "non-english-fr", stepKey: "email_1" },
  { leadId: "clear-fit-ecommerce", stepKey: "email_1", offerVariant: "no_proof" },
  { leadId: "clear-fit-support-saas", stepKey: "email_followup_1" },
  { leadId: "clear-fit-logistics", stepKey: "email_close" },
  { leadId: "clear-fit-support-saas", stepKey: "linkedin_message" },
  { leadId: "clear-fit-marketplace", stepKey: "email_1" },
];

function scorerTest(lead: (typeof GOLDEN_LEADS)[number], withProvider: boolean): string[] {
  const lines = [`  - description: "${lead.id} — ${lead.tests}"`];
  if (withProvider) lines.push("    provider: file://providers/scorer.ts");
  lines.push(`    vars: { leadId: ${lead.id} }`, ...SCORER_ASSERTS);
  return lines;
}

function copyTest(scenario: CopyScenario, withProvider: boolean): string[] {
  const suffix = scenario.offerVariant ? ` (${scenario.offerVariant})` : "";
  const lines = [`  - description: "copywriter ${scenario.leadId}:${scenario.stepKey}${suffix}"`];
  if (withProvider) lines.push("    provider: file://providers/copywriter-critic.ts");
  const vars = [`leadId: ${scenario.leadId}`, `stepKey: ${scenario.stepKey}`];
  if (scenario.offerVariant) vars.push(`offerVariant: ${scenario.offerVariant}`);
  lines.push(`    vars: { ${vars.join(", ")} }`, ...COPY_ASSERTS);
  return lines;
}

function classifierTests(withProvider: boolean): string[] {
  const lines: string[] = [];
  for (const reply of GOLDEN_REPLIES) {
    lines.push(`  - description: "${reply.id} (${reply.intent}) — ${reply.tests}"`);
    if (withProvider) lines.push("    provider: file://providers/reply-classifier.ts");
    lines.push(`    vars: { replyId: ${reply.id} }`, ...CLASSIFIER_ASSERTS);
  }
  return lines;
}

function componentConfig(input: {
  description: string;
  providerId: string;
  label: string;
  tests: string[];
}): string {
  return [
    ...HEADER,
    `description: "${input.description}"`,
    "",
    "prompts:",
    '  - "scout-evals"',
    "",
    "providers:",
    `  - id: ${input.providerId}`,
    `    label: ${input.label}`,
    "",
    "tests:",
    ...input.tests,
    "",
  ].join("\n");
}

const scorerConfig = componentConfig({
  description:
    "Scorer eval: does the real scorer (prompt + code rules) put each fictional golden lead in the right tier?",
  providerId: "file://providers/scorer.ts",
  label: "scorer",
  tests: GOLDEN_LEADS.flatMap((lead) => scorerTest(lead, false)),
});

const copywriterConfig = componentConfig({
  description:
    "Copywriter + critic eval: real revision loop, section 6 code rules, one model-graded idea check.",
  providerId: "file://providers/copywriter-critic.ts",
  label: "copywriter+critic",
  tests: COPY_SCENARIOS.flatMap((scenario) => copyTest(scenario, false)),
});

const classifierConfig = componentConfig({
  description:
    "Reply-classifier eval: 34 labelled replies across all 11 intents. Bar: at least 90% agreement (PROMPTFOO_PASS_RATE_THRESHOLD=90).",
  providerId: "file://providers/reply-classifier.ts",
  label: "reply-classifier",
  tests: classifierTests(false),
});

const defaultConfig = [
  ...HEADER,
  'description: "Scout evals: scorer + copywriter/critic + reply classifier. Needs AI_GATEWAY_API_KEY and MODEL_COPY (see evals/README.md)."',
  "",
  "# The one default target; each component is also runnable on its own (see evals/README.md).",
  "# Default bar: every code assertion passes; the classifier additionally needs >= 90% agreement.",
  "",
  "prompts:",
  '  - "scout-evals"',
  "",
  "providers:",
  "  - id: file://providers/scorer.ts",
  "    label: scorer",
  "  - id: file://providers/copywriter-critic.ts",
  "    label: copywriter+critic",
  "  - id: file://providers/reply-classifier.ts",
  "    label: reply-classifier",
  "",
  "tests:",
  ...GOLDEN_LEADS.flatMap((lead) => scorerTest(lead, true)),
  ...COPY_SCENARIOS.flatMap((scenario) => copyTest(scenario, true)),
  ...classifierTests(true),
  "",
].join("\n");

const files: [string, string][] = [
  ["promptfooconfig.scorer.yaml", scorerConfig],
  ["promptfooconfig.copywriter.yaml", copywriterConfig],
  ["promptfooconfig.classifier.yaml", classifierConfig],
  ["promptfooconfig.yaml", defaultConfig],
];

for (const [name, content] of files) {
  writeFileSync(resolve(OUT, name), content, "utf8");
  console.log(`wrote evals/${name}`);
}
