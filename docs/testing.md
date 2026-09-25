# Testing Scout locally

Scout has two Vitest suites. Only the database-backed tests in each one need Postgres;
unit and domain tests are pure and always run.

| Command | Config | What runs | Needs Postgres |
| --- | --- | --- | --- |
| `pnpm test` | `vitest.config.ts` | unit, domain and service tests (`tests/**/*.test.ts(x)` and `src/**/*.test.ts`, minus `tests/e2e/**` and `tests/workflows/**`) | only the service tests; they skip without |
| `pnpm test:workflows` | `vitest.workflows.config.ts` | workflow time-travel tests (`tests/workflows/**`), compiled by `@workflow/vitest` | yes; skips without |

`pnpm test:watch` and `pnpm test:coverage` use the same config as `pnpm test`. Browser e2e is
`pnpm test:e2e` (Playwright) and is not covered here.

## Start the test database

`docker-compose.yml` at the repo root runs the `postgres:17` service these suites expect
(CI provides the same image as a service container):

```powershell
docker compose up -d
docker compose ps    # wait until the health column says "healthy"
```

It creates database `scout_test` with user/password `scout`/`scout`, backed by a named
volume, and publishes it on host port **55432** — not 5432, so it cannot clash with a
Postgres you already run.

Connection string:

```text
postgres://scout:scout@localhost:55432/scout_test
```

Put it in `.env.local` for `pnpm dev` and the repo scripts:

```dotenv
DATABASE_URL=postgres://scout:scout@localhost:55432/scout_test
```

The test suites read `DATABASE_URL` from the **process environment**, and Vitest does not
load `.env*` files, so a value that lives only in `.env.local` is invisible to `pnpm test`.
Export it in the shell for a test run:

```powershell
$env:DATABASE_URL = "postgres://scout:scout@localhost:55432/scout_test"
pnpm test
pnpm test:workflows
```

When `DATABASE_URL` is absent, `tests/setup/vitest.setup.ts` fills in a sentinel
(`postgres://scout:scout@127.0.0.1:1/scout_test?sslmode=disable`) that points at a closed
port, so a test run can never accidentally reach a real database.

> These tests truncate every domain table. Use the fixture for tests only — never point it
> at a database whose data you care about.

Run a single file:

```powershell
pnpm test tests/services/send-guard.test.ts
pnpm test:workflows tests/workflows/sequence-happy-path.test.ts
```

## How migrations are applied for tests

`tests/setup/db.ts` is the whole harness. On the first `hasDatabase()` call in a worker
process it connects to `DATABASE_URL`, runs `select 1`, then applies the committed Drizzle
migrations from `./drizzle/` with `migrate()`. The result is cached for that process. A
failure closes the pool, logs `tests.database_unavailable` (error name and socket code only,
never the URL) and is remembered as "no database".

Every database-backed suite is wrapped in `describe.skipIf(!(await hasDatabase()))`. Suites
call `resetDatabase()` in `beforeEach`, which truncates the sixteen domain tables with
`RESTART IDENTITY CASCADE`. The Better Auth tables (`user`, `session`, `account`,
`verification`) are deliberately never truncated, so a test cannot wipe a developer's
session. `closeTestDatabase()` closes the pool in `afterAll` so a worker can exit.

You do **not** have to run `pnpm db:migrate` before `pnpm test`: the harness applies pending
migrations itself. `pnpm db:migrate` (same `DATABASE_URL`, from the environment) is there for
manual work; CI runs it before the suites. Schema changes follow section 10 rule 10 —
`pnpm db:generate`, commit the SQL, never edit an applied migration.

## What a skip looks like

With no database reachable, both suites exit 0 and report the database-backed files as
skipped:

```text
{"level":"warn","at":"...","message":"tests.database_unavailable","app":"scout","reason":"Error","code":"ECONNREFUSED"}
 ↓ tests/services/send-guard.test.ts (40 tests | 40 skipped)

 Test Files  1 skipped (1)
      Tests  40 skipped (40)
```

`pnpm test:workflows` prints the same shape, for example
`↓ tests/workflows/sequence-happy-path.test.ts (2 tests | 2 skipped)`. The pure tests in
`pnpm test` still run, so a laptop without Docker still gets a useful result — just less
coverage.

## Reset a dirty database

`resetDatabase()` runs before each test, so a dirty database only happens after a crashed
run or manual tinkering. Cheapest first:

Full reset — drops the container and its named volume; the next test run re-applies the
migrations:

```powershell
docker compose down -v
docker compose up -d
```

Truncate the domain tables in place, exactly as `resetDatabase()` does (auth tables left
alone):

```powershell
docker compose exec postgres psql -U scout -d scout_test -c "TRUNCATE TABLE activity_events, webhook_events, send_counters, suppressions, messages, enrollments, experiment_arms, learnings, lead_scores, research_briefs, contacts, companies, icps, offers, connected_accounts, settings RESTART IDENTITY CASCADE"
```

## CI

`.github/workflows/ci.yml` runs lint, typecheck, `pnpm db:migrate`, `pnpm test` and
`pnpm test:workflows` in one job against a `postgres:17` service container (database
`scout_ci`, published on 5432, same `scout`/`scout` credentials). Local and CI use the same
image and the same migrations; only the connection string and where it comes from differ.
