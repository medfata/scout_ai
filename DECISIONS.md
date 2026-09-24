# DECISIONS.md

Owner answers to open questions. Section 0 rule 6: **answers here extend `AGENTS.md`**. Where the two
conflict, this file wins. Never rewrite history in this file — append a new dated entry instead.

---

## D1 — Build scope for this pass (2026-09-24)

**Question.** Section 11 says to build one phase at a time and stop at each "done when" gate. How far
should the first pass go?

**Owner.** "What do you suggest?"

**Decision (agent recommendation, implicitly accepted).** Build **phases 0–5**, the MVP defined in
section 11: an email outreach engine that runs end to end, with LinkedIn left as assisted tasks only
in later phases.

**Reasoning recorded.** Phases 0–5 are declared "the MVP" by the plan itself. Phases 6–8 depend on
data that does not exist before real sends happen (reply statistics for the allocator, real bounce
rates for the circuit breakers, real volume for retention choices), so building them now would mean
guessing at thresholds the plan deliberately leaves to the owner. Everything built here is shaped so
those phases bolt on without refactoring.

**Not built, on purpose.** Phase 6 LinkedIn task queue (the `manual-linkedin` stub is here but the UI
queue is not), phase 7 analytics/allocator/weekly strategist, phase 8 circuit breakers, retention job,
export/delete UI, load test.

---

## D2 — Local sign-in without Google OAuth credentials (2026-09-24)

**Question.** Google sign-in needs a real GCP client before anyone can log in locally. Add a
dev-only backdoor?

**Owner.** "Dev-only email+password, off in production."

**Decision.** `src/lib/auth.ts` registers Better Auth's email + password provider **only** when
`NODE_ENV !== "production"` **and** `DRY_RUN=true`, and sign-up is disabled — the account must already
exist, so only `ADMIN_EMAIL` can be used. Production runs Google sign-in only, exactly as section 8
says. The credentials provider is not compiled into a production build (the branch is on
`process.env.NODE_ENV` and `DRY_RUN`, both inlined at build time).

**Consequence for the owner.** Locally, run `pnpm db:seed:owner` to create the single local owner
account from `ADMIN_EMAIL` + `DEV_OWNER_PASSWORD`. Never set `DRY_RUN=true` in production.

---

## D3 — Repo root (2026-09-24)

**Owner.** Use `D:\my_projects\scout_ai` directly as the repo root, not a `scout/` subfolder. The
section 10 tree is therefore applied with `app/`, `src/`, `tests/`, `evals/` at the repo root.

---

## D4 — Dependencies inferred from section 4 (2026-09-24)

Section 0 rule 2 forbids dependencies "outside section 4". Section 4 names several products without
naming their client library, so these are the *only* additional packages, each one the official
client for a section 4 choice:

| Package | Section 4 choice it serves |
| --- | --- |
| `googleapis` | "Gmail API with an Internal OAuth app" |
| `langfuse` | "Langfuse + promptfoo" |
| `@ai-sdk/gateway`, `@ai-sdk/google` | "AI SDK 7 via Vercel AI Gateway", "Gemini free tier" |
| `@workflow/vitest` | section 7: "Tests fast-forward time with `@workflow/vitest`" |
| `vite` | peer dependency of Vitest 5, not a choice of its own |

**Open question for the owner (Q1).** Prettier is not in section 4, so it is **not** installed, and
formatting is only lint-enforced. Approve `prettier` (dev-only) if you want deterministic formatting
in CI.

---

## D5 — Postgres driver: `postgres` (postgres.js) everywhere (2026-09-24)

Section 4 says "Postgres on Neon"; it does not name a driver. Scout uses **one** driver,
`postgres` (postgres.js), for local dev, CI and production, so that migrations and queries behave
identically everywhere. In production `DATABASE_URL` points at Neon's **pooled** endpoint
(`-pooler` hostname), and `src/db/client.ts` automatically disables prepared statements when it sees
`-pooler`, which is what PgBouncer transaction mode requires. `@neondatabase/serverless` stays in the
tree because the Neon HTTP driver is the documented escape hatch if connection limits ever bite on
Vercel Hobby; it is not wired up.

**Open question for the owner (Q2).** Approve switching production to `@neondatabase/serverless`
(Neon HTTP driver) if you ever hit `too many connections` on Hobby.

---

## D6 — TypeScript 5.9, not 6 or 7 (2026-09-24)

npm currently serves TypeScript 7.0.2 (the native compiler). Section 4 says "TypeScript strict" and
the rest of the toolchain (ESLint config, Vitest, Next 16) is only guaranteed against 5.x, so Scout
pins `typescript@^5.9.3`. Upgrading is a one-line change plus a full typecheck.

