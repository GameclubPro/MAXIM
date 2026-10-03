# Incident Playbook

Start read-only. Preserve logs and current state before applying a repair, migration, queue mutation,
DNS change, or container recreation.

Retain only allowlisted aggregates/classifications from production logs, plus exact UTC windows,
release/SHA, failed stage and exit status; do not persist raw logs, message content, identifiers or
credentials. State whether samples are complete, capped, rate-limited or missing. A script returning
zero without every expected stage is incomplete. For a shell script sent over stdin, keep child
commands from consuming the remaining script (`</dev/null` unless that child needs explicit input).

## Common Snapshot

```bash
./infra/scripts/vps-connect.sh doctor
./infra/scripts/vps-connect.sh health
./infra/scripts/vps-connect.sh ps
./infra/scripts/vps-connect.sh monitor-readonly 300 15
./infra/scripts/vps-connect.sh exec 'node infra/scripts/release-manifest.mjs show current'
```

`monitor-readonly` samples local/public health, Compose state, restart counts, canonical `/app/`, and
filtered role logs without reconciling webhooks or sending bot messages.

## Webhook 403 Spike

1. Inspect ingress logs without printing request authorization or secrets:

   ```bash
   ./infra/scripts/vps-connect.sh logs api-ingress 300
   ```

2. Verify that `MAX_WEBHOOK_SECRET_PATH` and `MAX_WEBHOOK_HEADER_SECRET` exist in production env,
   comparing presence/configuration only. Do not print their values.
3. Confirm backend nginx preserves `X-Max-Bot-Api-Secret` and that the public webhook still routes to
   `api-ingress`.
4. Read current MAX subscriptions. If host/domain changed, recreate the intended subscription; do
   not assume MAX rebound its configured secret automatically.
5. Recheck public live and ingress logs. Do not enable long polling while a production webhook is
   active.

## Queue Backlog Or Ready Failure

1. Read the local ready snapshots and inspect `checks.queueLag`, dependency state, and per-bot lag:

   ```bash
   ./infra/scripts/vps-connect.sh exec 'curl -fsS --max-time 15 http://127.0.0.1:3001/api/health/ready'
   ./infra/scripts/vps-connect.sh exec 'curl -fsS --max-time 15 http://127.0.0.1:3002/api/health/ready'
   ```

   Read bounded database evidence only through the fixed audit catalog:

   ```bash
   ./infra/scripts/vps-connect.sh postgres-audit queue
   ./infra/scripts/vps-connect.sh postgres-audit activity
   ```

   The activity report groups active work by fixed `query_family` labels, including enqueue
   selection, ordered chat heads, execution claims, and delete intents. Compare several short
   samples with the queue trend; one snapshot does not establish a bottleneck. Raw query text and
   parameters never leave the catalog, and idle sessions are labeled `inactive`.
   The queue report also reads only the oldest row per status for its attempt count, remaining
   retry delay, and fixed preparation category. `canonical_pending` or `membership_cache_pending`
   with a growing age calls for preparation-path diagnosis, not extra moderation consumers.
   `oldest_ordering_fence=timeout_quarantined` means the oldest message is waiting behind an
   unresolved earlier execution in that same chat. The probe uses the exact ordered-head index;
   never remove the fence or replay the old event merely because its heartbeat deadline elapsed.

   Run catalog calls sequentially because they share a lock. The last preparation-capacity marker
   describes that row's most recent deferral, not a fleet-wide cause. FAILED rows may be historical
   quarantine: report fresh deltas separately. Raw readiness, normal/healthy mode, burst state,
   exact images and queue fences must be assessed together; HTTP 200 may be hysteresis.

2. Inspect queue-owner logs:

   ```bash
   ./infra/scripts/vps-connect.sh logs api-enqueue 300
   ./infra/scripts/vps-connect.sh logs api-moderation-critical 300
   ./infra/scripts/vps-connect.sh logs api-moderation-background 300
   ./infra/scripts/vps-connect.sh logs api-action 300
   ```

3. Determine whether lag is ingress/enqueue, a moderation shard, action dispatch, Redis, Postgres, or
   MAX API pressure before changing concurrency.
4. Prefer the fixed catalog and health snapshots. Do not run raw `psql`, broad `webhook_events` or
   ledger aggregates during live pressure. A new diagnostic shape is code to review and test, not
   an inline incident command.
5. Quarantine or reprocess stale events only after root cause and exact IDs are reviewed. Queue/data
   mutation is a separate authorized repair, not a diagnostic step.
6. Ready can lag live while queues drain after deploy. Confirm that effective lag and oldest queued
   timestamps are improving before recreating workers.

7. Compare complete windows of ingress, SQL selection, preparation duration/admission, ordered-head
   progress, retries and action outcomes under comparable load. Rate-limited batch logs are not a
   throughput denominator. Missing samples or low counts remain incomplete. Distinguish urgent
   nomination delay from queue wait after nomination; a completed job is not permission evidence.
