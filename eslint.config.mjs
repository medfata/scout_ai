import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

/**
 * Section 10 architecture rules enforced by lint, not by review:
 *  - rule 3: `src/domain` imports nothing from adapters/db/vendor SDKs
 *  - ports never import adapters
 */
const config = [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      ".workflow-data/**",
      ".workflow-vitest/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "drizzle/**",
      "evals/**",
      "next-env.d.ts",
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    files: ["src/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/src/db/*", "@/src/adapters/*", "@/src/services/*", "@/src/ai/*", "@/src/workflows/*", "@/app/*"],
              message: "src/domain must stay pure: no db, adapter, service, ai or app imports (section 10, rule 3).",
            },
            {
              group: [
                "next",
                "next/*",
                "react",
                "react-dom",
                "ai",
                "@ai-sdk/*",
                "googleapis",
                "postgres",
                "drizzle-orm",
                "better-auth",
                "workflow",
                "langfuse",
              ],
              message: "src/domain must stay pure: no framework or vendor SDK imports (section 10, rule 3).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/ports/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/src/adapters/*"],
              message: "Ports are the boundary: ports never import adapters (section 3).",
            },
            {
              group: ["ai", "@ai-sdk/*", "googleapis", "postgres", "drizzle-orm", "better-auth", "workflow"],
              message: "Ports are vendor-free interfaces (section 3).",
            },
          ],
        },
      ],
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports", fixStyle: "inline-type-imports" }],
      "no-console": ["warn", { allow: ["warn", "error", "log"] }],
      // Scout is App Router only; this rule looks for a pages/ directory that never exists.
      "@next/next/no-html-link-for-pages": "off",
    },
  },
];

export default config;
