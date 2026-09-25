# Scout evals (stage 1b, phase 3 gate)

Promptfoo evals for the seven model calls in section 6. They run the **real** prompt functions
and agents from `src/ai/**` — no prompt text is copied into YAML — over a fictional golden set.
**Nothing here can send**: the providers call `scoreLead`, `draftMessage` and
`generateStructured` only; there is no `sendMessage`, no database and no mailbox in any eval
path. Briefs are fixed, so no eval performs live research.

The work order for this suite is `docs/review-2026-09-26.md`, Stage 1b.

## Commands

```bash
# Everything: scorer + copywriter/critic + classifier (~67 tests)
pnpm eval

# One component
pnpm eval:scorer        # 25 golden leads, code-only assertions
pnpm eval:copy          # 8 copy scenarios, code checks + 1 model-graded check
pnpm eval:classifier    # 34 labelled replies, code-only assertions, 90% bar

# No AI key needed: proves the harness itself is wired
pnpm eval:smoke         # TS provider + TS assertion + metadata plumbing
pnpm eval:assertions    # the real assertions pass on canned metadata and fail on bad metadata
```

`pnpm eval` needs the `eval` script in `package.json` (see "Scripts to add" below). The default
config is `evals/promptfooconfig.yaml`; the component configs sit next to it. All `file://`
paths in YAML resolve relative to the config file, so always run from the repo root.

## Required environment

`AI_GATEWAY_API_KEY` is the key that matters, plus the `MODEL_COPY` id from the gateway model
list (decision D7: model ids live in env, never hard-coded). Both normally live in `.env.local`;
the eval providers load that file the same way `scripts/refresh-models.ts` does.

`evals/lib/env.ts` fills the app's *unused* core variables with eval-only stubs (app URL, auth
secret, a `DATABASE_URL` that points at port 1 so an accidental connection fails instantly,
`MODEL_RESEARCH` for a role these evals never call). Values already present are never
overwritten. Without the key, every provider refuses politely with the same message the gate
script prints; nothing is sent.

## Pass bar

- **All code assertions pass.** That is `PROMPTFOO_PASS_RATE_THRESHOLD` unset (default 100%) for
  the scorer and copywriter runs.
- **Reply classifier: at least 90% agreement** on the 34 labelled replies:

  ```powershell
  $env:PROMPTFOO_PASS_RATE_THRESHOLD = "90"; pnpm eval:classifier
  ```

  Without the environment variable promptfoo stays strict (100%), which is *stricter* than the
  bar; the printed pass rate is the observed agreement either way.
- Record the first real run's numbers in `DECISIONS.md` when the owner provides the key
  (per the work order).

Evals are **not in CI**: `.github/workflows/ci.yml` runs lint, typecheck, unit and workflow
tests only. These runs need a real gateway key and spend the owner's AI credit, so they stay
owner-triggered.

## Golden set

| Data | Count | Coverage |
| --- | --- | --- |
| Leads (`evals/golden/leads*.ts`) | 25 | clear fit tier A, weak fit, disqualifier hits (agency, crypto, staffing, gambling), thin websites, non-English (de/fr), consent countries (CA/DE), catch-all emails, suppression |
| Fixed briefs | 25 | 1–3 numbered signals each, valid `.example` URLs, hooks bound to signal indices |
| Copy scenarios | 8 | first touch ×4 (clear, thin, French, no-proof offer), follow-up, close, LinkedIn (300 chars) |
| Labelled replies (`evals/golden/replies*.ts`) | 34 | every one of the 11 intents, ≥3 each: OOO with date / without date / explicit ISO date, hard + soft bounce DSNs, polite unsubscribe, human-answer-plus-OOO, named referrals |

Types make a broken fixture fail `pnpm typecheck`: leads are `GoldenLead` with
`ResearchBriefOutput` briefs; replies carry the expected `ReplyIntent`.

## Assertions: code vs model-graded

