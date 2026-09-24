/**
 * Market names re-exported so callers import from `@/src/domain` and never reach into
 * individual files. Nothing in this directory imports db, adapters, services or vendor
 * SDKs (section 10 rule 3) — and ESLint enforces it.
 */

export * from "./types";
export * from "./enrollment";
export * from "./sequence";
export * from "./copy-rules";
export * from "./scoring";
export * from "./quotas";
export * from "./suppression";
export * from "./reply";
export * from "./settings-defaults";
