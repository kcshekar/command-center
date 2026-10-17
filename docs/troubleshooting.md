# Command Center — Troubleshooting

Every real failure mode we've hit, with symptom → cause → fix. Grep for the error text; it's quoted verbatim.

## Database & migrations

### `relation "service_tokens" does not exist`
**Cause**: migration 0017 not applied, or api is running on a stale schema cache.
**Fix**: `bun run migrate` from repo root, then restart CC.

### `malformed array literal: "chat:write"`
**Cause**: Bun.sql serializes a JS array as CSV; Postgres `text[]` needs `{"a","b"}` literal.
**Fix**: Use `textArrayLiteral(...)::text[]` from `apps/api/core/pg-array.ts`. Already applied across the Slack + service-tokens routes.

### `permission denied for table notification_routes` / `slack_connections` / `service_tokens`
**Cause**: Migrations run as the owner role from `DATABASE_URL`; app queries as `command_center_app` from `APP_DATABASE_URL`. Postgres gives new tables no privileges to other roles unless the migration GRANTs them.
**Fix**: Migration 0018 backfills grants and sets `ALTER DEFAULT PRIVILEGES` so future migrations don't repeat this. If 0018 hasn't run yet on an environment:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE
  ON slack_connections, notification_routes, service_tokens
  TO command_center_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO command_center_app;
```

### `PostgresError: Connection closed` from `bun -e` while running CC works fine
**Cause**: Running CC has a long-lived TCP connection that survived a Tailscale/network blip. New connections fail because the route is actually down.
**Fix**:
```bash
tailscale status | grep <db-host>
ping -c 3 <db-host>
nc -zv -w 3 <db-host> 5432
```
If `bun -e` keeps failing after network recovery, pass env explicitly: `bun --env-file=.env -e '...'`.

## Slack

### Setting `SLACK_ENCRYPTION_SECRET` breaks reminder posting
**Cause**: Pre-change, Slack token encryption fell back to `SESSION_SECRET`. Setting a fresh `SLACK_ENCRYPTION_SECRET` means stored bot tokens can't decrypt.
**Fix**: Set `SLACK_ENCRYPTION_SECRET` to the **same bytes as current `SESSION_SECRET`** in existing prod, OR delete + re-add the bot connection via `/notifications` to re-encrypt under the new key.

### App-level token not saving when editing a bot connection
**Cause**: Original edit handler treated a blank bot token as "change nothing" and skipped the whole token-update branch — dropping the app token.
**Fix**: Already patched. Pull latest, restart CC, edit again. Verify with `SELECT (encrypted_app_token IS NOT NULL) AS has_app_tok FROM slack_connections`.

### Route key dropdown defaults to `reminders.due` (silent overwrite trap)
**Cause**: Add Route modal defaults to `reminders.due`; `ON CONFLICT (org_id, route_key)` upsert silently updates the existing reminders row if you don't change the dropdown.
**Fix**: Change System Route Key dropdown first, then fill the rest. Verify:
```bash
bun -e 'const s=new Bun.SQL(process.env.DATABASE_URL); console.log(await s`SELECT route_key, is_enabled, channel_id FROM notification_routes ORDER BY route_key`);'
```

### `Slack not configured for route 'automations.digest'`
**Cause**: Row missing/disabled, OR backing connection status != 'active'.
**Fix**:
```bash
bun -e 'const s=new Bun.SQL(process.env.DATABASE_URL); console.log(await s`SELECT r.route_key, r.is_enabled, c.name AS bot, c.status FROM notification_routes r JOIN slack_connections c ON c.id = r.connection_id ORDER BY r.route_key`);'
```
Then add the missing route in `/notifications` or re-enable the connection.

### Button click shows ⚠️ icon, nothing happens
**Causes** (in order of likelihood):
1. Socket Mode or Interactivity not enabled in Slack app settings — toggle both ON, click **Save Changes**, then **Install App → Reinstall to Workspace**
2. `@slack/socket-mode` v2 emits `"interactive"` events, not `"block_actions"` — already patched in `apps/api/core/slack-socket.ts`
3. Multiple CC processes with the same app token (dev + manual run) — kill the extras

### `route automations.approval does not allow buttons`
**Cause**: `allow_buttons` is false, OR the handler query didn't set `app.current_org_id` and RLS filtered the row.
**Fix**: In `/notifications` → Edit the route → Allow buttons ON. Also already patched: handler now sets GUC before querying.

### `user U... not in allowed approvers for automations.approval`
**Fix**: In `/notifications` → Edit the route → add your Slack user ID to the approver list. Find your ID in Slack: profile → three-dot menu → Copy member ID.

## Google

### `Google Tasks API has not been used in project ... before`
**Cause**: Enabling Gmail/Calendar doesn't enable Tasks — each API toggled per project.
**Fix**: Open the URL from the error (direct link to Tasks API overview). Click Enable. Re-run.

### "Sign in with Google" button redirects to localhost in prod
**Cause**: `NEXT_PUBLIC_WORKER_URL` is baked at build time by Next.js, not read at runtime. Setting it in `.env` after build has no effect.
**Fix**: Add `NEXT_PUBLIC_WORKER_URL=https://commandcenter.pametnitech.com/automations` (or `/w`, whichever path your nginx proxies to the worker) to the root `.env` BEFORE building. `build:web` script now sources `.env` automatically. Rebuild + restart cc_web.