Everything mechanical is code. `evals/assertions/copy-rules.ts` calls the real
`evaluateCopyRules` from `src/domain/copy-rules.ts` (never a copy of it) and fails on any
**error**-severity violation:

| Check | Where |
| --- | --- |
| 110 / 70 words, 300 LinkedIn chars, 60-char subject | `evaluateCopyRules` |
| every `claims[].signalIndex` exists in the brief | `evaluateCopyRules` |
| no link in email 1 outside the signature | `evaluateCopyRules` |
| opt-out line present, banned phrases absent | `evaluateCopyRules` |
| no invented numbers when the offer has no proof | `evaluateCopyRules` |
| exactly one CTA question *outside* signature/opt-out | `evals/lib/copy-check.ts` + copy assertion |
| `DraftSchema` parse passes | copy assertion |
| the critic + code merge passed, subject present on email | copy assertion |
| scorer tier / score / disqualification vs the fixture | `scorer-expectations.ts` |
| fixture integrity (brief schema, consent, email eligibility) | `lead-facts.ts` |
| intent, return dates, follow-up dates, referral names | `classifier-intent.ts`, `classifier-details.ts` |

One check is model-graded, and only one: **"exactly one concrete idea tied to a signal"**
(`evals/assertions/concrete-idea.ts`) sends the draft plus the numbered signals through the real
`generateStructured` client and requires `pass` with the signal index it used.

## Layout

```
evals/
├─ promptfooconfig.yaml            # default target: all three components
├─ promptfooconfig.scorer.yaml
├─ promptfooconfig.copywriter.yaml
├─ promptfooconfig.classifier.yaml
├─ generate-configs.ts            # re-emits the four configs from the fixtures
├─ golden/                        # 25 leads + 34 labelled replies, typed
├─ lib/                           # env bootstrap, grading helpers, copy checks
├─ providers/                     # file:// TS providers; the only model callers
├─ assertions/                    # file:// TS assertions; code and one model-graded check
└─ smoke/                         # no-key harness tests (see commands above)
```

Changing a fixture id? Run `pnpm tsx evals/generate-configs.ts` so the YAML stays in sync.

## Known blocker reported on 2026-09-25 (not an eval bug)

`DEFAULT_OPT_OUT_LINE` in `src/domain/copy-rules.ts`
(`Not interested? Reply "no" and I won't email you again.`) does **not** match any phrase in
`OPT_OUT_PHRASES`, so every draft that follows the copy prompt and appends the mandated opt-out
line fails `evaluateCopyRules` with `missing_opt_out`. Reproduced with a throwaway probe whose
body ended in the real default line: the only violation was `error:missing_opt_out`.

The copywriter eval keeps the app's real default line (faithful to the pipeline), so
`pnpm eval:copy` fails until `OPT_OUT_PHRASES` recognises the default line — for example by
adding `"won't email you again"`. That is a one-line `src/` fix owned by the main agent.

## Scripts to add

The work order's default command needs one line in `package.json` (the existing `evals` script
already runs the same config, but `eval` is the name the stage asks for):

```json
"eval": "promptfoo eval -c evals/promptfooconfig.yaml",
"eval:smoke": "promptfoo eval -c evals/smoke/promptfooconfig.yaml",
"eval:assertions": "promptfoo eval -c evals/smoke/assertions.yaml",
"eval:scorer": "promptfoo eval -c evals/promptfooconfig.scorer.yaml",
"eval:copy": "promptfoo eval -c evals/promptfooconfig.copywriter.yaml",
"eval:classifier": "promptfoo eval -c evals/promptfooconfig.classifier.yaml"
```

Only the first is required for the stage; the rest make component runs one word.

## Runtime note

promptfoo 0.123.1 refuses to start on Node < 22.22.0 ("promptfoo requires a supported Node.js
runtime") while the repo's `engines` allows `>=22.0.0`. Evals therefore need Node 22.22+ (or 24+);
this was observed on a machine with 22.20.0 and verified on 25.0.0. No app code depends on this.
