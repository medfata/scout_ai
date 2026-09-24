# Phase 2 vendor spikes (section 10, rule 2)

"Spike before building an adapter. Write a 20-line script that calls the real vendor
endpoint once, commit the recorded response as a test fixture, then build the adapter."

Each script below calls **one** real endpoint, prints the raw JSON, and exits with a
readable message when its key is missing. They are manual tools: nothing imports them,
no test runs them, and they are never part of `pnpm test` or a build.

## Running a spike

Point Node at `.env.local` (tsx forwards Node flags) and run the script once:

```bash
pnpm exec tsx --env-file=.env.local spikes/m2-apollo.ts
pnpm exec tsx --env-file=.env.local spikes/m2-exa.ts
pnpm exec tsx --env-file=.env.local spikes/m2-reoon.ts
pnpm exec tsx --env-file=.env.local spikes/m2-zerobounce.ts
pnpm exec tsx spikes/m2-jina.ts https://example.com
```

`.env.local` is git-ignored and must be filled in by the owner (see `.env.example`).
Each script prints the vendor's raw response to stdout so it can be pasted into
`tests/fixtures/vendor/` (see below). Keep the output out of commits.

## What each spike calls

| Script | Endpoint | Env var | Fixture it re-records |
| --- | --- | --- | --- |
| `m2-apollo.ts` | `POST https://api.apollo.io/api/v1/mixed_people/api_search` | `APOLLO_API_KEY` | `tests/fixtures/vendor/apollo-people-search.json` |
| `m2-exa.ts` | `POST https://api.exa.ai/search` | `EXA_API_KEY` | `tests/fixtures/vendor/exa-search.json` |
| `m2-reoon.ts` | `GET https://emailverifier.reoon.com/api/v1/verify` | `REOON_API_KEY` | `tests/fixtures/vendor/reoon-verify.json` |
| `m2-zerobounce.ts` | `GET https://api.zerobounce.net/v2/validate` | `ZEROBOUNCE_API_KEY` | `tests/fixtures/vendor/zerobounce-validate.json` |
| `m2-jina.ts` | `GET https://r.jina.ai/<url>` | none (public) | `tests/fixtures/vendor/jina-reader.json` |

## About the committed fixtures

Every file in `tests/fixtures/vendor/` carries a `_fixture_note` that says the same
thing: it is a **documented-shape example**, not a recorded response. The adapter is
built against the shape, but it must not be trusted for a real send until the owner
re-records the fixture with a live key. To re-record: run the spike, copy the JSON into
the fixture file, replace `_fixture_note` with the date and the exact request that
produced it, and re-run `pnpm vitest run`.

The Hacker News adapter needs no key and has no spike: its shapes come from the public
Algolia API and are committed as `hn-algolia-story.json` and `hn-algolia-search.json`.
Re-record them with a plain `curl` if they ever change.

## Docs these shapes came from (read 2026-09-24)

- Apollo People API search: https://docs.apollo.io/reference/people-api-search
  (base URL `https://api.apollo.io/api/v1`, `x-api-key` header, `people[].last_name_obfuscated`).
  The current published docs for this endpoint do **not** list an
  `organization_industries` filter, even though the ICP filter model carries industries.
  The spike must confirm whether Apollo still accepts it; see the open question in the
  phase 2 report.
- Exa search: https://docs.exa.ai/reference/search
  (`Authorization: Bearer` or `x-api-key`, response `{ requestId, results[] }`).
- Reoon email verifier: https://www.reoon.com/ (Email Verifier API v1,
  `GET https://emailverifier.reoon.com/api/v1/verify?email=&key=&mode=power`).
- ZeroBounce v2 validate: https://www.zerobounce.net/docs/email-validation-api-quickstart/v2-validate-emails
  (`GET https://api.zerobounce.net/v2/validate?api_key=&email=`).
- Jina Reader: https://jina.ai/reader (`GET https://r.jina.ai/<url>`, JSON response when
  `Accept: application/json`; anonymous tier allows 20 requests/minute, no key).
- Hacker News via Algolia: https://hn.algolia.com/api (`/api/v1/search`, `/api/v1/search_by_date`).