---

## D7 — `MODEL_*` env vars (2026-09-24)

Section 4 defines `MODEL_SMART` and `MODEL_FAST`, but section 13's `.env.example` (which is the
authoritative list for v1) defines `MODEL_COPY` and `MODEL_RESEARCH` instead. Section 0 wins, so v1
uses **`MODEL_COPY`** (Claude Haiku 4.5, from the AI Gateway model list) and **`MODEL_RESEARCH`**
(Gemini Flash free tier). No `MODEL_SMART` exists in v1 because Sonnet 5 is an upgrade the owner must
approve. Model IDs are read from env; nothing is hard-coded.

---

## D8 — Phase 0 "done when" gates that need the owner (2026-09-24)

Two phase 0 gates cannot be satisfied from inside this repo:

- *"Deploys on Vercel Hobby"* — needs the owner's Vercel account and the Neon integration. The repo is
  ready for it: `vercel.json` holds the single daily cron, and every env var is listed in
  `.env.example`.
- *"migrations run in CI"* — wired in `.github/workflows/ci.yml` against a throwaway `postgres:17`
  service. It runs on push to any branch once the repo has a GitHub remote.

**Open question for the owner (Q3).** Confirm you want the daily cron at 05:00 UTC (`0 5 * * *` in
`vercel.json`). Vercel Hobby allows one cron per day; the time should be a few hours before your
morning so the digest is waiting for you.

---

## Open questions for the owner (answer in a new entry below)

These are places where the plan is silent or where a default had to be chosen to keep
building. Each one is easy to change; none of them is a locked decision.

**Q1 — Prettier.** Not in section 4, so it is not installed and CI only lint-checks.
Approve `prettier` (dev-only) if you want deterministic formatting.

**Q2 — Neon driver.** Postgres.js is used for every environment (D5). Approve switching
production to `@neondatabase/serverless` if you ever hit `too many connections` on Hobby.

**Q3 — Daily cron time.** `vercel.json` runs the daily planner at 05:00 UTC. Confirm the
hour so the digest is waiting when you wake up.

**Q4 — The "LinkedIn-first variant".** Section 7's table says email step 1 is skipped "No
valid email (use LinkedIn-first variant)" but never defines that variant's day offsets.
Scout v1 defines **only** `email_linkedin_v1` (sequence templates are code, section 7) and
records the missing variant as a question rather than inventing a schedule. LinkedIn
automation is phase 6, so nothing is blocked today. **Proposed default:** same steps as
`email_linkedin_v1`, with the email steps removed until a valid address is found, and
LinkedIn steps at day 0 (invite) and accept+1 business day (message).

**Q5 — Thresholds the plan leaves open.** Chosen defaults, all in code where you can read
them: tier cutoffs A ≥ 80 / B ≥ 60 / C ≥ 40 and disqualify below 40
(`src/domain/scoring.ts`); the pre-score research gate at 50 and the enrichment gate at 60
(section 6 fixes 60, the 50 is a starting value); the banned-phrase list and opt-out
phrases in `src/domain/copy-rules.ts`; an out-of-office reply with no stated return date
reschedules 3 days out (`src/domain/enrollment.ts`, `OOO_DEFAULT_DAYS`).

**Q6 — "Never-contact" from the approval inbox.** The plan's inbox actions are "Review,
edit, approve, skip, never-contact". `X` adds the contact's email, email domain and
LinkedIn URL to `suppressions` and stops any live enrollment. Confirm that domain-level
suppression (blocking the whole company) is what you want from that key.

**Q7 — Digest delivery.** Section 4 says "daily digest by email" and section 3 calls it the
"morning digest". v1 sends it to the owner through the Telegram bot and the sending
mailbox; confirm you want both, or Telegram only.

**Q8 — Disconnecting an account.** Not in the plan. The connected-accounts page can show a
broken mailbox and offer Reconnect, but has no Disconnect button. Say the word if you want
one.

---

## Owner tasks still open (from section 11)

Tracked here so the plan and the repo agree. None of these block local development.

- [ ] Vercel Hobby project + Neon Postgres (free plan) from the Marketplace.
- [ ] Buy 1–2 secondary domains, create mailboxes, set SPF/DKIM/DMARC, start warmup in week 1.
- [ ] Google Cloud project: Gmail API, Internal OAuth consent screen, Pub/Sub topic for Gmail push.
- [ ] Free keys: Apollo, Exa, Reoon, ZeroBounce, Gemini (AI Studio), AI Gateway, Telegram bot.
- [ ] Write 1–3 offers with real proof: case studies, demos, numbers.
- [x] Keep LinkedIn in assisted mode (decided for v1).
