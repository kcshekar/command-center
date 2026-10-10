# Command Center — Setup & Deploy

Three sections: local setup, prod bootstrap (one-time), and prod routine update (every deploy after).

For failure modes during any of these, see `docs/troubleshooting.md`. For architecture context, see `docs/architecture.md`.

## Local setup (fresh clone)

Prerequisites: Bun, PostgreSQL 16, Node 22+ (nvm), Temporal CLI (`brew install temporal`), Ollama with `llama3.2:3b` pulled.

```bash
# 1. Clone + install
git clone <repo-url> command-center
cd command-center
bun install

# 2. Root .env
cp .env.example .env
# Fill in DATABASE_URL, APP_DATABASE_URL, REDIS_URL
openssl rand -hex 32   # for SESSION_SECRET
openssl rand -hex 32   # for SLACK_ENCRYPTION_SECRET
openssl rand -hex 32   # for WORKER_CALLBACK_TOKEN
# Also set OLLAMA_HOST, OLLAMA_MODEL

# 3. CC migrations
bun run migrate

# 4. Start CC + web + worker all together
bun run dev    # scripts/dev.sh — starts api, web, and worker if installed
```

Open http://localhost:3000, sign up, confirm sidebar shows all nav items.

**Slack**: In `/slack`, Add Bot Connection (paste `xoxb-...` + optional `xapp-...`), then Add Route Mappings for `reminders.due`, `automations.digest`, `automations.approval`.

**App-level token for Socket Mode**: at <https://api.slack.com/apps> → App-Level Tokens → Generate (scope `connections:write`), copy `xapp-...`, paste into the bot's Edit modal.

**Service token**: `/tokens` → Issue token with scopes `expenses:write reminders:write reminders:read slack:send`. Paste into `services/automations-worker/.env` as `CC_SERVICE_TOKEN`.

**Automations worker setup**:
```bash
cd services/automations-worker
pnpm install
ADMIN_DATABASE_URL="postgres://cc_admin:<pwd>@<host>:5432/postgres" pnpm bootstrap
cp .env.example .env
# Fill in all the values (AUTOMATIONS_DATABASE_URL from bootstrap, TEMPORAL_*, GOOGLE_*, etc.)
```

**Temporal namespace** (one-time per Temporal server):
```bash
temporal operator namespace create --address chandu-h110:7233 --namespace commandcenter
```

**Workflow Updates flag** (one-time per Temporal server) — see `infra/temporal/dynamicconfig/docker.yaml`.

**GCP OAuth** (Desktop type for local): add redirect `http://localhost:3005/auth/google/callback`, enable Gmail/Calendar/Tasks APIs, set consent screen to Production.

**Google authorization**: open `/agent-automations`, enter your Gmail, Sign in with Google.

**Smoke test**:
```bash
temporal workflow start \
  --address chandu-h110:7233 \
  --namespace commandcenter \
  --task-queue personal-automations \
  --type morningBriefWorkflow \
  --workflow-id smoke-$(date +%s) \
  --input '{"userEmail":"you@gmail.com","slackRouteKey":"automations.digest"}'
```