8. Reproduce a proposed correction with a failing local regression before deploying it. Use real
   PostgreSQL/Redis for query plans, retained-history bounds, leases and duplicate settlement. Stop
   only verified owned collectors during a release change; preserve capacity collection where possible.
   After runtime changes, restart homogeneous acceptance clocks and cycles. Do not retry the same
   unsuccessful deployment without a changed evidenced basis, or replace readiness with a longer
   timeout solely to make a release pass.

See the [3 October 2026 queue review](operations/incidents/2026-10-03-queue-backlog.md) for the
confirmed coupled defects and the limits of their measured attribution.

## API Container Restart Or Failed Rollout

```bash
./infra/scripts/vps-connect.sh ps api-ingress api-admin api-enqueue api-action
./infra/scripts/vps-connect.sh logs api-ingress 300
./infra/scripts/vps-connect.sh logs api-admin 300
```

- Check disk preflight/build contention and the first failing role before retrying deploy.
- Do not recreate Redis/Postgres as an application recovery step.
- If every API/static component already runs the green exact target, all roles are stable, readiness
  recovered, the webhook queues are unpaused and unowned, and only the typed release journal remains,
  finalize without another runtime wave:

  ```bash
  ./infra/scripts/vps-connect.sh finalize-release-recovery main
  ```

  This command fails closed unless the exact runtime, strict API/static/OCR smokes, released queue
  fence, single recovery journal, synchronized HEAD, and green exact-SHA CI are all proven. It does
  not build, migrate, or recreate containers.

- If rollback is required, prefer a retained immutable API component release:

  ```bash
  : "${RELEASE_ID:?Set RELEASE_ID to a retained release manifest id}"
  ./infra/scripts/vps-connect.sh rollback-release "$RELEASE_ID" api-shared
  ```

- This reuses the manifest's exact API image, verifies its image ID and Prisma compatibility, runs
  strict API smokes, and records a new rollback manifest without switching Git or running migrations.
- If no suitable immutable API release is retained, use the ref-based API fallback with a known
  compatible ref:

  ```bash
  ROLLBACK_REF="${ROLLBACK_REF:?Set ROLLBACK_REF to a compatible Git ref}"
  ./infra/scripts/vps-connect.sh rollback-runtime "$ROLLBACK_REF"
  ```

- Stop if an API rollback's Prisma compatibility preflight fails. `rollback-runtime` requires the
  existing Postgres/Redis services, rebuilds API only, and records the resulting API component after
  strict smokes; static components are restored through `rollback-release` without database access.

## Canonical Mini App 502 Or Blank Screen

```bash
./infra/scripts/vps-connect.sh ps miniapp-major-static
./infra/scripts/vps-connect.sh logs miniapp-major-static 300
```

- Check `https://major-maksimov.ru/app/`, not app2/CDN/Object Storage.
- Confirm HTML and hashed JS/CSS assets come from the same deployment.
- `miniapp-static` serves the legacy play-team support host and is not the Major container.
- For a UI regression, reproduce against the local current tree with `npm run screenshots:miniapp`
  or `npm run audit:miniapp:visual` before preparing a new build.
- To restore a retained Major build without rebuilding or running migrations:

  ```bash
  : "${RELEASE_ID:?Set RELEASE_ID to a retained release manifest id}"
  ./infra/scripts/vps-connect.sh rollback-release "$RELEASE_ID" miniapp-major-static
  ```

## Safety Desk Failure

```bash
./infra/scripts/vps-connect.sh ps admin-static api-admin
./infra/scripts/vps-connect.sh logs admin-static 300
./infra/scripts/vps-connect.sh logs api-admin 300
```

- Separate Basic Auth/nginx failures from `api-admin` authorization or application errors.
- Confirm public Major sites still deny Safety Desk/support endpoints.
- Never print the Basic Auth password, `ADMIN_ACCESS_CODE`, forwarded authorization headers, or bot
  credentials while diagnosing.
- For a confirmed Safety Desk static regression, restore its retained immutable component:

  ```bash
  : "${RELEASE_ID:?Set RELEASE_ID to a retained release manifest id}"
  ./infra/scripts/vps-connect.sh rollback-release "$RELEASE_ID" admin-static
  ```

## Redis Restore Or Queue-State Incident

- Preserve and identify the intended Redis volume before stopping either stack.
- Do not start main and scale stacks together.
- After restore/merge, inspect schedule-driven queues before workers resume.
- Rebuild future `night-mode-transitions` from database occurrences rather than restoring stale due
  jobs blindly. Require empty wait/active/failed and no due-now delayed work; persisted
  `NIGHT_MODE_CLOSE_NOTICE` is the idempotency source.

## False-Positive Moderation

- Review the exact moderation event and explainable detector metadata.
- Determine whether the correction belongs to a chat setting, allowlist, commercial fixture/rule,
  or global-spammer review decision.
- Add a regression fixture/test before changing shared scoring or suppressors.
- Do not weaken global thresholds based on one unverified event.

## Domain Allowlist Drift

- Do not normalize or delete production rows with ad hoc SQL during an incident.
- Reproduce canonicalization against a bounded sample, encode the correction as an idempotent
  migration or reviewed repair script, and test exact-host/subdomain plus `EXACT` semantics first.