## Workflow / Temporal

### `UpdateWorkflowExecution operation is disabled on this namespace`
**Cause**: Workflow Updates are off by default in self-hosted Temporal; our approval workflow uses them (not Signals).
**Fix**: Add the two `frontend.enableUpdateWorkflowExecution*` flags to Temporal's dynamic-config YAML. See `infra/temporal/dynamicconfig/docker.yaml`. Then `docker compose up -d --force-recreate temporal`.

### Dynamic-config file mounted but Temporal ignores it
**Cause**: `temporalio/auto-setup` default `DYNAMIC_CONFIG_FILE_PATH=config/dynamicconfig/docker.yaml`. If you named your file differently (e.g. `development.yaml`), you must also set the env var to match.
**Fix**: Rename to `docker.yaml`, OR set `DYNAMIC_CONFIG_FILE_PATH=config/dynamicconfig/<your name>.yaml`. Also: `restart` doesn't reload env — must be `up -d --force-recreate`.

### `invalid input syntax for type uuid: ""` from CC when worker calls `/api/integrations/reminders/due`
**Cause**: Service token resolver returned a row with empty `org_id` because the resolver's SECURITY DEFINER function runs under FORCE RLS on `service_tokens`. Owner (`cc_admin` in prod) doesn't bypass FORCE RLS → policy filters everything → empty result.
**Fix (permanent)**: Migration 0018 does `ALTER TABLE service_tokens NO FORCE ROW LEVEL SECURITY`. Owner (cc_admin) now bypasses naturally; command_center_app is still policy-filtered.
**Fix (hot-patch if 0018 not yet run)**: `ALTER FUNCTION resolve_service_token(text) OWNER TO postgres` — superuser bypass.

### Service token resolver returns `row count: 0` even though the hash matches
Same cause and fix as above (FORCE RLS on service_tokens).

### Triage input shape mismatch: `routeKey, text, blocks are required`
**Cause**: `inboxTriageWorkflow` expects `digestRouteKey` + `approvalRouteKey`, not `slackRouteKey` (which `morningBriefWorkflow` uses).
**Fix**:
```bash
--input '{"userEmail":"you@gmail.com","digestRouteKey":"automations.digest","approvalRouteKey":"automations.approval"}'
```

### Ollama returns `invalid category: undefined` OR extractors return null for valid emails
**Cause**: `format: "json"` enforces valid JSON but not schema. Small models like llama3.2:3b omit required fields.
**Fix**: Pass the JSON schema as the `format` value instead of the string `"json"`. Requires Ollama 0.5+. Already applied in `services/automations-worker/src/ollama.ts`.

## Worker / tooling

### `Unsupported package manager specification (bun@1.3.14)`
**Cause**: Corepack walks up from the worker dir, hits the root `packageManager: bun@...` field it doesn't recognize.
**Fix**: Already patched — removed `packageManager` from the root `package.json`. Worker's own `pnpm@9.12.0` is the first (and only) one corepack sees.

### `client.schedule.createSchedule is not a function`
**Cause**: Newer `@temporalio/client` renamed to `client.schedule.create`.
**Fix**: Already patched. Pull latest.

### Cannot delete schedule from Temporal UI (`missing csrf token`)
**Fix**: Use the CLI instead:
```bash
temporal schedule delete \
  --address <host>:7233 \
  --namespace commandcenter \
  --schedule-id <id>
```
Or via kubectl exec if Temporal is in GKE:
```bash
kubectl exec -n temporal deploy/temporal-admintools -- temporal schedule delete --namespace commandcenter --schedule-id <id>
```

### `localhost:3005 — This site can't be reached` on `/agent-automations`
**Cause**: Worker (and its callback-server) not running.
**Fix**: `cd services/automations-worker && pnpm worker` (local), or `pm2 restart automations-worker` (prod).

## Next.js / web

### `404` on `/_next/static/chunks/*.js` after rebuild
**Cause**: `bun run build` inside `apps/web` runs `next build` but doesn't copy static assets into the standalone output.
**Fix**: Use `bun run build:web` from project root — the script does the next build AND copies `.next/static` + `public/` into the standalone directory.

### `500` on static chunks after rename + rebuild
**Cause**: Stale build cache after a route rename.
**Fix**:
```bash
rm -rf apps/web/.next
bun run build:web
pm2 restart cc_web
```
Hard-refresh browser.

## Nginx / proxy

### Worker's `/auth/google/start` reachable from browser but times out
**Cause**: nginx `location /automations/` not added, OR CC's `/automations` page served by Next.js is colliding with the proxy path.
**Fix**: Use a non-colliding path like `/automations/` (if Next.js page is renamed to `/agent-automations`), or `/w/`. Nginx:
```nginx
location /automations/ {
    proxy_pass http://127.0.0.1:3005/;
    proxy_set_header Host $host;
    proxy_http_version 1.1;
}
```
`sudo nginx -t && sudo systemctl reload nginx`.

## Infrastructure / connectivity

### `chandu-h110` hostname doesn't resolve
**Cause**: Tailscale down on your Mac (or GCP VM), or the hostname is bare without MagicDNS resolution.
**Fix**:
```bash
tailscale status
# if offline: tailscale up
```
If MagicDNS is disabled, use the Tailscale IP directly instead of the hostname.
