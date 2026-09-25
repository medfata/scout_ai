# First-send checklist (gate 4)

Everything that must be true before a real email can leave a real mailbox. Work top to bottom;
each section assumes the one above it is done. Nothing here is optional — a skipped line shows
up as a blocked send, a bounce, or a spam complaint.

Reference: `AGENTS.md` sections 8 (accounts and secrets), 9 (deliverability) and 11 (owner tasks).

---

## 1. Hosting and database

- [ ] Vercel project on **Hobby**, connected to `medfata/scout_ai`, production branch `main`.
- [ ] Neon Postgres (free plan) added from the Vercel Marketplace; `DATABASE_URL` copied from
      the **pooled** endpoint (the host contains `-pooler`; Scout disables prepared statements
      automatically when it does).
- [ ] Preview deployments have **Deployment Protection** on, and `DRY_RUN=true`.

## 2. Environment variables

Set these separately for **Preview** and **Production**. Names only; values never go in git.
Production must set `DRY_RUN=false` or Scout refuses to boot (review item 21).

| Variable | Preview | Production |
| --- | --- | --- |
| `APP_URL` | preview URL | production URL |
| `ADMIN_EMAIL` | your address | your address |
| `BETTER_AUTH_SECRET` | 32+ random chars | a **different** 32+ random chars |
| `ENCRYPTION_KEY` | 32 random bytes, base64 | same value as Preview |
| `OWNER_TIMEZONE` | e.g. `Europe/Berlin` | same |
| `DRY_RUN` | `true` | `false` |
| `DRY_RUN_REDIRECT_EMAIL` | your test inbox | (unused when `DRY_RUN=false`) |
| `DATABASE_URL` | Neon pooled URL | Neon pooled URL |
| `MODEL_COPY` | `anthropic/claude-haiku-4.5` | same |
| `MODEL_RESEARCH` | `gemini-3.8-flash` | same |
| `CRON_SECRET` | 32+ random chars | a different 32+ random chars |

Generate secrets with `openssl rand -base64 32`. Rotating `ENCRYPTION_KEY` invalidates the
do-not-contact list (D11) — decide Q12 before you ever rotate it.

## 3. Google Cloud (sign-in + Gmail)

- [ ] One Google Cloud project. **Internal** OAuth consent screen on the sending Workspace
      domain, so no verification review is needed.
- [ ] OAuth client (Web application) with redirect URIs:
      `https://<app>/api/oauth/gmail/callback` and `https://<app>/api/auth/callback/google`.
- [ ] APIs enabled: **Gmail API**, **Cloud Pub/Sub**.
- [ ] Scopes requested by Scout: `gmail.send` and `gmail.readonly` only.
- [ ] `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` for app sign-in.
- [ ] `GMAIL_OAUTH_CLIENT_ID` / `GMAIL_OAUTH_CLIENT_SECRET` for the mailbox (may be the same
      client, but keep them separate so rotating one does not break the other).
- [ ] Pub/Sub topic (e.g. `scout-gmail-push`) and a **push subscription** whose endpoint is
      `https://<app>/api/webhooks/gmail?token=<GMAIL_PUSH_SECRET>`.
- [ ] Grant the Gmail service account publish rights on the topic
      (`gmail-api-push@system.gserviceaccount.com` → Pub/Sub Publisher).
- [ ] `GMAIL_PUBSUB_TOPIC` = `projects/<project>/topics/<topic>` and `GMAIL_PUSH_SECRET` set.

## 4. Sending domain and mailbox (section 9 — do this before the first send)

- [ ] Secondary domain bought (close to the brand). **Never cold-email from the primary domain.**
- [ ] Its website redirects to the main site.
- [ ] **SPF, DKIM and DMARC** configured and verified on the sending domain.
- [ ] One mailbox created with a real name, photo and signature.
- [ ] Warmup started; the mailbox has been warm for **2–3 weeks** before any cold send.
      Scout ramps 5 → 10 → 20 → 30 new conversations a week from `warmup_started_at`.
- [ ] Google Postmaster Tools configured so the spam-rate breaker has data.

## 5. Scout settings (`/settings`)

- [ ] **Signature** and **postal address** — both are required; a blank one blocks every send
      (guard rule 0).
- [ ] Timezone, sending windows (Mon–Fri 08:30–16:30 by default) and daily caps reviewed.
- [ ] Autonomy left at **L0** for the first two weeks (section 9).
- [ ] Kill switch **off**.
- [ ] Connect the mailbox at `/settings/connected-accounts` and confirm it shows `ok`.

## 6. Prove it, then record it

On the **preview** deploy with `DRY_RUN=true`:

- [ ] Approve one message in `/inbox` and confirm it lands in `DRY_RUN_REDIRECT_EMAIL` **inside
      the sending window**, with the subject prefixed `[TEST → original@address]`.
- [ ] Reply to that email from the redirect inbox and confirm Scout ingests it, classifies it,
      and stops the sequence (`/replies` shows the intent; the enrollment is no longer live).
- [ ] Confirm CI is green including the workflow time-travel job.

Record the three results, with dates and links, in `DECISIONS.md`. That record is what closes
gate 4 — the code being correct is not the gate.

## 7. Only then: production

- [ ] Flip `DRY_RUN=false` in Production **last**, after the preview demo is recorded.
- [ ] Watch the first real sends at L0: nothing leaves without your approval.
- [ ] Keep an eye on the digest's quota and bounce lines for the first week.