**Schedules** (after you've seen a few manual runs land cleanly):
```bash
cd services/automations-worker
pnpm schedules:init -- you@gmail.com [--skip-triage]
```

---

## Prod bootstrap (one-time)

Target: GCP VM with CC + Postgres + reminders already running (Phase 1 live). Temporal in shared GKE cluster (cuva dev), namespace `commandcenter`, Updates flag ON cluster-wide. Deployment is manual via git pull on the VM.

### 1. Pull + base env

```bash
ssh <cc-vm>
cd ~/command-center
git pull --ff-only
bun install --frozen-lockfile
```

Append to CC's `.env`:
```
SLACK_ENCRYPTION_SECRET=<paste SESSION_SECRET value to keep existing tokens decryptable>
WORKER_CALLBACK_URL=http://localhost:3005
WORKER_CALLBACK_TOKEN=<openssl rand -hex 32>
NEXT_PUBLIC_WORKER_URL=https://commandcenter.pametnitech.com/automations
API_ORIGIN=http://localhost:3011
```

### 2. CC migrations

```bash
bun run migrate
```

Applies 0016 (slack-registry), 0017 (service-tokens), 0018 (RLS + grants fix), 0019 (google-accounts mirror).

If `cc_admin` lacks CREATEDB/CREATEROLE, grant first:
```bash
sudo -u postgres psql -c "ALTER ROLE cc_admin CREATEDB CREATEROLE;"
```

Verify:
```bash
sudo -u postgres psql -d commandcenter -c "\dt" | grep -E "slack_connections|slack_routes|service_tokens|google_oauth_accounts"
```

### 3. Rebuild + reload CC

```bash
rm -rf apps/web/.next
bun run build:web
pm2 reload cc_api cc_web
pm2 logs cc_api --lines 60
```

### 4. Slack setup

In `/slack`:
- **Add Bot Connection** (paste existing `xoxb-...` and the `xapp-...` from Slack app settings)
- Make sure Socket Mode + Interactivity are both ON in <https://api.slack.com/apps>, click Save Changes, then **Install App → Reinstall to Workspace**
- Add Route Mappings for `reminders.due`, `automations.digest`, `automations.approval`

Reload CC and expect `"message":"slack socket connected"` in `pm2 logs cc_api`.

### 5. Service token

`/tokens` → Issue token with scopes `expenses:write reminders:write reminders:read slack:send`. Copy the `cc_st_...` value shown once.

### 6. Install Node 22 + pnpm on the VM

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.5/install.sh | bash
source ~/.nvm/nvm.sh
nvm install 22
corepack enable
corepack prepare pnpm@9.12.0 --activate
```

### 7. Bootstrap automations DB

```bash
cd ~/command-center/services/automations-worker
pnpm install --frozen-lockfile
ADMIN_DATABASE_URL="postgres://cc_admin:<pwd>@localhost:5432/postgres" pnpm bootstrap
# Save the AUTOMATIONS_DATABASE_URL output — needed next step
```

### 8. Worker env

```bash
cp .env.example .env
```

Required values:
```
AUTOMATIONS_DATABASE_URL=<from step 7>
AUTOMATIONS_ENCRYPTION_SECRET=<openssl rand -hex 32>
TEMPORAL_ADDRESS=<ILB IP>:7233
TEMPORAL_NAMESPACE=commandcenter
TEMPORAL_TASK_QUEUE=personal-automations
CC_BASE_URL=http://localhost:3011
CC_SERVICE_TOKEN=<from step 5>
GOOGLE_CLIENT_ID=<GCP console, Web application type>
GOOGLE_CLIENT_SECRET=<GCP console>
GOOGLE_REDIRECT_URI=https://commandcenter.pametnitech.com/automations/auth/google/callback
OLLAMA_HOST=http://chandu-h110:11434
OLLAMA_MODEL=llama3.2:3b
WORKER_CALLBACK_PORT=3005
WORKER_CALLBACK_TOKEN=<same string as CC's .env>
SLACK_ROUTE_DIGEST=automations.digest
SLACK_ROUTE_APPROVAL=automations.approval
```

### 9. nginx proxy for the worker

Add to the server block for `commandcenter.pametnitech.com`, **above** the existing `location /` block:

```nginx
location /automations/ {
    proxy_pass http://127.0.0.1:3005/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 10. GCP OAuth client (Web application)

<https://console.cloud.google.com/apis/credentials>:
- Type: **Web application**
- Authorized redirect URI: `https://commandcenter.pametnitech.com/automations/auth/google/callback`
- Enable Gmail API, Calendar API, Tasks API in the same project
- OAuth consent screen: Publishing status → **In production**

### 11. Start the worker

```bash
cd ~/command-center/services/automations-worker
pnpm build
pm2 start pnpm --name automations-worker --cwd "$(pwd)" -- start
pm2 save
pm2 logs automations-worker --lines 60
```

Expect `callback server listening on :3005` and `worker ready. namespace=commandcenter queue=personal-automations`.

Verify proxy from your laptop: `curl -i https://commandcenter.pametnitech.com/automations/auth/google/start` → expect 400 "missing ?email=".

### 12. Google authorization

Browser → <https://commandcenter.pametnitech.com/agent-automations> → enter your Gmail → Sign in with Google. Verify:

```bash
sudo -u postgres psql -d automations -c "SELECT user_email, scopes FROM google_oauth_tokens;"
```

### 13. Smoke tests

```bash
kubectl exec -n temporal deploy/temporal-admintools -- \
  temporal workflow start \
    --namespace commandcenter \
    --task-queue personal-automations \
    --type morningBriefWorkflow \
    --workflow-id prod-brief-$(date +%s) \
    --input '{"userEmail":"you@gmail.com","slackRouteKey":"automations.digest"}'
```

Then `eveningWrapWorkflow` with the same input shape. Skip triage until Ollama is reachable from the VM.

### 14. Schedules (leave off until smoke tests pass)

```bash
cd ~/command-center/services/automations-worker
pnpm schedules:init -- you@gmail.com --skip-triage
```

Add triage later (`pnpm schedules:init -- you@gmail.com` without the flag) once Ollama is reachable.

---

## Routine update (every deploy)

```bash
ssh <cc-vm>
cd ~/command-center
git pull --ff-only
git diff HEAD~ HEAD -- .env.example services/automations-worker/.env.example
# add any new required env vars

# CC
bun install --frozen-lockfile
bun run migrate
bun run build:web
pm2 reload cc_api cc_web
pm2 logs cc_api --lines 40

# Worker
cd services/automations-worker
pnpm install --frozen-lockfile
pnpm migrate
pnpm build
pm2 reload automations-worker
pm2 logs automations-worker --lines 40

# Verify
kubectl exec -n temporal deploy/temporal-admintools -- \
  temporal workflow start --namespace commandcenter --task-queue personal-automations \
  --type morningBriefWorkflow --workflow-id post-deploy-$(date +%s) \
  --input '{"userEmail":"you@gmail.com","slackRouteKey":"automations.digest"}'
```
