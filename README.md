# Command Center

Personal + small-business ops app: zero-knowledge secrets, password vault,
developer knowledge base, finance/payroll/tax, and Slack-integrated reminders.

Bun + Next.js 16 + Postgres + Redis. Two apps in one repo (`apps/api`, `apps/web`).

---

## Prereqs

- **Bun** ≥ 1.3.14 (`curl -fsSL https://bun.sh/install | bash`)
- **Postgres 13+** reachable from your machine
- **Redis** reachable from your machine
- **Chromium** on `$CHROME_PATH` — only if you'll use the CA-invoice PDF export (macOS: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`; Linux: `sudo apt install chromium`)
- **Ollama** running locally — only if you'll use the LLM-drafted email / secret-import features (`OLLAMA_HOST`, `OLLAMA_MODEL` in `.env`)
- **Slack bot token** — only if you want reminder notifications

---

## First-time setup

```bash
# 1. Clone + install
git clone <repo> && cd command-center
bun install

# 2. Env
cp .env.example .env
# Edit .env — set DATABASE_URL, APP_DATABASE_URL, REDIS_URL, SESSION_SECRET
# (the two DB URLs are different roles on the same database; see "Two DB roles" below)

# 3. Create the database as your admin user, then apply schema
createdb command_center                 # or from psql: CREATE DATABASE command_center;
bun run migrate                         # creates all tables via DATABASE_URL

# 4. Provision the restricted runtime role (prints its password once)
bun run apps/api/scripts/bootstrap-app-role.ts
# Copy the printed password into APP_DATABASE_URL in .env
```

## Run

```bash
bun run dev            # starts api (:3001) + web (:3010) with hot reload
```

Open [http://localhost:3010](http://localhost:3010). Sign up creates your first org.

Individual services:

```bash
bun run dev:api        # api only, --hot reload
bun run dev:web        # web only, next dev
```

---

## Common commands

```bash
bun run typecheck      # tsc on both api and web
bun run test           # bun test (unit)
bun run migrate        # run pending SQL migrations
bun run build:web      # production build for the web app (standalone + assets)
bun run start:cc_api   # production api runner (used by pm2)
bun run start:cc_web   # production web runner (used by pm2)
bun run db:backup      # pg_dump to a timestamped file
bun run db:restore     # restore from a dump file
```

---

## Two DB roles — DATABASE_URL vs APP_DATABASE_URL

Same database, two different Postgres roles:

| Env var | Role | Used by | Privileges |
|---|---|---|---|
| `DATABASE_URL` | admin (e.g. `cc_admin`) | `bun run migrate`, `bootstrap-app-role.ts` | full DDL, bypasses RLS |
| `APP_DATABASE_URL` | `command_center_app` | every running api request | restricted; RLS enforced; can't UPDATE/DELETE `audit_log` |

Two roles because Postgres Row-Level Security **only applies to non-superusers**. If the runtime app had admin rights, a bug or SQL injection could bypass tenant isolation. Migrations do it once with a strong key; the app carries a weaker one every day.

---

## Env vars

Required (app won't boot without these — see `apps/api/core/config.ts`):

- `APP_DATABASE_URL` — Postgres runtime URL (restricted role)
- `REDIS_URL` — must end with `/0` (Redis DB index; single-DB Redis servers reject others)
- `SESSION_SECRET` — 32+ random chars; app refuses to boot in production if left as `change-me`

Also read at runtime, but each has its own "not configured" behavior:

- `DATABASE_URL` — admin role; migrations/bootstrap only
- `API_PORT` (default 3001), `PORT` (web, default 3010)
- `API_ORIGIN` — web → api origin (baked at web build time; local default is `http://localhost:3001`)
- `APP_URL` — used in password-reset email links
- `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID` — reminder notifications
- `SMTP_HOST/PORT/SECURE/USER/PASSWORD/FROM` — password reset + CA invoice emails (Gmail: use an App Password, `SMTP_HOST=smtp.gmail.com`, `SMTP_FROM` must match `SMTP_USER` or a verified alias)
- `CHROME_PATH` — Chromium binary for CA invoice PDF rendering
- `OLLAMA_HOST`, `OLLAMA_MODEL` — LLM drafting for monthly CA email + Ollama-assisted secret imports
- `GCS_BUCKET_NAME`, `GCS_SERVICE_ACCOUNT_KEY` — Knowledge base file attachments (Google Cloud Storage)

See `.env.example` for a starter file.

---

## Structure

```
apps/
  api/                         Bun HTTP server (Bun.serve native routing)
    core/                      auth, config, db, email, ollama, slack, rate-limit
    modules/                   secrets, vault, knowledge, finance, reminders, audit
    migrations/                numbered .sql files, `bun run migrate` applies them
    scripts/                   bootstrap-app-role.ts, backup/restore
  web/                         Next.js 16 App Router (Turbopack), zero-knowledge crypto client-side
infrastructure/                Kubernetes manifests + kustomize overlays for GKE
.github/workflows/             ci.yml (tests), deploy.yml (build → GKE)
```

Read `apps/web/AGENTS.md` before editing web code — this Next.js version has breaking changes from what most reference material assumes.

---

## Architecture in one paragraph

Secrets and Vault are **zero-knowledge**: the browser derives a workspace key from your password, wraps a per-project DEK with it, and the server only ever sees ciphertext. Losing your password + recovery key = permanent data loss (that's the point). Everything else (finance, knowledge base, reminders) is server-readable and RLS-scoped per org via the `command_center_app` role. Reminders are swept once an hour and delivered to Slack; the sweep is idempotent per calendar day per reminder.

---

## Deploying

Two options wired up in this repo:

- **VM + pm2** — build locally, `git pull` on the VM, `bun run build:web && pm2 reload all`. See `package.json` for `start:cc_*` scripts.
- **GKE** — see `infrastructure/k8s/` (kustomize base + dev/staging/production overlays) and `.github/workflows/deploy.yml`. Push to `main` → staging; publish a Release → production. Requires GCP secrets set up per that workflow.

---

## License

Private / personal use.
